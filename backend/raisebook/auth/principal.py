"""Who is calling, in which workspace, with which scopes (SPEC §4.3 to §4.7).

Credentials, in order:

1. ``Authorization: Bearer rb_live_…|rb_test_…`` or ``X-API-Key``: the key's
   workspace. ``X-Workspace`` is ignored. Scopes come from the key.
2. The ``rb_session`` cookie (only when no API credential is sent). The workspace
   comes from ``X-Workspace`` (id or slug) checked against the user's
   memberships: not a member → 404 ``workspace_not_found``; no header and exactly
   one workspace → that one; otherwise 400 ``workspace_required``. Scopes come
   from the role. Unsafe methods pass the CSRF check.

FastAPI dependencies exposed to feature modules:

- :func:`get_principal`: authenticate (+ rate limit), no scope check.
- :func:`require_scopes`: ``Depends(require_scopes(SCOPE_WRITE))``.
- :func:`require_owner_session`: owner signed in through the web (keys, members, delete).
- :func:`get_workspace_ctx` / :func:`workspace_ctx`: a :class:`WorkspaceContext`
  (workspace id, timezone, currency, principal, actor) for service calls.
- :func:`get_session_user`: org-less session endpoints (``/v1/me``, ``/v1/workspaces``…).

A missing scope is 403 ``insufficient_scope`` for keys and ``forbidden_role`` for
sessions, with ``details.required``. Ids from another workspace are 404.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import Depends, Request
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.api_keys import authenticate_api_key
from raisebook.auth.scopes import (
    ROLE_SCOPES,
    SCOPE_READ,
    SCOPE_WRITE,
    canonical_order,
    granted_scopes,
    missing_scopes,
)
from raisebook.auth.session import (
    SESSION_COOKIE,
    WORKSPACE_HEADER,
    SessionRefresh,
    check_csrf,
    has_api_credential,
    load_session_detail,
)
from raisebook.config import get_settings
from raisebook.core import ratelimit
from raisebook.core.actor import (
    AGENT_MODEL_HEADER,
    AGENT_NAME_HEADER,
    Actor,
    agent_actor,
    user_actor,
)
from raisebook.core.clock import get_now
from raisebook.core.database import get_session
from raisebook.core.errors import (
    ForbiddenRole,
    InsufficientScope,
    InvalidApiKey,
    SessionInvalid,
    Unauthorized,
    WorkspaceNotFound,
    WorkspaceRequired,
)
from raisebook.models.enums import ActorType, KeyMode, Role, Via
from raisebook.models.user import User, UserSession
from raisebook.models.workspace import Membership, Workspace

OWNER_SESSION = "owner_session"


@dataclass(frozen=True)
class WorkspaceInfo:
    """A snapshot of the caller's workspace (no ORM object travels with the principal)."""

    id: UUID
    slug: str
    name: str
    timezone: str
    currency: str
    is_sandbox: bool

    @classmethod
    def of(cls, ws: Workspace) -> WorkspaceInfo:
        return cls(
            id=ws.id,
            slug=str(ws.slug),
            name=ws.name,
            timezone=ws.timezone,
            currency=ws.default_currency,
            is_sandbox=ws.is_sandbox,
        )


@dataclass(frozen=True)
class Principal:
    type: ActorType  # USER (session) or AGENT (API key)
    workspace: WorkspaceInfo
    scopes: frozenset[str]
    user_id: UUID | None = None
    session_id: UUID | None = None
    role: Role | None = None
    api_key_id: UUID | None = None
    key_prefix: str | None = None
    key_name: str | None = None
    key_agent_name: str | None = None
    key_mode: KeyMode | None = None

    @property
    def workspace_id(self) -> UUID:
        return self.workspace.id

    @property
    def is_session(self) -> bool:
        return self.type == ActorType.USER

    @property
    def is_key(self) -> bool:
        return self.type == ActorType.AGENT

    def has(self, *scopes: str) -> bool:
        return not missing_scopes(self.scopes, *scopes)

    def require(self, *scopes: str) -> None:
        missing = missing_scopes(self.scopes, *scopes)
        if not missing:
            return
        details = {"required": list(scopes), "missing": missing}
        if self.is_key:
            raise InsufficientScope(
                f"This API key lacks {', '.join(missing)}. Create a key with that scope in "
                "Settings → API keys.",
                details=details,
            )
        role = self.role.value if self.role else "member"
        raise ForbiddenRole(
            f"Your role ({role}) cannot do this. Ask a workspace owner.", details=details
        )

    def require_owner_session(self) -> None:
        details = {"required": [OWNER_SESSION]}
        if self.is_key:
            raise InsufficientScope(
                "Only a workspace owner signed in to the web app can do this; API keys cannot.",
                details=details,
            )
        if self.role != Role.OWNER:
            role = self.role.value if self.role else "member"
            raise ForbiddenRole(
                f"Only a workspace owner can do this (your role is {role}).", details=details
            )

    def actor(self, *, via: Via | None = None, headers: dict[str, str] | None = None) -> Actor:
        """The :class:`Actor` for writes made by this principal."""
        if self.is_session:
            assert self.user_id is not None
            return user_actor(self.user_id)
        assert self.api_key_id is not None and self.key_name is not None
        h = headers or {}
        return agent_actor(
            api_key_id=self.api_key_id,
            key_name=self.key_name,
            key_agent_name=self.key_agent_name,
            header_name=h.get(AGENT_NAME_HEADER.lower()),
            header_model=h.get(AGENT_MODEL_HEADER.lower()),
            via=via or Via.API,
        )


@dataclass(frozen=True)
class WorkspaceContext:
    """What every workspace-scoped service function takes (never a raw workspace id)."""

    workspace_id: UUID
    timezone: str
    currency: str
    principal: Principal
    actor: Actor
    slug: str = ""
    name: str = ""
    is_sandbox: bool = False

    def today(self, now: datetime) -> date:
        """Today's date in the workspace timezone."""
        return now.astimezone(ZoneInfo(self.timezone)).date()

    @classmethod
    def build(cls, principal: Principal, actor: Actor) -> WorkspaceContext:
        ws = principal.workspace
        return cls(
            workspace_id=ws.id,
            timezone=ws.timezone,
            currency=ws.currency,
            principal=principal,
            actor=actor,
            slug=ws.slug,
            name=ws.name,
            is_sandbox=ws.is_sandbox,
        )


@dataclass(frozen=True)
class SessionUser:
    session: UserSession
    user: User


def extract_credential(request: Request) -> str | None:
    auth = request.headers.get("authorization")
    if auth:
        scheme, _, token = auth.partition(" ")
        if scheme.lower() == "bearer" and token.strip():
            return token.strip()
        return None
    api_key = request.headers.get("x-api-key")
    return api_key.strip() if api_key else None


async def principal_from_api_key(db: AsyncSession, raw: str | None, *, now: datetime) -> Principal:
    """Resolve an API key to a principal; 401 ``invalid_api_key`` on any failure."""
    if not raw:
        raise InvalidApiKey("Send an API key as 'Authorization: Bearer rb_live_…'.")
    found = await authenticate_api_key(
        db, raw, now=now, touch_interval_s=get_settings().api_key_touch_interval_s
    )
    if found is None:
        raise InvalidApiKey()
    key = found.key
    return Principal(
        type=ActorType.AGENT,
        workspace=WorkspaceInfo.of(found.workspace),
        scopes=granted_scopes(key.scopes),
        api_key_id=key.id,
        key_prefix=key.key_prefix,
        key_name=key.name,
        key_agent_name=key.agent_name,
        key_mode=KeyMode(key.mode),
    )


async def user_workspaces(db: AsyncSession, user_id: UUID) -> list[tuple[Workspace, Role]]:
    """``(workspace, role)`` for each of the user's memberships, oldest membership first."""
    rows = await db.execute(
        select(Workspace, Membership.role)
        .join(Membership, Membership.workspace_id == Workspace.id)
        .where(Membership.user_id == user_id)
        .order_by(Membership.created_at, Workspace.created_at, Workspace.id)
    )
    return [(ws, Role(role)) for ws, role in rows.tuples()]


def _as_uuid(value: str) -> UUID | None:
    try:
        return UUID(value)
    except ValueError:
        return None


async def resolve_session_workspace(
    db: AsyncSession, user_id: UUID, wanted: str | None
) -> tuple[Workspace, Role]:
    wanted = (wanted or "").strip()
    if wanted:
        as_id = _as_uuid(wanted)
        cond = Workspace.slug == wanted.lower()
        stmt = (
            select(Workspace, Membership.role)
            .join(Membership, Membership.workspace_id == Workspace.id)
            .where(
                Membership.user_id == user_id,
                or_(cond, Workspace.id == as_id) if as_id is not None else cond,
            )
        )
        row = (await db.execute(stmt)).one_or_none()
        if row is None:
            raise WorkspaceNotFound()
        return row[0], Role(row[1])
    mine = await user_workspaces(db, user_id)
    if len(mine) == 1:
        return mine[0]
    if not mine:
        raise WorkspaceRequired(
            "You have no workspace yet. Create one with POST /v1/workspaces.",
        )
    raise WorkspaceRequired()


async def _session_or_401(request: Request, db: AsyncSession, now: datetime) -> SessionUser:
    cookie = request.cookies.get(SESSION_COOKIE)
    loaded = await load_session_detail(db, cookie, now=now)
    if loaded is None or cookie is None:
        raise SessionInvalid()
    check_csrf(request, loaded.session.id)
    if loaded.touched:  # the expiry slid: refresh the cookies too
        request.state.session_refresh = SessionRefresh(
            cookie, loaded.session.id, loaded.session.expires_at
        )
    return SessionUser(loaded.session, loaded.user)


async def get_session_user(
    request: Request,
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> SessionUser:
    """Org-less session endpoints: a valid cookie (CSRF-checked on unsafe methods).

    API keys are refused: these endpoints act on a person's account.
    """
    if has_api_credential(request):
        raise Unauthorized("This endpoint needs a signed-in session; API keys cannot use it.")
    if SESSION_COOKIE not in request.cookies:
        raise SessionInvalid("Sign in first.")
    su = await _session_or_401(request, db, now)
    await ratelimit.enforce("session", str(su.user.id), request=request, now=now)
    await db.commit()  # persist the sliding-expiry touch
    request.state.actor_type = ActorType.USER.value
    return su


async def get_principal(
    request: Request,
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Principal:
    """Authenticate the caller for a workspace endpoint (no scope check)."""
    if not has_api_credential(request) and SESSION_COOKIE in request.cookies:
        su = await _session_or_401(request, db, now)
        ws, role = await resolve_session_workspace(
            db, su.user.id, request.headers.get(WORKSPACE_HEADER)
        )
        principal = Principal(
            type=ActorType.USER,
            workspace=WorkspaceInfo.of(ws),
            scopes=ROLE_SCOPES[role],
            user_id=su.user.id,
            session_id=su.session.id,
            role=role,
        )
        await ratelimit.enforce("session", str(su.user.id), request=request, now=now)
    else:
        credential = extract_credential(request)
        if credential is None and not has_api_credential(request):
            raise Unauthorized()
        principal = await principal_from_api_key(db, credential, now=now)
        kind: ratelimit.BucketKind = (
            "key_read" if request.method.upper() in ("GET", "HEAD", "OPTIONS") else "key_write"
        )
        await ratelimit.enforce(kind, str(principal.api_key_id), request=request, now=now)
    await db.commit()  # persist throttled last_used_at / last_seen_at touches
    request.state.principal = principal
    request.state.workspace_id = str(principal.workspace_id)
    request.state.actor_type = principal.type.value
    request.state.key_prefix = principal.key_prefix
    return principal


def require_scopes(*scopes: str) -> Callable[..., Awaitable[Principal]]:
    """Dependency factory: ``principal = Depends(require_scopes(SCOPE_WRITE))``."""

    async def _dep(principal: Principal = Depends(get_principal)) -> Principal:
        principal.require(*scopes)
        return principal

    return _dep


def require_owner_session() -> Callable[..., Awaitable[Principal]]:
    """Dependency factory: an owner signed in through the web (never an API key)."""

    async def _dep(principal: Principal = Depends(get_principal)) -> Principal:
        principal.require_owner_session()
        return principal

    return _dep


def request_actor(request: Request, principal: Principal) -> Actor:
    """The actor for a REST request (agent headers apply to API keys only)."""
    headers = {k.lower(): v for k, v in request.headers.items()}
    return principal.actor(via=Via.WEB if principal.is_session else Via.API, headers=headers)


def workspace_ctx(*scopes: str) -> Callable[..., Awaitable[WorkspaceContext]]:
    """Dependency factory: ``ws: WorkspaceContext = Depends(workspace_ctx(SCOPE_WRITE))``.

    ``raisebook:read`` is always required.
    """
    needed = canonical_order({SCOPE_READ, *scopes})

    async def _dep(
        request: Request, principal: Principal = Depends(get_principal)
    ) -> WorkspaceContext:
        principal.require(*needed)
        return WorkspaceContext.build(principal, request_actor(request, principal))

    return _dep


get_workspace_ctx = workspace_ctx(SCOPE_READ)
"""Read access to the caller's workspace (``ws = Depends(get_workspace_ctx)``)."""

get_write_ctx = workspace_ctx(SCOPE_WRITE)
"""Write access (``raisebook:write``) to the caller's workspace."""
