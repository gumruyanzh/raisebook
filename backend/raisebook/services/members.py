"""Members: list, change role, remove or leave (SPEC §3.1, §5.4).

A workspace always keeps at least one owner (409 ``last_owner``). Removing a
member clears them as owner of round participants (``ON DELETE SET NULL``).

API keys belong to the workspace but are tied to the person who created them:
removing a member, demoting an owner (only owners hold keys), or deleting an
account revokes every active key that person created, in the same transaction.
Otherwise someone who saw a secret once could keep using it after losing access.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.clock import get_now
from raisebook.core.errors import LastOwner, NotFound, ValidationFailed
from raisebook.models.enums import Role
from raisebook.models.user import User
from raisebook.models.workspace import ApiKey, Membership


@dataclass(frozen=True)
class MemberRow:
    user_id: UUID
    email: str
    name: str | None
    role: str
    joined_at: datetime
    active_api_keys: int = 0


async def revoke_keys_created_by(
    db: AsyncSession, user_id: UUID, *, now: datetime, workspace_id: UUID | None = None
) -> int:
    """Revoke every active key ``user_id`` created (in one workspace, or in all)."""
    q = (
        update(ApiKey)
        .where(ApiKey.created_by_user_id == user_id, ApiKey.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    if workspace_id is not None:
        q = q.where(ApiKey.workspace_id == workspace_id)
    res = await db.execute(q)
    return int(getattr(res, "rowcount", 0) or 0)


async def _active_key_counts(
    db: AsyncSession, workspace_id: UUID, now: datetime
) -> dict[UUID, int]:
    rows = await db.execute(
        select(ApiKey.created_by_user_id, func.count())
        .where(
            ApiKey.workspace_id == workspace_id,
            ApiKey.created_by_user_id.is_not(None),
            ApiKey.revoked_at.is_(None),
            or_(ApiKey.expires_at.is_(None), ApiKey.expires_at > now),
        )
        .group_by(ApiKey.created_by_user_id)
    )
    return {u: int(n) for u, n in rows.tuples() if u is not None}


async def list_members(db: AsyncSession, ws: WorkspaceContext) -> list[MemberRow]:
    rows = await db.execute(
        select(User.id, User.email, User.name, Membership.role, Membership.created_at)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.workspace_id == ws.workspace_id)
        .order_by(Membership.created_at, User.email)
    )
    keys = await _active_key_counts(db, ws.workspace_id, get_now())
    return [MemberRow(u, str(e), n, r, c, keys.get(u, 0)) for u, e, n, r, c in rows.tuples()]


async def get_member(db: AsyncSession, ws: WorkspaceContext, user_id: UUID) -> MemberRow:
    for m in await list_members(db, ws):
        if m.user_id == user_id:
            return m
    raise NotFound("Member not found in this workspace.")


async def _owner_count(db: AsyncSession, workspace_id: UUID) -> int:
    n = await db.scalar(
        select(func.count())
        .select_from(Membership)
        .where(Membership.workspace_id == workspace_id, Membership.role == Role.OWNER.value)
    )
    return int(n or 0)


async def _membership(db: AsyncSession, ws: WorkspaceContext, user_id: UUID) -> Membership:
    row = await db.get(Membership, (ws.workspace_id, user_id))
    if row is None:
        raise NotFound("Member not found in this workspace.")
    return row


def parse_role(raw: str) -> Role:
    try:
        return Role(raw.strip().lower())
    except ValueError:
        raise ValidationFailed("role", "Role must be owner, editor or viewer.") from None


async def change_role(
    db: AsyncSession, ws: WorkspaceContext, user_id: UUID, role: str
) -> MemberRow:
    new_role = parse_role(role)
    m = await _membership(db, ws, user_id)
    if (
        m.role == Role.OWNER.value
        and new_role != Role.OWNER
        and await _owner_count(db, ws.workspace_id) <= 1
    ):
        raise LastOwner()
    if m.role == Role.OWNER.value and new_role != Role.OWNER:
        # Only owners may hold keys: a demoted owner's keys stop working now.
        await revoke_keys_created_by(db, user_id, now=get_now(), workspace_id=ws.workspace_id)
    m.role = new_role.value
    await db.flush()
    return await get_member(db, ws, user_id)


async def remove_member(db: AsyncSession, ws: WorkspaceContext, user_id: UUID) -> None:
    """Remove a member (or leave, when ``user_id`` is the caller)."""
    m = await _membership(db, ws, user_id)
    if m.role == Role.OWNER.value and await _owner_count(db, ws.workspace_id) <= 1:
        raise LastOwner(
            "You are the last owner. Make another member an owner first, or delete the workspace."
        )
    await revoke_keys_created_by(db, user_id, now=get_now(), workspace_id=ws.workspace_id)
    await db.execute(
        delete(Membership).where(
            Membership.workspace_id == ws.workspace_id, Membership.user_id == user_id
        )
    )
    await db.flush()
