"""Users: lookup, creation on first sign-in, profile, display names.

Display names are resolved at read time (``users.name``, else the email's local
part). A deleted user shows as "Former member"; no personal name is ever copied
into another table (SPEC §3.6).
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core.errors import ValidationFailed
from raisebook.models.user import User

FORMER_MEMBER = "Former member"


def display_name(user: User | None) -> str:
    if user is None:
        return FORMER_MEMBER
    if user.name:
        return user.name
    return str(user.email).split("@", 1)[0]


async def get_by_email(db: AsyncSession, email: str) -> User | None:
    user: User | None = await db.scalar(select(User).where(User.email == email))
    return user


async def get_or_create_user(db: AsyncSession, email: str, *, now: datetime) -> tuple[User, bool]:
    user = await get_by_email(db, email)
    if user is not None:
        return user, False
    user = User(email=email, created_at=now, updated_at=now)
    db.add(user)
    await db.flush()
    return user, True


def clean_name(raw: str | None) -> str | None:
    if raw is None:
        return None
    name = " ".join(raw.split())
    if not name:
        return None
    if len(name) > 120:
        raise ValidationFailed("name", "Name must be at most 120 characters.")
    return name


async def update_profile(db: AsyncSession, user: User, *, name: str | None, now: datetime) -> User:
    user.name = clean_name(name)
    user.updated_at = now
    await db.flush()
    return user


async def display_names(db: AsyncSession, user_ids: Iterable[UUID | None]) -> dict[UUID, str]:
    """``{user_id: display name}`` for existing users (missing ids → use FORMER_MEMBER)."""
    ids = {u for u in user_ids if u is not None}
    if not ids:
        return {}
    users = await db.scalars(select(User).where(User.id.in_(ids)))
    return {u.id: display_name(u) for u in users}
