"""Rounds and stages: ``/v1/rounds`` (SPEC §5.5). Owner: API+MCP (AM).

``{round}`` in paths is a round id or slug (a name works too). A round from another
workspace is 404. The export route lives in ``api/exports.py`` (IE).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import (
    WorkspaceContext,
    get_now,
    get_session,
    get_workspace_ctx,
    get_write_ctx,
    workspace_ctx,
)
from raisebook.auth.scopes import SCOPE_ADMIN, SCOPE_WRITE
from raisebook.core.refs import resolve_round
from raisebook.models.round import Round
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.schemas.participants import RoundSummaryOut
from raisebook.schemas.rounds import (
    RoundCreate,
    RoundDelete,
    RoundList,
    RoundOut,
    RoundUpdate,
    StagesReplace,
)
from raisebook.services import rounds as rounds_svc
from raisebook.services import stages as stages_svc
from raisebook.services.summary import round_summary

router = APIRouter(prefix="/v1/rounds", tags=["rounds"], responses=ERROR_RESPONSES)


async def load_round(db: AsyncSession, ws: WorkspaceContext, ref: str) -> Round:
    rnd = await resolve_round(db, ws, ref, required=True)
    assert rnd is not None
    return rnd


@router.get("", response_model=RoundList)
async def list_rounds(
    status: Literal["open", "closed", "all"] = "all",
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> RoundList:
    """Rounds, open first, then by creation date."""
    rows = await rounds_svc.list_rounds(db, ws, status=status)
    return RoundList(data=await rounds_svc.present(db, ws, rows))


@router.post("", status_code=201, response_model=RoundOut)
async def create_round(
    body: RoundCreate,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> RoundOut:
    """Create a round with the default stages (or ``stages``). 409 ``duplicate`` with
    ``details.existing`` when a round with this name exists (treat it as idempotent)."""
    data = body.model_dump(exclude_unset=True)
    if body.stages is not None:
        data["stages"] = body.stages
    rnd = await rounds_svc.create_round(db, ws, data, now=now)
    await db.commit()
    return await rounds_svc.present_one(db, ws, rnd)


@router.get("/{round}", response_model=RoundOut)
async def get_round(
    round: str,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> RoundOut:
    """A round with its stages (each with its participant ``count``)."""
    rnd = await load_round(db, ws, round)
    return await rounds_svc.present_one(db, ws, rnd)


@router.patch("/{round}", response_model=RoundOut)
async def update_round(
    round: str,
    body: RoundUpdate,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> RoundOut:
    """Change terms, rename, or close/reopen (closing sets ``closed_on`` to today)."""
    rnd = await load_round(db, ws, round)
    await rounds_svc.update_round(db, ws, rnd, body.model_dump(exclude_unset=True), now=now)
    await db.commit()
    return await rounds_svc.present_one(db, ws, rnd)


@router.delete("/{round}", status_code=204, response_class=Response)
async def delete_round(
    round: str,
    body: RoundDelete,
    ws: WorkspaceContext = Depends(workspace_ctx(SCOPE_WRITE, SCOPE_ADMIN)),
    db: AsyncSession = Depends(get_session),
) -> Response:
    """Delete the round permanently (admin). Send ``{"confirm": "<round name or slug>"}``."""
    rnd = await load_round(db, ws, round)
    await rounds_svc.delete_round(db, ws, rnd, confirm=body.confirm)
    await db.commit()
    return Response(status_code=204)


@router.put("/{round}/stages", response_model=RoundOut)
async def replace_stages(
    round: str,
    body: StagesReplace,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> RoundOut:
    """Replace the ordered stage list. Stages are matched by ``key``; a removed stage with
    investors needs ``reassign: {"<removed_key>": "<target_key>"}`` (409 ``stage_in_use``)."""
    rnd = await load_round(db, ws, round)
    await stages_svc.replace_stages(db, ws, rnd, body.stages, reassign=body.reassign, now=now)
    await db.commit()
    return await rounds_svc.present_one(db, ws, rnd)


@router.get("/{round}/summary", response_model=RoundSummaryOut)
async def get_summary(
    round: str,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> RoundSummaryOut:
    """Committed vs target, funnel, follow-ups, stale conversations, recent activity."""
    rnd = await load_round(db, ws, round)
    return await round_summary(db, ws, rnd, now=now)
