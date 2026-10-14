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

import json
from collections.abc import Sequence
from typing import Any

from fastapi import FastAPI
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ContentBlock, TextContent
from mcp.types import Tool as MCPTool
from pydantic import ValidationError
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from raisebook import __version__
from raisebook.auth.scopes import SCOPE_WRITE

SERVER_NAME = "raisebook"

# SPEC §6.3, verbatim. The research line (RESEARCH-PLAN §7) is added only when research is on.
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
RESEARCH_INSTRUCTIONS = (
    " Research: get_dossier reads an investor's cited dossier; research_investor runs research "
    "on the workspace's own OpenRouter key within its monthly limit (a dossier under 30 days "
    "old is returned instead of paid for twice; kind=refresh researches again); or research "
    "with your own "
    "tools and submit it with save_dossier (every fact cites a source you fetched; professional "
    "information only)."
)


def server_instructions() -> str:
    from raisebook.config import get_settings

    if get_settings().research_enabled:
        return SERVER_INSTRUCTIONS + RESEARCH_INSTRUCTIONS
    return SERVER_INSTRUCTIONS


def _got(value: Any) -> str:
    text = json.dumps(value, default=str, ensure_ascii=False)
    return text if len(text) <= 60 else text[:57] + "..."


def format_validation_error(exc: ValidationError) -> str:
    """``validation_error: fit must be at most 5 (got 7); type must be one of …``."""
    parts: list[str] = []
    for err in exc.errors(include_url=False)[:5]:
        loc = ".".join(str(x) for x in err.get("loc", ()) if x != "body") or "arguments"
        typ = err.get("type", "")
        ctx = err.get("ctx") or {}
        got = f" (got {_got(err['input'])})" if "input" in err and typ != "missing" else ""
        if typ == "missing":
            msg = f"{loc} is required"
        elif typ == "extra_forbidden":
            msg = f"{loc} is not a known field"
            got = ""
        elif typ == "literal_error":
            msg = f"{loc} must be one of {ctx.get('expected', '')}".replace("'", "")
        elif typ in ("less_than_equal", "less_than"):
            msg = f"{loc} must be at most {ctx.get('le', ctx.get('lt'))}"
        elif typ in ("greater_than_equal", "greater_than"):
            msg = f"{loc} must be at least {ctx.get('ge', ctx.get('gt'))}"
        elif typ.startswith("int_"):
            msg = f"{loc} must be a whole number (amounts may also be written like '250k')"
        else:
            msg = f"{loc}: {err.get('msg', 'invalid value')}"
        parts.append(msg + got)
    return "validation_error: " + "; ".join(parts) + "."


class RaisebookMCP(FastMCP):
    """FastMCP with Raisebook's result and error conventions.

    - Results are compact JSON text (no pretty-printing, no useless ``outputSchema``).
    - Errors read ``<code>: <message>``; argument validation errors are rewritten from
      pydantic's text into ``validation_error: fit must be at most 5 (got 7)``.
    - ``tools/list`` hides write tools from keys without ``raisebook:write`` (the scope
      check in each tool stays as the backstop).
    - ``serverInfo.version`` is the Raisebook version.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._mcp_server.version = __version__

    def tool(self, *args: Any, **kwargs: Any) -> Any:
        kwargs.setdefault("structured_output", False)
        return super().tool(*args, **kwargs)

    async def list_tools(self) -> list[MCPTool]:
        from raisebook.mcp.auth import current_principal

        tools = await super().list_tools()
        principal = current_principal()
        if principal is None or SCOPE_WRITE in principal.scopes:
            return tools
        return [t for t in tools if t.annotations is None or t.annotations.readOnlyHint]

    async def call_tool(
        self, name: str, arguments: dict[str, Any]
    ) -> Sequence[ContentBlock] | dict[str, Any]:
        context = self.get_context()
        try:
            result = await self._tool_manager.call_tool(
                name, arguments, context=context, convert_result=False
            )
        except ToolError as exc:
            cause = exc.__cause__
            if isinstance(cause, ToolError):
                raise cause from None  # drop the SDK's "Error executing tool …" prefix
            if isinstance(cause, ValidationError):
                raise ToolError(format_validation_error(cause)) from None
            raise
        if isinstance(result, str):
            text = result
        else:
            text = json.dumps(result, separators=(",", ":"), ensure_ascii=False, default=str)
        return [TextContent(type="text", text=text)]


def create_mcp_server() -> FastMCP:
    """A fresh FastMCP instance with the full Raisebook tool surface."""
    server = RaisebookMCP(
        name=SERVER_NAME,
        instructions=server_instructions(),
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
