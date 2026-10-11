"""Invites: owners invite co-founders and advisors by email (SPEC §5.4).

The invite link is ``${RAISEBOOK_APP_URL}/invite/<token>`` (only sha256 stored,
7-day expiry). A new invite to the same email replaces the pending one. The
member limit counts pending invites. Accepting requires a session whose email
matches the invite (409 ``invite_mismatch``).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import ColumnElement, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.magic_link import hash_token, new_token, normalize_email
from raisebook.auth.principal import WorkspaceContext
from raisebook.config import get_settings
from raisebook.core import ratelimit
from raisebook.core.errors import (
    AlreadyMember,
    InvalidToken,
    InviteMismatch,
    LimitReached,
    NotFound,
    ValidationFailed,
)
from raisebook.models.user import User
from raisebook.models.workspace import Invite, Membership, Workspace
from raisebook.services.members import parse_role
from raisebook.services.users import display_name
from raisebook.services.workspaces import LIMITS, member_count


@dataclass(frozen=True)
class CreatedInvite:
    invite: Invite
    raw_token: str
    link: str


def invite_url(raw_token: str) -> str:
    return f"{get_settings().app_url.rstrip('/')}/invite/{raw_token}"


def invite_status(inv: Invite, now: datetime) -> str:
    if inv.revoked_at is not None:
        return "revoked"
    if inv.accepted_at is not None:
        return "accepted"
    if inv.expires_at <= now:
        return "expired"
    return "pending"


def email_hint(email: str) -> str:
    local, _, domain = email.partition("@")
    return f"{local[:1]}***@{domain}"


def _pending(workspace_id: UUID) -> list[ColumnElement[bool]]:
    return [
        Invite.workspace_id == workspace_id,
        Invite.accepted_at.is_(None),
        Invite.revoked_at.is_(None),
    ]


async def pending_count(db: AsyncSession, workspace_id: UUID, *, now: datetime) -> int:
    n = await db.scalar(
        select(func.count())
        .select_from(Invite)
        .where(*_pending(workspace_id), Invite.expires_at > now)
    )
    return int(n or 0)


async def create_invite(
    db: AsyncSession, ws: WorkspaceContext, *, email: str, role: str, now: datetime
) -> CreatedInvite:
    addr = normalize_email(email)
    if addr is None:
        raise ValidationFailed("email", "Enter a valid email address.")
    parsed_role = parse_role(role)
    existing_member = await db.scalar(
        select(Membership.user_id)
        .join(User, User.id == Membership.user_id)
        .where(Membership.workspace_id == ws.workspace_id, User.email == addr)
    )
    if existing_member is not None:
        raise AlreadyMember(
            f"{addr} is already a member of this workspace. Change their role instead.",
            details={"user_id": str(existing_member)},
        )
    # Replace a pending invite for the same address (it no longer counts toward the limit).
    await db.execute(
        update(Invite)
        .where(*_pending(ws.workspace_id), Invite.email == addr)
        .values(revoked_at=now)
    )
    used = await member_count(db, ws.workspace_id) + await pending_count(
        db, ws.workspace_id, now=now
    )
    if used >= LIMITS["members"]:
        raise LimitReached(
            f"A workspace can have {LIMITS['members']} members including pending invites. "
            "Remove a member or revoke an invite first.",
            details={"limit": LIMITS["members"]},
        )
    await ratelimit.enforce("invite", str(ws.workspace_id), now=now)
    inviter_id = ws.principal.user_id
    if inviter_id is not None:
        # Per person across every workspace, so creating workspaces in a loop does not
        # multiply the per-workspace allowance; brand-new accounts get a tighter cap.
        await ratelimit.enforce("invite_user", str(inviter_id), now=now)
        joined = await db.scalar(select(User.created_at).where(User.id == inviter_id))
        if joined is not None and now - joined < timedelta(hours=24):
            await ratelimit.enforce("invite_user_new", str(inviter_id), now=now)
    raw, digest = new_token()
    inv = Invite(
        workspace_id=ws.workspace_id,
        email=addr,
        role=parsed_role.value,
        token_hash=digest,
        invited_by_user_id=ws.principal.user_id,
        created_at=now,
        expires_at=now + timedelta(days=get_settings().invite_ttl_days),
    )
    db.add(inv)
    await db.flush()
    return CreatedInvite(inv, raw, invite_url(raw))


async def list_invites(db: AsyncSession, ws: WorkspaceContext) -> list[Invite]:
    return list(
        await db.scalars(
            select(Invite)
            .where(Invite.workspace_id == ws.workspace_id)
            .order_by(Invite.created_at.desc())
            .limit(200)
        )
    )


async def revoke_invite(
    db: AsyncSession, ws: WorkspaceContext, invite_id: UUID, *, now: datetime
) -> None:
    inv = await db.scalar(
        select(Invite).where(Invite.id == invite_id, Invite.workspace_id == ws.workspace_id)
    )
    if inv is None:
        raise NotFound("Invite not found in this workspace.")
    if inv.revoked_at is None and inv.accepted_at is None:
        inv.revoked_at = now
        await db.flush()


async def find_by_token(db: AsyncSession, raw_token: str) -> Invite | None:
    if not raw_token or len(raw_token) > 200:
        return None
    inv: Invite | None = await db.scalar(
        select(Invite).where(Invite.token_hash == hash_token(raw_token))
    )
    return inv


@dataclass(frozen=True)
class InviteLookup:
    workspace_name: str
    inviter_name: str | None
    email_hint: str
    role: str
    expired: bool


async def lookup(db: AsyncSession, raw_token: str, *, now: datetime) -> InviteLookup:
    inv = await find_by_token(db, raw_token)
    if inv is None or inv.revoked_at is not None or inv.accepted_at is not None:
        raise NotFound("This invite link is not valid. Ask the workspace owner for a new one.")
    ws = await db.get(Workspace, inv.workspace_id)
    assert ws is not None
    inviter = await db.get(User, inv.invited_by_user_id) if inv.invited_by_user_id else None
    return InviteLookup(
        workspace_name=ws.name,
        inviter_name=display_name(inviter) if inviter else None,
        email_hint=email_hint(str(inv.email)),
        role=inv.role,
        expired=inv.expires_at <= now,
    )


async def accept_invite_row(
    db: AsyncSession, inv: Invite, user: User, *, now: datetime
) -> Workspace:
    """Accept a loaded invite for ``user`` (emails must match). Idempotent for members."""
    if inv.revoked_at is not None or inv.accepted_at is not None or inv.expires_at <= now:
        raise InvalidToken("This invite is no longer valid. Ask the workspace owner for a new one.")
    if str(inv.email).lower() != str(user.email).lower():
        raise InviteMismatch(
            f"This invite is for {email_hint(str(inv.email))}. Sign in with that address.",
            details={"email_hint": email_hint(str(inv.email))},
        )
    existing = await db.get(Membership, (inv.workspace_id, user.id))
    if existing is None:
        db.add(
            Membership(
                workspace_id=inv.workspace_id, user_id=user.id, role=inv.role, created_at=now
            )
        )
    inv.accepted_at = now
    inv.accepted_by_user_id = user.id
    await db.flush()
    ws = await db.get(Workspace, inv.workspace_id)
    assert ws is not None
    return ws


async def accept_invite(
    db: AsyncSession, user: User, raw_token: str, *, now: datetime
) -> Workspace:
    inv = await find_by_token(db, raw_token)
    if inv is None:
        raise InvalidToken("This invite link is not valid. Ask the workspace owner for a new one.")
    return await accept_invite_row(db, inv, user, now=now)
