"""Fixed-window rate limits (SPEC §7).

Backends (``RAISEBOOK_RATE_LIMIT_BACKEND``):

- ``postgres`` (default): counters in the UNLOGGED ``rate_limit_counters`` table,
  so limits hold across API replicas. Each hit runs on its own autocommitted
  connection, so a request that later fails still counts.
- ``memory``: a per-process dict (tests, single-process dev).
- ``off``: never limits.

Use :func:`rate_limit` as a FastAPI dependency (``Depends(rate_limit("import"))``),
:func:`enforce` from code, and :func:`check` where going over the limit must not
fail the request (magic links answer 202 regardless). API-key and session buckets
are enforced automatically by ``auth.principal.get_principal``; MCP tool calls by
``mcp.tools._common.tool_call``. The last result is stored on the request and
:class:`RateLimitHeadersMiddleware` turns it into ``RateLimit-*`` headers.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol

from fastapi import Request
from sqlalchemy import text
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from raisebook.config import get_settings
from raisebook.core.clock import get_now
from raisebook.core.errors import RateLimited

BucketKind = Literal[
    "key_read",
    "key_write",
    "session",
    "import",
    "export",
    "magic_email",
    "magic_ip",
    "invite",
    "anon_ip",
    "mcp_protocol",
    "auth_fail",
    "invite_user",
    "invite_user_new",
    "ai_key",
]


@dataclass(frozen=True)
class Limit:
    limit: int
    window_s: int


# SPEC §7. Tests may patch entries (``monkeypatch.setitem(LIMITS, "key_read", Limit(2, 60))``).
LIMITS: dict[str, Limit] = {
    "key_read": Limit(600, 60),
    "key_write": Limit(120, 60),
    "session": Limit(1200, 60),
    "import": Limit(30, 3600),
    "export": Limit(60, 3600),
    "magic_email": Limit(5, 900),
    "magic_ip": Limit(30, 3600),
    "invite": Limit(50, 86400),
    "anon_ip": Limit(120, 60),
    "mcp_protocol": Limit(300, 60),
    # Requests that present an API key which does not authenticate, per client IP.
    "auth_fail": Limit(60, 60),
    # Invites sent by one person across all their workspaces (per day); accounts younger
    # than a day get the tighter ``invite_user_new`` bucket on top.
    "invite_user": Limit(20, 86400),
    "invite_user_new": Limit(5, 86400),
    # Saving an OpenRouter key calls OpenRouter: per workspace, per hour.
    "ai_key": Limit(10, 3600),
}


@dataclass(frozen=True)
class RateResult:
    allowed: bool
    limit: int
    remaining: int
    reset_s: int  # seconds until the window resets

    def headers(self) -> dict[str, str]:
        return {
            "RateLimit-Limit": str(self.limit),
            "RateLimit-Remaining": str(self.remaining),
            "RateLimit-Reset": str(self.reset_s),
        }


class Backend(Protocol):
    async def hit(self, bucket: str, window_start: datetime) -> int: ...


class OffBackend:
    async def hit(self, bucket: str, window_start: datetime) -> int:
        return 0


class MemoryBackend:
    def __init__(self) -> None:
        self.counts: dict[tuple[str, datetime], int] = {}
        self._lock = asyncio.Lock()

    async def hit(self, bucket: str, window_start: datetime) -> int:
        async with self._lock:
            key = (bucket, window_start)
            self.counts[key] = self.counts.get(key, 0) + 1
            return self.counts[key]

    def reset(self) -> None:
        self.counts.clear()


class PostgresBackend:
    SQL = text(
        "INSERT INTO rate_limit_counters (bucket, window_start, count) "
        "VALUES (:bucket, :window_start, 1) "
        "ON CONFLICT (bucket, window_start) "
        "DO UPDATE SET count = rate_limit_counters.count + 1 RETURNING count"
    )

    async def hit(self, bucket: str, window_start: datetime) -> int:
        from raisebook.core.database import get_ratelimit_engine

        async with get_ratelimit_engine().begin() as conn:
            value = await conn.scalar(self.SQL, {"bucket": bucket, "window_start": window_start})
        return int(value or 0)


_memory = MemoryBackend()
_override: Backend | None = None


def memory_backend() -> MemoryBackend:
    return _memory


def set_backend(backend: Backend | None) -> None:
    """Force a backend (tests); ``None`` returns to ``RAISEBOOK_RATE_LIMIT_BACKEND``."""
    global _override
    _override = backend


def get_backend() -> Backend:
    if _override is not None:
        return _override
    name = get_settings().rate_limit_backend
    if name == "off":
        return OffBackend()
    if name == "memory":
        return _memory
    return PostgresBackend()


def window_start(now: datetime, window_s: int) -> datetime:
    epoch = math.floor(now.timestamp() / window_s) * window_s
    return datetime.fromtimestamp(epoch, UTC)


async def check(kind: BucketKind, subject: str, *, now: datetime | None = None) -> RateResult:
    """Count one hit on ``kind:subject`` and say whether it is within the limit."""
    lim = LIMITS[kind]
    ts = now or get_now()
    start = window_start(ts, lim.window_s)
    backend = get_backend()
    if isinstance(backend, OffBackend):
        return RateResult(True, lim.limit, lim.limit, lim.window_s)
    count = await backend.hit(f"{kind}:{subject}", start)
    reset = max(1, math.ceil((start + timedelta(seconds=lim.window_s) - ts).total_seconds()))
    return RateResult(count <= lim.limit, lim.limit, max(0, lim.limit - count), reset)


def remember(request: Request | None, result: RateResult) -> None:
    if request is not None:
        request.state.ratelimit = result


async def enforce(
    kind: BucketKind,
    subject: str,
    *,
    request: Request | None = None,
    now: datetime | None = None,
) -> RateResult:
    """Like :func:`check`, but raise 429 ``rate_limited`` (with ``Retry-After``) when over."""
    result = await check(kind, subject, now=now)
    remember(request, result)
    if not result.allowed:
        raise RateLimited(result.reset_s, headers=result.headers())
    return result


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


_WORKSPACE_KINDS = frozenset({"import", "export", "invite"})


def rate_limit(kind: BucketKind) -> Any:
    """FastAPI dependency factory.

    Workspace buckets (``import``, ``export``, ``invite``) count per the caller's
    workspace (place it after the principal dependency); IP buckets per client IP.
    """

    async def _dep(request: Request) -> RateResult:
        if kind in _WORKSPACE_KINDS:
            principal = getattr(request.state, "principal", None)
            subject = str(principal.workspace_id) if principal is not None else client_ip(request)
        else:
            subject = client_ip(request)
        return await enforce(kind, subject, request=request)

    return _dep


async def delete_old_windows(older_than: datetime) -> int:
    """Housekeeping: drop Postgres windows that started before ``older_than``."""
    from raisebook.core.database import get_engine

    async with get_engine().begin() as conn:
        result = await conn.execute(
            text("DELETE FROM rate_limit_counters WHERE window_start < :t"), {"t": older_than}
        )
    return int(getattr(result, "rowcount", 0) or 0)


class RateLimitHeadersMiddleware:
    """Adds ``RateLimit-*`` headers from the request's last rate-limit result."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                result = scope.get("state", {}).get("ratelimit")
                if isinstance(result, RateResult):
                    headers = list(message.get("headers", []))
                    present = {k.lower() for k, _ in headers}
                    for k, v in result.headers().items():
                        if k.lower().encode() not in present:
                            headers.append((k.lower().encode(), v.encode()))
                    message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)
