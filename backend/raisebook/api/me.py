"""The signed-in account: ``/v1/me`` (session only), SPEC §5.4."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import SessionUser, get_now, get_session, get_session_user
from raisebook.auth.session import (
    absolute_expiry,
    clear_session_cookies,
    list_user_sessions,
    revoke_other_sessions,
    revoke_user_session,
)
from raisebook.core.errors import NotFound
from raisebook.schemas.auth import DeleteMeRequest, MeOut, MeUpdate, SessionInfoOut
from raisebook.schemas.common import ERROR_RESPONSES, DataList
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


@router.get("/sessions", response_model=DataList[SessionInfoOut])
async def list_sessions(
    su: SessionUser = Depends(get_session_user),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> DataList[SessionInfoOut]:
    """Your signed-in browsers (most recently used first). ``current`` marks this one.
    A session ends after 30 days without use, or 90 days after sign-in at the latest."""
    rows = await list_user_sessions(db, su.user.id, now=now)
    return DataList(
        data=[
            SessionInfoOut(
                id=r.id,
                created_at=r.created_at,
                last_seen_at=r.last_seen_at,
                expires_at=min(r.expires_at, absolute_expiry(r.created_at)),
                user_agent=r.user_agent,
                ip=str(r.ip) if r.ip is not None else None,
                current=r.id == su.session.id,
            )
            for r in rows
        ]
    )


@router.delete("/sessions/{session_id}", status_code=204, response_class=Response)
async def end_session(
    session_id: UUID,
    su: SessionUser = Depends(get_session_user),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """Sign out one of your sessions. Ending the current one also clears its cookies."""
    if not await revoke_user_session(db, su.user.id, session_id, now=now):
        raise NotFound("Session not found.")
    await db.commit()
    resp = Response(status_code=204)
    if session_id == su.session.id:
        clear_session_cookies(resp)
    return resp


@router.post("/sessions/revoke-others", status_code=204, response_class=Response)
async def end_other_sessions(
    su: SessionUser = Depends(get_session_user),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """Sign out every other browser; this one stays signed in."""
    await revoke_other_sessions(db, su.user.id, su.session.id, now=now)
    await db.commit()
    return Response(status_code=204)
