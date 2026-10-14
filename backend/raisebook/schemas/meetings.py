"""Meeting schemas (``/v1/meetings``, the calendar feed). See docs/SPEC.md §5.9.

``MeetingBrief`` lives in ``schemas.participants`` (a participant carries its next meeting).
"""

from __future__ import annotations

from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from raisebook.schemas.activities import ActivityOut, ActorOut
from raisebook.schemas.common import StrictInput, Timestamp
from raisebook.schemas.investors import InvestorCompact
from raisebook.schemas.participants import MeetingBrief, ParticipantOut
from raisebook.schemas.rounds import StageOut

MeetingStatusName = Literal["scheduled", "done", "cancelled", "no_show"]
MeetingSourceName = Literal["manual", "email", "agent", "calendar"]


__all__ = ["MeetingBrief"]


class MeetingRound(BaseModel):
    id: UUID
    slug: str
    name: str


class MeetingChange(BaseModel):
    """One entry of a meeting's history (from the activity timeline)."""

    at: Timestamp
    change: str  # scheduled, rescheduled, edited, cancelled, no_show, reopened, done
    from_starts_at: Timestamp | None = None
    to_starts_at: Timestamp | None = None
    by: ActorOut


class MeetingOut(BaseModel):
    id: UUID
    investor: InvestorCompact
    guests: list[InvestorCompact] = []
    round: MeetingRound | None = None
    title: str
    starts_at: Timestamp
    ends_at: Timestamp
    duration_minutes: int
    timezone: str
    location: str | None = None
    video_url: str | None = None
    agenda: str | None = None
    status: MeetingStatusName
    # A scheduled meeting that has ended and has no outcome yet.
    needs_outcome: bool
    outcome: str | None = None
    outcome_activity_id: UUID | None = None
    source: MeetingSourceName
    created_by: ActorOut
    created_at: Timestamp
    updated_at: Timestamp
    completed_at: Timestamp | None = None
    cancelled_at: Timestamp | None = None
    history: list[MeetingChange] = []


class MeetingPage(BaseModel):
    data: list[MeetingOut]
    next_cursor: str | None = None


class MeetingCreate(StrictInput):
    investor_id: UUID
    starts_at: str = Field(
        ...,
        max_length=40,
        description="RFC 3339; a time without an offset is in the workspace timezone.",
    )
    ends_at: str | None = Field(None, max_length=40)
    duration_minutes: int | None = Field(None, ge=5, le=1440)
    round: str | None = Field(None, max_length=200)
    title: str | None = Field(None, max_length=200)
    location: str | None = Field(None, max_length=500)
    video_url: str | None = Field(None, max_length=1000)
    agenda: str | None = Field(None, max_length=5000)
    guest_ids: list[UUID] = Field(default_factory=list, max_length=10)
    source: MeetingSourceName | None = None
    move_to_meeting_stage: bool = True


class MeetingUpdate(StrictInput):
    starts_at: str | None = Field(None, max_length=40)
    ends_at: str | None = Field(None, max_length=40)
    duration_minutes: int | None = Field(None, ge=5, le=1440)
    round: str | None = Field(None, max_length=200)
    title: str | None = Field(None, max_length=200)
    location: str | None = Field(None, max_length=500)
    video_url: str | None = Field(None, max_length=1000)
    agenda: str | None = Field(None, max_length=5000)
    guest_ids: list[UUID] | None = Field(None, max_length=10)
    status: Literal["scheduled", "cancelled", "no_show"] | None = None
    note: str | None = Field(None, max_length=2000, description="Why; shown on the timeline.")


class MeetingComplete(StrictInput):
    outcome: str | None = Field(None, max_length=5000)
    next_step: str | None = Field(None, max_length=500)
    follow_up_on: date | None = None
    follow_up_in_days: int | None = Field(None, ge=0, le=365)
    follow_up_note: str | None = Field(None, max_length=500)


class StageMoveBrief(BaseModel):
    """``from`` is null when the investor was added to the round at the Meeting stage."""

    from_stage: StageOut | None = Field(None, alias="from")
    to: StageOut

    model_config = {"populate_by_name": True}


class MeetingWriteOut(BaseModel):
    meeting: MeetingOut
    created: bool = False
    changed: bool = True
    moved_stage: StageMoveBrief | None = None
    # The participant after the write (stage moved, next step or follow-up set).
    participant: ParticipantOut | None = None
    activity: ActivityOut | None = None
    warnings: list[str] = []


class CalendarFeedOut(BaseModel):
    active: bool
    token_hint: str | None = None
    created_at: Timestamp | None = None
    last_used_at: Timestamp | None = None


class CalendarFeedCreated(CalendarFeedOut):
    url: str
    webcal_url: str
