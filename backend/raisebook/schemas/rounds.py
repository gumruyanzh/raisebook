"""Round, stage and summary schemas (SPEC §5.3, §5.5). Owner: API+MCP (AM)."""

from __future__ import annotations

from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from raisebook.schemas.common import StrictInput, Timestamp

StageColorName = Literal[
    "slate", "violet", "cobalt", "teal", "amber", "orange", "green", "gray", "olive", "sky"
]
StageKindName = Literal["open", "active", "won", "lost"]
RoundStatusName = Literal["open", "closed"]


class StageOut(BaseModel):
    key: str
    label: str
    color: StageColorName
    kind: StageKindName
    position: int
    count: int | None = None  # only in round detail


class StageInput(StrictInput):
    key: str | None = Field(None, max_length=32)
    label: str = Field(..., min_length=1, max_length=40)
    color: StageColorName
    kind: StageKindName


class RoundOut(BaseModel):
    id: UUID
    slug: str
    name: str
    status: RoundStatusName
    instrument: str
    currency: str
    target_amount: int
    valuation_cap: int | None = None
    pre_money_valuation: int | None = None
    target_close_on: date | None = None
    closed_on: date | None = None
    notes: str | None = None
    stages: list[StageOut]
    committed_amount: int
    participant_count: int
    created_at: Timestamp
    updated_at: Timestamp


class RoundCreate(StrictInput):
    name: str = Field(..., min_length=1, max_length=80)
    target_amount: int | None = Field(None, ge=0)
    currency: str | None = Field(None, max_length=3)
    instrument: str | None = Field(None, max_length=40)
    valuation_cap: int | None = Field(None, gt=0)
    pre_money_valuation: int | None = Field(None, gt=0)
    target_close_on: date | None = None
    notes: str | None = Field(None, max_length=20000)
    stages: list[StageInput] | None = None


class RoundUpdate(StrictInput):
    name: str | None = Field(None, min_length=1, max_length=80)
    status: RoundStatusName | None = None
    target_amount: int | None = Field(None, ge=0)
    currency: str | None = Field(None, max_length=3)
    instrument: str | None = Field(None, max_length=40)
    valuation_cap: int | None = Field(None, gt=0)
    pre_money_valuation: int | None = Field(None, gt=0)
    target_close_on: date | None = None
    closed_on: date | None = None
    notes: str | None = Field(None, max_length=20000)


class RoundDelete(StrictInput):
    confirm: str = Field(..., max_length=200)


class StagesReplace(StrictInput):
    stages: list[StageInput] = Field(..., min_length=1, max_length=32)
    reassign: dict[str, str] | None = None


class RoundList(BaseModel):
    data: list[RoundOut]
