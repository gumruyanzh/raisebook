"""The Postgres job queue (RESEARCH-PLAN §1.4, §3). See ``services/jobs.py``."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, SmallInteger, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from raisebook.core.database import Base
from raisebook.models._common import TimestampMixin, check_in, pk
from raisebook.models.enums import JobStatus


class Job(TimestampMixin, Base):
    __tablename__ = "jobs"
    __table_args__ = (check_in("status", JobStatus),)

    id: Mapped[uuid.UUID] = pk()
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # Ids only (``run_id``): never secrets or investor fields.
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'"), default=dict
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'queued'"))
    priority: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="100")
    attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    max_attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="5")
    run_after: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    locked_by: Mapped[str | None] = mapped_column(Text)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    dedupe_key: Mapped[str | None] = mapped_column(Text)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
