"""Members: list, change role, remove or leave (SPEC §3.1, §5.4).

A workspace always keeps at least one owner (409 ``last_owner``). Removing a
member clears them as owner of round participants (``ON DELETE SET NULL``).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.errors import LastOwner, NotFound, ValidationFailed
from raisebook.models.enums import Role
from raisebook.models.user import User
from raisebook.models.workspace import Membership


@dataclass(frozen=True)
class MemberRow:
    user_id: UUID
    email: str
    name: str | None
    role: str
    joined_at: datetime


async def list_members(db: AsyncSession, ws: WorkspaceContext) -> list[MemberRow]:
    rows = await db.execute(
        select(User.id, User.email, User.name, Membership.role, Membership.created_at)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.workspace_id == ws.workspace_id)
        .order_by(Membership.created_at, User.email)
    )
    return [MemberRow(u, str(e), n, r, c) for u, e, n, r, c in rows.tuples()]


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
    await db.execute(
        delete(Membership).where(
            Membership.workspace_id == ws.workspace_id, Membership.user_id == user_id
        )
    )
    await db.flush()
