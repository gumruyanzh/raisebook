"""MCP transport auth (SPEC §6.1), adapted from smmist ``mcp/auth.py``.

``/mcp`` accepts any valid Raisebook API key (``Authorization: Bearer rb_live_…``
or ``X-API-Key``). The key is resolved exactly like REST
(``auth.principal.principal_from_api_key``: sha256 lookup, revoked, expired and
wrong-mode keys rejected, throttled ``last_used_at``) and exposed to tool
handlers through the SDK's auth context as a :class:`RaisebookAccessToken`.
Sessions (cookies) are never accepted here.

Stack: authentication backend → auth-context contextvar → require auth (401 +
``WWW-Authenticate``) → protocol rate limit (300/min per key for messages that
are not tool calls; tool calls are limited per tool in ``tools._common``) → the
SDK. Any lookup error fails closed.

The DB session comes from the hosting app's ``get_session`` dependency (honouring
``dependency_overrides``), so tests share their transaction with MCP calls.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any
from uuid import UUID

import structlog
from mcp.server.auth.middleware.auth_context import AuthContextMiddleware, get_access_token
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser, RequireAuthMiddleware
from mcp.server.auth.provider import AccessToken
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.authentication import AuthCredentials, AuthenticationBackend
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from raisebook.auth.principal import Principal, WorkspaceInfo, principal_from_api_key
from raisebook.auth.scopes import SCOPE_READ, canonical_order
from raisebook.core import ratelimit
from raisebook.core.clock import get_now
from raisebook.core.database import get_session
from raisebook.core.errors import APIError, RateLimited, error_body
from raisebook.models.enums import ActorType, KeyMode

log = structlog.get_logger(__name__)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


class RaisebookAccessToken(AccessToken):
    """The SDK AccessToken plus the Raisebook identity tool handlers act as."""

    workspace_id: str
    workspace_slug: str
    workspace_name: str
    timezone: str
    currency: str
    is_sandbox: bool
    api_key_id: str
    key_prefix: str
    key_name: str
    key_agent_name: str | None = None
    key_mode: str = "live"


def session_factory_for(app: Any) -> SessionFactory:
    """A session context manager built from ``app``'s ``get_session`` dependency."""
    overrides = getattr(app, "dependency_overrides", None) or {}
    dep = overrides.get(get_session, get_session)
    return asynccontextmanager(dep)


@asynccontextmanager
async def app_session(app: Any) -> AsyncIterator[AsyncSession]:
    async with session_factory_for(app)() as db:
        yield db


def principal_to_token(principal: Principal, token: str) -> RaisebookAccessToken:
    ws = principal.workspace
    return RaisebookAccessToken(
        token=token,
        client_id=f"api_key:{principal.api_key_id}",
        scopes=canonical_order(principal.scopes),
        workspace_id=str(ws.id),
        workspace_slug=ws.slug,
        workspace_name=ws.name,
        timezone=ws.timezone,
        currency=ws.currency,
        is_sandbox=ws.is_sandbox,
        api_key_id=str(principal.api_key_id),
        key_prefix=principal.key_prefix or "",
        key_name=principal.key_name or "",
        key_agent_name=principal.key_agent_name,
        key_mode=(principal.key_mode or KeyMode.LIVE).value,
    )


def token_to_principal(token: AccessToken) -> Principal | None:
    if not isinstance(token, RaisebookAccessToken):
        return None
    return Principal(
        type=ActorType.AGENT,
        workspace=WorkspaceInfo(
            id=UUID(token.workspace_id),
            slug=token.workspace_slug,
            name=token.workspace_name,
            timezone=token.timezone,
            currency=token.currency,
            is_sandbox=token.is_sandbox,
        ),
        scopes=frozenset(token.scopes),
        api_key_id=UUID(token.api_key_id),
        key_prefix=token.key_prefix,
        key_name=token.key_name,
        key_agent_name=token.key_agent_name,
        key_mode=KeyMode(token.key_mode),
    )


def current_principal() -> Principal | None:
    """The authenticated caller for the tool handler running right now."""
    token = get_access_token()
    return token_to_principal(token) if token is not None else None


def _credential(conn: HTTPConnection) -> str | None:
    auth = conn.headers.get("authorization")
    if auth:
        scheme, _, value = auth.partition(" ")
        return value.strip() if scheme.lower() == "bearer" and value.strip() else None
    key = conn.headers.get("x-api-key")
    return key.strip() if key else None


class ApiKeyAuthBackend(AuthenticationBackend):
    """Starlette auth backend: resolves the API key with the app's own DB session."""

    async def authenticate(
        self, conn: HTTPConnection
    ) -> tuple[AuthCredentials, AuthenticatedUser] | None:
        credential = _credential(conn)
        if not credential:
            return None
        try:
            async with session_factory_for(conn.scope.get("app"))() as db:
                principal = await principal_from_api_key(db, credential, now=get_now())
                await db.commit()  # persist the throttled last_used_at touch
        except APIError:
            return None
        except Exception as exc:  # fail closed on DB errors; never log the key
            log.warning("mcp_key_verification_failed", exc_type=type(exc).__name__)
            return None
        state = conn.scope.setdefault("state", {})
        state["workspace_id"] = str(principal.workspace_id)
        state["actor_type"] = principal.type.value
        state["key_prefix"] = principal.key_prefix
        token = principal_to_token(principal, credential)
        return AuthCredentials(token.scopes), AuthenticatedUser(token)


def _jsonrpc_methods(body: bytes) -> list[str]:
    try:
        payload = json.loads(body or b"null")
    except ValueError:
        return []
    items = payload if isinstance(payload, list) else [payload]
    return [str(i.get("method")) for i in items if isinstance(i, dict) and i.get("method")]


class ProtocolRateLimit:
    """Counts MCP protocol messages that are not tool calls (300/min per key)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        chunks: list[bytes] = []
        more = True
        while more:
            message = await receive()
            if message["type"] != "http.request":
                break
            chunks.append(message.get("body", b""))
            more = bool(message.get("more_body"))
        body = b"".join(chunks)
        methods = _jsonrpc_methods(body) if scope.get("method") == "POST" else ["(stream)"]
        principal = current_principal()
        if principal is not None and any(m != "tools/call" for m in methods):
            try:
                await ratelimit.enforce("mcp_protocol", str(principal.api_key_id))
            except RateLimited as exc:
                resp = JSONResponse(
                    error_body(exc.code, exc.message, exc.details),
                    status_code=429,
                    headers=exc.headers,
                )
                await resp(scope, receive, send)
                return
        sent = False

        async def replay() -> Message:
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def build_guarded_mcp_asgi(handler: ASGIApp) -> ASGIApp:
    """Wrap the raw /mcp handler: authenticate → auth context → require a key → limit."""
    guarded: ASGIApp = ProtocolRateLimit(handler)
    guarded = RequireAuthMiddleware(guarded, required_scopes=[SCOPE_READ])
    guarded = AuthContextMiddleware(guarded)
    return AuthenticationMiddleware(guarded, backend=ApiKeyAuthBackend())
