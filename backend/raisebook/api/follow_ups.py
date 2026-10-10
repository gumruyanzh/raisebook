"""Due follow-ups: ``GET /v1/follow-ups`` (SPEC §5.6). Owner: API+MCP (AM)."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import WorkspaceContext, get_now, get_session, get_workspace_ctx
from raisebook.core.refs import resolve_round
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.schemas.participants import FollowUpList
from raisebook.services.followups import list_due

router = APIRouter(prefix="/v1/follow-ups", tags=["follow-ups"], responses=ERROR_RESPONSES)


@router.get("", response_model=FollowUpList)
async def due_follow_ups(
    round: str | None = Query(None, max_length=200),
    within_days: int = Query(0, ge=0, le=60),
    include_overdue: bool = True,
    limit: int = Query(50, ge=1, le=200),
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> FollowUpList:
    """Overdue first, then today, then the next ``within_days`` days. Without ``round``,
    every open round."""
    rnd = await resolve_round(db, ws, round, required=False)
    return await list_due(
        db,
        ws,
        now=now,
        round_id=rnd.id if rnd else None,
        within_days=within_days,
        include_overdue=include_overdue,
        limit=limit,
    )
