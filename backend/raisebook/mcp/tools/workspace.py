# mypy: disable-error-code="type-arg"
"""MCP tool: get_workspace (SPEC §6.4 #1). Owner: API+MCP (AM)."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context, FastMCP

from raisebook.auth.scopes import canonical_order
from raisebook.mcp.annotations import read_only
from raisebook.mcp.tools._common import Clock, tool_call
from raisebook.models.enums import LOGGABLE_ACTIVITY_KINDS
from raisebook.services import rounds as rounds_svc
from raisebook.services.normalize import INVESTOR_TYPES
from raisebook.services.stages import stages_by_round


def register(server: FastMCP) -> None:
    @server.tool(annotations=read_only("Workspace overview"))
    async def get_workspace(ctx: Context | None = None) -> dict[str, Any]:
        """Who am I and what's here: workspace name, timezone and today's date, your scopes and agent name, every round with its stage keys, and the allowed investor types and activity kinds. Call this first."""  # noqa: E501
        async with tool_call(ctx) as (db, ws):
            rounds = await rounds_svc.list_rounds(db, ws, status="all")
            stages = await stages_by_round(db, ws, [r.id for r in rounds])
            p = ws.principal
            return {
                "workspace": {
                    "id": str(ws.workspace_id),
                    "name": ws.name,
                    "slug": ws.slug,
                    "is_sandbox": ws.is_sandbox,
                    "timezone": ws.timezone,
                    "today": ws.today(Clock.now()).isoformat(),
                    "weekday": ws.today(Clock.now()).strftime("%A"),
                    "default_currency": ws.currency,
                },
                "you": {
                    "agent_name": ws.actor.label,
                    "scopes": canonical_order(p.scopes),
                    "key_prefix": p.key_prefix,
                },
                "rounds": [
                    {
                        "id": str(r.id),
                        "slug": str(r.slug),
                        "name": r.name,
                        "status": r.status,
                        "currency": r.currency,
                        "target_amount": r.target_amount,
                        "stages": [
                            {"key": s.key, "label": s.label, "kind": s.kind} for s in stages[r.id]
                        ],
                    }
                    for r in rounds
                ],
                "investor_types": list(INVESTOR_TYPES),
                "loggable_activity_kinds": [k.value for k in LOGGABLE_ACTIVITY_KINDS],
            }
