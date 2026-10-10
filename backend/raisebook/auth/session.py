"""Browser sessions: the signed ``rb_session`` cookie, server-side rows, CSRF (SPEC §4.2).

Cookie value: ``<session_id hex>.<secret>.<sig>`` where ``secret`` is 32 random
bytes (base64url) and ``sig = HMAC-SHA256(session_key, "<id>.<secret>")``. The
``user_sessions`` row stores only ``sha256(secret)``. A tampered cookie is
rejected before any database lookup; a revoked or expired row after it.

CSRF: every cookie-authenticated unsafe request must carry ``X-CSRF-Token`` equal
to :func:`csrf_token_for` (an HMAC of the session id, also in the readable
``rb_csrf`` cookie and in ``GET /v1/auth/session``), and its ``Origin`` header,
when present, must be an allowed origin. A request that carries an API key is
never cookie-authenticated.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import Request, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from raisebook.config import Settings, get_settings
from raisebook.core.errors import CsrfFailed
from raisebook.models.user import User, UserSession

SESSION_COOKIE = "rb_session"
CSRF_COOKIE = "rb_csrf"
CSRF_HEADER = "X-CSRF-Token"
WORKSPACE_HEADER = "X-Workspace"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def session_key(settings: Settings | None = None) -> bytes:
    """HMAC key for cookies and CSRF tokens.

    ``RAISEBOOK_SESSION_SECRET`` is required in staging and production (startup
    fails without it). In development and tests a fixed dev key is used.
    """
    s = settings or get_settings()
    raw = s.session_secret.get_secret_value()
    if raw:
        return hashlib.sha256(b"raisebook-session:" + raw.encode()).digest()
    if s.is_production:
        raise RuntimeError("RAISEBOOK_SESSION_SECRET must be set in staging and production")
    return hashlib.sha256(b"raisebook-dev-session-key").digest()


def _sign(payload: str, key: bytes) -> str:
    return _b64(hmac.new(key, payload.encode(), hashlib.sha256).digest())


def hash_secret(secret: str) -> bytes:
    return hashlib.sha256(secret.encode()).digest()


def new_session_secret() -> tuple[str, bytes]:
    secret = _b64(secrets.token_bytes(32))
    return secret, hash_secret(secret)


def encode_cookie(session_id: UUID, secret: str, key: bytes | None = None) -> str:
    payload = f"{session_id.hex}.{secret}"
    return f"{payload}.{_sign(payload, key or session_key())}"


def decode_cookie(value: str, key: bytes | None = None) -> tuple[UUID, str] | None:
    """``(session_id, secret)`` from a well-formed, correctly signed cookie, else None."""
    parts = value.split(".")
    if len(parts) != 3:
        return None
    sid_hex, secret, sig = parts
    expected = _sign(f"{sid_hex}.{secret}", key or session_key())
    if not hmac.compare_digest(expected, sig):
        return None
    try:
        return UUID(hex=sid_hex), secret
    except ValueError:
        return None


def csrf_token_for(session_id: UUID, key: bytes | None = None) -> str:
    mac = hmac.new(key or session_key(), b"csrf:" + session_id.hex.encode(), hashlib.sha256)
    return _b64(mac.digest())


def _origin(url: str) -> str | None:
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}".lower()


def allowed_origins(settings: Settings | None = None) -> list[str]:
    s = settings or get_settings()
    out: list[str] = []
    for url in [s.app_url, s.public_base_url, *s.cors_origins]:
        o = _origin(url)
        if o and o not in out:
            out.append(o)
    return out


def check_csrf(request: Request, session_id: UUID) -> None:
    """Raise 403 ``csrf_failed`` unless an unsafe cookie request proves same-site intent."""
    if request.method.upper() in SAFE_METHODS:
        return
    origin = (request.headers.get("origin") or "").strip().lower()
    if origin and (origin == "null" or origin not in allowed_origins()):
        raise CsrfFailed("Cross-site request refused: this Origin is not allowed.")
    token = request.headers.get(CSRF_HEADER, "")
    if not token or not hmac.compare_digest(token, csrf_token_for(session_id)):
        raise CsrfFailed()


def has_api_credential(request: Request) -> bool:
    return bool(request.headers.get("authorization") or request.headers.get("x-api-key"))


@dataclass(frozen=True)
class LoadedSession:
    session: UserSession
    user: User
    touched: bool  # the expiry slid during this call


async def load_session(
    db: AsyncSession, cookie_value: str | None, *, now: datetime
) -> tuple[UserSession, User] | None:
    """Resolve a cookie to its live session and user, sliding the expiry (≤ every 5 min)."""
    loaded = await load_session_detail(db, cookie_value, now=now)
    return (loaded.session, loaded.user) if loaded else None


async def load_session_detail(
    db: AsyncSession, cookie_value: str | None, *, now: datetime
) -> LoadedSession | None:
    """Like :func:`load_session`, also saying whether the expiry slid."""
    if not cookie_value:
        return None
    decoded = decode_cookie(cookie_value)
    if decoded is None:
        return None
    sid, secret = decoded
    row = (
        await db.execute(
            select(UserSession, User)
            .join(User, User.id == UserSession.user_id)
            .where(UserSession.id == sid)
        )
    ).one_or_none()
    if row is None:
        return None
    sess, user = row[0], row[1]
    if not hmac.compare_digest(bytes(sess.secret_hash), hash_secret(secret)):
        return None
    if sess.revoked_at is not None or sess.expires_at <= now:
        return None
    s = get_settings()
    interval = timedelta(seconds=s.session_touch_interval_s)
    touched = False
    if sess.last_seen_at is None or now - sess.last_seen_at >= interval:
        expires = now + timedelta(hours=s.session_ttl_hours)
        await db.execute(
            update(UserSession)
            .where(UserSession.id == sess.id)
            .values(last_seen_at=now, expires_at=expires)
        )
        sess.last_seen_at = now
        sess.expires_at = expires
        touched = True
    return LoadedSession(sess, user, touched)


def set_session_cookies(
    response: Response, cookie_value: str, session_id: UUID, expires_at: datetime
) -> None:
    """``rb_session`` (HttpOnly) plus ``rb_csrf`` (readable, for the X-CSRF-Token header)."""
    s = get_settings()
    for name, value, http_only in (
        (SESSION_COOKIE, cookie_value, True),
        (CSRF_COOKIE, csrf_token_for(session_id), False),
    ):
        response.set_cookie(
            name,
            value,
            expires=expires_at.astimezone(UTC),
            path="/",
            domain=s.session_cookie_domain,
            secure=s.session_cookie_secure,
            httponly=http_only,
            samesite="lax",
        )


def clear_session_cookies(response: Response) -> None:
    s = get_settings()
    for name, http_only in ((SESSION_COOKIE, True), (CSRF_COOKIE, False)):
        response.delete_cookie(
            name,
            path="/",
            domain=s.session_cookie_domain,
            secure=s.session_cookie_secure,
            httponly=http_only,
            samesite="lax",
        )


async def create_user_session(
    db: AsyncSession,
    user: User,
    *,
    now: datetime,
    user_agent: str | None = None,
    ip: str | None = None,
) -> tuple[UserSession, str]:
    """Insert a session row; returns it and the signed cookie value (never stored)."""
    secret, digest = new_session_secret()
    row = UserSession(
        user_id=user.id,
        secret_hash=digest,
        created_at=now,
        expires_at=now + timedelta(hours=get_settings().session_ttl_hours),
        last_seen_at=now,
        user_agent=(user_agent or "")[:400] or None,
        ip=ip,
    )
    db.add(row)
    await db.flush()
    return row, encode_cookie(row.id, secret)


async def revoke_session(db: AsyncSession, session_id: UUID, *, now: datetime) -> None:
    await db.execute(
        update(UserSession)
        .where(UserSession.id == session_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=now)
    )


@dataclass(frozen=True)
class SessionRefresh:
    """A session whose expiry slid during this request (set by the principal resolver)."""

    cookie_value: str
    session_id: UUID
    expires_at: datetime


class SessionRefreshMiddleware:
    """Re-sends ``rb_session``/``rb_csrf`` with the new expiry when a session slid, so an
    active user stays signed in past the first 30 days."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                refresh = scope.get("state", {}).get("session_refresh")
                headers = list(message.get("headers", []))
                sets_cookie = any(
                    k.lower() == b"set-cookie" and v.startswith(SESSION_COOKIE.encode() + b"=")
                    for k, v in headers
                )
                if isinstance(refresh, SessionRefresh) and not sets_cookie:
                    tmp = Response()
                    set_session_cookies(
                        tmp, refresh.cookie_value, refresh.session_id, refresh.expires_at
                    )
                    headers.extend((k, v) for k, v in tmp.raw_headers if k.lower() == b"set-cookie")
                    message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)
