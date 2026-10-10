"""Invites (SPEC §5.4): owners invite people by email; invitees accept after signing in."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api._out import invite_out, workspace_out
from raisebook.api.deps import (
    SessionUser,
    WorkspaceContext,
    get_email_sender,
    get_now,
    get_session,
    get_session_user,
    rate_limit,
    workspace_ctx,
)
from raisebook.auth.scopes import SCOPE_ADMIN, SCOPE_WRITE
from raisebook.config import get_settings
from raisebook.models.user import User
from raisebook.schemas.common import ERROR_RESPONSES, DataList
from raisebook.schemas.members import (
    InviteAccept,
    InviteCreate,
    InviteCreatedOut,
    InviteLookupOut,
    InviteOut,
)
from raisebook.schemas.workspaces import WorkspaceOut
from raisebook.services import invites as invites_svc
from raisebook.services.email import EmailSender, invite_email
from raisebook.services.users import display_name, display_names
from raisebook.services.workspaces import role_of

router = APIRouter(prefix="/v1/invites", tags=["members"], responses=ERROR_RESPONSES)


@router.get("", response_model=DataList[InviteOut])
async def list_invites(
    ws: WorkspaceContext = Depends(workspace_ctx(SCOPE_WRITE, SCOPE_ADMIN)),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> DataList[InviteOut]:
    """Invites of this workspace, newest first, with their status (admin)."""
    rows = await invites_svc.list_invites(db, ws)
    names = await display_names(db, [r.invited_by_user_id for r in rows])
    return DataList(data=[invite_out(r, now, names) for r in rows])


@router.post("", status_code=201, response_model=InviteCreatedOut, response_model_exclude_none=True)
async def create_invite(
    body: InviteCreate,
    ws: WorkspaceContext = Depends(workspace_ctx()),
    db: AsyncSession = Depends(get_session),
    sender: EmailSender = Depends(get_email_sender),
    now: datetime = Depends(get_now),
) -> InviteCreatedOut:
    """Invite someone by email as owner, editor or viewer (owner, signed in).

    A pending invite for the same address is replaced. 409 ``already_member``; 422
    ``limit_reached`` at 20 members including pending invites.
    """
    ws.principal.require_owner_session()
    created = await invites_svc.create_invite(db, ws, email=body.email, role=body.role, now=now)
    await db.commit()
    inviter = await db.get(User, ws.principal.user_id) if ws.principal.user_id else None
    s = get_settings()
    await sender.send(
        invite_email(
            str(created.invite.email),
            created.link,
            workspace_name=ws.name,
            inviter=display_name(inviter) if inviter else None,
            role=created.invite.role,
            ttl_days=s.invite_ttl_days,
        )
    )
    names = {inviter.id: display_name(inviter)} if inviter else {}
    out = invite_out(created.invite, now, names)
    return InviteCreatedOut(
        **out.model_dump(), dev_link=created.link if s.echo_magic_links else None
    )


@router.delete("/{invite_id}", status_code=204, response_class=Response)
async def revoke_invite(
    invite_id: UUID,
    ws: WorkspaceContext = Depends(workspace_ctx()),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """Revoke a pending invite (owner, signed in)."""
    ws.principal.require_owner_session()
    await invites_svc.revoke_invite(db, ws, invite_id, now=now)
    await db.commit()
    return Response(status_code=204)


@router.get(
    "/lookup", response_model=InviteLookupOut, dependencies=[Depends(rate_limit("anon_ip"))]
)
async def lookup_invite(
    token: str = Query(..., min_length=1, max_length=200),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> InviteLookupOut:
    """What an invite link is for (no sign-in needed). The email is only hinted."""
    info = await invites_svc.lookup(db, token, now=now)
    return InviteLookupOut(
        workspace_name=info.workspace_name,
        inviter_name=info.inviter_name,
        email_hint=info.email_hint,
        role=info.role,
        expired=info.expired,
    )


@router.post("/accept", response_model=WorkspaceOut)
async def accept_invite(
    body: InviteAccept,
    su: SessionUser = Depends(get_session_user),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> WorkspaceOut:
    """Join the workspace of an invite. 409 ``invite_mismatch`` when you are signed in
    with a different email than the invite's."""
    ws = await invites_svc.accept_invite(db, su.user, body.token, now=now)
    await db.commit()
    return workspace_out(ws, await role_of(db, ws.id, su.user.id))
