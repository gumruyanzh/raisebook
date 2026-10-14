"""ICS for meetings: one meeting's download, and each user's private subscription feed.

The feed is a per-user read across the workspaces that user is a member of **right now**
(memberships are checked on every request, so leaving or being removed from a workspace drops
its meetings at the next refresh). It never reads a workspace the user is not in. The secret is
``rbcal_`` + 43 url-safe characters; only its SHA-256 is stored (``calendar_feeds``), it is
shown once, rotating replaces it and revoking deletes it. Logs carry the route template, never
the token.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta
from urllib.parse import quote, urlsplit

from sqlalchemy import and_, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.magic_link import hash_token
from raisebook.config import get_settings
from raisebook.core.errors import NotFound
from raisebook.models.investor import Investor
from raisebook.models.meeting import CalendarFeed, Meeting
from raisebook.models.user import User
from raisebook.models.workspace import Membership, Workspace
from raisebook.services.ics import IcsEvent, calendar

TOKEN_PREFIX = "rbcal_"
FEED_PAST = timedelta(days=60)
FEED_FUTURE = timedelta(days=400)
TOUCH_EVERY = timedelta(hours=1)


def feed_url(token: str) -> str:
    base = get_settings().public_base_url.rstrip("/")
    return f"{base}/v1/calendar/{token}.ics"


def webcal_url(url: str) -> str:
    parts = urlsplit(url)
    return "webcal://" + url[len(parts.scheme) + 3 :]


def investor_href(slug: str, investor_id: object) -> str:
    app = get_settings().app_url.rstrip("/")
    return f"{app}/w/{quote(slug)}/investors/{investor_id}"


def event_for(
    m: Meeting, inv: Investor, ws_slug: str, *, now: datetime, ws_name: str | None = None
) -> IcsEvent:
    """One meeting as a calendar event (UTC times, stable UID, SEQUENCE for updates)."""
    summary = m.title
    if m.status == "no_show":
        summary += " (no-show)"
    if ws_name:
        summary += f" · {ws_name}"
    href = investor_href(ws_slug, inv.id)
    parts: list[str] = []
    if m.video_url:
        parts.append(f"Join: {m.video_url}")
    if m.agenda:
        parts.append(m.agenda)
    who = inv.name + (f", {inv.title}" if inv.title else "")
    who += f" at {inv.firm}" if inv.firm else ""
    parts.append(f"With {who}.")
    parts.append(f"Investor file: {href}")
    return IcsEvent(
        uid=f"meeting-{m.id}@raisebook.org",
        sequence=m.sequence,
        starts_at=m.starts_at,
        ends_at=m.ends_at,
        summary=summary,
        dtstamp=m.updated_at or now,
        location=m.location or m.video_url,
        description="\n\n".join(parts),
        url=href,
        cancelled=m.status == "cancelled",
    )


async def status(db: AsyncSession, user: User) -> CalendarFeed | None:
    row: CalendarFeed | None = await db.scalar(
        select(CalendarFeed).where(CalendarFeed.user_id == user.id)
    )
    return row


async def rotate(db: AsyncSession, user: User, *, now: datetime) -> tuple[CalendarFeed, str]:
    """A new secret (any earlier URL stops working). Returns ``(row, token)``."""
    await db.execute(delete(CalendarFeed).where(CalendarFeed.user_id == user.id))
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = CalendarFeed(
        user_id=user.id, token_hash=hash_token(token), token_hint=token[-4:], created_at=now
    )
    db.add(row)
    await db.flush()
    return row, token


async def revoke(db: AsyncSession, user: User) -> bool:
    res = await db.execute(delete(CalendarFeed).where(CalendarFeed.user_id == user.id))
    await db.flush()
    return bool(getattr(res, "rowcount", 0))


async def feed_ics(db: AsyncSession, token: str, *, now: datetime) -> str:
    """The calendar for a feed token: every workspace's meetings for its user (scheduled,
    done and no-show as events, cancelled as cancelled) from 60 days ago to 400 days ahead."""
    if not token.startswith(TOKEN_PREFIX) or len(token) > 120:
        raise NotFound("Calendar feed not found. Create a new feed URL in Raisebook.")
    feed = await db.scalar(select(CalendarFeed).where(CalendarFeed.token_hash == hash_token(token)))
    if feed is None:
        raise NotFound("Calendar feed not found. Create a new feed URL in Raisebook.")
    if feed.last_used_at is None or now - feed.last_used_at > TOUCH_EVERY:
        feed.last_used_at = now
    workspaces = list(
        (
            await db.execute(
                select(Workspace.id, Workspace.slug, Workspace.name)
                .join(Membership, Membership.workspace_id == Workspace.id)
                .where(Membership.user_id == feed.user_id)
            )
        ).tuples()
    )
    names = {wid: (str(slug), name) for wid, slug, name in workspaces}
    events: list[IcsEvent] = []
    if names:
        rows = await db.execute(
            select(Meeting, Investor)
            .join(
                Investor,
                and_(
                    Investor.id == Meeting.investor_id,
                    Investor.workspace_id == Meeting.workspace_id,
                ),
            )
            .where(
                Meeting.workspace_id.in_(list(names)),
                Meeting.starts_at >= now - FEED_PAST,
                Meeting.starts_at <= now + FEED_FUTURE,
            )
            .order_by(Meeting.starts_at, Meeting.id)
        )
        several = len(names) > 1
        for m, inv in rows.tuples():
            slug, wname = names[m.workspace_id]
            events.append(event_for(m, inv, slug, now=now, ws_name=wname if several else None))
    await db.flush()
    return calendar(events, name="Raisebook meetings")
