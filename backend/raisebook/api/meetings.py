"""Meetings: ``/v1/meetings`` (docs/SPEC.md §5.9).

Read routes need ``raisebook:read``; scheduling, changes, marking done and deleting need
``raisebook:write``. A meeting id from another workspace is 404.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import (
    WorkspaceContext,
    get_now,
    get_session,
    get_workspace_ctx,
    get_write_ctx,
)
from raisebook.core.refs import resolve_round
from raisebook.models.meeting import Meeting
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.schemas.meetings import (
    MeetingComplete,
    MeetingCreate,
    MeetingOut,
    MeetingPage,
    MeetingUpdate,
    MeetingWriteOut,
    StageMoveBrief,
)
from raisebook.services import activities as act_svc
from raisebook.services import calendar_feed
from raisebook.services import investors as investors_svc
from raisebook.services import meetings as svc
from raisebook.services import participants as parts_svc
from raisebook.services.ics import calendar
from raisebook.services.stages import stage_out

router = APIRouter(prefix="/v1/meetings", tags=["meetings"], responses=ERROR_RESPONSES)


async def write_out(
    db: AsyncSession, ws: WorkspaceContext, res: svc.WriteResult, *, now: datetime
) -> MeetingWriteOut:
    meeting = await svc.present_one(db, ws, res.meeting, now=now)
    moved = None
    if res.moved is not None:
        to = stage_out(res.moved.to_stage)
        moved = StageMoveBrief(
            **{"from": stage_out(res.moved.from_stage) if res.moved.from_stage else None, "to": to}
        )
    part = (
        await parts_svc.present_one(db, ws, res.participant, now=now)
        if res.participant is not None
        else None
    )
    act = (await act_svc.present(db, ws, [res.activity]))[0] if res.activity is not None else None
    return MeetingWriteOut(
        meeting=meeting,
        created=res.created,
        changed=res.changed,
        moved_stage=moved,
        participant=part,
        activity=act,
        warnings=res.warnings,
    )


@router.get("", response_model=MeetingPage)
async def list_all(
    investor_id: UUID | None = None,
    round: str | None = Query(None, max_length=200),
    status: list[Literal["scheduled", "done", "cancelled", "no_show"]] | None = Query(None),
    when: Literal["upcoming", "needs_outcome", "all"] = Query(
        "all",
        description="upcoming: scheduled and not ended; needs_outcome: scheduled and ended.",
    ),
    start_from: datetime | None = Query(None, alias="from"),
    start_to: datetime | None = Query(None, alias="to"),
    order: Literal["asc", "desc"] = "asc",
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = None,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> MeetingPage:
    """Meetings by start time. ``investor_id`` matches the investor or a guest; ``from`` and
    ``to`` bound the start (RFC 3339)."""
    if investor_id is not None:
        await investors_svc.get(db, ws, investor_id)
    rnd = await resolve_round(db, ws, round, required=False)
    rows, nxt = await svc.list_meetings(
        db,
        ws,
        now=now,
        investor_id=investor_id,
        round_id=rnd.id if rnd else None,
        statuses=status,
        # A time without an offset is workspace time, as everywhere else in meetings.
        start_from=svc.parse_when(start_from, ws, "from"),
        start_to=svc.parse_when(start_to, ws, "to"),
        upcoming=when == "upcoming",
        needs_outcome_only=when == "needs_outcome",
        order=order,
        limit=limit,
        cursor=cursor,
    )
    return MeetingPage(data=await svc.present(db, ws, rows, now=now), next_cursor=nxt)


@router.post("", status_code=201, response_model=MeetingWriteOut)
async def schedule(
    body: MeetingCreate,
    response: Response,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> MeetingWriteOut:
    """Schedule a meeting. In a round, the investor moves to the Meeting stage when earlier
    in the pipeline (``move_to_meeting_stage``, default true). The same investor at the
    same start returns the existing meeting (200, ``created: false``)."""
    inv = await investors_svc.get(db, ws, body.investor_id)
    rnd = await resolve_round(db, ws, body.round, required=False)
    starts = svc.parse_when(body.starts_at, ws, "starts_at")
    assert starts is not None
    guests = await svc.resolve_guests(db, ws, inv, body.guest_ids)
    res = await svc.schedule(
        db,
        ws,
        investor=inv,
        starts_at=starts,
        ends_at=svc.parse_when(body.ends_at, ws, "ends_at"),
        duration_minutes=body.duration_minutes,
        round=rnd,
        title=body.title,
        location=body.location,
        video_url=body.video_url,
        agenda=body.agenda,
        guests=guests,
        source=body.source,
        move_to_meeting_stage=body.move_to_meeting_stage,
        now=now,
    )
    await db.commit()
    if not res.created:
        response.status_code = 200
    return await write_out(db, ws, res, now=now)


@router.get("/{meeting_id}", response_model=MeetingOut)
async def get_one(
    meeting_id: UUID,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> MeetingOut:
    """One meeting with its history (scheduled, rescheduled, cancelled… from the timeline)."""
    m = await svc.get(db, ws, meeting_id)
    return (await svc.present(db, ws, [m], now=now, with_history=True))[0]


@router.patch("/{meeting_id}", response_model=MeetingWriteOut)
async def change(
    meeting_id: UUID,
    body: MeetingUpdate,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> MeetingWriteOut:
    """Reschedule, edit, cancel (``status: cancelled``), mark a no-show or reopen. A done
    meeting cannot change (409 ``meeting_done``). ``note`` explains why on the timeline."""
    m = await svc.get(db, ws, meeting_id)
    changes = await _changes(db, ws, m, body)
    res = await svc.update(db, ws, m, changes, now=now, note=body.note)
    await db.commit()
    return await write_out(db, ws, res, now=now)


async def _changes(
    db: AsyncSession, ws: WorkspaceContext, m: Meeting, body: MeetingUpdate
) -> dict[str, object]:
    sent = body.model_fields_set
    out: dict[str, object] = {}
    if "starts_at" in sent and body.starts_at:
        out["starts_at"] = svc.parse_when(body.starts_at, ws, "starts_at")
    if "ends_at" in sent and body.ends_at:
        out["ends_at"] = svc.parse_when(body.ends_at, ws, "ends_at")
    if body.duration_minutes is not None:
        out["duration_minutes"] = body.duration_minutes
    for f in ("title", "location", "video_url", "agenda"):
        if f in sent:
            out[f] = getattr(body, f)
    if "round" in sent:
        out["round"] = await resolve_round(db, ws, body.round, required=False)
    if body.guest_ids is not None:
        primary = await investors_svc.get(db, ws, m.investor_id)
        out["guests"] = await svc.resolve_guests(db, ws, primary, body.guest_ids)
    if body.status is not None:
        out["status"] = body.status
    return out


@router.post("/{meeting_id}/complete", response_model=MeetingWriteOut)
async def complete(
    meeting_id: UUID,
    body: MeetingComplete,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> MeetingWriteOut:
    """Mark done with a quick outcome (logged as a ``meeting`` activity) and, optionally, the
    next step and follow-up for the investor's round. Repeating it changes nothing."""
    m = await svc.get(db, ws, meeting_id)
    res = await svc.complete(
        db,
        ws,
        m,
        now=now,
        outcome=body.outcome,
        next_step=body.next_step,
        follow_up_on=body.follow_up_on,
        follow_up_in_days=body.follow_up_in_days,
        follow_up_note=body.follow_up_note,
    )
    await db.commit()
    return await write_out(db, ws, res, now=now)


@router.delete("/{meeting_id}", status_code=204, response_class=Response)
async def remove(
    meeting_id: UUID,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """Delete a meeting entered by mistake (to call one off, cancel it instead: cancelled
    meetings keep their history). The timeline keeps a ``deleted`` entry."""
    m = await svc.get(db, ws, meeting_id)
    await svc.delete_meeting(db, ws, m, now=now)
    await db.commit()
    return Response(status_code=204)


@router.get(
    "/{meeting_id}/ics",
    response_class=Response,
    responses={200: {"content": {"text/calendar": {}}}},
)
async def ics(
    meeting_id: UUID,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """The meeting as an ``.ics`` file (open it to add the meeting to any calendar)."""
    m = await svc.get(db, ws, meeting_id)
    inv = await investors_svc.get(db, ws, m.investor_id)
    text = calendar([calendar_feed.event_for(m, inv, ws.slug, now=now)], method=True)
    return Response(
        content=text,
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="raisebook-meeting-{m.id}.ics"',
            "Cache-Control": "no-store",
        },
    )
