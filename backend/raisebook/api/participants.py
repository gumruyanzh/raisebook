"""Participants: an investor in a round, ``/v1/rounds/{round}/participants`` (SPEC §5.6).

Owner: API+MCP (AM). Participants are addressed by ``investor_id``. ``stage`` input
accepts a stage key or label (case-insensitive); an unknown stage is 422
``stage_not_found`` with ``details.valid``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import (
    WorkspaceContext,
    get_now,
    get_session,
    get_workspace_ctx,
    get_write_ctx,
)
from raisebook.api.rounds import load_round
from raisebook.core.refs import resolve_stage
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.schemas.participants import (
    BulkAdd,
    BulkAddOut,
    CommitmentIn,
    CommitmentOut,
    FollowUpSet,
    FollowUpSetOut,
    ParticipantCreate,
    ParticipantCreated,
    ParticipantOut,
    ParticipantPage,
    ParticipantUpdate,
    StageMove,
    StageMoveOut,
)
from raisebook.services import investors as investors_svc
from raisebook.services import participants as parts_svc
from raisebook.services.stages import stage_out, stages_for

router = APIRouter(prefix="/v1/rounds", tags=["participants"], responses=ERROR_RESPONSES)

SortName = Literal["fit", "name", "firm", "stage", "follow_up", "updated", "amount"]


@router.get("/{round}/participants", response_model=ParticipantPage)
async def list_participants(
    round: str,
    q: str | None = Query(None, max_length=200),
    stage: list[str] | None = Query(None),
    fit_min: int | None = Query(None, ge=0, le=5),
    type: str | None = Query(None, max_length=40),
    tag: list[str] | None = Query(None),
    industry: list[str] | None = Query(None),
    follow_up: Literal["due", "week", "none"] | None = None,
    owner: str | None = Query(None, max_length=40),
    sort: SortName = "fit",
    order: Literal["asc", "desc"] | None = None,
    limit: int = Query(50, ge=1, le=1000),
    cursor: str | None = None,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> ParticipantPage:
    """The round's investors with stage, fit, follow-up and amounts (filter, sort, page)."""
    rnd = await load_round(db, ws, round)
    stages = await stages_for(db, ws, rnd.id)
    picked = [resolve_stage(stages, s) for s in stage] if stage else None
    rows, nxt, total = await parts_svc.list_participants(
        db,
        ws,
        rnd,
        now=now,
        limit=limit,
        cursor=cursor,
        q=q,
        stages=picked,
        fit_min=fit_min,
        type_=type,
        tags=tag,
        industries=industry,
        follow_up=follow_up,
        owner=owner,
        sort=sort,
        order=order,
    )
    return ParticipantPage(
        data=await parts_svc.present(db, ws, rows, now=now), next_cursor=nxt, total=total
    )


@router.post("/{round}/participants", status_code=201, response_model=ParticipantCreated)
async def add_participant(
    round: str,
    body: ParticipantCreate,
    response: Response,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> ParticipantCreated:
    """Put an investor on the round (201), or apply the given fields if already there (200)."""
    rnd = await load_round(db, ws, round)
    inv = await investors_svc.get(db, ws, body.investor_id)
    changes = body.model_dump(exclude_unset=True, exclude={"investor_id"})
    res = await parts_svc.upsert(db, ws, rnd, inv, changes, now=now)
    await db.commit()
    out = await parts_svc.present_one(db, ws, res.participant, now=now)
    if not res.created:
        response.status_code = 200
    return ParticipantCreated(**out.model_dump(), created=res.created)


@router.post("/{round}/participants/bulk", response_model=BulkAddOut)
async def bulk_add(
    round: str,
    body: BulkAdd,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> BulkAddOut:
    """Add up to 500 investors at once (``stage`` or the first stage)."""
    rnd = await load_round(db, ws, round)
    added, already = await parts_svc.bulk_add(
        db, ws, rnd, body.investor_ids, stage=body.stage, now=now
    )
    await db.commit()
    return BulkAddOut(added=added, already=already)


@router.get("/{round}/participants/{investor_id}", response_model=ParticipantOut)
async def get_participant(
    round: str,
    investor_id: UUID,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> ParticipantOut:
    rnd = await load_round(db, ws, round)
    inv = await investors_svc.get(db, ws, investor_id)
    part = await parts_svc.require_participant(db, ws, rnd, inv)
    return await parts_svc.present_one(db, ws, part, now=now)


@router.patch("/{round}/participants/{investor_id}", response_model=ParticipantOut)
async def update_participant(
    round: str,
    investor_id: UUID,
    body: ParticipantUpdate,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> ParticipantOut:
    """Change round fields; one activity per change type. ``note`` goes on the stage change."""
    rnd = await load_round(db, ws, round)
    inv = await investors_svc.get(db, ws, investor_id)
    part = await parts_svc.require_participant(db, ws, rnd, inv)
    changes = body.model_dump(exclude_unset=True, exclude={"note"})
    stages = await stages_for(db, ws, rnd.id)
    await parts_svc.apply_changes(db, ws, rnd, part, stages, changes, now=now, note=body.note)
    await db.commit()
    return await parts_svc.present_one(db, ws, part, now=now)


@router.post("/{round}/participants/{investor_id}/stage", response_model=StageMoveOut)
async def move_stage(
    round: str,
    investor_id: UUID,
    body: StageMove,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> JSONResponse:
    """Move to another stage (the current stage is a no-op with ``changed: false``)."""
    rnd = await load_round(db, ws, round)
    inv = await investors_svc.get(db, ws, investor_id)
    res = await parts_svc.move_stage(db, ws, rnd, inv, body.stage, note=body.note, now=now)
    await db.commit()
    out = StageMoveOut(
        participant=await parts_svc.present_one(db, ws, res.participant, now=now),
        changed=res.changed,
        from_=stage_out(res.from_stage),
        to=stage_out(res.to_stage),
    )
    return JSONResponse(out.model_dump(mode="json", by_alias=True))


@router.post("/{round}/participants/{investor_id}/follow-up", response_model=FollowUpSetOut)
async def set_follow_up(
    round: str,
    investor_id: UUID,
    body: FollowUpSet,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> FollowUpSetOut:
    """Set (``on`` or ``in_days``) or ``clear`` the follow-up date; exactly one of them."""
    rnd = await load_round(db, ws, round)
    inv = await investors_svc.get(db, ws, investor_id)
    part, changed = await parts_svc.set_follow_up(
        db,
        ws,
        rnd,
        inv,
        on=body.on,
        in_days=body.in_days,
        clear=body.clear,
        note=body.note,
        now=now,
    )
    await db.commit()
    return FollowUpSetOut(
        participant=await parts_svc.present_one(db, ws, part, now=now), changed=changed
    )


@router.post("/{round}/participants/{investor_id}/commitment", response_model=CommitmentOut)
async def record_commitment(
    round: str,
    investor_id: UUID,
    body: CommitmentIn,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> CommitmentOut:
    """Set the total committed amount (replaces; 0 clears) and, by default, move to won."""
    rnd = await load_round(db, ws, round)
    inv = await investors_svc.get(db, ws, investor_id)
    res = await parts_svc.record_commitment(
        db,
        ws,
        rnd,
        inv,
        amount=body.amount,
        committed_on=body.committed_on,
        note=body.note,
        move_to_won=body.move_to_won,
        now=now,
    )
    await db.commit()
    return CommitmentOut(
        participant=await parts_svc.present_one(db, ws, res.participant, now=now),
        previous_amount=res.previous_amount,
        moved_stage=res.moved_stage,
        round_committed_total=res.round_committed_total,
    )


@router.delete("/{round}/participants/{investor_id}", status_code=204, response_class=Response)
async def remove_participant(
    round: str,
    investor_id: UUID,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """Take the investor off this round (the contact and its timeline stay)."""
    rnd = await load_round(db, ws, round)
    inv = await investors_svc.get(db, ws, investor_id)
    await parts_svc.remove(db, ws, rnd, inv, now=now)
    await db.commit()
    return Response(status_code=204)
