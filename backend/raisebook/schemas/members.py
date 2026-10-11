"""Member and invite schemas (SPEC §5.3 ``Member``, ``Invite``)."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from raisebook.schemas.common import StrictInput, Timestamp

RoleName = Literal["owner", "editor", "viewer"]


class MemberOut(BaseModel):
    user_id: UUID
    email: str
    name: str | None = None
    role: RoleName
    joined_at: Timestamp
    is_you: bool
    active_api_keys: int = Field(
        0,
        description="Active API keys this person created. They are revoked if the member "
        "is removed, leaves, or (for an owner) is demoted.",
    )


class MemberUpdate(StrictInput):
    role: str = Field(..., max_length=20)


class InviteOut(BaseModel):
    id: UUID
    email: str
    role: RoleName
    invited_by: str | None = None
    created_at: Timestamp
    expires_at: Timestamp
    status: Literal["pending", "accepted", "revoked", "expired"]


class InviteCreatedOut(InviteOut):
    dev_link: str | None = Field(None, description="Only in local development: the invite link.")


class InviteCreate(StrictInput):
    email: str = Field(..., max_length=254)
    role: str = Field("editor", max_length=20)


class InviteLookupOut(BaseModel):
    workspace_name: str
    inviter_name: str | None = None
    email_hint: str
    role: RoleName
    expired: bool


class InviteAccept(StrictInput):
    token: str = Field(..., min_length=1, max_length=200)
