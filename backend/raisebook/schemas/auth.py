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
    switch_account: bool = Field(
        False,
        description="Sign out of the account this browser is signed in to and continue with "
        "this link. Without it, a different signed-in account gives 409 session_conflict.",
    )


class VerifyPeekOut(BaseModel):
    valid: bool
    email_hint: str | None = Field(None, description="Masked email, e.g. j***@example.com.")


class SessionInfoOut(BaseModel):
    id: UUID
    created_at: Timestamp
    last_seen_at: Timestamp | None = None
    expires_at: Timestamp
    user_agent: str | None = None
    ip: str | None = None
    current: bool


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
