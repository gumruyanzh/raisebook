"""Hard deletes of a workspace or an account (SPEC §8.4).

Deletes are immediate and permanent, in one transaction, with no soft-delete
columns or tombstones. Deleting a workspace cascades everything in it (rounds,
stages, investors, participants, activities, import runs, invites, API keys,
memberships). Deleting an account deletes the workspaces where the user is the
only member, removes their memberships elsewhere (revoking the API keys they
created there), and their pending sign-in tokens; activities they made stay,
shown as "Former member".
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.errors import ConfirmationRequired, TransferOwnershipFirst
from raisebook.models.enums import Role
from raisebook.models.user import LoginToken, User
from raisebook.models.workspace import Invite, Membership, Workspace
from raisebook.services.members import revoke_keys_created_by


async def delete_workspace_by_id(db: AsyncSession, workspace_id: UUID) -> None:
    await db.execute(delete(Workspace).where(Workspace.id == workspace_id))
    await db.flush()


async def delete_workspace(db: AsyncSession, ws: WorkspaceContext, *, confirm: str) -> None:
    """``DELETE /v1/workspace``: the caller must type the workspace slug."""
    if (confirm or "").strip().lower() != ws.slug.lower():
        raise ConfirmationRequired(
            f"Type the workspace slug ({ws.slug}) in 'confirm' to delete this workspace.",
            details={"expected": ws.slug},
        )
    await delete_workspace_by_id(db, ws.workspace_id)


@dataclass(frozen=True)
class AccountDeletionPlan:
    delete_workspaces: list[UUID]
    leave_workspaces: list[UUID]
    blocked: list[dict[str, str]]  # only owner of a workspace with other members


async def plan_account_deletion(db: AsyncSession, user: User) -> AccountDeletionPlan:
    member_counts = (
        select(Membership.workspace_id, func.count().label("n"))
        .group_by(Membership.workspace_id)
        .subquery()
    )
    owner_counts = (
        select(Membership.workspace_id, func.count().label("owners"))
        .where(Membership.role == Role.OWNER.value)
        .group_by(Membership.workspace_id)
        .subquery()
    )
    rows = await db.execute(
        select(
            Workspace.id,
            Workspace.slug,
            Workspace.name,
            Membership.role,
            member_counts.c.n,
            func.coalesce(owner_counts.c.owners, 0),
        )
        .join(Membership, Membership.workspace_id == Workspace.id)
        .join(member_counts, member_counts.c.workspace_id == Workspace.id)
        .outerjoin(owner_counts, owner_counts.c.workspace_id == Workspace.id)
        .where(Membership.user_id == user.id)
    )
    to_delete: list[UUID] = []
    to_leave: list[UUID] = []
    blocked: list[dict[str, str]] = []
    for ws_id, slug, name, role, n, owners in rows.tuples():
        if int(n) <= 1:
            to_delete.append(ws_id)
        elif role == Role.OWNER.value and int(owners) <= 1:
            blocked.append({"id": str(ws_id), "slug": str(slug), "name": name})
        else:
            to_leave.append(ws_id)
    return AccountDeletionPlan(to_delete, to_leave, blocked)


async def delete_account(
    db: AsyncSession, user: User, *, confirm_email: str, now: datetime
) -> AccountDeletionPlan:
    """``DELETE /v1/me``. 422 ``confirmation_required`` unless ``confirm_email`` matches;
    409 ``transfer_ownership_first`` when the user is the only owner of a shared workspace."""
    if (confirm_email or "").strip().lower() != str(user.email).lower():
        raise ConfirmationRequired(
            "Type your account email in 'confirm_email' to delete your account.",
        )
    plan = await plan_account_deletion(db, user)
    if plan.blocked:
        raise TransferOwnershipFirst(
            "You are the only owner of a workspace with other members. Make someone else an "
            "owner (or remove the other members) first.",
            details={"workspaces": plan.blocked},
        )
    for ws_id in plan.delete_workspaces:
        await delete_workspace_by_id(db, ws_id)
    # Keys the user created in workspaces they leave stop working before the user row
    # goes (ON DELETE SET NULL would otherwise erase who created them).
    await revoke_keys_created_by(db, user.id, now=now)
    await db.execute(delete(LoginToken).where(LoginToken.email == user.email))
    await db.execute(delete(Invite).where(Invite.email == user.email, Invite.accepted_at.is_(None)))
    await db.execute(delete(User).where(User.id == user.id))
    await db.flush()
    return plan
