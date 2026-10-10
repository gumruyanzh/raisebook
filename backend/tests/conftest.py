"""Test harness: real Postgres 17, one throwaway schema per pytest session (copied from smmist).

* Connects to ``RAISEBOOK_TEST_DATABASE_URL`` (default ``postgresql://localhost/raisebook_test``).
* Creates schema ``t_<pid>_<hex>`` so concurrent runs never collide, runs ``alembic upgrade
  head`` into it (the real trigger, CHECKs and partial indexes) and drops it at exit
  (``RAISEBOOK_TEST_KEEP_SCHEMA=1`` keeps it).
* ``db``: a session inside an outer transaction rolled back after each test; ``commit()``
  only releases a SAVEPOINT. The ``app`` shares it for REST and MCP requests.

Fixtures: ``db``, ``app``, ``client`` (anonymous), ``session_client(user, ws)`` (cookie +
CSRF + X-Workspace), ``key_client(key)``, ``mcp_call(key, tool, args)`` (JSON-RPC over the
real ``/mcp`` route), ``mcp_rpc(key, method, params)``, ``outbox`` (emails sent),
``frozen_now`` (fixed clock). Row builders live in ``tests/factories.py``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import asyncpg
import httpx
import pytest
import pytest_asyncio

TEST_DB_URL = os.environ.get("RAISEBOOK_TEST_DATABASE_URL", "postgresql://localhost/raisebook_test")
SCHEMA = f"t_{os.getpid()}_{secrets.token_hex(4)}"

# Must happen before anything reads settings.
os.environ.update(
    {
        "RAISEBOOK_ENVIRONMENT": "test",
        "RAISEBOOK_DATABASE_URL": TEST_DB_URL,
        "RAISEBOOK_DB_SCHEMA": SCHEMA,
        "RAISEBOOK_LOG_JSON": "false",
        "RAISEBOOK_LOG_LEVEL": "WARNING",
        "RAISEBOOK_EMAIL_BACKEND": "memory",
        "RAISEBOOK_RATE_LIMIT_BACKEND": "memory",
        "RAISEBOOK_SESSION_COOKIE_SECURE": "false",
        "RAISEBOOK_PUBLIC_BASE_URL": "http://localhost:8000",
        "RAISEBOOK_APP_URL": "http://localhost:3000",
    }
)
for _k in ("RAISEBOOK_SESSION_SECRET", "RAISEBOOK_SESSION_COOKIE_DOMAIN", "RAISEBOOK_ENV"):
    os.environ.pop(_k, None)

from alembic.config import Config  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker  # noqa: E402

from alembic import command  # noqa: E402
from raisebook.config import get_settings, reset_settings_cache  # noqa: E402
from raisebook.core import clock, ratelimit  # noqa: E402
from raisebook.core.database import build_engine, get_session, set_engine  # noqa: E402

reset_settings_cache()

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FROZEN_AT = datetime(2026, 10, 12, 17, 0, 0, tzinfo=UTC)  # a Monday, 10:00 in Los Angeles
MCP_ACCEPT = "application/json, text/event-stream"


def _pg_dsn() -> str:
    return TEST_DB_URL.replace("postgresql+asyncpg://", "postgresql://")


async def _ensure_extensions(conn: asyncpg.Connection) -> None:
    for ext in ("citext", "pg_trgm"):
        try:
            await conn.execute(f"CREATE EXTENSION IF NOT EXISTS {ext} WITH SCHEMA public")
        except (asyncpg.UniqueViolationError, asyncpg.DuplicateObjectError):
            pass  # a concurrent run created it first


def _alembic_upgrade() -> None:
    cfg = Config(os.path.join(BACKEND_DIR, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(BACKEND_DIR, "alembic"))
    cfg.attributes["schema"] = SCHEMA
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def migrated_schema() -> AsyncIterator[str]:
    conn = await asyncpg.connect(_pg_dsn())
    try:
        await _ensure_extensions(conn)
        await conn.execute(f'CREATE SCHEMA "{SCHEMA}"')
    finally:
        await conn.close()
    try:
        await asyncio.to_thread(_alembic_upgrade)
        yield SCHEMA
    finally:
        if os.environ.get("RAISEBOOK_TEST_KEEP_SCHEMA") != "1":
            conn = await asyncpg.connect(_pg_dsn())
            try:
                await conn.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
            finally:
                await conn.close()


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def engine(migrated_schema: str) -> AsyncIterator[AsyncEngine]:
    eng = build_engine(get_settings(), pool_size=8, max_overflow=4)
    set_engine(eng)
    yield eng
    set_engine(None)
    await eng.dispose()


@pytest_asyncio.fixture(loop_scope="session")
async def db(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    async with engine.connect() as conn:
        outer = await conn.begin()
        session = AsyncSession(
            bind=conn, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
        try:
            yield session
        finally:
            await session.close()
            if outer.is_active:
                await outer.rollback()


@pytest.fixture
def committing_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Real commits (rows persist in this run's schema): use fresh workspaces."""
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture(autouse=True)
def _reset_globals() -> Any:
    from raisebook.services.email import OUTBOX

    ratelimit.memory_backend().reset()
    ratelimit.set_backend(None)
    OUTBOX.clear()
    clock.freeze(None)
    yield
    clock.freeze(None)
    ratelimit.set_backend(None)
    OUTBOX.clear()


@pytest.fixture
def outbox() -> list[Any]:
    """Emails sent during the test (``OutboundEmail``: to, subject, text, link)."""
    from raisebook.services.email import OUTBOX

    return OUTBOX


@pytest.fixture
def frozen_now() -> Any:
    """Freeze the clock (REST ``get_now``, services and the MCP ``Clock``) at FROZEN_AT."""
    clock.freeze(FROZEN_AT)
    yield FROZEN_AT
    clock.freeze(None)


@pytest.fixture
def now() -> datetime:
    return clock.get_now()


@pytest.fixture
def app(db: AsyncSession) -> Any:
    from raisebook.main import create_app

    application = create_app()

    async def _session() -> AsyncIterator[AsyncSession]:
        # Production gives each request its own session; tests share the test's ``db``
        # (requests in a test are sequential).
        yield db

    application.dependency_overrides[get_session] = _session
    return application


@pytest_asyncio.fixture(loop_scope="session")
async def client(app: Any) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


def bearer(raw_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {raw_key}"}


def _raw_key(key: Any) -> str:
    if isinstance(key, str):
        return key
    if isinstance(key, tuple):
        return str(key[1])
    secret = getattr(key, "secret", None)
    if isinstance(secret, str):
        return secret
    raise TypeError("pass the plaintext key, a (ApiKey, plaintext) tuple or a CreatedKey")


SessionClientFactory = Callable[..., Awaitable[httpx.AsyncClient]]


@pytest_asyncio.fixture(loop_scope="session")
async def session_client(app: Any, db: AsyncSession) -> AsyncIterator[SessionClientFactory]:
    """``await session_client(user, ws)``: a client signed in as ``user`` (real session row,
    signed ``rb_session`` cookie), sending ``X-CSRF-Token`` and ``X-Workspace: <slug>``.
    Pass ``ws=None`` to omit X-Workspace and ``csrf=False`` to omit the CSRF header."""
    from raisebook.auth.session import (
        CSRF_HEADER,
        SESSION_COOKIE,
        WORKSPACE_HEADER,
        create_user_session,
        csrf_token_for,
    )

    clients: list[httpx.AsyncClient] = []

    async def make(user: Any, ws: Any = None, *, csrf: bool = True) -> httpx.AsyncClient:
        sess, cookie = await create_user_session(db, user, now=clock.get_now())
        headers: dict[str, str] = {}
        if csrf:
            headers[CSRF_HEADER] = csrf_token_for(sess.id)
        if ws is not None:
            headers[WORKSPACE_HEADER] = str(getattr(ws, "slug", ws))
        c = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers=headers,
            cookies={SESSION_COOKIE: cookie},
        )
        c.session_id = sess.id  # type: ignore[attr-defined]
        clients.append(c)
        return c

    yield make
    for c in clients:
        await c.aclose()


KeyClientFactory = Callable[..., httpx.AsyncClient]


@pytest_asyncio.fixture(loop_scope="session")
async def key_client(app: Any) -> AsyncIterator[KeyClientFactory]:
    """``key_client(key, headers=None)``: a client sending ``Authorization: Bearer <key>``."""
    clients: list[httpx.AsyncClient] = []

    def make(key: Any, headers: dict[str, str] | None = None) -> httpx.AsyncClient:
        c = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers={**bearer(_raw_key(key)), **(headers or {})},
        )
        clients.append(c)
        return c

    yield make
    for c in clients:
        await c.aclose()


@dataclass
class ToolResult:
    """The outcome of one MCP ``tools/call``."""

    ok: bool
    data: Any  # structured result (dict) when ok
    text: str  # the text content (the error message when not ok)
    raw: dict[str, Any]

    @property
    def code(self) -> str | None:
        """The error code before ``:`` in a tool error (``not_found``, ``insufficient_scope``…)."""
        if self.ok:
            return None
        return tool_error_text(self.text).split(":", 1)[0].strip() or None

    @property
    def message(self) -> str:
        """The error text without the SDK's ``Error executing tool <name>:`` prefix."""
        return tool_error_text(self.text)


_SDK_PREFIX = re.compile(r"^Error executing tool [^:]+:\s*")


def tool_error_text(text: str) -> str:
    return _SDK_PREFIX.sub("", text, count=1)


async def _mcp_post(
    app: Any, raw_key: str | None, payload: dict[str, Any], headers: dict[str, str] | None
) -> httpx.Response:
    from raisebook.mcp.server import create_mcp_server

    server = create_mcp_server()
    server.streamable_http_app()
    app.state.mcp_server = server  # a session manager runs once; use a fresh one per call
    hdrs = {"accept": MCP_ACCEPT, "content-type": "application/json", **(headers or {})}
    if raw_key is not None:
        hdrs.update(bearer(raw_key))
    async with (
        server.session_manager.run(),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as c,
    ):
        return await c.post("/mcp", content=json.dumps(payload), headers=hdrs)


McpRpc = Callable[..., Awaitable[httpx.Response]]
McpCall = Callable[..., Awaitable[ToolResult]]


@pytest.fixture
def mcp_rpc(app: Any) -> McpRpc:
    """``await mcp_rpc(key, method, params=None, headers=None)`` → the raw HTTP response of
    one JSON-RPC request to the real ``/mcp`` route (key may be None for no auth)."""

    async def call(
        key: Any, method: str, params: dict[str, Any] | None = None, headers: Any = None
    ) -> httpx.Response:
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
        return await _mcp_post(app, None if key is None else _raw_key(key), payload, headers)

    return call


@pytest.fixture
def mcp_call(app: Any) -> McpCall:
    """``await mcp_call(key, tool, args=None, headers=None)`` → :class:`ToolResult`.

    One ``tools/call`` JSON-RPC request over the real ``/mcp`` route (stateless server,
    no initialize needed). Pass ``headers={"X-Agent-Name": …, "X-Agent-Model": …}``.
    """

    async def call(
        key: Any, tool: str, args: dict[str, Any] | None = None, headers: Any = None
    ) -> ToolResult:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool, "arguments": args or {}},
        }
        resp = await _mcp_post(app, _raw_key(key), payload, headers)
        assert resp.status_code == 200, (resp.status_code, resp.text)
        body = resp.json()
        if "error" in body:
            err = body["error"]
            return ToolResult(False, None, f"{err.get('message', '')}", body)
        result = body["result"]
        text = " ".join(c.get("text", "") for c in result.get("content", []))
        if result.get("isError"):
            return ToolResult(False, None, text, body)
        data = result.get("structuredContent")
        if data is None and text:
            try:
                data = json.loads(text)
            except ValueError:
                data = text
        return ToolResult(True, data, text, body)

    return call
