"""The activity timeline (SPEC §3.6, §8.1). Owner: API+MCP (AM).

:func:`log` is the only writer of ``activities`` rows. Every state change calls it in the
same transaction as the change (one service call, one commit), stamped with the
:class:`~raisebook.core.actor.Actor` (user, agent with name and model, or system). It also
bumps ``round_participants.last_activity_at``: for an activity on a round, that
participant; for an activity without a round, every participation of the investor.

Manual kinds (note, email, call, meeting) are logged with :func:`log_manual` (idempotency
key, ``occurred_at`` bounds) and can be deleted under the SPEC §4.6 rules; system kinds
cannot (409 ``not_deletable``).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, time, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import Select, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import Principal, WorkspaceContext
from raisebook.auth.scopes import SCOPE_WRITE
from raisebook.core.actor import Actor
from raisebook.core.errors import (
    ForbiddenRole,
    InsufficientScope,
    LimitReached,
    NotDeletable,
    ValidationFailed,
    not_found,
)
from raisebook.models.activity import Activity
from raisebook.models.enums import LOGGABLE_ACTIVITY_KINDS, ActorType, Role
from raisebook.models.investor import Investor
from raisebook.models.round import Round, RoundParticipant
from raisebook.schemas.activities import ActivityOut, ActorOut
from raisebook.schemas.common import decode_cursor, encode_cursor
from raisebook.services.users import FORMER_MEMBER, display_names
from raisebook.services.workspaces import LIMITS

MANUAL_KINDS: frozenset[str] = frozenset(k.value for k in LOGGABLE_ACTIVITY_KINDS)
MAX_BODY = 20000
PAST_LIMIT = timedelta(days=3653)  # 10 years
FUTURE_LIMIT = timedelta(days=366)  # 1 year


async def log(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    investor_id: UUID,
    kind: str,
    now: datetime,
    round_id: UUID | None = None,
    body: str | None = None,
    data: dict[str, Any] | None = None,
    occurred_at: datetime | None = None,
    actor: Actor | None = None,
    import_run_id: UUID | None = None,
    idempotency_key: str | None = None,
) -> Activity:
    """Append one activity (and bump ``last_activity_at``). Flushes; the caller commits.

    ``actor`` defaults to ``ws.actor``; imports pass ``ws.actor.with_via(Via.IMPORT)`` and
    ``import_run_id``. The investor (and round) must belong to ``ws``: the composite
    foreign keys refuse anything else.
    """
    act = actor or ws.actor
    at = occurred_at or now
    row = Activity(
        workspace_id=ws.workspace_id,
        investor_id=investor_id,
        round_id=round_id,
        kind=kind,
        occurred_at=at,
        body=body,
        data=_jsonable(data or {}),
        created_at=now,
        import_run_id=import_run_id,
        idempotency_key=idempotency_key,
        **act.activity_fields(),
    )
    db.add(row)
    stamp = min(at, now)
    cond = [
        RoundParticipant.workspace_id == ws.workspace_id,
        RoundParticipant.investor_id == investor_id,
    ]
    if round_id is not None:
        cond.append(RoundParticipant.round_id == round_id)
    await db.execute(
        update(RoundParticipant)
        .where(
            *cond,
            (RoundParticipant.last_activity_at.is_(None))
            | (RoundParticipant.last_activity_at < stamp),
        )
        .values(last_activity_at=stamp)
        .execution_options(synchronize_session="fetch")
    )
    await db.flush()
    return row


def _jsonable(value: Any) -> Any:
    """Dates and UUIDs in ``data`` become strings (JSONB)."""
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(v) for v in value]
    if isinstance(value, datetime):
        return value.isoformat()
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    return value


def parse_occurred_at(value: str | datetime | None, ws: WorkspaceContext) -> datetime | None:
    """RFC 3339 timestamp; a bare ``YYYY-MM-DD`` becomes 12:00 local time (SPEC §6.2)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = value.strip()
        if not text:
            return None
        if len(text) == 10:
            try:
                d = datetime.fromisoformat(text).date()
            except ValueError:
                raise ValidationFailed(
                    "occurred_at", "occurred_at must be YYYY-MM-DD or an RFC 3339 timestamp."
                ) from None
            return datetime.combine(d, time(12, 0), tzinfo=ZoneInfo(ws.timezone))
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            raise ValidationFailed(
                "occurred_at",
                "occurred_at must be an RFC 3339 timestamp such as "
                "2026-10-10T17:00:00Z, or a date YYYY-MM-DD.",
            ) from None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo(ws.timezone))
    return dt


async def log_manual(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    investor: Investor,
    kind: str,
    body: str,
    now: datetime,
    occurred_at: datetime | None = None,
    round_id: UUID | None = None,
    direction: str | None = None,
    idempotency_key: str | None = None,
    actor: Actor | None = None,
) -> tuple[Activity, bool]:
    """Log a note, email, call or meeting. Returns ``(activity, duplicate)``: a repeated
    ``idempotency_key`` returns the earlier activity and writes nothing."""
    if kind not in MANUAL_KINDS:
        raise ValidationFailed("kind", f"kind must be one of: {', '.join(sorted(MANUAL_KINDS))}.")
    text = (body or "").strip()
    if not text:
        raise ValidationFailed("body", "body is required: say what happened in plain words.")
    if len(text) > MAX_BODY:
        raise ValidationFailed("body", f"body must be at most {MAX_BODY} characters.")
    if direction is not None and direction not in ("inbound", "outbound"):
        raise ValidationFailed("direction", "direction must be inbound or outbound.")
    key = (idempotency_key or "").strip() or None
    if key is not None:
        if len(key) > 200:
            raise ValidationFailed("idempotency_key", "idempotency_key is at most 200 chars.")
        existing = await db.scalar(
            select(Activity).where(
                Activity.workspace_id == ws.workspace_id, Activity.idempotency_key == key
            )
        )
        if existing is not None:
            return existing, True
    if occurred_at is not None:
        if occurred_at < now - PAST_LIMIT or occurred_at > now + FUTURE_LIMIT:
            raise ValidationFailed(
                "occurred_at",
                "occurred_at must be within 10 years in the past and 1 year in the future.",
            )
    await check_activity_limit(db, ws)
    row = await log(
        db,
        ws,
        investor_id=investor.id,
        kind=kind,
        now=now,
        round_id=round_id,
        body=text,
        data={"direction": direction} if direction else {},
        occurred_at=occurred_at,
        actor=actor,
        idempotency_key=key,
    )
    return row, False


async def check_activity_limit(db: AsyncSession, ws: WorkspaceContext) -> None:
    n = await db.scalar(
        select(func.count()).select_from(Activity).where(Activity.workspace_id == ws.workspace_id)
    )
    if int(n or 0) >= LIMITS["activities"]:
        raise LimitReached(
            f"This workspace has reached the limit of {LIMITS['activities']:,} activities."
        )


async def get(db: AsyncSession, ws: WorkspaceContext, activity_id: UUID) -> Activity:
    row = await db.scalar(
        select(Activity).where(Activity.workspace_id == ws.workspace_id, Activity.id == activity_id)
    )
    if row is None:
        raise not_found("Activity")
    return row


def can_delete(row: Activity, principal: Principal) -> bool:
    """SPEC §4.6: manual kinds only; owner any, editor own, key own key; needs write."""
    if row.kind not in MANUAL_KINDS or not principal.has(SCOPE_WRITE):
        return False
    if principal.is_key:
        return row.api_key_id is not None and row.api_key_id == principal.api_key_id
    if principal.role == Role.OWNER:
        return True
    return row.actor_user_id is not None and row.actor_user_id == principal.user_id


async def delete_activity(db: AsyncSession, ws: WorkspaceContext, activity_id: UUID) -> None:
    row = await get(db, ws, activity_id)
    if row.kind not in MANUAL_KINDS:
        raise NotDeletable(
            "Only notes, emails, calls and meetings can be deleted; system entries such as "
            "stage changes stay on the timeline."
        )
    if not can_delete(row, ws.principal):
        ws.principal.require(SCOPE_WRITE)
        msg = "You can only delete activities you logged yourself (owners can delete any)."
        details = {"required": ["author_or_owner"]}
        if ws.principal.is_key:
            raise InsufficientScope(
                "This API key can only delete activities it logged itself.", details=details
            )
        raise ForbiddenRole(msg, details=details)
    await db.execute(
        delete(Activity).where(Activity.workspace_id == ws.workspace_id, Activity.id == row.id)
    )
    await db.flush()


def list_query(
    ws: WorkspaceContext,
    *,
    investor_id: UUID | None = None,
    round_id: UUID | None = None,
    kinds: Sequence[str] | None = None,
    actor_type: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> Select[tuple[Activity]]:
    stmt = select(Activity).where(Activity.workspace_id == ws.workspace_id)
    if investor_id is not None:
        stmt = stmt.where(Activity.investor_id == investor_id)
    if round_id is not None:
        stmt = stmt.where(Activity.round_id == round_id)
    if kinds:
        stmt = stmt.where(Activity.kind.in_(list(kinds)))
    if actor_type:
        stmt = stmt.where(Activity.actor_type == actor_type)
    if since is not None:
        stmt = stmt.where(Activity.occurred_at >= since)
    if until is not None:
        stmt = stmt.where(Activity.occurred_at < until)
    return stmt.order_by(
        Activity.occurred_at.desc(), Activity.created_at.desc(), Activity.id.desc()
    )


async def list_activities(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    limit: int = 50,
    cursor: str | None = None,
    **filters: Any,
) -> tuple[list[Activity], str | None]:
    offset = int((decode_cursor(cursor) or {}).get("o", 0))
    stmt = list_query(ws, **filters).offset(offset).limit(limit + 1)
    rows = list(await db.scalars(stmt))
    more = len(rows) > limit
    rows = rows[:limit]
    return rows, encode_cursor({"o": offset + limit}) if more else None


async def present(
    db: AsyncSession, ws: WorkspaceContext, rows: Sequence[Activity]
) -> list[ActivityOut]:
    """Rows → ``Activity`` objects (names resolved at read time, never stored)."""
    if not rows:
        return []
    inv_ids = {r.investor_id for r in rows}
    round_ids = {r.round_id for r in rows if r.round_id is not None}
    names = dict(
        (
            await db.execute(
                select(Investor.id, Investor.name).where(
                    Investor.workspace_id == ws.workspace_id, Investor.id.in_(inv_ids)
                )
            )
        ).tuples()
    )
    slugs: dict[UUID, str] = {}
    if round_ids:
        slugs = {
            rid: str(slug)
            for rid, slug in (
                await db.execute(
                    select(Round.id, Round.slug).where(
                        Round.workspace_id == ws.workspace_id, Round.id.in_(round_ids)
                    )
                )
            ).tuples()
        }
    users = await display_names(db, [r.actor_user_id for r in rows])
    out: list[ActivityOut] = []
    for r in rows:
        if r.actor_type == ActorType.USER.value:
            label = users.get(r.actor_user_id, FORMER_MEMBER) if r.actor_user_id else FORMER_MEMBER
        else:
            label = r.actor_label or "raisebook"
        out.append(
            ActivityOut(
                id=r.id,
                investor_id=r.investor_id,
                investor_name=names.get(r.investor_id, ""),
                round_id=r.round_id,
                round_slug=slugs.get(r.round_id) if r.round_id else None,
                kind=r.kind,
                occurred_at=r.occurred_at,
                body=r.body,
                data=dict(r.data or {}),
                actor=ActorOut(
                    type=r.actor_type,
                    label=label,
                    user_id=r.actor_user_id,
                    api_key_id=r.api_key_id,
                    agent_model=r.agent_model,
                    via=r.via,
                ),
                created_at=r.created_at,
                deletable=can_delete(r, ws.principal),
            )
        )
    return out
