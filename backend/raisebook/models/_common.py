"""Shared column helpers for models.

The migration (``alembic/versions/0001_init.py``) is the source of truth for the
schema; these mappings mirror it for the ORM. Relationships are deliberately
not declared: services query explicitly by ``workspace_id`` and deletes rely on
the database's ``ON DELETE`` rules.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, DateTime, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from raisebook.models.enums import values


def new_id() -> uuid.UUID:
    return uuid.uuid4()


def pk() -> Mapped[uuid.UUID]:
    return mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=new_id,
        server_default=text("gen_random_uuid()"),
    )


def check_in(
    column: str, enum: type[StrEnum], name: str | None = None, *, nullable: bool = False
) -> CheckConstraint:
    allowed = ", ".join(f"'{v}'" for v in values(enum))
    expr = f"{column} IN ({allowed})"
    if nullable:
        expr = f"{column} IS NULL OR {expr}"
    return CheckConstraint(expr, name=name or f"{column}_valid")


class CreatedAtMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )


class TimestampMixin(CreatedAtMixin):
    """``updated_at`` is set by services from the injected clock (no ``onupdate``)."""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
