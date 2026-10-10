"""Import runs: one row per committed import (SPEC §3.6)."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ForeignKey, ForeignKeyConstraint, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from raisebook.core.database import Base
from raisebook.models._common import CreatedAtMixin, check_in, pk
from raisebook.models.enums import ActorType, ImportFormat


class ImportRun(CreatedAtMixin, Base):
    __tablename__ = "import_runs"
    __table_args__ = (
        check_in("format", ImportFormat),
        check_in("actor_type", ActorType),
        # The migration declares ON DELETE SET NULL (round_id) (PG15+ syntax).
        ForeignKeyConstraint(
            ["workspace_id", "round_id"],
            ["rounds.workspace_id", "rounds.id"],
            name="fk_import_runs_workspace_round",
        ),
    )

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    format: Mapped[str] = mapped_column(Text, nullable=False)
    filename: Mapped[str | None] = mapped_column(Text)
    round_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    actor_type: Mapped[str] = mapped_column(Text, nullable=False)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    api_key_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("api_keys.id", ondelete="SET NULL")
    )
    actor_label: Mapped[str | None] = mapped_column(Text)
    options: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'"), default=dict
    )
    counts: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
