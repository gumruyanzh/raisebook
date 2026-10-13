"""Magic-link tokens (SPEC §4.1).

A token is 32 random bytes (base64url) emailed as
``${RAISEBOOK_APP_URL}/auth/verify?token=<token>``; only its sha256 is stored. It
lives 15 minutes and is consumed atomically (``UPDATE … WHERE consumed_at IS NULL
AND expires_at > now RETURNING``), so two clicks can never yield two sessions.
The web page shows "Sign in as j***@example.com" (from the non-consuming
``GET /v1/auth/verify/peek``) and POSTs the token (``POST /v1/auth/verify``) only
when the person clicks Continue, so link scanners, including ones that run
JavaScript, cannot burn it.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlencode
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.config import get_settings
from raisebook.models.user import LoginToken

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
MAX_TOKEN_LEN = 200


def hash_token(raw: str) -> bytes:
    return hashlib.sha256(raw.encode()).digest()


def new_token() -> tuple[str, bytes]:
    raw = secrets.token_urlsafe(32)
    return raw, hash_token(raw)


def normalize_email(raw: str) -> str | None:
    """Lowercased, trimmed email, or None when it is not a plausible address."""
    email = raw.strip().lower()
    if len(email) > 254 or not EMAIL_RE.match(email):
        return None
    return email


_DOTLESS_DOMAINS = {"gmail.com": "gmail.com", "googlemail.com": "gmail.com"}


def mailbox_key(email: str) -> str:
    """The inbox an address delivers to, for rate limits only (the address is stored as
    typed): ``+tags`` are dropped, and for Gmail the dots too (``j.doe+x@gmail.com`` and
    ``jdoe@googlemail.com`` are one inbox)."""
    local, _, domain = email.strip().lower().rpartition("@")
    local = local.split("+", 1)[0]
    if domain in _DOTLESS_DOMAINS:
        local = local.replace(".", "")
        domain = _DOTLESS_DOMAINS[domain]
    return f"{local}@{domain}"


def safe_redirect_path(raw: str | None) -> str | None:
    """Only same-app relative paths survive (no open redirects)."""
    if not raw:
        return None
    if not raw.startswith("/") or raw.startswith(("//", "/\\")) or len(raw) > 500:
        return None
    if any(c in raw for c in ("\r", "\n", "\\")) or not raw.isprintable():
        return None
    return raw


def verify_url(raw_token: str) -> str:
    base = get_settings().app_url.rstrip("/")
    return f"{base}/auth/verify?{urlencode({'token': raw_token})}"


@dataclass(frozen=True)
class IssuedToken:
    raw: str
    row: LoginToken
    link: str


async def recent_token_count(db: AsyncSession, email: str, *, now: datetime) -> int:
    window = timedelta(minutes=get_settings().magic_link_ttl_minutes)
    count = await db.scalar(
        select(func.count())
        .select_from(LoginToken)
        .where(LoginToken.email == email, LoginToken.created_at > now - window)
    )
    return int(count or 0)


async def issue_login_token(
    db: AsyncSession,
    email: str,
    *,
    now: datetime,
    redirect_path: str | None = None,
    invite_id: UUID | None = None,
    ip: str | None = None,
) -> IssuedToken:
    raw, digest = new_token()
    row = LoginToken(
        email=email,
        token_hash=digest,
        redirect_path=safe_redirect_path(redirect_path),
        invite_id=invite_id,
        requested_ip=ip,
        created_at=now,
        expires_at=now + timedelta(minutes=get_settings().magic_link_ttl_minutes),
    )
    db.add(row)
    await db.flush()
    return IssuedToken(raw=raw, row=row, link=verify_url(raw))


async def consume_login_token(db: AsyncSession, raw: str, *, now: datetime) -> LoginToken | None:
    """Spend a token exactly once. None when unknown, used or expired."""
    if not raw or len(raw) > MAX_TOKEN_LEN:
        return None
    result = await db.execute(
        update(LoginToken)
        .where(
            LoginToken.token_hash == hash_token(raw),
            LoginToken.consumed_at.is_(None),
            LoginToken.expires_at > now,
        )
        .values(consumed_at=now)
        .returning(LoginToken)
        .execution_options(synchronize_session=False)
    )
    return result.scalar_one_or_none()


async def peek_login_token(db: AsyncSession, raw: str, *, now: datetime) -> LoginToken | None:
    """The live (unused, unexpired) token row for ``raw``, without spending it."""
    if not raw or len(raw) > MAX_TOKEN_LEN:
        return None
    row: LoginToken | None = await db.scalar(
        select(LoginToken).where(
            LoginToken.token_hash == hash_token(raw),
            LoginToken.consumed_at.is_(None),
            LoginToken.expires_at > now,
        )
    )
    return row
