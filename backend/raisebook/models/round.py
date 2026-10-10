"""Rounds, their ordered stages, and round participation (SPEC §3.2, §3.3, §3.5).

Child tables reference parents through composite ``(workspace_id, id)`` keys, so
the database itself refuses a link between two workspaces.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, UUID
from sqlalchemy.orm import Mapped, mapped_column

from raisebook.core.database import Base
from raisebook.models._common import TimestampMixin, check_in, pk
from raisebook.models.enums import Instrument, RoundStatus, StageColor, StageKind


@dataclass(frozen=True)
class DefaultStage:
    key: str
    label: str
    color: str
    kind: str


# SPEC §3.3: created with every round; keys match prototype.html.
DEFAULT_STAGES: tuple[DefaultStage, ...] = (
    DefaultStage("new", "New", StageColor.SLATE, StageKind.OPEN),
    DefaultStage("research", "Researching", StageColor.VIOLET, StageKind.OPEN),
    DefaultStage("contacted", "Contacted", StageColor.COBALT, StageKind.ACTIVE),
    DefaultStage("replied", "Replied", StageColor.TEAL, StageKind.ACTIVE),
    DefaultStage("meeting", "Meeting", StageColor.AMBER, StageKind.ACTIVE),
    DefaultStage("dd", "Diligence", StageColor.ORANGE, StageKind.ACTIVE),
    DefaultStage("committed", "Committed", StageColor.GREEN, StageKind.WON),
    DefaultStage("passed", "Passed", StageColor.GRAY, StageKind.LOST),
)


class Round(TimestampMixin, Base):
    __tablename__ = "rounds"
    __table_args__ = (
        check_in("status", RoundStatus),
        check_in("instrument", Instrument),
        UniqueConstraint("workspace_id", "id", name="uq_rounds_workspace_id_id"),
        UniqueConstraint("workspace_id", "slug", name="uq_rounds_workspace_id_slug"),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    slug: Mapped[str] = mapped_column(CITEXT, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'open'"))
    instrument: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'safe'"))
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    target_amount: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    valuation_cap: Mapped[int | None] = mapped_column(BigInteger)
    pre_money_valuation: Mapped[int | None] = mapped_column(BigInteger)
    target_close_on: Mapped[date | None] = mapped_column(Date)
    closed_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class RoundStage(Base):
    __tablename__ = "round_stages"
    __table_args__ = (
        check_in("color", StageColor),
        check_in("kind", StageKind),
        ForeignKeyConstraint(
            ["workspace_id", "round_id"],
            ["rounds.workspace_id", "rounds.id"],
            ondelete="CASCADE",
            name="fk_round_stages_workspace_round",
        ),
        UniqueConstraint("round_id", "id", name="uq_round_stages_round_id_id"),
        UniqueConstraint("round_id", "key", name="uq_round_stages_round_id_key"),
        UniqueConstraint(
            "round_id",
            "position",
            name="uq_round_stages_position",
            deferrable=True,
            initially="DEFERRED",
        ),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    round_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    key: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    color: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)


class RoundParticipant(TimestampMixin, Base):
    """An investor in a round. ``priority`` and ``follow_up_state`` are derived, never stored."""

    __tablename__ = "round_participants"
    __table_args__ = (
        ForeignKeyConstraint(
            ["workspace_id", "round_id"],
            ["rounds.workspace_id", "rounds.id"],
            ondelete="CASCADE",
            name="fk_round_participants_workspace_round",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "investor_id"],
            ["investors.workspace_id", "investors.id"],
            ondelete="CASCADE",
            name="fk_round_participants_workspace_investor",
        ),
        ForeignKeyConstraint(
            ["round_id", "stage_id"],
            ["round_stages.round_id", "round_stages.id"],
            name="fk_round_participants_round_stage",
        ),
        # The migration declares ON DELETE SET NULL (owner_user_id) (PG15+ syntax).
        ForeignKeyConstraint(
            ["workspace_id", "owner_user_id"],
            ["memberships.workspace_id", "memberships.user_id"],
            name="fk_round_participants_owner_membership",
        ),
        UniqueConstraint("round_id", "investor_id", name="uq_round_participants_round_investor"),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    round_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    investor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    stage_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    fit: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    probability: Mapped[int | None] = mapped_column(SmallInteger)
    amount_soft: Mapped[int | None] = mapped_column(BigInteger)
    amount_committed: Mapped[int | None] = mapped_column(BigInteger)
    committed_on: Mapped[date | None] = mapped_column(Date)
    follow_up_on: Mapped[date | None] = mapped_column(Date)
    follow_up_note: Mapped[str | None] = mapped_column(Text)
    next_step: Mapped[str | None] = mapped_column(Text)
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    stage_changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    last_activity_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
