# mypy: disable-error-code="type-arg"
"""MCP tools: search_investors, get_investor, add_investor, update_investor (SPEC §6.4).

Owner: API+MCP (AM). Handlers call the same services as REST (``services.investors``,
``services.search``, ``services.participants``); references go through ``core.refs``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import ToolAnnotations
from pydantic import BaseModel, ConfigDict, Field

from raisebook.auth.scopes import SCOPE_WRITE
from raisebook.core.errors import APIError
from raisebook.core.refs import resolve_investor, resolve_round, resolve_stage, suggestions
from raisebook.mcp import shaping
from raisebook.mcp.tools._args import (
    Amount,
    CheckNote,
    DateArg,
    Email,
    Fit,
    InvestorArg,
    InvestorType,
    LinkedIn,
    RoundOpt,
    StageArg,
    Str200,
    Tags,
    Url,
)
from raisebook.mcp.tools._common import Clock, parse_date, tool_call
from raisebook.services import activities as act_svc
from raisebook.services import investors as investors_svc
from raisebook.services import participants as parts_svc
from raisebook.services.investors import compact
from raisebook.services.search import list_investors
from raisebook.services.stages import stages_for

# MCP argument names → investor columns.
MCP_TO_FIELD = {"linkedin": "linkedin_url", "website": "website_url", "x": "x_url"}


class InvestorSet(BaseModel):
    """Contact fields to change. Only keys you pass change; null clears a field."""

    model_config = ConfigDict(extra="forbid")

    name: Str200 = None
    firm: Str200 = None
    title: Str200 = None
    type: InvestorType | None = None
    email: Email = None
    linkedin: LinkedIn = None
    website: Url = None
    x: Url = Field(None, description="X/Twitter URL or @handle")
    location: Str200 = None
    check_min: Amount = None
    check_max: Amount = None
    check_note: CheckNote = None
    stage_focus: Annotated[
        list[str] | None, Field(max_length=10, description='e.g. ["pre-seed", "seed"]')
    ] = None
    industries: Tags = None
    tags: Tags = None
    notes: Annotated[str | None, Field(max_length=20000)] = None
    source: Str200 = Field(None, description='Where you found them, e.g. "SF Tech Week 2026"')
    warm_intro_by: Str200 = None


MCP_FROM_FIELD = {v: k for k, v in MCP_TO_FIELD.items()}


def to_fields(data: dict[str, Any]) -> dict[str, Any]:
    return {MCP_TO_FIELD.get(k, k): v for k, v in data.items()}


ADD_DESCRIPTION = """Add an investor contact, or find the existing one and fill in what it is missing. Dedupes by email, then LinkedIn profile, then name+firm, then the name alone when there is exactly one person with that name; `matched_on` tells you which. on_duplicate: fill_empty (default: fill empty fields, merge tags, and append new notes as a dated paragraph; it never overwrites), return_existing (change nothing; `not_applied` lists the fields you sent that were not saved), create_anyway (ignore name matches; email/LinkedIn duplicates are never created). Pass `round` (and optionally `stage`, `fit`, `follow_up_on`, `follow_up_note`, `next_step`, `amount_soft`) to also put them on that round's board in the same call. Leave unknown fields out."""  # noqa: E501

ADD_MANY_DESCRIPTION = """Add up to 50 investors in one call, each exactly as add_investor would (same dedupe and on_duplicate rules), optionally all on one round. Each item takes add_investor's contact fields plus its own stage, fit, follow_up_on, follow_up_note, next_step and amount_soft. Returns one compact line per item (id, name, created or matched_on, and any error), so one bad item does not stop the rest."""  # noqa: E501


class RoundFields(BaseModel):
    """Round options shared by add_investor and add_investors items."""

    stage: StageArg = None
    fit: Fit = None
    follow_up_on: DateArg = None
    follow_up_note: Annotated[
        str | None, Field(max_length=500, description="What the follow-up is for.")
    ] = None
    next_step: Annotated[str | None, Field(max_length=500)] = None
    amount_soft: Amount = None


class InvestorItem(RoundFields):
    """One investor for add_investors (add_investor's fields)."""

    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1, max_length=200)]
    firm: Str200 = None
    title: Str200 = None
    type: InvestorType | None = None
    email: Email = None
    linkedin: LinkedIn = None
    website: Url = None
    x: Annotated[str | None, Field(description="URL or @handle", max_length=500)] = None
    location: Str200 = None
    check_min: Amount = None
    check_max: Amount = None
    check_note: CheckNote = None
    stage_focus: Annotated[list[str] | None, Field(max_length=10)] = None
    industries: Tags = None
    tags: Tags = None
    notes: Annotated[str | None, Field(max_length=20000)] = None
    source: Str200 = None
    warm_intro_by: Str200 = None


CONTACT_KEYS = tuple(k for k in InvestorItem.model_fields if k not in RoundFields.model_fields)
ROUND_KEYS = tuple(RoundFields.model_fields)
OnDup = Annotated[
    Literal["fill_empty", "return_existing", "create_anyway"],
    Field(description="What to do when the investor already exists (default fill_empty)."),
]


def _hint(matched_on: str, not_applied: list[str], on_duplicate: str) -> str:
    fields = ", ".join(not_applied)
    if on_duplicate == "return_existing":
        return (
            f"Existing investor matched on {matched_on}; {fields} were not saved. To save them, "
            "call add_investor again with on_duplicate='fill_empty', or update_investor "
            "(use append_notes for notes)."
        )
    return (
        f"Existing investor matched on {matched_on}; {fields} already have different values "
        "and were not overwritten. Use update_investor to change them."
    )


async def _add_one(
    db: Any,
    ws: Any,
    contact: dict[str, Any],
    round_fields: dict[str, Any],
    *,
    round_ref: str | None,
    on_duplicate: str,
    now: Any,
) -> dict[str, Any]:
    """add_investor's work for one investor (shared by add_investors)."""
    fields = to_fields({k: v for k, v in contact.items() if v is not None})
    wants_round = any(v is not None for v in round_fields.values())
    rnd = await resolve_round(db, ws, round_ref, required=False)
    res = await investors_svc.add(db, ws, fields, on_duplicate=on_duplicate, now=now)  # type: ignore[arg-type]
    if rnd is None and wants_round:
        rnd = await resolve_round(db, ws, None, required=True, investor=res.investor)
    out: dict[str, Any] = {"created": res.created}
    if res.matched_on:
        out["matched_on"] = res.matched_on
    if res.filled_fields:
        out["filled_fields"] = res.filled_fields
    if res.not_applied and not res.created:
        shown = [MCP_FROM_FIELD.get(f, f) for f in res.not_applied]
        out["not_applied"] = shown
        out["hint"] = _hint(res.matched_on or "", shown, on_duplicate)
    if rnd is not None:
        changes: dict[str, Any] = {}
        for key in ROUND_KEYS:
            value = round_fields.get(key)
            if value is None:
                continue
            changes[key] = parse_date(value, key) if key == "follow_up_on" else value
        up = await parts_svc.upsert(db, ws, rnd, res.investor, changes, now=now)
        part = await parts_svc.present_one(db, ws, up.participant, now=now)
        out["participant"] = shaping.participant(part, with_investor=False)
        out["round"] = str(rnd.slug)
        fu = changes.get("follow_up_on")
        if fu is not None and fu < ws.today(now):
            out["warning"] = f"follow_up_on {fu.isoformat()} is in the past (today is " + (
                f"{ws.today(now).isoformat()}); the follow-up shows as overdue."
            )
    inv = shaping.investor(await investors_svc.present_one(db, ws, res.investor))
    if rnd is not None:
        inv.pop("rounds", None)
    out["investor"] = inv
    return out


def register(server: FastMCP) -> None:
    @server.tool(
        annotations=ToolAnnotations(
            title="Search investors",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    async def search_investors(
        query: Annotated[
            str | None, Field(description="Words to match (all must match).", max_length=200)
        ] = None,
        round: RoundOpt = None,
        stage: Annotated[
            str | list[str] | None, Field(description="Stage key(s) or label(s) in the round.")
        ] = None,
        fit_min: Annotated[
            int | None, Field(ge=0, le=5, description="Minimum fit (5 hot, 4 warm, 3 maybe).")
        ] = None,
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
        cursor: Annotated[
            str | None, Field(description="next_cursor from the previous page.")
        ] = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Find investors. `query` matches name, firm, title, email, location, tags, industries, source and notes (all words must match). Without `round`, it searches all workspace contacts and shows each one's stage in every round. With `round` (or any of stage/fit_min/follow_up, which imply the single open round), it returns investors in that round with stage, fit, follow-up and amounts. When nothing matches, `suggestions` lists close names."""  # noqa: E501
        async with tool_call(ctx) as (db, ws):
            now = Clock.now()
            round_mode = bool(round) or stage is not None or fit_min is not None or bool(follow_up)
            out: dict[str, Any]
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
                    row = shaping.investor(p.investor)
                    row.update(
                        shaping.dump(
                            {
                                "stage": p.stage.key,
                                "fit": p.fit or None,
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
                out = {
                    "round": {"slug": str(rnd.slug), "name": rnd.name},
                    "results": results,
                    "next_cursor": nxt,
                    "total": total,
                }
            else:
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
                    row = shaping.investor(compact(inv))
                    rounds = [
                        {"round_slug": b.round_slug, "stage_key": b.stage.key, "fit": b.fit}
                        for b in briefs.get(inv.id, [])
                    ]
                    if rounds:
                        row["rounds"] = rounds
                    results.append(row)
                out = {"results": results, "next_cursor": nxt, "total": total}
            if not results and query:
                sugg = await suggestions(db, ws, query)
                if sugg:
                    out["suggestions"] = sugg
            return shaping.prune(out)  # type: ignore[no-any-return]

    @server.tool(
        annotations=ToolAnnotations(
            title="Get investor",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
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
            result: dict[str, Any] = {
                "investor": data,
                "participations": [
                    shaping.participant(p, with_investor=False)
                    for p in await parts_svc.present(db, ws, parts, now=now)
                ],
                "timeline": [shaping.activity(a, with_investor=False) for a in timeline],
            }
            if nxt is not None:
                result["timeline_truncated"] = True
            return shaping.prune(result)  # type: ignore[no-any-return]

    @server.tool(
        annotations=ToolAnnotations(
            title="Add investor",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
        description=ADD_DESCRIPTION,
    )
    async def add_investor(
        name: Annotated[str, Field(min_length=1, max_length=200)],
        firm: Str200 = None,
        title: Str200 = None,
        type: InvestorType | None = None,
        email: Email = None,
        linkedin: LinkedIn = None,
        website: Url = None,
        x: Annotated[str | None, Field(description="URL or @handle", max_length=500)] = None,
        location: Str200 = None,
        check_min: Amount = None,
        check_max: Amount = None,
        check_note: CheckNote = None,
        stage_focus: Annotated[
            list[str] | None, Field(max_length=10, description='e.g. ["pre-seed", "seed"]')
        ] = None,
        industries: Tags = None,
        tags: Tags = None,
        notes: Annotated[str | None, Field(max_length=20000)] = None,
        source: Annotated[
            str | None,
            Field(max_length=200, description='Where you found them, e.g. "SF Tech Week 2026"'),
        ] = None,
        warm_intro_by: Annotated[
            str | None, Field(max_length=200, description="Who can introduce you.")
        ] = None,
        on_duplicate: OnDup = "fill_empty",
        round: Annotated[
            str | None,
            Field(
                description="Round id, slug or name to also add them to. Omitted with any round "
                "option below = the single open round.",
                max_length=200,
            ),
        ] = None,
        stage: StageArg = None,
        fit: Fit = None,
        follow_up_on: DateArg = None,
        follow_up_note: Annotated[
            str | None, Field(max_length=500, description="What the follow-up is for.")
        ] = None,
        next_step: Annotated[str | None, Field(max_length=500)] = None,
        amount_soft: Amount = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        contact = {
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
        round_fields = {
            "stage": stage,
            "fit": fit,
            "follow_up_on": follow_up_on,
            "follow_up_note": follow_up_note,
            "next_step": next_step,
            "amount_soft": amount_soft,
        }
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            return await _add_one(
                db,
                ws,
                contact,
                round_fields,
                round_ref=round,
                on_duplicate=on_duplicate,
                now=Clock.now(),
            )

    @server.tool(
        annotations=ToolAnnotations(
            title="Add investors",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
        description=ADD_MANY_DESCRIPTION,
    )
    async def add_investors(
        items: Annotated[list[InvestorItem], Field(min_length=1, max_length=50)],
        round: Annotated[
            str | None,
            Field(description="Round id, slug or name to add every item to.", max_length=200),
        ] = None,
        on_duplicate: OnDup = "fill_empty",
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        results: list[dict[str, Any]] = []
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            for i, item in enumerate(items):
                data = item.model_dump()
                contact = {k: data[k] for k in CONTACT_KEYS}
                round_fields = {k: data[k] for k in ROUND_KEYS}
                try:
                    async with db.begin_nested():
                        one = await _add_one(
                            db,
                            ws,
                            contact,
                            round_fields,
                            round_ref=round,
                            on_duplicate=on_duplicate,
                            now=now,
                        )
                except APIError as exc:
                    results.append(
                        {"item": i, "name": item.name, "error": f"{exc.code}: {exc.message}"}
                    )
                    continue
                line: dict[str, Any] = {
                    "item": i,
                    "id": one["investor"]["id"],
                    "name": one["investor"]["name"],
                }
                for key in ("created", "matched_on", "not_applied", "round", "warning"):
                    if key in one:
                        line[key] = one[key]
                if "participant" in one:
                    line["stage"] = one["participant"]["stage"]["key"]
                results.append(line)
        created = sum(1 for r in results if r.get("created"))
        failed = sum(1 for r in results if "error" in r)
        return {
            "counts": {
                "created": created,
                "existing": len(results) - created - failed,
                "errors": failed,
            },
            "results": results,
        }

    @server.tool(
        annotations=ToolAnnotations(
            title="Update investor",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=False,
            openWorldHint=False,
        )
    )
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
            out = shaping.investor(await investors_svc.present_one(db, ws, inv))
            out.pop("rounds", None)
            return {"investor": out, "changed_fields": res.changed_fields}
