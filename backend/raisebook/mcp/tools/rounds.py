# mypy: disable-error-code="type-arg"
"""MCP tools: list_rounds, get_round_summary (SPEC §6.4 #2, #3). Owner: API+MCP (AM)."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from mcp.server.fastmcp import Context, FastMCP
from pydantic import Field

from raisebook.core.refs import resolve_round
from raisebook.mcp import shaping
from raisebook.mcp.annotations import read_only
from raisebook.mcp.tools._common import Clock, tool_call
from raisebook.services import rounds as rounds_svc
from raisebook.services.summary import round_summary

RoundArg = Annotated[
    str | None,
    Field(
        description="Round id, slug or name. Omit when the workspace has exactly one open round."
    ),
]


def register(server: FastMCP) -> None:
    @server.tool(annotations=read_only("List rounds"))
    async def list_rounds(
        status: Annotated[
            Literal["open", "closed", "all"], Field(description="Which rounds to list.")
        ] = "open",
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """List fundraising rounds with target, committed amount and participant counts per stage kind. Use the slug or name as `round` in other tools."""  # noqa: E501
        async with tool_call(ctx) as (db, ws):
            rows = await rounds_svc.list_rounds(db, ws, status=status)
            outs = await rounds_svc.present(db, ws, rows)
            counts = await rounds_svc.kind_counts(db, ws, rows)
            return {
                "rounds": [
                    shaping.dump(
                        {
                            "id": str(o.id),
                            "slug": o.slug,
                            "name": o.name,
                            "status": o.status,
                            "instrument": o.instrument,
                            "currency": o.currency,
                            "target_amount": o.target_amount,
                            "committed_amount": o.committed_amount,
                            "target_close_on": (
                                o.target_close_on.isoformat() if o.target_close_on else None
                            ),
                            "counts": counts[o.id],
                        }
                    )
                    for o in outs
                ]
            }

    @server.tool(annotations=read_only("Round summary"))
    async def get_round_summary(
        round: RoundArg = None, ctx: Context | None = None
    ) -> dict[str, Any]:
        """The state of a round in one call: committed vs target, soft-circled and weighted pipeline, investors per stage, overdue and upcoming follow-ups, stale conversations (no activity for 14+ days), recent activity and warnings. Use it for status updates and 'what should I do today'."""  # noqa: E501
        async with tool_call(ctx) as (db, ws):
            rnd = await resolve_round(db, ws, round, required=True)
            assert rnd is not None
            summary = await round_summary(db, ws, rnd, now=Clock.now())
            out: dict[str, Any] = shaping.dump(summary)
            r = out["round"]
            r.pop("notes", None)
            r["stages"] = [shaping.stage_brief(s) for s in r.get("stages", [])]
            out["recent_activity"] = [shaping.activity(a) for a in summary.recent_activity]
            for item in out["follow_ups"]["top"]:
                item["stage"] = shaping.stage_brief(item["stage"])
            for item in out["stale"]:
                item["stage"] = shaping.stage_brief(item["stage"])
            return out
