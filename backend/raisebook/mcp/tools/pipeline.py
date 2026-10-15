# mypy: disable-error-code="type-arg"
"""MCP tools: add_to_round, move_stage, log_activity, set_follow_up, list_due_follow_ups,
record_commitment (SPEC §6.4 #8 to #13). Owner: API+MCP (AM).

Every write runs through ``services.participants`` / ``services.activities`` (the same
code as REST) and is recorded under the caller's agent name and model.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import ToolAnnotations
from pydantic import BeforeValidator, Field

from raisebook.auth.scopes import SCOPE_WRITE
from raisebook.core.refs import resolve_investor, resolve_round
from raisebook.mcp import shaping
from raisebook.mcp.tools._args import (
    Amount,
    DateArg,
    Fit,
    InvestorArg,
    LoggableKind,
    Probability,
    RoundArg,
    StageArg,
    parse_amount_arg,
)
from raisebook.mcp.tools._common import Clock, parse_date, tool_call
from raisebook.services import activities as act_svc
from raisebook.services import participants as parts_svc
from raisebook.services.followups import list_due, upcoming_outlook
from raisebook.services.stages import stage_out


def _past_warning(ws: Any, now: Any, on: Any, what: str) -> str | None:
    today = ws.today(now)
    if on is not None and on < today:
        return (
            f"{what} {on.isoformat()} is before today ({today.isoformat()}, "
            f"{today.strftime('%A')}); it shows as overdue. Check the year."
        )
    return None


def register(server: FastMCP) -> None:
    @server.tool(
        annotations=ToolAnnotations(
            title="Add to round",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    async def add_to_round(
        investor: InvestorArg,
        round: RoundArg = None,
        stage: StageArg = None,
        fit: Fit = None,
        probability: Probability = None,
        amount_soft: Amount = None,
        next_step: Annotated[str | None, Field(max_length=500)] = None,
        follow_up_on: DateArg = None,
        follow_up_note: Annotated[
            str | None, Field(max_length=500, description="What the follow-up is for.")
        ] = None,
        owner_email: Annotated[
            str | None, Field(description="A workspace member's email.", max_length=254)
        ] = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Put an investor on a round's board, or update their round fields if they are already there. Safe to repeat. New participants start in the first stage unless you pass `stage`. For an existing participant, a different `stage` moves them (logged as a stage change)."""  # noqa: E501
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            inv = await resolve_investor(db, ws, investor)
            rnd = await resolve_round(db, ws, round, required=True, investor=inv)
            assert rnd is not None
            changes: dict[str, Any] = {}
            fu = parse_date(follow_up_on, "follow_up_on")
            for key, value in (
                ("stage", stage),
                ("fit", fit),
                ("probability", probability),
                ("amount_soft", amount_soft),
                ("next_step", next_step),
                ("follow_up_on", fu),
                ("follow_up_note", follow_up_note),
            ):
                if value is not None:
                    changes[key] = value
            if owner_email:
                changes["owner_user_id"] = await parts_svc.owner_from_email(db, ws, owner_email)
            res = await parts_svc.upsert(db, ws, rnd, inv, changes, now=now)
            part = await parts_svc.present_one(db, ws, res.participant, now=now)
            out: dict[str, Any] = {
                "participant": shaping.participant(part),
                "created": res.created,
                "changed": res.changed,
            }
            warning = _past_warning(ws, now, fu, "follow_up_on")
            if warning:
                out["warning"] = warning
            return out

    @server.tool(
        annotations=ToolAnnotations(
            title="Move stage",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    async def move_stage(
        investor: InvestorArg,
        stage: Annotated[str, Field(description="Target stage key or label.", min_length=1)],
        round: RoundArg = None,
        note: Annotated[
            str | None, Field(description="Why; shown on the timeline.", max_length=2000)
        ] = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Move an investor to another stage in a round (for example contacted → meeting). Moving to the current stage does nothing. Add `note` to explain why; it appears on the timeline. To mark a commitment with an amount, use record_commitment instead of moving to the won stage."""  # noqa: E501
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            inv = await resolve_investor(db, ws, investor)
            rnd = await resolve_round(db, ws, round, required=True, investor=inv)
            assert rnd is not None
            res = await parts_svc.move_stage(db, ws, rnd, inv, stage, note=note, now=now)
            part = await parts_svc.present_one(db, ws, res.participant, now=now)
            return {
                "participant": shaping.participant(part),
                "changed": res.changed,
                "from": shaping.stage_brief(stage_out(res.from_stage)),
                "to": shaping.stage_brief(stage_out(res.to_stage)),
            }

    @server.tool(
        annotations=ToolAnnotations(
            title="Log activity",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=False,
            openWorldHint=False,
        )
    )
    async def log_activity(
        investor: InvestorArg,
        kind: LoggableKind,
        body: Annotated[
            str, Field(description="What happened, in plain words.", min_length=1, max_length=20000)
        ],
        occurred_at: Annotated[
            str | None,
            Field(description="RFC 3339 timestamp or YYYY-MM-DD (12:00 local). Default now."),
        ] = None,
        round: Annotated[
            str | None, Field(description="Round id, slug or name, when it concerns one.")
        ] = None,
        direction: Literal["inbound", "outbound"] | None = None,
        idempotency_key: Annotated[
            str | None,
            Field(
                description="Stable key (e.g. an email message id) for safe retries.",
                max_length=200,
            ),
        ] = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Record something that happened with an investor: a note, an email (sent or received), a call or a meeting. `body` is what happened in plain words. `occurred_at` defaults to now; past dates are fine, and a future meeting time records a scheduled meeting. Pass `round` when it concerns a specific round. Pass a stable `idempotency_key` (for example an email message id) to make retries safe."""  # noqa: E501
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            inv = await resolve_investor(db, ws, investor)
            rnd = await resolve_round(db, ws, round, required=False)
            row, duplicate = await act_svc.log_manual(
                db,
                ws,
                investor=inv,
                kind=kind,
                body=body,
                now=now,
                occurred_at=act_svc.parse_occurred_at(occurred_at, ws),
                round_id=rnd.id if rnd else None,
                direction=direction,
                idempotency_key=idempotency_key,
            )
            out = (await act_svc.present(db, ws, [row]))[0]
            return {"activity": shaping.activity(out), "duplicate": duplicate}

    @server.tool(
        annotations=ToolAnnotations(
            title="Set follow-up",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    async def set_follow_up(
        investor: InvestorArg,
        round: RoundArg = None,
        on: DateArg = None,
        in_days: Annotated[
            int | None, Field(ge=0, le=365, description="Days from today (workspace timezone).")
        ] = None,
        clear: bool | None = None,
        note: Annotated[
            str | None, Field(description="What the follow-up is for.", max_length=500)
        ] = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Set or clear the date you should next follow up with an investor in a round. Give exactly one of `on` (YYYY-MM-DD), `in_days` (from today in the workspace timezone) or `clear: true`. `note` says what the follow-up is for (shown in the follow-up list)."""  # noqa: E501
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            inv = await resolve_investor(db, ws, investor)
            rnd = await resolve_round(db, ws, round, required=True, investor=inv)
            assert rnd is not None
            on_date = parse_date(on, "on")
            part, changed = await parts_svc.set_follow_up(
                db,
                ws,
                rnd,
                inv,
                on=on_date,
                in_days=in_days,
                clear=clear,
                note=note,
                now=now,
            )
            out = await parts_svc.present_one(db, ws, part, now=now)
            result: dict[str, Any] = {
                "participant": shaping.participant(out),
                "changed": changed,
            }
            warning = _past_warning(ws, now, on_date, "on")
            if warning:
                result["warning"] = warning
            return result

    @server.tool(
        annotations=ToolAnnotations(
            title="Due follow-ups",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    async def list_due_follow_ups(
        round: Annotated[
            str | None, Field(description="Round id, slug or name. Omit for all open rounds.")
        ] = None,
        within_days: Annotated[
            int,
            Field(
                ge=0,
                le=60,
                description="Also list follow-ups in the next N days. Default 0 = overdue and "
                "today only. For 'this week', pass 7.",
            ),
        ] = 0,
        include_overdue: Annotated[
            bool, Field(description="Include follow-ups whose date has passed. Default true.")
        ] = True,
        limit: Annotated[int, Field(ge=1, le=200)] = 50,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Follow-ups that are due: overdue first, then today, then (with within_days > 0) the next N days. Without `round`, it covers all open rounds. Use it to plan the founder's outreach for the day; for 'this week', pass within_days=7. `counts` always includes next_7_days and next_due_on, so an empty list never hides a busy week ahead."""  # noqa: E501
        async with tool_call(ctx) as (db, ws):
            rnd = await resolve_round(db, ws, round, required=False)
            res = await list_due(
                db,
                ws,
                now=Clock.now(),
                round_id=rnd.id if rnd else None,
                within_days=within_days,
                include_overdue=include_overdue,
                limit=limit,
            )
            items = []
            for item in res.data:
                d = shaping.dump(item)
                d["stage"] = shaping.stage_brief(d["stage"])
                d["investor"] = shaping.investor(d["investor"])
                d["round"] = d["round"]["slug"]
                d.pop("last_activity_at", None)
                items.append(d)
            week, next_on = await upcoming_outlook(
                db, ws, now=Clock.now(), round_id=rnd.id if rnd else None
            )
            counts = shaping.dump(res.counts)
            counts["next_7_days"] = week
            if next_on is not None:
                counts["next_due_on"] = next_on.isoformat()
            return {
                "today": res.today.isoformat(),
                "weekday": res.today.strftime("%A"),
                "items": items,
                "counts": counts,
            }

    @server.tool(
        annotations=ToolAnnotations(
            title="Record commitment",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    async def record_commitment(
        investor: InvestorArg,
        amount: Annotated[
            int,
            BeforeValidator(parse_amount_arg),
            Field(
                ge=0,
                description="Total commitment in whole currency units ('250k' works); 0 clears.",
            ),
        ],
        round: RoundArg = None,
        committed_on: Annotated[
            str | None, Field(description="YYYY-MM-DD; default today.", max_length=10)
        ] = None,
        note: Annotated[str | None, Field(max_length=2000)] = None,
        move_to_won: bool = True,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Record that an investor committed money to a round. `amount` is the total commitment in whole currency units (it replaces any earlier amount; it is not added to it), and 0 clears it. By default this also moves them to the round's won stage (Committed) and adds them to the round if needed."""  # noqa: E501
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            inv = await resolve_investor(db, ws, investor)
            rnd = await resolve_round(db, ws, round, required=True, investor=inv)
            assert rnd is not None
            res = await parts_svc.record_commitment(
                db,
                ws,
                rnd,
                inv,
                amount=amount,
                committed_on=parse_date(committed_on, "committed_on"),
                note=note,
                move_to_won=move_to_won,
                now=now,
            )
            out = await parts_svc.present_one(db, ws, res.participant, now=now)
            return shaping.dump(
                {
                    "participant": shaping.participant(out),
                    "previous_amount": res.previous_amount,
                    "moved_stage": res.moved_stage,
                    "round_committed_total": res.round_committed_total,
                    "currency": rnd.currency,
                }
            )
