"""``rbctl housekeeping`` retention rules (privacy page: what Raisebook stores)."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core.clock import get_now
from raisebook.models.workspace import Invite
from raisebook.services.housekeeping import purge
from tests.factories import make_invite, make_workspace


async def test_purge_drops_dead_invites_only(db: AsyncSession) -> None:
    now = get_now()
    ws = await make_workspace(db)
    pending, _ = await make_invite(db, ws)
    revoked, _ = await make_invite(db, ws)
    revoked.revoked_at = now
    old, _ = await make_invite(db, ws)
    old.expires_at = now - timedelta(days=8)
    recent, _ = await make_invite(db, ws)
    recent.expires_at = now - timedelta(days=2)
    await db.flush()
    counts = await purge(db, now=now)
    assert counts["invites"] == 2
    db.expunge_all()
    assert await db.get(Invite, pending.id) is not None
    assert await db.get(Invite, recent.id) is not None
    assert await db.get(Invite, revoked.id) is None
    assert await db.get(Invite, old.id) is None
