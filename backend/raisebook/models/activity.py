"""The append-only activity timeline (SPEC §3.6, §8.1).

The ``activities_guard_update`` trigger (migration 0001) rejects every UPDATE
except ``actor_user_id``, ``api_key_id`` or ``import_run_id`` becoming NULL (the
``ON DELETE SET NULL`` cascades). Write activities only through
``services.activities.log``.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, ForeignKeyConstraint, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from raisebook.core.database import Base
from raisebook.models._common import CreatedAtMixin, check_in, pk
from raisebook.models.enums import ActivityKind, ActorType, Via


class Activity(CreatedAtMixin, Base):
    __tablename__ = "activities"
    __table_args__ = (
        check_in("kind", ActivityKind),
        check_in("actor_type", ActorType),
        check_in("via", Via),
        ForeignKeyConstraint(
            ["workspace_id", "investor_id"],
            ["investors.workspace_id", "investors.id"],
            ondelete="CASCADE",
            name="fk_activities_workspace_investor",
        ),
        ForeignKeyConstraint(
            ["workspace_id", "round_id"],
            ["rounds.workspace_id", "rounds.id"],
            ondelete="CASCADE",
            name="fk_activities_workspace_round",
        ),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    investor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    round_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    body: Mapped[str | None] = mapped_column(Text)
    data: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'"), default=dict
    )
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
    import_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("import_runs.id", ondelete="SET NULL")
    )
    idempotency_key: Mapped[str | None] = mapped_column(Text)
