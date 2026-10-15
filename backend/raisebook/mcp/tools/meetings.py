# mypy: disable-error-code="type-arg"
"""MCP tools: schedule_meeting, list_meetings, update_meeting, complete_meeting
(docs/SPEC.md §6.8). They call ``services.meetings`` exactly like ``/v1/meetings``."""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from raisebook.auth.scopes import SCOPE_WRITE
from raisebook.core.errors import NotFound
from raisebook.core.refs import resolve_investor, resolve_round
from raisebook.mcp import shaping
from raisebook.mcp.tools._args import DateArg, InvestorArg
from raisebook.mcp.tools._common import Clock, parse_date, parse_uuid, tool_call
from raisebook.schemas.meetings import MeetingOut
from raisebook.services import meetings as svc
from raisebook.services import participants as parts_svc
from raisebook.services.stages import stage_out

TimeArg = Annotated[
    str,
    Field(
        description="RFC 3339 (2026-10-20T11:00:00-07:00), or a local time 2026-10-20T11:00 "
        "in the workspace timezone.",
        min_length=1,
        max_length=40,
    ),
]
TimeOpt = Annotated[str | None, Field(description="Like starts_at.", max_length=40)]
Minutes = Annotated[int | None, Field(ge=5, le=1440, description="Length in minutes (default 30).")]
MeetingArg = Annotated[
    str, Field(description="The meeting id (from schedule_meeting or list_meetings).")
]


def meeting(out: MeetingOut, tz: str) -> dict[str, Any]:
    """Compact meeting: local start and end in the workspace timezone, no UI-only fields."""
    d = shaping.dump(out)
    local = out.starts_at.astimezone(ZoneInfo(tz))
    res: dict[str, Any] = {
        "id": d["id"],
        "title": d["title"],
        "starts_at": d["starts_at"],
        "local": f"{local.strftime('%A %Y-%m-%d %H:%M')} ({tz})",
        "minutes": d["duration_minutes"],
        "status": d["status"],
        "investor": shaping.investor(d["investor"]),
    }
    if out.needs_outcome:
        res["needs_outcome"] = True
    for k in ("location", "video_url", "agenda", "outcome", "source"):
        if d.get(k):
            res[k] = d[k]
    if d.get("guests"):
        res["guests"] = [g["name"] for g in d["guests"]]
    if d.get("round"):
        res["round"] = d["round"]["slug"]
    res["by"] = shaping.actor_by(d.get("created_by") or {})
    hist = d.get("history") or []
    if len(hist) > 1:
        res["history"] = [
            shaping.prune(
                {
                    "change": h.get("change"),
                    "at": h.get("at"),
                    "from": h.get("from_starts_at"),
                    "to": h.get("to_starts_at"),
                    "by": shaping.actor_by(h.get("by") or {}),
                }
            )
            for h in hist
        ]
    return res


async def _write_result(db: Any, ws: Any, res: svc.WriteResult, now: Any) -> dict[str, Any]:
    out = await svc.present_one(db, ws, res.meeting, now=now)
    result: dict[str, Any] = {"meeting": meeting(out, ws.timezone), "changed": res.changed}
    if res.moved is not None:
        result["moved_stage"] = {
            "from": shaping.stage_brief(stage_out(res.moved.from_stage))
            if res.moved.from_stage
            else None,
            "to": shaping.stage_brief(stage_out(res.moved.to_stage)),
        }
        result["moved_stage"] = shaping.prune(result["moved_stage"])
    if res.participant is not None and (res.moved is not None or res.activity is not None):
        part = await parts_svc.present_one(db, ws, res.participant, now=now)
        result["participant"] = shaping.participant(part, with_investor=False)
    if res.warnings:
        result["warnings"] = res.warnings
    return result


async def _meeting(db: Any, ws: Any, ref: str) -> Any:
    try:
        return await svc.get(db, ws, parse_uuid(ref, "meeting"))
    except NotFound:
        raise NotFound(
            f"Meeting {ref} not found in this workspace. Use list_meetings to find its id.",
            details={"meeting": ref},
        ) from None


def register(server: FastMCP) -> None:
    @server.tool(
        annotations=ToolAnnotations(
            title="Schedule meeting",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    async def schedule_meeting(
        investor: InvestorArg,
        starts_at: TimeArg,
        duration_minutes: Minutes = None,
        ends_at: TimeOpt = None,
        round: Annotated[
            str | None,
            Field(
                description="Round id, slug or name. Omit to use the investor's only open "
                "round (else no round).",
                max_length=200,
            ),
        ] = None,
        title: Annotated[str | None, Field(max_length=200)] = None,
        location: Annotated[
            str | None, Field(max_length=500, description="Address or place.")
        ] = None,
        video_url: Annotated[
            str | None, Field(max_length=1000, description="Video call link.")
        ] = None,
        agenda: Annotated[str | None, Field(max_length=5000)] = None,
        guests: Annotated[
            list[str] | None,
            Field(
                max_length=10,
                description="More people from the same firm (investor references).",
            ),
        ] = None,
        source: Literal["manual", "email", "agent", "calendar"] | None = None,
        move_to_meeting_stage: Annotated[
            bool,
            Field(
                description="Move the investor to the round's Meeting stage when they are "
                "earlier in the pipeline. Default true."
            ),
        ] = True,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Put a future meeting with an investor on the founder's calendar. By default it also moves them to the round's Meeting stage when they are earlier in the pipeline. Scheduling the same investor at the same start again returns the existing meeting, so retries are safe. `source` says where you learned about it (email, calendar); it defaults to agent."""  # noqa: E501
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            inv = await resolve_investor(db, ws, investor)
            rnd = await resolve_round(db, ws, round, required=False)
            start = svc.parse_when(starts_at, ws, "starts_at")
            assert start is not None
            guest_rows = [await resolve_investor(db, ws, g) for g in guests or []]
            guest_list = await svc.resolve_guests(db, ws, inv, [g.id for g in guest_rows])
            res = await svc.schedule(
                db,
                ws,
                investor=inv,
                starts_at=start,
                ends_at=svc.parse_when(ends_at, ws, "ends_at"),
                duration_minutes=duration_minutes,
                round=rnd,
                title=title,
                location=location,
                video_url=video_url,
                agenda=agenda,
                guests=guest_list,
                source=source or "agent",
                move_to_meeting_stage=move_to_meeting_stage,
                now=now,
            )
            out = await _write_result(db, ws, res, now)
            out["created"] = res.created
            return out

    @server.tool(
        annotations=ToolAnnotations(
            title="List meetings",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    async def list_meetings(
        when: Annotated[
            Literal["upcoming", "today", "week", "needs_outcome", "past", "all"],
            Field(
                description="upcoming (default): scheduled and not over; today / week: "
                "starting today / in the next 7 days; needs_outcome: over but not marked done; "
                "past: started before now; all."
            ),
        ] = "upcoming",
        investor: Annotated[
            str | None, Field(description="Only this investor (as host or guest).")
        ] = None,
        round: Annotated[str | None, Field(max_length=200)] = None,
        status: Literal["scheduled", "done", "cancelled", "no_show"] | None = None,
        limit: Annotated[int, Field(ge=1, le=200)] = 50,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Meetings with investors, soonest first (past and needs_outcome: latest first). Use it to prepare the founder's day ('today'), and 'needs_outcome' to find meetings that happened but have no outcome yet; record those with complete_meeting."""  # noqa: E501
        async with tool_call(ctx) as (db, ws):
            now = Clock.now()
            inv = await resolve_investor(db, ws, investor) if investor else None
            rnd = await resolve_round(db, ws, round, required=False)
            tz = ZoneInfo(ws.timezone)
            today = ws.today(now)
            day_start = now.replace(microsecond=0).astimezone(tz)
            day_start = day_start.replace(hour=0, minute=0, second=0)
            kw: dict[str, Any] = {}
            order = "asc"
            if when == "upcoming":
                kw["upcoming"] = True
            elif when == "today":
                kw.update(start_from=day_start, start_to=day_start + timedelta(days=1))
                kw["statuses"] = [status] if status else ["scheduled", "done", "no_show"]
            elif when == "week":
                kw.update(start_from=day_start, start_to=day_start + timedelta(days=8))
            elif when == "needs_outcome":
                kw["needs_outcome_only"] = True
                order = "desc"
            elif when == "past":
                kw["start_to"] = now
                order = "desc"
            if status and "statuses" not in kw:
                kw["statuses"] = [status]
            rows, _ = await svc.list_meetings(
                db,
                ws,
                now=now,
                investor_id=inv.id if inv else None,
                round_id=rnd.id if rnd else None,
                order=order,
                limit=limit,
                **kw,
            )
            outs = await svc.present(db, ws, rows, now=now)
            items = [meeting(o, ws.timezone) for o in outs]
            for it in items:
                if inv is not None and it["investor"].get("id") == str(inv.id):
                    it["investor"] = inv.name
            needs, _ = await svc.list_meetings(db, ws, now=now, needs_outcome_only=True, limit=200)
            return {
                "now": now.astimezone(tz).strftime("%A %Y-%m-%d %H:%M"),
                "today": today.isoformat(),
                "timezone": ws.timezone,
                "items": items,
                "counts": {"returned": len(items), "needs_outcome": len(needs)},
            }

    @server.tool(
        annotations=ToolAnnotations(
            title="Update meeting",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    async def update_meeting(
        meeting_id: MeetingArg,
        starts_at: TimeOpt = None,
        duration_minutes: Minutes = None,
        ends_at: TimeOpt = None,
        status: Annotated[
            Literal["scheduled", "cancelled", "no_show"] | None,
            Field(description="cancelled, no_show, or scheduled to reopen one."),
        ] = None,
        title: Annotated[str | None, Field(max_length=200)] = None,
        location: Annotated[str | None, Field(max_length=500)] = None,
        video_url: Annotated[str | None, Field(max_length=1000)] = None,
        agenda: Annotated[str | None, Field(max_length=5000)] = None,
        note: Annotated[
            str | None, Field(max_length=2000, description="Why; shown on the timeline.")
        ] = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Reschedule a meeting (new starts_at; the length stays unless you pass duration_minutes or ends_at), edit its details, cancel it (status: cancelled) or mark a no-show. Rescheduling a cancelled or no-show meeting brings it back. Every change stays in the meeting's history and on the timeline. To record how a meeting went, use complete_meeting."""  # noqa: E501
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            m = await _meeting(db, ws, meeting_id)
            changes: dict[str, Any] = {}
            if starts_at:
                changes["starts_at"] = svc.parse_when(starts_at, ws, "starts_at")
            if ends_at:
                changes["ends_at"] = svc.parse_when(ends_at, ws, "ends_at")
            if duration_minutes is not None:
                changes["duration_minutes"] = duration_minutes
            for k, v in (
                ("title", title),
                ("location", location),
                ("video_url", video_url),
                ("agenda", agenda),
                ("status", status),
            ):
                if v is not None:
                    changes[k] = v
            res = await svc.update(db, ws, m, changes, now=now, note=note)
            return await _write_result(db, ws, res, now)

    @server.tool(
        annotations=ToolAnnotations(
            title="Complete meeting",
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    async def complete_meeting(
        meeting_id: MeetingArg,
        outcome: Annotated[
            str | None,
            Field(
                max_length=5000,
                description="How it went, in plain words (logged on the timeline).",
            ),
        ] = None,
        next_step: Annotated[str | None, Field(max_length=500)] = None,
        follow_up_on: DateArg = None,
        follow_up_in_days: Annotated[int | None, Field(ge=0, le=365)] = None,
        follow_up_note: Annotated[str | None, Field(max_length=500)] = None,
        ctx: Context | None = None,
    ) -> dict[str, Any]:
        """Mark a meeting done and record the outcome (logged as a meeting on the investor's timeline). Optionally set the next step and the follow-up date for the investor's round in the same call. Repeating it changes nothing. Use move_stage separately if the meeting moved them further (for example to Diligence)."""  # noqa: E501
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            now = Clock.now()
            m = await _meeting(db, ws, meeting_id)
            res = await svc.complete(
                db,
                ws,
                m,
                now=now,
                outcome=outcome,
                next_step=next_step,
                follow_up_on=parse_date(follow_up_on, "follow_up_on"),
                follow_up_in_days=follow_up_in_days,
                follow_up_note=follow_up_note,
            )
            return await _write_result(db, ws, res, now)
