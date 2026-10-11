# mypy: disable-error-code="type-arg"
# (FastMCP injects the request Context only into parameters annotated with the bare class.)
"""Shared plumbing for MCP tools (SPEC §6.1).

Every tool handler looks like::

    @server.tool(annotations=write("Move an investor to another stage"))
    async def move_stage(investor: str, stage: str, round: str | None = None,
                         ctx: Context | None = None) -> dict[str, Any]:
        \"\"\"<binding description from SPEC §6.4>\"\"\"
        async with tool_call(ctx, SCOPE_WRITE) as (db, ws):
            ...  # call the same services as REST, with ws (and ws.actor)
            return shaped

:func:`tool_call` checks the scope against the caller's API key (read tools need
``raisebook:read``, write tools ``raisebook:write``), applies the per-key read or
write rate limit, builds the :class:`WorkspaceContext` whose actor is
``type=agent, via=mcp`` with the agent name/model from the ``X-Agent-Name`` /
``X-Agent-Model`` request headers, opens a DB session from the hosting app,
commits on success, and turns service errors into ``ToolError("<code>: <message>")``
plus a JSON line of details.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime
from typing import Any
from uuid import UUID

from mcp.server.fastmcp import Context
from mcp.server.fastmcp.exceptions import ToolError
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import Principal, WorkspaceContext
from raisebook.auth.scopes import SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE, canonical_order
from raisebook.auth.scopes import missing_scopes as _missing
from raisebook.core import ratelimit
from raisebook.core.clock import get_now
from raisebook.core.errors import APIError, RateLimited
from raisebook.mcp.auth import app_session, current_principal
from raisebook.models.enums import Via

__all__ = [
    "Clock",
    "ToolError",
    "agent_headers",
    "parse_date",
    "parse_uuid",
    "tool_call",
    "tool_error",
]


class Clock:
    """Tool clock; delegates to ``core.clock`` (frozen by the ``frozen_now`` fixture)."""

    @staticmethod
    def now() -> datetime:
        return get_now()


# REST paths in a message ("(POST /v1/rounds)") mean nothing to an MCP agent.
_REST_HINT = re.compile(r"\s*\((?:GET|POST|PATCH|PUT|DELETE) /v1/[^)]*\)")


def tool_error(exc: APIError) -> ToolError:
    msg = f"{exc.code}: {_REST_HINT.sub('', exc.message)}"
    if exc.details:
        msg += "\n" + json.dumps(exc.details, default=str)[:4000]
    return ToolError(msg)


def _request(ctx: Context | None) -> Any:
    try:
        return ctx.request_context.request if ctx is not None else None
    except ValueError:  # no active request context
        return None


def agent_headers(ctx: Context | None) -> dict[str, str]:
    """Lower-cased request headers of the current MCP call (for X-Agent-Name/-Model)."""
    request = _request(ctx)
    if request is None:
        return {}
    return {k.lower(): v for k, v in request.headers.items()}


@asynccontextmanager
async def tool_call(
    ctx: Context | None, *scopes: str
) -> AsyncIterator[tuple[AsyncSession, WorkspaceContext]]:
    """Authorise the caller for ``scopes`` and yield ``(db, ws)``. Commits on success."""
    principal: Principal | None = current_principal()
    if principal is None:
        raise ToolError("unauthorized: connect with a Raisebook API key (Bearer rb_live_…).")
    needed = canonical_order({SCOPE_READ, *scopes})
    missing = _missing(principal.scopes, *needed)
    if missing:
        raise ToolError(
            f"insufficient_scope: this API key lacks {', '.join(missing)} "
            f"(it has {', '.join(canonical_order(principal.scopes)) or 'nothing'}). "
            "Ask the workspace owner for a key with that scope."
        )
    kind: ratelimit.BucketKind = (
        "key_write" if (SCOPE_WRITE in needed or SCOPE_ADMIN in needed) else "key_read"
    )
    try:
        await ratelimit.enforce(kind, str(principal.api_key_id))
    except RateLimited as exc:
        raise ToolError(f"rate_limited: retry after {exc.retry_after_s}s") from exc
    actor = principal.actor(via=Via.MCP, headers=agent_headers(ctx))
    ws = WorkspaceContext.build(principal, actor)
    request = _request(ctx)
    async with app_session(getattr(request, "app", None)) as db:
        try:
            yield db, ws
            await db.commit()
        except APIError as exc:
            await db.rollback()
            raise tool_error(exc) from exc
        except ValidationError as exc:
            await db.rollback()
            raise ToolError(f"validation_error: {exc.errors(include_url=False)}") from exc
        except BaseException:
            await db.rollback()
            raise


def parse_uuid(value: str, what: str) -> UUID:
    try:
        return UUID(str(value).strip())
    except ValueError:
        raise ToolError(f"validation_error: {what} {value!r} is not an id") from None


def parse_date(value: str | None, what: str) -> date | None:
    """``YYYY-MM-DD`` → date (None/empty → None)."""
    if value is None or str(value).strip() == "":
        return None
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError:
        raise ToolError(f"validation_error: {what} must be YYYY-MM-DD, e.g. 2026-10-20") from None
