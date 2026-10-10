"""Workspace members (SPEC §5.4)."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api._out import member_out
from raisebook.api.deps import (
    WorkspaceContext,
    get_session,
    get_workspace_ctx,
)
from raisebook.schemas.common import ERROR_RESPONSES, DataList
from raisebook.schemas.members import MemberOut, MemberUpdate
from raisebook.services import members as members_svc

router = APIRouter(prefix="/v1/members", tags=["members"], responses=ERROR_RESPONSES)


@router.get("", response_model=DataList[MemberOut])
async def list_members(
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> DataList[MemberOut]:
    """Everyone in the workspace with their role (any scope or role)."""
    rows = await members_svc.list_members(db, ws)
    return DataList(data=[member_out(m, ws.principal.user_id) for m in rows])


@router.patch("/{user_id}", response_model=MemberOut)
async def change_role(
    user_id: UUID,
    body: MemberUpdate,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> MemberOut:
    """Change a member's role (owner, signed in). 409 ``last_owner`` when it would leave
    the workspace without an owner."""
    ws.principal.require_owner_session()
    m = await members_svc.change_role(db, ws, user_id, body.role)
    await db.commit()
    return member_out(m, ws.principal.user_id)


@router.delete("/{user_id}", status_code=204, response_class=Response)
async def remove_member(
    user_id: UUID,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> Response:
    """Remove a member (owner, signed in), or leave the workspace (your own user id).
    409 ``last_owner`` for the last owner."""
    p = ws.principal
    if not (p.is_session and p.user_id == user_id):
        p.require_owner_session()
    await members_svc.remove_member(db, ws, user_id)
    await db.commit()
    return Response(status_code=204)
