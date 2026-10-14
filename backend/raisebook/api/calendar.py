"""The private calendar feed (docs/SPEC.md §5.9).

- ``/v1/me/calendar-feed`` (session only): see, create or rotate, and revoke your feed URL.
- ``GET /v1/calendar/{token}.ics`` (no sign-in; the secret is the credential): every
  meeting in the workspaces you belong to, for Google, Apple or Outlook Calendar to
  subscribe to. Rate limited per IP.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import SessionUser, get_now, get_session, get_session_user, rate_limit
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.schemas.meetings import CalendarFeedCreated, CalendarFeedOut
from raisebook.services import calendar_feed as svc

router = APIRouter(tags=["meetings"], responses=ERROR_RESPONSES)


@router.get("/v1/me/calendar-feed", response_model=CalendarFeedOut)
async def feed_status(
    su: SessionUser = Depends(get_session_user),
    db: AsyncSession = Depends(get_session),
) -> CalendarFeedOut:
    """Whether you have a feed URL (the URL itself is shown only when created)."""
    row = await svc.status(db, su.user)
    if row is None:
        return CalendarFeedOut(active=False)
    return CalendarFeedOut(
        active=True,
        token_hint=row.token_hint,
        created_at=row.created_at,
        last_used_at=row.last_used_at,
    )


@router.post("/v1/me/calendar-feed", status_code=201, response_model=CalendarFeedCreated)
async def feed_create(
    su: SessionUser = Depends(get_session_user),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> CalendarFeedCreated:
    """Create your feed URL, or replace it (the old URL stops working). Copy it now: it is
    shown once."""
    row, token = await svc.rotate(db, su.user, now=now)
    await db.commit()
    url = svc.feed_url(token)
    return CalendarFeedCreated(
        active=True,
        token_hint=row.token_hint,
        created_at=row.created_at,
        last_used_at=None,
        url=url,
        webcal_url=svc.webcal_url(url),
    )


@router.delete("/v1/me/calendar-feed", status_code=204, response_class=Response)
async def feed_revoke(
    su: SessionUser = Depends(get_session_user),
    db: AsyncSession = Depends(get_session),
) -> Response:
    """Turn the feed off: subscribed calendars stop updating."""
    await svc.revoke(db, su.user)
    await db.commit()
    return Response(status_code=204)


@router.get(
    "/v1/calendar/{token}.ics",
    response_class=Response,
    responses={200: {"content": {"text/calendar": {}}}},
    dependencies=[Depends(rate_limit("anon_ip"))],
)
async def feed(
    token: str,
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """The subscription feed for a calendar app (404 for an unknown or revoked token)."""
    text = await svc.feed_ics(db, token, now=now)
    await db.commit()
    return Response(
        content=text,
        media_type="text/calendar; charset=utf-8",
        headers={"Cache-Control": "private, max-age=300", "X-Robots-Tag": "noindex"},
    )
