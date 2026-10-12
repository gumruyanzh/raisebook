"""Workspaces: creation (with an owner membership), settings, limits (SPEC §3.1).

Slugs are ``slugify(name)[:43] + "-" + 4 random base32 chars`` (``qenzo-k7p2``),
generated once and never changed, so a slug never reveals that another workspace
with the same name exists.
"""

from __future__ import annotations

import re
import secrets
import unicodedata
from datetime import datetime
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.config import get_settings
from raisebook.core.errors import LimitReached, ValidationFailed, WorkspaceNotFound
from raisebook.models.enums import Role
from raisebook.models.user import User
from raisebook.models.workspace import Membership, Workspace

# SPEC §3.1 limits per workspace (422 limit_reached when exceeded).
LIMITS: dict[str, int] = {
    "members": 20,  # including pending invites
    "api_keys": 20,  # active
    "rounds": 50,
    "investors": 20_000,
    "activities": 1_000_000,
    "sample_workspaces_per_user": 3,
}

# Names go into invite emails, so they must not carry links (phishing relay guard).
_LINKY_RE = re.compile(r"(://|\bwww\.|https?\b:|[<>])", re.IGNORECASE)


def reject_links(field: str, value: str, what: str) -> None:
    if _LINKY_RE.search(value):
        raise ValidationFailed(field, f"{what} cannot contain a web address or angle brackets.")


_BASE32 = "abcdefghijklmnopqrstuvwxyz234567"
_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


def slugify(value: str, sep: str = "-") -> str:
    """ASCII, lowercase, words joined by ``sep``; empty when nothing usable remains."""
    norm = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    norm = norm.lower().replace("&", " and ")
    return sep.join(re.findall(r"[a-z0-9]+", norm))


def new_workspace_slug(name: str) -> str:
    base = slugify(name)[:43].strip("-") or "workspace"
    if len(base) < 2:
        base = f"ws-{base}"
    suffix = "".join(secrets.choice(_BASE32) for _ in range(4))
    return f"{base}-{suffix}"


def clean_workspace_name(raw: str) -> str:
    name = " ".join((raw or "").split())
    if not 1 <= len(name) <= 80:
        raise ValidationFailed("name", "Workspace name must be 1 to 80 characters.")
    reject_links("name", name, "Workspace name")
    return name


def clean_timezone(raw: str | None) -> str:
    tz = (raw or "UTC").strip()
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValidationFailed(
            "timezone", f"Unknown timezone {tz!r}. Use an IANA name such as America/New_York."
        ) from None
    return tz


def clean_currency(raw: str | None) -> str:
    cur = (raw or "USD").strip().upper()
    if not _CURRENCY_RE.match(cur):
        raise ValidationFailed(
            "default_currency", "Currency must be a 3-letter ISO code such as USD or EUR."
        )
    return cur


async def create_workspace_row(
    db: AsyncSession,
    *,
    user: User,
    name: str,
    now: datetime,
    timezone: str | None = None,
    default_currency: str | None = None,
    is_sandbox: bool = False,
) -> Workspace:
    """Insert a workspace and make ``user`` its owner (used by sample data too)."""
    ws = Workspace(
        slug=new_workspace_slug(name),
        name=clean_workspace_name(name),
        is_sandbox=is_sandbox,
        default_currency=clean_currency(default_currency),
        timezone=clean_timezone(timezone),
        created_by_user_id=user.id,
        created_at=now,
        updated_at=now,
    )
    for _ in range(5):  # a slug collision is astronomically rare; retry a new suffix anyway
        taken = await db.scalar(select(Workspace.id).where(Workspace.slug == ws.slug))
        if taken is None:
            break
        ws.slug = new_workspace_slug(name)
    db.add(ws)
    await db.flush()
    db.add(Membership(workspace_id=ws.id, user_id=user.id, role=Role.OWNER.value, created_at=now))
    await db.flush()
    return ws


async def create_workspace(
    db: AsyncSession,
    *,
    user: User,
    name: str,
    now: datetime,
    timezone: str | None = None,
    default_currency: str | None = None,
    sample: bool = False,
) -> Workspace:
    """``POST /v1/workspaces``. ``sample=True`` creates the fictional sandbox workspace.

    422 ``limit_reached`` past ``workspaces_per_user`` real (or
    ``sample_workspaces_per_user`` sample) workspaces owned by the caller."""
    await _check_owned_limit(db, user, sample=sample)
    if sample:
        from raisebook.services.sample_data import create_sample_workspace

        return await create_sample_workspace(db, user=user, now=now)
    return await create_workspace_row(
        db,
        user=user,
        name=name,
        now=now,
        timezone=timezone,
        default_currency=default_currency,
    )


async def _check_owned_limit(db: AsyncSession, user: User, *, sample: bool) -> None:
    owned = await db.scalar(
        select(func.count())
        .select_from(Membership)
        .join(Workspace, Workspace.id == Membership.workspace_id)
        .where(
            Membership.user_id == user.id,
            Membership.role == Role.OWNER.value,
            Workspace.is_sandbox.is_(sample),
        )
    )
    settings = get_settings()
    if sample:
        limit = LIMITS["sample_workspaces_per_user"]
    else:
        exempt = {e.strip().lower() for e in settings.workspace_limit_exempt_emails}
        if (user.email or "").lower() in exempt:
            return
        limit = settings.max_workspaces_per_user
    if int(owned or 0) >= limit:
        kind = "sample workspaces" if sample else "workspaces"
        raise LimitReached(
            f"You can own {limit} {kind}. Delete one you no longer use first.",
            details={"limit": limit},
        )


async def get_workspace(db: AsyncSession, ws: WorkspaceContext) -> Workspace:
    row = await db.get(Workspace, ws.workspace_id)
    if row is None:
        raise WorkspaceNotFound()
    return row


async def get_by_slug(db: AsyncSession, slug: str) -> Workspace | None:
    ws: Workspace | None = await db.scalar(
        select(Workspace).where(Workspace.slug == slug.strip().lower())
    )
    return ws


async def update_workspace(
    db: AsyncSession,
    ws: WorkspaceContext,
    changes: dict[str, Any],
    *,
    now: datetime,
) -> Workspace:
    """``PATCH /v1/workspace``: name, timezone, default_currency (absent = unchanged)."""
    row = await get_workspace(db, ws)
    if "name" in changes:
        row.name = clean_workspace_name(changes["name"] or "")
    if "timezone" in changes:
        if changes["timezone"] is None:
            raise ValidationFailed("timezone", "Timezone cannot be empty.")
        row.timezone = clean_timezone(changes["timezone"])
    if "default_currency" in changes:
        if changes["default_currency"] is None:
            raise ValidationFailed("default_currency", "Currency cannot be empty.")
        row.default_currency = clean_currency(changes["default_currency"])
    row.updated_at = now
    await db.flush()
    return row


async def member_count(db: AsyncSession, workspace_id: UUID) -> int:
    n = await db.scalar(
        select(func.count()).select_from(Membership).where(Membership.workspace_id == workspace_id)
    )
    return int(n or 0)


async def role_of(db: AsyncSession, workspace_id: UUID, user_id: UUID) -> Role | None:
    role = await db.scalar(
        select(Membership.role).where(
            Membership.workspace_id == workspace_id, Membership.user_id == user_id
        )
    )
    return Role(role) if role else None
