"""API keys for a workspace: create (secret shown once), list, revoke (SPEC §4.4).

Only an owner signed in through the web creates or revokes keys (enforced by the
routes with ``require_owner_session``), so an agent can never mint or widen its
own access. The key's mode follows the workspace: ``rb_test_`` for sandbox
workspaces, ``rb_live_`` otherwise.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.api_keys import generate_api_key
from raisebook.auth.principal import WorkspaceContext
from raisebook.auth.scopes import InvalidScope, key_scopes
from raisebook.core.actor import AGENT_NAME_RE
from raisebook.core.errors import LimitReached, NotFound, ValidationFailed
from raisebook.models.enums import KeyMode
from raisebook.models.workspace import ApiKey
from raisebook.services.workspaces import LIMITS


@dataclass(frozen=True)
class CreatedKey:
    key: ApiKey
    secret: str


def _active(now: datetime) -> list[ColumnElement[bool]]:
    return [
        ApiKey.revoked_at.is_(None),
        or_(ApiKey.expires_at.is_(None), ApiKey.expires_at > now),
    ]


async def create_api_key(
    db: AsyncSession,
    *,
    workspace_id: UUID,
    is_sandbox: bool,
    name: str,
    scopes: list[str] | str,
    now: datetime,
    agent_name: str | None = None,
    expires_at: datetime | None = None,
    created_by_user_id: UUID | None = None,
) -> CreatedKey:
    clean = " ".join((name or "").split())
    if not 1 <= len(clean) <= 80:
        raise ValidationFailed("name", "Key name must be 1 to 80 characters.")
    agent = (agent_name or "").strip() or None
    if agent is not None and not AGENT_NAME_RE.match(agent):
        raise ValidationFailed(
            "agent_name",
            "Agent name must be 1 to 60 letters, digits, spaces, dots, dashes or underscores, "
            "starting with a letter or digit (for example claude-code).",
        )
    try:
        parsed = key_scopes(scopes)
    except InvalidScope as exc:
        raise ValidationFailed("scopes", str(exc)) from exc
    if expires_at is not None and expires_at <= now:
        raise ValidationFailed("expires_at", "expires_at must be in the future.")
    active = await db.scalar(
        select(func.count())
        .select_from(ApiKey)
        .where(ApiKey.workspace_id == workspace_id, *_active(now))
    )
    if int(active or 0) >= LIMITS["api_keys"]:
        raise LimitReached(
            f"A workspace can have {LIMITS['api_keys']} active API keys. Revoke one first.",
            details={"limit": LIMITS["api_keys"]},
        )
    gen = generate_api_key(KeyMode.TEST if is_sandbox else KeyMode.LIVE)
    key = ApiKey(
        workspace_id=workspace_id,
        name=clean,
        agent_name=agent,
        key_prefix=gen.prefix,
        key_hash=gen.digest,
        mode=(KeyMode.TEST if is_sandbox else KeyMode.LIVE).value,
        scopes=parsed,
        created_by_user_id=created_by_user_id,
        created_at=now,
        expires_at=expires_at,
    )
    db.add(key)
    await db.flush()
    return CreatedKey(key, gen.plaintext)


async def create_for_workspace(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    name: str,
    scopes: list[str] | str,
    now: datetime,
    agent_name: str | None = None,
    expires_at: datetime | None = None,
) -> CreatedKey:
    return await create_api_key(
        db,
        workspace_id=ws.workspace_id,
        is_sandbox=ws.is_sandbox,
        name=name,
        scopes=scopes,
        now=now,
        agent_name=agent_name,
        expires_at=expires_at,
        created_by_user_id=ws.principal.user_id,
    )


async def list_api_keys(db: AsyncSession, ws: WorkspaceContext) -> list[ApiKey]:
    return list(
        await db.scalars(
            select(ApiKey)
            .where(ApiKey.workspace_id == ws.workspace_id)
            .order_by(ApiKey.created_at.desc(), ApiKey.id)
        )
    )


async def revoke_api_key(
    db: AsyncSession, workspace_id: UUID, key_id: UUID, *, now: datetime
) -> ApiKey:
    key = await db.scalar(
        select(ApiKey).where(ApiKey.id == key_id, ApiKey.workspace_id == workspace_id)
    )
    if key is None:
        raise NotFound("API key not found in this workspace.")
    if key.revoked_at is None:
        key.revoked_at = now
        await db.flush()
    return key
