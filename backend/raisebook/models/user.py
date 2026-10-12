"""Identity: users, magic-link login tokens, browser sessions (SPEC §3.1)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, LargeBinary, Text
from sqlalchemy.dialects.postgresql import CITEXT, INET, UUID
from sqlalchemy.orm import Mapped, mapped_column

from raisebook.core.database import Base
from raisebook.models._common import CreatedAtMixin, TimestampMixin, pk


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = pk()
    email: Mapped[str] = mapped_column(CITEXT, nullable=False, unique=True)
    name: Mapped[str | None] = mapped_column(Text)
    last_signin_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Google account id (OIDC ``sub``), bound on the first "Continue with Google" sign-in.
    google_sub: Mapped[str | None] = mapped_column(Text, unique=True)


class LoginToken(CreatedAtMixin, Base):
    """A one-time magic link. The user row is created on first successful verify."""

    __tablename__ = "login_tokens"

    id: Mapped[uuid.UUID] = pk()
    email: Mapped[str] = mapped_column(CITEXT, nullable=False)
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, unique=True)
    redirect_path: Mapped[str | None] = mapped_column(Text)
    # Raisebook addition to SPEC §3.1: the invite attached to this sign-in (accepted on verify).
    invite_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("invites.id", ondelete="SET NULL")
    )
    requested_ip: Mapped[str | None] = mapped_column(INET)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UserSession(CreatedAtMixin, Base):
    __tablename__ = "user_sessions"

    id: Mapped[uuid.UUID] = pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    secret_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    user_agent: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(INET)
