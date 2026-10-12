"""Participant, follow-up and round-summary schemas (SPEC §5.3, §5.6). Owner: API+MCP (AM)."""

from __future__ import annotations

from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from raisebook.schemas.activities import ActivityOut
from raisebook.schemas.common import StrictInput, Timestamp
from raisebook.schemas.investors import InvestorCompact
from raisebook.schemas.rounds import RoundOut, StageOut

Priority = Literal["hot", "warm", "maybe", "low"]
FollowUpState = Literal["overdue", "today", "soon", "later"]


class OwnerOut(BaseModel):
    user_id: UUID
    name: str | None = None
    email: str


class ParticipantOut(BaseModel):
    round_id: UUID
    round_slug: str
    investor: InvestorCompact
    stage: StageOut
    fit: int
    priority: Priority
    probability: int | None = None
    amount_soft: int | None = None
    amount_committed: int | None = None
    committed_on: date | None = None
    follow_up_on: date | None = None
    follow_up_note: str | None = None
    follow_up_state: FollowUpState | None = None
    next_step: str | None = None
    owner: OwnerOut | None = None
    stage_changed_at: Timestamp
    last_activity_at: Timestamp | None = None
    created_at: Timestamp
    updated_at: Timestamp


class ParticipantCreated(ParticipantOut):
    created: bool


class ParticipantPage(BaseModel):
    data: list[ParticipantOut]
    next_cursor: str | None = None
    total: int


class ParticipantCreate(StrictInput):
    investor_id: UUID
    stage: str | None = Field(None, max_length=40)
    fit: int | None = Field(None, ge=0, le=5)
    probability: int | None = Field(None, ge=0, le=100)
    amount_soft: int | None = Field(None, ge=0)
    next_step: str | None = Field(None, max_length=500)
    follow_up_on: date | None = None
    follow_up_note: str | None = Field(None, max_length=500)
    owner_user_id: UUID | None = None


class ParticipantUpdate(StrictInput):
    stage: str | None = Field(None, max_length=40)
    note: str | None = Field(None, max_length=2000)
    fit: int | None = Field(None, ge=0, le=5)
    probability: int | None = Field(None, ge=0, le=100)
    amount_soft: int | None = Field(None, ge=0)
    amount_committed: int | None = Field(None, ge=0)
    committed_on: date | None = None
    follow_up_on: date | None = None
    follow_up_note: str | None = Field(None, max_length=500)
    next_step: str | None = Field(None, max_length=500)
    owner_user_id: UUID | None = None


class BulkAdd(StrictInput):
    investor_ids: list[UUID] = Field(..., min_length=1, max_length=500)
    stage: str | None = Field(None, max_length=40)


class BulkAddOut(BaseModel):
    added: int
    already: int


BulkOp = Literal["stage", "follow_up", "owner", "fit", "add_tag", "remove_tag", "remove", "restore"]


class BulkItem(StrictInput):
    """One investor's values for ``op: "restore"`` (Undo). Fields that are present are
    applied; an investor no longer in the round is added back with them."""

    investor_id: UUID
    stage: str | None = Field(None, max_length=40)
    fit: int | None = Field(None, ge=0, le=5)
    probability: int | None = Field(None, ge=0, le=100)
    amount_soft: int | None = Field(None, ge=0)
    amount_committed: int | None = Field(None, ge=0)
    committed_on: date | None = None
    follow_up_on: date | None = None
    follow_up_note: str | None = Field(None, max_length=500)
    next_step: str | None = Field(None, max_length=500)
    owner_user_id: UUID | None = None


class BulkUpdate(StrictInput):
    """``POST /v1/rounds/{round}/participants/bulk-update``: one change for up to 1,000
    investors in one transaction. ``op`` picks the field: ``stage`` (key or label),
    ``follow_up`` (``follow_up_on``; null clears), ``owner`` (``owner_user_id``; null
    unassigns), ``fit``, ``add_tag`` / ``remove_tag`` (``tag``), ``remove`` (take them off
    the round), or ``restore`` (per-investor ``items``, used by Undo)."""

    op: BulkOp
    investor_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    stage: str | None = Field(None, max_length=40)
    follow_up_on: date | None = None
    owner_user_id: UUID | None = None
    fit: int | None = Field(None, ge=0, le=5)
    tag: str | None = Field(None, min_length=1, max_length=40)
    items: list[BulkItem] | None = Field(None, max_length=1000)


class BulkUpdateOut(BaseModel):
    bulk_id: UUID
    op: BulkOp
    changed: int
    unchanged: int
    #: The listed investors' participations after the change (empty for ``remove``).
    participants: list[ParticipantOut]
    removed: list[UUID] = Field(default_factory=list)


class StageMove(StrictInput):
    stage: str = Field(..., min_length=1, max_length=40)
    note: str | None = Field(None, max_length=2000)


class StageMoveOut(BaseModel):
    participant: ParticipantOut
    changed: bool
    from_: StageOut = Field(..., serialization_alias="from")
    to: StageOut


class FollowUpSet(StrictInput):
    on: date | None = None
    in_days: int | None = Field(None, ge=0, le=365)
    clear: bool | None = None
    note: str | None = Field(None, max_length=500)


class FollowUpSetOut(BaseModel):
    participant: ParticipantOut
    changed: bool


class CommitmentIn(StrictInput):
    amount: int = Field(..., ge=0)
    committed_on: date | None = None
    note: str | None = Field(None, max_length=2000)
    move_to_won: bool = True


class CommitmentOut(BaseModel):
    participant: ParticipantOut
    previous_amount: int | None = None
    moved_stage: bool
    round_committed_total: int


# --- follow-ups --------------------------------------------------------------------------


class RoundRef(BaseModel):
    id: UUID
    slug: str
    name: str


class FollowUpItem(BaseModel):
    investor: InvestorCompact
    round: RoundRef
    stage: StageOut
    follow_up_on: date
    follow_up_state: FollowUpState
    days_overdue: int
    follow_up_note: str | None = None
    next_step: str | None = None
    last_activity_at: Timestamp | None = None


class FollowUpCounts(BaseModel):
    overdue: int
    today: int
    upcoming: int


class FollowUpList(BaseModel):
    today: date
    data: list[FollowUpItem]
    counts: FollowUpCounts


# --- round summary -----------------------------------------------------------------------


class RoundWithClose(RoundOut):
    days_to_close: int | None = None


class MoneyOut(BaseModel):
    currency: str
    target: int
    committed: int
    pct_of_target: float
    soft_circled: int
    weighted_pipeline: int
    committed_count: int


class FunnelStage(StageOut):
    count: int
    amount_soft: int
    amount_committed: int


class KindCounts(BaseModel):
    total: int
    open: int
    active: int
    won: int
    lost: int


class StaleItem(BaseModel):
    investor: InvestorCompact
    stage: StageOut
    days_since_activity: int


class FollowUpBlock(BaseModel):
    overdue: int
    today: int
    next_7_days: int
    top: list[FollowUpItem]


class RoundSummaryOut(BaseModel):
    round: RoundWithClose
    money: MoneyOut
    funnel: list[FunnelStage]
    counts: KindCounts
    follow_ups: FollowUpBlock
    stale: list[StaleItem]
    recent_activity: list[ActivityOut]
    warnings: list[str]
