"""Raisebook MCP server at exactly ``/mcp`` (SPEC §6.1), adapted from smmist.

Streamable HTTP, stateless (any API replica serves any request), JSON responses.

- The endpoint is an exact-path raw-ASGI Route delegating to the SDK's session
  manager, not a Mount: a Mount turns ``POST /mcp`` into a 307 to ``/mcp/``,
  which MCP clients do not follow.
- Starlette does not forward the lifespan into route endpoints, so the app's
  lifespan must enter ``server.session_manager.run()`` (``main.create_app`` does),
  or every request fails with "Task group is not initialized".
- ``session_manager.run()`` may be entered once per instance, so each app builds
  its own server with :func:`create_mcp_server`.
"""

from __future__ import annotations

from fastapi import FastAPI
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

SERVER_NAME = "raisebook"

# SPEC §6.3, verbatim.
SERVER_INSTRUCTIONS = (
    "Raisebook is the founder's fundraising CRM: rounds, investors, and each investor's stage "
    "in a round. Your API key belongs to one workspace (one company). Start with get_workspace "
    "to learn the rounds, valid stage keys and today's date in the workspace timezone. Refer "
    'to investors by id, email, LinkedIn URL, or exact name ("Name" or "Name @ Firm"). Refer '
    "to rounds by id, slug or name; you may omit the round when the workspace has exactly one "
    "open round. Amounts are whole units of the round's currency (250000 means $250k). Dates "
    "are YYYY-MM-DD. add_investor deduplicates by email, LinkedIn and name+firm, so call it "
    "directly instead of searching first. Use log_activity for what happened (email sent, "
    "call, meeting), set_follow_up for what should happen next, move_stage when the "
    "relationship advances, and record_commitment only when the investor has actually "
    "committed. Every write is recorded on the investor's timeline under your agent name, and "
    "the founder sees it. Never invent investor details; leave unknown fields empty. "
    "import_investors_csv defaults to dry_run=true: show the human the preview counts, then "
    "rerun with dry_run=false."
)


def create_mcp_server() -> FastMCP:
    """A fresh FastMCP instance with the full Raisebook tool surface."""
    server = FastMCP(
        name=SERVER_NAME,
        instructions=SERVER_INSTRUCTIONS,
        stateless_http=True,
        json_response=True,
        streamable_http_path="/mcp",
        # A public TLS API behind host routing; DNS-rebinding protection targets localhost
        # servers. Disabled explicitly so the choice is visible.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    from raisebook.mcp.tools import register_tools

    register_tools(server)
    return server


class MCPEndpoint:
    """Raw-ASGI endpoint delegating to a server's session manager.

    A class on purpose: Starlette's Route wraps plain functions in request/response
    handling but passes ASGI callables through untouched.
    """

    def __init__(self, server: FastMCP) -> None:
        server.streamable_http_app()  # side effect: creates the session manager
        self._server = server

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # The app's current server wins (tests swap in a fresh one per call, because a
        # session manager can only be run once); otherwise the one built at startup.
        app = scope.get("app")
        server = getattr(getattr(app, "state", None), "mcp_server", None) or self._server
        await server.session_manager.handle_request(scope, receive, send)


def add_mcp_route(app: FastAPI, server: FastMCP) -> None:
    """Register the exact-path ``/mcp`` route behind the API-key auth stack."""
    from raisebook.mcp.auth import build_guarded_mcp_asgi

    handler = build_guarded_mcp_asgi(MCPEndpoint(server))
    app.router.routes.append(Route("/mcp", handler, methods=["GET", "POST", "DELETE"]))
