"""Sign-in and account schemas (SPEC §5.4)."""

from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, Field

from raisebook.schemas.common import APIModel, StrictInput, Timestamp
from raisebook.schemas.workspaces import WorkspaceOut


class MagicLinkRequest(StrictInput):
    email: str = Field(..., min_length=3, max_length=254)
    redirect_path: str | None = Field(None, max_length=500)
    invite_token: str | None = Field(None, max_length=200)


class MagicLinkOut(BaseModel):
    sent: bool = True
    dev_link: str | None = Field(
        None, description="Only in local development: the sign-in link, so no email is needed."
    )


class VerifyRequest(StrictInput):
    token: str = Field(..., min_length=1, max_length=200)


class UserOut(APIModel):
    id: UUID
    email: str
    name: str | None = None


class MeOut(UserOut):
    created_at: Timestamp


class MeUpdate(StrictInput):
    name: str | None = Field(None, max_length=200)


class DeleteMeRequest(StrictInput):
    confirm_email: str = Field(..., max_length=254)


class SessionOut(BaseModel):
    user: UserOut
    csrf_token: str
    workspaces: list[WorkspaceOut]


class VerifyOut(SessionOut):
    redirect_path: str | None = None
