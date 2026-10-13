"""Activity schemas (SPEC §5.3 ``Activity``, ``Actor``; §5.7). Owner: API+MCP (AM)."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

from raisebook.schemas.common import StrictInput, Timestamp

ActorTypeName = Literal["user", "agent", "system"]
ViaName = Literal["web", "api", "mcp", "import", "system"]
LoggableKind = Literal["note", "email", "call", "meeting"]


class ActorOut(BaseModel):
    type: ActorTypeName
    label: str  # resolved display name (user name, agent name, "raisebook")
    user_id: UUID | None = None
    api_key_id: UUID | None = None
    agent_model: str | None = None
    via: ViaName


class RunOut(BaseModel):
    """A run of activities written by one import or one bulk change, collapsed to one entry
    in a feed (``collapse_runs=true``). ``key`` filters the run back out (``?run=``)."""

    key: str
    kind: Literal["import", "bulk"]
    size: int  # activities in the run (within the same filters)
    investors: int  # distinct investors they touch


class ActivityOut(BaseModel):
    id: UUID
    investor_id: UUID
    investor_name: str
    round_id: UUID | None = None
    round_slug: str | None = None
    kind: str
    occurred_at: Timestamp
    body: str | None = None
    data: dict[str, Any]
    actor: ActorOut
    created_at: Timestamp
    deletable: bool
    import_run_id: UUID | None = None
    # Only with ``collapse_runs=true``: this entry stands for a whole import or bulk change.
    run: RunOut | None = None


class ActivityCreate(StrictInput):
    investor_id: UUID
    kind: LoggableKind
    body: str = Field(..., min_length=1, max_length=20000)
    occurred_at: str | None = Field(None, max_length=40)
    round: str | None = Field(None, max_length=200)
    direction: Literal["inbound", "outbound"] | None = None
    idempotency_key: str | None = Field(None, min_length=1, max_length=200)


class ActivityCreated(ActivityOut):
    duplicate: bool = False


class ActivityPage(BaseModel):
    data: list[ActivityOut]
    next_cursor: str | None = None
