"""API keys (SPEC §4.4): ``rb_live_`` / ``rb_test_`` + 32 base62 chars.

Only the sha256 is stored; the plaintext is returned once, at creation.
``key_prefix`` (first 12 chars) identifies a key in the UI and in logs. Live keys
belong to real workspaces and test keys to sandbox workspaces; a key whose mode
does not match its workspace never authenticates.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import string
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.enums import KeyMode
from raisebook.models.workspace import ApiKey, Workspace

PREFIXES: dict[KeyMode, str] = {KeyMode.LIVE: "rb_live_", KeyMode.TEST: "rb_test_"}
SECRET_LEN = 32
DISPLAY_PREFIX_LEN = 12
_BASE62 = string.ascii_letters + string.digits


@dataclass(frozen=True)
class GeneratedKey:
    plaintext: str
    digest: bytes
    prefix: str


@dataclass(frozen=True)
class AuthenticatedKey:
    key: ApiKey
    workspace: Workspace


def hash_api_key(raw: str) -> bytes:
    return hashlib.sha256(raw.encode()).digest()


def key_mode(raw: str) -> KeyMode | None:
    """The mode a well-formed key implies, else None (cheap check before any lookup)."""
    for mode, prefix in PREFIXES.items():
        if raw.startswith(prefix):
            body = raw[len(prefix) :]
            if len(body) == SECRET_LEN and all(c in _BASE62 for c in body):
                return mode
    return None


def looks_like_api_key(raw: str) -> bool:
    return raw.startswith(tuple(PREFIXES.values()))


def generate_api_key(mode: KeyMode) -> GeneratedKey:
    body = "".join(secrets.choice(_BASE62) for _ in range(SECRET_LEN))
    raw = PREFIXES[mode] + body
    return GeneratedKey(raw, hash_api_key(raw), raw[:DISPLAY_PREFIX_LEN])


async def authenticate_api_key(
    db: AsyncSession, raw: str, *, now: datetime, touch_interval_s: int = 60
) -> AuthenticatedKey | None:
    """Resolve a presented key to an active key and its workspace, or None.

    None covers unknown, malformed, revoked, expired and wrong-mode keys alike.
    ``last_used_at`` is touched at most once per ``touch_interval_s``.
    """
    mode = key_mode(raw)
    if mode is None:
        return None
    digest = hash_api_key(raw)
    row = (
        await db.execute(
            select(ApiKey, Workspace)
            .join(Workspace, Workspace.id == ApiKey.workspace_id)
            .where(ApiKey.key_hash == digest)
        )
    ).one_or_none()
    if row is None:
        return None
    key, workspace = row[0], row[1]
    if not hmac.compare_digest(bytes(key.key_hash), digest):
        return None
    if key.revoked_at is not None and key.revoked_at <= now:
        return None
    if key.expires_at is not None and key.expires_at <= now:
        return None
    if key.mode != mode.value:
        return None
    expected = KeyMode.TEST if workspace.is_sandbox else KeyMode.LIVE
    if mode != expected:
        return None
    if key.last_used_at is None or now - key.last_used_at >= timedelta(seconds=touch_interval_s):
        await db.execute(update(ApiKey).where(ApiKey.id == key.id).values(last_used_at=now))
        key.last_used_at = now
    return AuthenticatedKey(key, workspace)
