"""Row → response-model converters shared by the foundation routes."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from raisebook.auth.principal import Principal
from raisebook.auth.scopes import canonical_order
from raisebook.models.enums import Role
from raisebook.models.workspace import ApiKey, Invite, Workspace
from raisebook.schemas.api_keys import ApiKeyOut
from raisebook.schemas.members import InviteOut, MemberOut
from raisebook.schemas.workspaces import LimitsOut, WorkspaceDetailOut, WorkspaceOut, YouOut
from raisebook.services.invites import invite_status
from raisebook.services.members import MemberRow
from raisebook.services.users import FORMER_MEMBER
from raisebook.services.workspaces import LIMITS


def workspace_out(ws: Workspace, role: Role | str | None = None) -> WorkspaceOut:
    return WorkspaceOut(
        id=ws.id,
        slug=str(ws.slug),
        name=ws.name,
        is_sandbox=ws.is_sandbox,
        default_currency=ws.default_currency,
        timezone=ws.timezone,
        role=Role(role).value if role else None,
        created_at=ws.created_at,
    )


def workspace_detail_out(ws: Workspace, principal: Principal) -> WorkspaceDetailOut:
    base = workspace_out(ws, principal.role)
    you = YouOut(
        type="user" if principal.is_session else "agent",
        role=principal.role.value if principal.role else None,
        scopes=canonical_order(principal.scopes),
        agent_name=(principal.key_agent_name or principal.key_name) if principal.is_key else None,
        key_prefix=principal.key_prefix,
    )
    return WorkspaceDetailOut(**base.model_dump(), you=you, limits=LimitsOut(**LIMITS))


def member_out(m: MemberRow, you: UUID | None) -> MemberOut:
    return MemberOut(
        user_id=m.user_id,
        email=m.email,
        name=m.name,
        role=m.role,
        joined_at=m.joined_at,
        is_you=m.user_id == you,
        active_api_keys=m.active_api_keys,
    )


def invite_out(inv: Invite, now: datetime, names: dict[UUID, str]) -> InviteOut:
    inviter = None
    if inv.invited_by_user_id is not None:
        inviter = names.get(inv.invited_by_user_id, FORMER_MEMBER)
    return InviteOut(
        id=inv.id,
        email=str(inv.email),
        role=inv.role,
        invited_by=inviter,
        created_at=inv.created_at,
        expires_at=inv.expires_at,
        status=invite_status(inv, now),
    )


def api_key_out(key: ApiKey, names: dict[UUID, str]) -> ApiKeyOut:
    creator = None
    if key.created_by_user_id is not None:
        creator = names.get(key.created_by_user_id, FORMER_MEMBER)
    return ApiKeyOut(
        id=key.id,
        name=key.name,
        agent_name=key.agent_name,
        key_prefix=key.key_prefix,
        mode=key.mode,
        scopes=canonical_order(key.scopes),
        created_by=creator,
        created_at=key.created_at,
        last_used_at=key.last_used_at,
        expires_at=key.expires_at,
        revoked_at=key.revoked_at,
    )
