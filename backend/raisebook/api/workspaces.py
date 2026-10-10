"""Workspaces (SPEC §5.4).

- ``GET/POST /v1/workspaces``: the signed-in user's workspaces (session only).
- ``GET/PATCH/DELETE /v1/workspace``: the caller's current workspace (key or session
  with ``X-Workspace``).
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api._out import workspace_detail_out, workspace_out
from raisebook.api.deps import (
    Principal,
    SessionUser,
    WorkspaceContext,
    get_now,
    get_session,
    get_session_user,
    get_workspace_ctx,
    require_owner_session,
    workspace_ctx,
)
from raisebook.auth.principal import user_workspaces
from raisebook.auth.scopes import SCOPE_ADMIN, SCOPE_WRITE
from raisebook.models.enums import Role
from raisebook.schemas.common import ERROR_RESPONSES, DataList
from raisebook.schemas.workspaces import (
    WorkspaceCreate,
    WorkspaceDelete,
    WorkspaceDetailOut,
    WorkspaceOut,
    WorkspaceUpdate,
)
from raisebook.services import deletion
from raisebook.services import workspaces as ws_svc

router = APIRouter(prefix="/v1", tags=["workspaces"], responses=ERROR_RESPONSES)


@router.get("/workspaces", response_model=DataList[WorkspaceOut])
async def list_workspaces(
    su: SessionUser = Depends(get_session_user),
    db: AsyncSession = Depends(get_session),
) -> DataList[WorkspaceOut]:
    """Your workspaces, with your role in each."""
    return DataList(data=[workspace_out(ws, r) for ws, r in await user_workspaces(db, su.user.id)])


@router.post("/workspaces", status_code=201, response_model=WorkspaceOut)
async def create_workspace(
    body: WorkspaceCreate,
    su: SessionUser = Depends(get_session_user),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> WorkspaceOut:
    """Create a workspace (you become its owner). ``sample: true`` creates the fictional
    sandbox workspace "Kestrel Robotics (sample)" instead."""
    ws = await ws_svc.create_workspace(
        db,
        user=su.user,
        name=body.name,
        now=now,
        timezone=body.timezone,
        default_currency=body.default_currency,
        sample=body.sample,
    )
    await db.commit()
    return workspace_out(ws, Role.OWNER)


@router.get("/workspace", response_model=WorkspaceDetailOut)
async def get_workspace(
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> WorkspaceDetailOut:
    """The current workspace, who you are in it (scopes, role or agent name) and limits."""
    row = await ws_svc.get_workspace(db, ws)
    return workspace_detail_out(row, ws.principal)


@router.patch("/workspace", response_model=WorkspaceDetailOut)
async def update_workspace(
    body: WorkspaceUpdate,
    ws: WorkspaceContext = Depends(workspace_ctx(SCOPE_WRITE, SCOPE_ADMIN)),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> WorkspaceDetailOut:
    """Rename the workspace or change its timezone or default currency (admin)."""
    changes = body.model_dump(include=body.model_fields_set)
    row = await ws_svc.update_workspace(db, ws, changes, now=now)
    await db.commit()
    return workspace_detail_out(row, ws.principal)


@router.delete("/workspace", status_code=204, response_class=Response)
async def delete_workspace(
    body: WorkspaceDelete,
    principal: Principal = Depends(require_owner_session()),
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> Response:
    """Delete the workspace and everything in it, permanently (owner, signed in).
    Send ``{"confirm": "<workspace slug>"}``; 422 ``confirmation_required`` otherwise."""
    await deletion.delete_workspace(db, ws, confirm=body.confirm)
    await db.commit()
    return Response(status_code=204)
