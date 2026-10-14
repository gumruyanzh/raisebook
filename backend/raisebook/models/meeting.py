"""Meetings: scheduled time with an investor, and the per-user calendar feed (migration 0008).

A meeting belongs to one investor (``investor_id``) and may include more people from the
same firm (``meeting_guests``). It can be tied to a round (``round_id``, set to NULL when the
round is deleted). Deleting the investor deletes their meetings; deleting a guest removes
them from the meeting. Every change is also written to the activity timeline
(``meeting_scheduled`` / ``meeting_updated`` / ``meeting``), which is the audit trail.

``calendar_feeds`` holds one secret per user for the private ICS subscription URL (only its
hash is stored, as for API keys).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from raisebook.core.database import Base
from raisebook.models._common import CreatedAtMixin, TimestampMixin, check_in, pk
from raisebook.models.enums import ActorType, MeetingSource, MeetingStatus, Via


class Meeting(TimestampMixin, Base):
    __tablename__ = "meetings"
    __table_args__ = (
        check_in("status", MeetingStatus),
        check_in("source", MeetingSource),
        check_in("actor_type", ActorType),
        check_in("via", Via),
        UniqueConstraint("workspace_id", "id", name="uq_meetings_workspace_id_id"),
        ForeignKeyConstraint(
            ["workspace_id", "investor_id"],
            ["investors.workspace_id", "investors.id"],
            ondelete="CASCADE",
            name="fk_meetings_workspace_investor",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "round_id"],
            ["rounds.workspace_id", "rounds.id"],
            name="fk_meetings_workspace_round",
        ),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    investor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    round_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    title: Mapped[str] = mapped_column(Text, nullable=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    timezone: Mapped[str] = mapped_column(Text, nullable=False)
    location: Mapped[str | None] = mapped_column(Text)
    video_url: Mapped[str | None] = mapped_column(Text)
    agenda: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'scheduled'"))
    outcome: Mapped[str | None] = mapped_column(Text)
    outcome_activity_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("activities.id", ondelete="SET NULL")
    )
    source: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'manual'"))
    sequence: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Who scheduled it (shaped like ``activities``).
    actor_type: Mapped[str] = mapped_column(Text, nullable=False)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    api_key_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("api_keys.id", ondelete="SET NULL")
    )
    actor_label: Mapped[str | None] = mapped_column(Text)
    agent_model: Mapped[str | None] = mapped_column(Text)
    via: Mapped[str] = mapped_column(Text, nullable=False)


class MeetingGuest(Base):
    """Another person from the same firm in the meeting."""

    __tablename__ = "meeting_guests"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "meeting_id"],
            ["meetings.workspace_id", "meetings.id"],
            ondelete="CASCADE",
            name="fk_meeting_guests_workspace_meeting",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "investor_id"],
            ["investors.workspace_id", "investors.id"],
            ondelete="CASCADE",
            name="fk_meeting_guests_workspace_investor",
        ),
    )

    meeting_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    investor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)


class CalendarFeed(CreatedAtMixin, Base):
    """A user's private ICS feed secret (one per user; rotating replaces it)."""

    __tablename__ = "calendar_feeds"

    id: Mapped[uuid.UUID] = pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, unique=True)
    token_hint: Mapped[str] = mapped_column(Text, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
