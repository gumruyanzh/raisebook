"""Test-only MCP tools that exercise ``tool_call`` before feature tools exist.

Registered by patching ``raisebook.mcp.tools.TOOL_MODULES`` in ``test_mcp_transport``.
"""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from raisebook.auth.scopes import SCOPE_WRITE
from raisebook.core.errors import NotFound
from raisebook.mcp.annotations import read_only, write
from raisebook.mcp.tools._common import Clock, tool_call
from raisebook.models.investor import Investor


def register(server: FastMCP) -> None:
    @server.tool(annotations=read_only("Probe: who am I"))
    async def probe_whoami(ctx: Context | None = None) -> dict[str, Any]:  # type: ignore[type-arg]
        """Return the caller's workspace context and actor. Test-only probe tool."""
        async with tool_call(ctx) as (_db, ws):
            return {
                "workspace_id": str(ws.workspace_id),
                "slug": ws.slug,
                "timezone": ws.timezone,
                "currency": ws.currency,
                "actor": {
                    "type": ws.actor.type.value,
                    "via": ws.actor.via.value,
                    "label": ws.actor.label,
                    "model": ws.actor.model,
                    "api_key_id": str(ws.actor.api_key_id),
                },
                "now": Clock.now().isoformat(),
            }

    @server.tool(annotations=write("Probe: write"))
    async def probe_write(investor_id: str, ctx: Context | None = None) -> dict[str, Any]:  # type: ignore[type-arg]
        """Rename an investor in the caller's workspace (needs write). Test-only probe tool."""
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            inv = await db.get(Investor, investor_id)
            if inv is None or inv.workspace_id != ws.workspace_id:
                raise NotFound("Investor not found in this workspace.")
            inv.title = "Probed"
            await db.flush()
            return {"ok": True}
