# mypy: disable-error-code="type-arg"
"""MCP tools: list_rounds, get_round_summary (SPEC §6.4 #2, #3). Owner: API+MCP (AM)."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from mcp.server.fastmcp import Context, FastMCP
from pydantic import Field

from raisebook.auth.scopes import SCOPE_WRITE
from raisebook.core.refs import resolve_round
from raisebook.mcp import shaping
from raisebook.mcp.annotations import read_only, write
from raisebook.mcp.tools._args import Amount, DateArg
from raisebook.mcp.tools._common import Clock, parse_date, tool_call
from raisebook.services import rounds as rounds_svc
from raisebook.services.stages import stages_for
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
            for k in ("notes", "stages", "id", "created_at", "updated_at"):
                r.pop(k, None)
            out["funnel"] = [
                shaping.prune(
                    {
                        "key": f.get("key"),
                        "label": f.get("label"),
                        "kind": f.get("kind"),
                        "count": f.get("count") or None,
                        "amount_soft": f.get("amount_soft") or None,
                        "amount_committed": f.get("amount_committed") or None,
                    }
                )
                for f in out.get("funnel", [])
            ]
            out["recent_activity"] = [shaping.activity(a) for a in summary.recent_activity]
            fu = out.get("follow_ups", {})
            fu["top"] = [_item(i) for i in fu.get("top", [])]
            out["stale"] = [_item(i) for i in out.get("stale", [])]
            return shaping.prune(out)  # type: ignore[no-any-return]

    @server.tool(annotations=write("Create round", idempotent=True))
    async def create_round(
        name: Annotated[
            str, Field(min_length=1, max_length=80, description='e.g. "Seed" or "Seed Extension"')
        ],
        target_amount: Amount = None,
        currency: Annotated[
            str | None,
            Field(description="3-letter code; default the workspace currency.", max_length=3),
        ] = None,
        instrument: Annotated[
            str | None,
            Field(
                description="safe (default), priced, convertible_note or other "
                '(labels like "SAFE" or "equity" work).',
                max_length=40,
            ),
        ] = None,
        valuation_cap: Amount = None,
        target_close_on: DateArg = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Create a fundraising round with the default stages (New, Researching, Contacted, Replied, Meeting, Diligence, Committed, Passed). Safe to repeat: if a round with this name exists, it is returned unchanged with `created: false`. Returns the round with its stage keys, ready for add_investor / add_to_round."""  # noqa: E501
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            existing = await rounds_svc.find_by_name(db, ws, name)
            created = existing is None
            if existing is None:
                data: dict[str, Any] = {
                    "name": name,
                    "target_amount": target_amount,
                    "currency": currency,
                    "instrument": instrument,
                    "valuation_cap": valuation_cap,
                    "target_close_on": parse_date(target_close_on, "target_close_on"),
                }
                rnd = await rounds_svc.create_round(
                    db, ws, {k: v for k, v in data.items() if v is not None}, now=now
                )
            else:
                rnd = existing
            stages = await stages_for(db, ws, rnd.id)
            return shaping.prune(  # type: ignore[no-any-return]
                {
                    "created": created,
                    "round": {
                        "id": str(rnd.id),
                        "slug": str(rnd.slug),
                        "name": rnd.name,
                        "status": rnd.status,
                        "instrument": rnd.instrument,
                        "currency": rnd.currency,
                        "target_amount": rnd.target_amount,
                        "valuation_cap": rnd.valuation_cap,
                        "target_close_on": (
                            rnd.target_close_on.isoformat() if rnd.target_close_on else None
                        ),
                        "stages": [
                            {"key": st.key, "label": st.label, "kind": st.kind} for st in stages
                        ],
                    },
                }
            )


def _item(item: dict[str, Any]) -> dict[str, Any]:
    """A follow-up or stale entry without UI-only and repeated fields."""
    out = dict(item)
    if isinstance(out.get("stage"), dict):
        out["stage"] = out["stage"].get("key")
    if isinstance(out.get("round"), dict):
        out.pop("round")
    if isinstance(out.get("investor"), dict):
        out["investor"] = shaping.investor(out["investor"])
    return shaping.prune(out)  # type: ignore[no-any-return]
