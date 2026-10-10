"""API key schemas (SPEC §5.3 ``ApiKey``, §5.4)."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, Field

from raisebook.schemas.common import StrictInput, Timestamp


class ApiKeyOut(BaseModel):
    id: UUID
    name: str
    agent_name: str | None = None
    key_prefix: str
    mode: Literal["live", "test"]
    scopes: list[str]
    created_by: str | None = None
    created_at: Timestamp
    last_used_at: Timestamp | None = None
    expires_at: Timestamp | None = None
    revoked_at: Timestamp | None = None


class ApiKeyCreate(StrictInput):
    name: str = Field(..., max_length=200)
    agent_name: str | None = Field(None, max_length=60)
    scopes: list[str] = Field(
        default_factory=lambda: ["raisebook:read", "raisebook:write"], max_length=3
    )
    expires_at: AwareDatetime | None = None


class ApiKeyCreated(BaseModel):
    api_key: ApiKeyOut
    secret: str = Field(..., description="The full key. Shown once: store it now.")
