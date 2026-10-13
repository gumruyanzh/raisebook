"""AI research settings, the spend ledger and the company profile (RESEARCH-PLAN §1.1 to §1.3).

The OpenRouter key is stored sealed (``core/secrets.py``): ciphertext and nonce under a
per-key data key (DEK), the DEK wrapped by the server KEK. Only ``key_last4`` is ever shown.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Integer, LargeBinary, Text, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from raisebook.core.database import Base
from raisebook.models._common import TimestampMixin, check_in
from raisebook.models.enums import AiPreset


class WorkspaceAiSettings(TimestampMixin, Base):
    __tablename__ = "workspace_ai_settings"
    __table_args__ = (check_in("preset", AiPreset),)

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    preset: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'best'"))
    identity_model: Mapped[str] = mapped_column(Text, nullable=False)
    search_model: Mapped[str] = mapped_column(Text, nullable=False)
    writer_model: Mapped[str] = mapped_column(Text, nullable=False)
    monthly_cap_micros: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=text("25000000")
    )
    key_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    key_nonce: Mapped[bytes | None] = mapped_column(LargeBinary)
    key_dek_wrapped: Mapped[bytes | None] = mapped_column(LargeBinary)
    key_dek_nonce: Mapped[bytes | None] = mapped_column(LargeBinary)
    key_kek_id: Mapped[str | None] = mapped_column(Text)
    key_last4: Mapped[str | None] = mapped_column(Text)
    key_label: Mapped[str | None] = mapped_column(Text)
    key_set_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    key_set_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    key_validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    models_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Prices/parameters of the chosen models as OpenRouter listed them when last verified.
    model_prices: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb"), default=dict
    )
    key_error: Mapped[str | None] = mapped_column(Text)  # OpenRouter refused the key in a run
    key_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @property
    def has_key(self) -> bool:
        return self.key_ciphertext is not None

    def __repr__(self) -> str:  # never show key material, even sealed
        return f"<WorkspaceAiSettings {self.workspace_id} preset={self.preset}>"


class AiUsageMonth(Base):
    """Spend per workspace month (month = first day, in the workspace timezone)."""

    __tablename__ = "ai_usage_months"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    month: Mapped[date] = mapped_column(Date, primary_key=True)
    spent_micros: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    reserved_micros: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    calls: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )


class CompanyProfile(TimestampMixin, Base):
    __tablename__ = "company_profiles"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    pitch: Mapped[str | None] = mapped_column(Text)
    sectors: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default=text("'{}'"), default=list
    )
    stage: Mapped[str | None] = mapped_column(Text)
    location: Mapped[str | None] = mapped_column(Text)
    traction: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default=text("'{}'"), default=list
    )
    wants_lead: Mapped[str | None] = mapped_column(Text)
    check_min: Mapped[int | None] = mapped_column(BigInteger)
    check_max: Mapped[int | None] = mapped_column(BigInteger)
    strategic_help: Mapped[str | None] = mapped_column(Text)
    website_url: Mapped[str | None] = mapped_column(Text)
    deck_filename: Mapped[str | None] = mapped_column(Text)
    prefilled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
