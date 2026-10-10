"""Workspace schemas (SPEC §5.3 ``Workspace``, §5.4)."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from raisebook.schemas.common import APIModel, StrictInput, Timestamp


class WorkspaceOut(APIModel):
    id: UUID
    slug: str
    name: str
    is_sandbox: bool
    default_currency: str
    timezone: str
    role: Literal["owner", "editor", "viewer"] | None = None
    created_at: Timestamp


class WorkspaceCreate(StrictInput):
    name: str = Field("", max_length=200)
    timezone: str | None = Field(None, max_length=64)
    default_currency: str | None = Field(None, max_length=3)
    sample: bool = False


class WorkspaceUpdate(StrictInput):
    name: str | None = Field(None, max_length=200)
    timezone: str | None = Field(None, max_length=64)
    default_currency: str | None = Field(None, max_length=3)


class WorkspaceDelete(StrictInput):
    confirm: str = Field(..., max_length=100)


class YouOut(BaseModel):
    type: Literal["user", "agent"]
    role: Literal["owner", "editor", "viewer"] | None = None
    scopes: list[str]
    agent_name: str | None = None
    key_prefix: str | None = None


class LimitsOut(BaseModel):
    members: int
    api_keys: int
    rounds: int
    investors: int
    activities: int


class WorkspaceDetailOut(WorkspaceOut):
    you: YouOut
    limits: LimitsOut
