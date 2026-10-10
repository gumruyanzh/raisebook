"""The activity timeline: ``/v1/activities`` (SPEC §5.7, §8.1). Owner: API+MCP (AM).

Activities are append-only. Manual kinds (note, email, call, meeting) can be logged and
deleted (owner: any; editor: own; key: own key); system kinds cannot be deleted.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import (
    WorkspaceContext,
    get_now,
    get_session,
    get_workspace_ctx,
    get_write_ctx,
)
from raisebook.core.errors import ValidationFailed
from raisebook.core.refs import resolve_round
from raisebook.schemas.activities import ActivityCreate, ActivityCreated, ActivityPage
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.services import activities as act_svc
from raisebook.services import investors as investors_svc

router = APIRouter(prefix="/v1/activities", tags=["activities"], responses=ERROR_RESPONSES)


@router.get("", response_model=ActivityPage)
async def list_activities(
    investor_id: UUID | None = None,
    round: str | None = Query(None, max_length=200),
    kind: list[str] | None = Query(None),
    actor_type: Literal["user", "agent", "system"] | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = None,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> ActivityPage:
    """Timeline entries, newest ``occurred_at`` first, with who did what."""
    if investor_id is not None:
        await investors_svc.get(db, ws, investor_id)  # 404 for other workspaces
    rnd = await resolve_round(db, ws, round, required=False)
    rows, nxt = await act_svc.list_activities(
        db,
        ws,
        limit=limit,
        cursor=cursor,
        investor_id=investor_id,
        round_id=rnd.id if rnd else None,
        kinds=kind,
        actor_type=actor_type,
        since=since,
        until=until,
    )
    return ActivityPage(data=await act_svc.present(db, ws, rows), next_cursor=nxt)


@router.post("", status_code=201, response_model=ActivityCreated)
async def log_activity(
    body: ActivityCreate,
    response: Response,
    idempotency_key: str | None = Header(None, alias="Idempotency-Key", max_length=200),
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> ActivityCreated:
    """Log a note, email, call or meeting. A repeated ``idempotency_key`` (or
    ``Idempotency-Key`` header) returns the earlier activity with ``duplicate: true``."""
    key = body.idempotency_key or idempotency_key
    if body.idempotency_key and idempotency_key and body.idempotency_key != idempotency_key:
        raise ValidationFailed(
            "idempotency_key", "idempotency_key and the Idempotency-Key header differ."
        )
    inv = await investors_svc.get(db, ws, body.investor_id)
    rnd = await resolve_round(db, ws, body.round, required=False)
    row, duplicate = await act_svc.log_manual(
        db,
        ws,
        investor=inv,
        kind=body.kind,
        body=body.body,
        now=now,
        occurred_at=act_svc.parse_occurred_at(body.occurred_at, ws),
        round_id=rnd.id if rnd else None,
        direction=body.direction,
        idempotency_key=key,
    )
    await db.commit()
    if duplicate:
        response.status_code = 200
    out = (await act_svc.present(db, ws, [row]))[0]
    return ActivityCreated(**out.model_dump(), duplicate=duplicate)


@router.delete("/{activity_id}", status_code=204, response_class=Response)
async def delete_activity(
    activity_id: UUID,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
) -> Response:
    """Delete a manual entry (409 ``not_deletable`` for system entries)."""
    await act_svc.delete_activity(db, ws, activity_id)
    await db.commit()
    return Response(status_code=204)
