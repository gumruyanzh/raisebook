"""API keys (SPEC §4.4, §5.4). Created and revoked only by an owner signed in to the web."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api._out import api_key_out
from raisebook.api.deps import (
    WorkspaceContext,
    get_now,
    get_session,
    workspace_ctx,
)
from raisebook.auth.scopes import SCOPE_ADMIN, SCOPE_WRITE
from raisebook.schemas.api_keys import ApiKeyCreate, ApiKeyCreated, ApiKeyOut
from raisebook.schemas.common import ERROR_RESPONSES, DataList
from raisebook.services import api_keys as keys_svc
from raisebook.services.users import display_names

router = APIRouter(prefix="/v1/api-keys", tags=["api keys"], responses=ERROR_RESPONSES)


@router.get("", response_model=DataList[ApiKeyOut])
async def list_api_keys(
    ws: WorkspaceContext = Depends(workspace_ctx(SCOPE_WRITE, SCOPE_ADMIN)),
    db: AsyncSession = Depends(get_session),
) -> DataList[ApiKeyOut]:
    """Keys of this workspace, newest first (admin). Secrets are never shown again."""
    rows = await keys_svc.list_api_keys(db, ws)
    names = await display_names(db, [k.created_by_user_id for k in rows])
    return DataList(data=[api_key_out(k, names) for k in rows])


@router.post("", status_code=201, response_model=ApiKeyCreated)
async def create_api_key(
    body: ApiKeyCreate,
    ws: WorkspaceContext = Depends(workspace_ctx()),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> ApiKeyCreated:
    """Create a key (owner, signed in). ``secret`` is returned once: store it now.

    Scopes: ``raisebook:read`` is always included; ``raisebook:admin`` requires
    ``raisebook:write``. ``agent_name`` labels what this key's agent does on timelines.
    """
    ws.principal.require_owner_session()
    created = await keys_svc.create_for_workspace(
        db,
        ws,
        name=body.name,
        scopes=body.scopes,
        now=now,
        agent_name=body.agent_name,
        expires_at=body.expires_at,
    )
    await db.commit()
    names = await display_names(db, [created.key.created_by_user_id])
    return ApiKeyCreated(api_key=api_key_out(created.key, names), secret=created.secret)


@router.delete("/{key_id}", status_code=204, response_class=Response)
async def revoke_api_key(
    key_id: UUID,
    ws: WorkspaceContext = Depends(workspace_ctx()),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """Revoke a key immediately (owner, signed in)."""
    ws.principal.require_owner_session()
    await keys_svc.revoke_api_key(db, ws.workspace_id, key_id, now=now)
    await db.commit()
    return Response(status_code=204)
