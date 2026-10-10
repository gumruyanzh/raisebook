"""The signed-in account: ``/v1/me`` (session only), SPEC §5.4."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import SessionUser, get_now, get_session, get_session_user
from raisebook.auth.session import clear_session_cookies
from raisebook.schemas.auth import DeleteMeRequest, MeOut, MeUpdate
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.services import deletion
from raisebook.services.users import update_profile

router = APIRouter(prefix="/v1/me", tags=["account"], responses=ERROR_RESPONSES)


@router.get("", response_model=MeOut)
async def get_me(su: SessionUser = Depends(get_session_user)) -> MeOut:
    return MeOut.model_validate(su.user)


@router.patch("", response_model=MeOut)
async def update_me(
    body: MeUpdate,
    su: SessionUser = Depends(get_session_user),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> MeOut:
    """Change your display name (``null`` or empty clears it)."""
    if "name" in body.model_fields_set:
        await update_profile(db, su.user, name=body.name, now=now)
        await db.commit()
    return MeOut.model_validate(su.user)


@router.delete("", status_code=204, response_class=Response)
async def delete_me(
    body: DeleteMeRequest,
    su: SessionUser = Depends(get_session_user),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """Delete your account permanently, effective immediately.

    Workspaces where you are the only member are deleted with everything in them.
    409 ``transfer_ownership_first`` if you are the only owner of a workspace that has
    other members (``details.workspaces`` lists them).
    """
    await deletion.delete_account(db, su.user, confirm_email=body.confirm_email, now=now)
    await db.commit()
    resp = Response(status_code=204)
    clear_session_cookies(resp)
    return resp
