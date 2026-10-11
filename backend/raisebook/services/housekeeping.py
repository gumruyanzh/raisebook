"""Daily housekeeping (``rbctl housekeeping``): drop data Raisebook no longer needs.

Sign-in requests (email + IP) go a day after they expire, sessions when they expire
or a day after they are revoked, and invites (the invitee's email) once revoked or
seven days after they expire. Accepted invites stay as membership history.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import delete, or_
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.user import LoginToken, UserSession
from raisebook.models.workspace import Invite


def _n(result: object) -> int:
    return int(getattr(result, "rowcount", 0) or 0)


async def purge(db: AsyncSession, *, now: datetime) -> dict[str, int]:
    tokens = await db.execute(
        delete(LoginToken).where(LoginToken.expires_at < now - timedelta(days=1))
    )
    sessions = await db.execute(
        delete(UserSession).where(
            or_(
                UserSession.expires_at < now,
                UserSession.revoked_at < now - timedelta(days=1),
            )
        )
    )
    invites = await db.execute(
        delete(Invite).where(
            Invite.accepted_at.is_(None),
            or_(Invite.revoked_at.is_not(None), Invite.expires_at < now - timedelta(days=7)),
        )
    )
    return {"login_tokens": _n(tokens), "sessions": _n(sessions), "invites": _n(invites)}
