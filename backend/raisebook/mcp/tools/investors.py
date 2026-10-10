# mypy: disable-error-code="type-arg"
"""MCP tools: search_investors, get_investor, add_investor, update_investor (SPEC §6.4).

Owner: API+MCP (AM). Handlers call the same services as REST (``services.investors``,
``services.search``, ``services.participants``); references go through ``core.refs``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, ConfigDict, Field

from raisebook.auth.scopes import SCOPE_WRITE
from raisebook.core.refs import resolve_investor, resolve_round, resolve_stage
from raisebook.mcp import shaping
from raisebook.mcp.annotations import read_only, write
from raisebook.mcp.tools._common import Clock, tool_call
from raisebook.services import activities as act_svc
from raisebook.services import investors as investors_svc
from raisebook.services import participants as parts_svc
from raisebook.services.investors import compact
from raisebook.services.search import list_investors
from raisebook.services.stages import stages_for

InvestorType = Literal[
    "vc", "angel", "family_office", "corporate_vc", "accelerator", "scout", "other"
]
InvestorArg = Annotated[
    str,
    Field(
        description='Investor id, email, LinkedIn URL, exact "Name", or "Name @ Firm".',
        min_length=1,
        max_length=500,
    ),
]
RoundOpt = Annotated[str | None, Field(description="Round id, slug or name.", max_length=200)]
Str200 = Annotated[str | None, Field(max_length=200)]
Url = Annotated[str | None, Field(max_length=500)]
Amount = Annotated[int | None, Field(ge=0, description="Whole currency units (250000 = $250k).")]
Tags = Annotated[list[str] | None, Field(max_length=30)]

# MCP argument names → investor columns.
MCP_TO_FIELD = {"linkedin": "linkedin_url", "website": "website_url", "x": "x_url"}


class InvestorSet(BaseModel):
    """Contact fields to change. Only keys you pass change; null clears a field."""

    model_config = ConfigDict(extra="forbid")

    name: Str200 = None
    firm: Str200 = None
    title: Str200 = None
    type: InvestorType | None = None
    email: Annotated[str | None, Field(max_length=254)] = None
    linkedin: Url = Field(None, description="LinkedIn profile URL")
    website: Url = None
    x: Url = Field(None, description="X/Twitter URL or @handle")
    location: Str200 = None
    check_min: Amount = None
    check_max: Amount = None
    check_note: Str200 = Field(None, description='Check size as written, e.g. "$250k-$1M, leads"')
    stage_focus: Annotated[list[str] | None, Field(max_length=10)] = None
    industries: Tags = None
    tags: Tags = None
    notes: Annotated[str | None, Field(max_length=20000)] = None
    source: Str200 = Field(None, description='Where you found them, e.g. "SF Tech Week 2026"')
    warm_intro_by: Str200 = None


def to_fields(data: dict[str, Any]) -> dict[str, Any]:
    return {MCP_TO_FIELD.get(k, k): v for k, v in data.items()}


def register(server: FastMCP) -> None:
    @server.tool(annotations=read_only("Search investors"))
    async def search_investors(
        query: Annotated[
            str | None, Field(description="Words to match (all must match).", max_length=200)
        ] = None,
        round: RoundOpt = None,
        stage: Annotated[
            str | list[str] | None, Field(description="Stage key(s) or label(s) in the round.")
        ] = None,
        fit_min: Annotated[int | None, Field(ge=0, le=5)] = None,
        tags: Annotated[list[str] | None, Field(description="All must match.")] = None,
        industries: Annotated[list[str] | None, Field(description="Any matches.")] = None,
        type: InvestorType | None = None,
        follow_up: Annotated[
            Literal["due", "week", "none"] | None,
            Field(description="due = today or overdue; week = within 7 days; none = no date"),
        ] = None,
        sort: Annotated[
            Literal["fit", "name", "follow_up", "recent", "stage"] | None,
            Field(description="Default: fit (round) / name (contacts)."),
        ] = None,
        limit: Annotated[int, Field(ge=1, le=100)] = 25,
        cursor: str | None = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Find investors. `query` matches name, firm, title, email, location, tags, industries, source and notes (all words must match). Without `round`, it searches all workspace contacts and shows each one's stage in every round. With `round` (or any of stage/fit_min/follow_up, which imply the single open round), it returns investors in that round with stage, fit, follow-up and amounts."""  # noqa: E501
        async with tool_call(ctx) as (db, ws):
            now = Clock.now()
            round_mode = bool(round) or stage is not None or fit_min is not None or bool(follow_up)
            if round_mode:
                rnd = await resolve_round(db, ws, round, required=True)
                assert rnd is not None
                stages = await stages_for(db, ws, rnd.id)
                wanted = [stage] if isinstance(stage, str) else (stage or [])
                picked = [resolve_stage(stages, s) for s in wanted] or None
                parts, nxt, total = await parts_svc.list_participants(
                    db,
                    ws,
                    rnd,
                    now=now,
                    limit=limit,
                    cursor=cursor,
                    q=query,
                    stages=picked,
                    fit_min=fit_min,
                    type_=type,
                    tags=tags,
                    industries=industries,
                    follow_up=follow_up,
                    sort=sort or "fit",
                )
                results = []
                for p in await parts_svc.present(db, ws, parts, now=now):
                    row = shaping.dump(p.investor)
                    if row.get("tags") == []:
                        row.pop("tags")
                    row.update(
                        shaping.dump(
                            {
                                "stage": p.stage.key,
                                "fit": p.fit,
                                "priority": p.priority,
                                "follow_up_on": (
                                    p.follow_up_on.isoformat() if p.follow_up_on else None
                                ),
                                "follow_up_state": p.follow_up_state,
                                "amount_soft": p.amount_soft,
                                "amount_committed": p.amount_committed,
                                "next_step": p.next_step,
                            }
                        )
                    )
                    results.append(row)
                return shaping.dump(
                    {
                        "round": {"slug": str(rnd.slug), "name": rnd.name},
                        "results": results,
                        "next_cursor": nxt,
                        "total": total,
                    }
                )
            sort_map = {"name": "name", "recent": "updated"}
            rows, nxt, total = await list_investors(
                db,
                ws,
                limit=limit,
                cursor=cursor,
                q=query,
                type_=type,
                tags=tags,
                industries=industries,
                sort=sort_map.get(sort or "name", "name"),
            )
            briefs = await investors_svc.participations(db, ws, [r.id for r in rows])
            results = []
            for inv in rows:
                row = shaping.dump(compact(inv))
                if row.get("tags") == []:
                    row.pop("tags")
                rounds = [
                    {"round_slug": b.round_slug, "stage_key": b.stage.key, "fit": b.fit}
                    for b in briefs.get(inv.id, [])
                ]
                if rounds:
                    row["rounds"] = rounds
                results.append(row)
            return shaping.dump({"results": results, "next_cursor": nxt, "total": total})

    @server.tool(annotations=read_only("Get investor"))
    async def get_investor(
        investor: InvestorArg,
        round: Annotated[
            str | None,
            Field(description="Only show this round's participation and timeline."),
        ] = None,
        timeline_limit: Annotated[int, Field(ge=1, le=100)] = 20,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Everything about one investor: contact fields, notes, their stage and terms in every round, and the timeline (newest first) with who did what, including agent actions."""  # noqa: E501
        async with tool_call(ctx) as (db, ws):
            now = Clock.now()
            inv = await resolve_investor(db, ws, investor)
            rnd = await resolve_round(db, ws, round, required=False)
            out = await investors_svc.present_one(db, ws, inv)
            parts = await parts_svc.for_investor(db, ws, inv.id, rnd.id if rnd else None)
            rows, nxt = await act_svc.list_activities(
                db, ws, limit=timeline_limit, investor_id=inv.id, round_id=rnd.id if rnd else None
            )
            timeline = await act_svc.present(db, ws, rows)
            data = shaping.investor(out, notes_limit=shaping.DETAIL_NOTES_LIMIT)
            data.pop("rounds", None)
            return {
                "investor": data,
                "participations": [
                    shaping.participant(p) for p in await parts_svc.present(db, ws, parts, now=now)
                ],
                "timeline": [shaping.activity(a) for a in timeline],
                "timeline_truncated": nxt is not None,
            }

    @server.tool(annotations=write("Add investor", idempotent=True))
    async def add_investor(
        name: Annotated[str, Field(min_length=1, max_length=200)],
        firm: Str200 = None,
        title: Str200 = None,
        type: InvestorType | None = None,
        email: Annotated[str | None, Field(max_length=254)] = None,
        linkedin: Annotated[str | None, Field(description="Profile URL", max_length=500)] = None,
        website: Url = None,
        x: Annotated[str | None, Field(description="URL or @handle", max_length=500)] = None,
        location: Str200 = None,
        check_min: Amount = None,
        check_max: Amount = None,
        check_note: Str200 = None,
        stage_focus: Annotated[list[str] | None, Field(max_length=10)] = None,
        industries: Tags = None,
        tags: Tags = None,
        notes: Annotated[str | None, Field(max_length=20000)] = None,
        source: Str200 = None,
        warm_intro_by: Str200 = None,
        on_duplicate: Literal["return_existing", "fill_empty", "create_anyway"] = (
            "return_existing"
        ),
        round: RoundOpt = None,
        stage: Annotated[str | None, Field(description="Stage key or label (needs round).")] = None,
        fit: Annotated[int | None, Field(ge=0, le=5)] = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Add an investor contact, or return the existing one. Dedupes by email, then LinkedIn profile, then name+firm; `matched_on` tells you which. on_duplicate: return_existing (default, changes nothing), fill_empty (fill only fields that are empty, merge tags), create_anyway (ignore a name+firm match; email/LinkedIn duplicates are never created). Pass `round` (and optionally `stage`, `fit`) to also put them on that round's board. Leave unknown fields out."""  # noqa: E501
        given = {
            "name": name,
            "firm": firm,
            "title": title,
            "type": type,
            "email": email,
            "linkedin": linkedin,
            "website": website,
            "x": x,
            "location": location,
            "check_min": check_min,
            "check_max": check_max,
            "check_note": check_note,
            "stage_focus": stage_focus,
            "industries": industries,
            "tags": tags,
            "notes": notes,
            "source": source,
            "warm_intro_by": warm_intro_by,
        }
        fields = to_fields({k: v for k, v in given.items() if v is not None})
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            rnd = await resolve_round(db, ws, round, required=False)
            if rnd is None and (stage is not None or fit is not None):
                rnd = await resolve_round(db, ws, None, required=True)
            res = await investors_svc.add(db, ws, fields, on_duplicate=on_duplicate, now=now)
            out: dict[str, Any] = {
                "investor": shaping.investor(await investors_svc.present_one(db, ws, res.investor)),
                "created": res.created,
            }
            if res.matched_on:
                out["matched_on"] = res.matched_on
            if res.filled_fields is not None:
                out["filled_fields"] = res.filled_fields
            if rnd is not None:
                changes: dict[str, Any] = {}
                if stage is not None:
                    changes["stage"] = stage
                if fit is not None:
                    changes["fit"] = fit
                up = await parts_svc.upsert(db, ws, rnd, res.investor, changes, now=now)
                part = await parts_svc.present_one(db, ws, up.participant, now=now)
                out["participant"] = shaping.participant(part)
                out["investor"] = shaping.investor(
                    await investors_svc.present_one(db, ws, res.investor)
                )
            return out

    @server.tool(annotations=write("Update investor", idempotent=False))
    async def update_investor(
        investor: InvestorArg,
        set: Annotated[
            InvestorSet | None,
            Field(description="Fields to change; only keys you pass change; null clears."),
        ] = None,
        add_tags: Tags = None,
        remove_tags: Tags = None,
        add_industries: Tags = None,
        append_notes: Annotated[
            str | None,
            Field(
                description="Adds a dated paragraph to notes instead of replacing them.",
                max_length=20000,
            ),
        ] = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Change an investor's contact fields. Only keys in `set` change; null clears a field. Use add_tags/remove_tags to edit tags without rewriting the list, and append_notes to add a dated paragraph to their notes instead of replacing them. Round-specific fields (stage, fit, follow-up, amounts) are changed with add_to_round, move_stage, set_follow_up and record_commitment."""  # noqa: E501
        changes = to_fields({k: getattr(set, k) for k in set.model_fields_set}) if set else {}
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            inv = await resolve_investor(db, ws, investor)
            res = await investors_svc.update(
                db,
                ws,
                inv,
                changes,
                now=Clock.now(),
                add_tags=add_tags,
                remove_tags=remove_tags,
                add_industries=add_industries,
                append_notes=append_notes,
            )
            return {
                "investor": shaping.investor(await investors_svc.present_one(db, ws, inv)),
                "changed_fields": res.changed_fields,
            }
