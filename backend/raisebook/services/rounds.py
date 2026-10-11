"""Rounds: create, list, update, close/reopen, delete (SPEC §3.2, §5.5). Owner: AM.

A round's name is unique per workspace (case-insensitive): creating an existing name
returns 409 ``duplicate`` with the existing round in ``details.existing``, so agents can
treat it as idempotent. The slug is ``slugify(name)`` with ``-2``, ``-3``… on collision
and follows renames; ids are the stable reference.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.errors import ConfirmationRequired, Duplicate, LimitReached, ValidationFailed
from raisebook.models.round import Round, RoundParticipant, RoundStage
from raisebook.schemas.rounds import RoundOut
from raisebook.services.normalize import clean_text, collapse, parse_instrument
from raisebook.services.stages import (
    create_stages,
    default_specs,
    stage_out,
    stages_by_round,
    validate_specs,
)
from raisebook.services.workspaces import LIMITS, clean_currency, slugify

STATUS_ORDER = {"open": 0, "closed": 1}


def clean_round_name(raw: Any) -> str:
    name = collapse(str(raw or ""))
    if not 1 <= len(name) <= 80:
        raise ValidationFailed("name", "Round name must be 1 to 80 characters.")
    return name


async def _by_name(
    db: AsyncSession, ws: WorkspaceContext, name: str, exclude: UUID | None = None
) -> Round | None:
    stmt = select(Round).where(
        Round.workspace_id == ws.workspace_id, func.lower(Round.name) == name.lower()
    )
    if exclude is not None:
        stmt = stmt.where(Round.id != exclude)
    row: Round | None = await db.scalar(stmt)
    return row


async def find_by_name(db: AsyncSession, ws: WorkspaceContext, name: str) -> Round | None:
    """A round by exact (case-insensitive) name, after the usual name cleaning."""
    return await _by_name(db, ws, clean_round_name(name))


async def _unique_slug(
    db: AsyncSession, ws: WorkspaceContext, name: str, exclude: UUID | None = None
) -> str:
    base = slugify(name)[:44].strip("-") or "round"
    if not base[0].isalnum():
        base = "r" + base
    stmt = select(Round.slug).where(Round.workspace_id == ws.workspace_id)
    if exclude is not None:
        stmt = stmt.where(Round.id != exclude)
    taken = {str(s) for s in await db.scalars(stmt)}
    slug, n = base, 2
    while slug in taken:
        slug = f"{base}-{n}"
        n += 1
    return slug


def _money(value: Any, field: str, *, positive: bool) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationFailed(field, f"{field} must be a whole number.")
    if value < 0 or (positive and value == 0):
        raise ValidationFailed(field, f"{field} must be {'> 0' if positive else '>= 0'}.")
    return value


async def create_round(
    db: AsyncSession, ws: WorkspaceContext, data: Mapping[str, Any], *, now: datetime
) -> Round:
    name = clean_round_name(data.get("name"))
    existing = await _by_name(db, ws, name)
    if existing is not None:
        out = (await present(db, ws, [existing]))[0]
        raise Duplicate(
            f"A round named {existing.name!r} already exists (slug {existing.slug}).",
            details={"existing": out.model_dump(mode="json")},
        )
    n = await db.scalar(
        select(func.count()).select_from(Round).where(Round.workspace_id == ws.workspace_id)
    )
    if int(n or 0) >= LIMITS["rounds"]:
        raise LimitReached(f"This workspace has reached the limit of {LIMITS['rounds']} rounds.")
    specs = validate_specs(data["stages"]) if data.get("stages") else default_specs()
    rnd = Round(
        workspace_id=ws.workspace_id,
        slug=await _unique_slug(db, ws, name),
        name=name,
        status="open",
        instrument=parse_instrument(data.get("instrument") or "safe"),
        currency=clean_currency(data.get("currency") or ws.currency),
        target_amount=_money(data.get("target_amount"), "target_amount", positive=False) or 0,
        valuation_cap=_money(data.get("valuation_cap"), "valuation_cap", positive=True),
        pre_money_valuation=_money(
            data.get("pre_money_valuation"), "pre_money_valuation", positive=True
        ),
        target_close_on=data.get("target_close_on"),
        notes=clean_text(data.get("notes"), "notes", max_len=20000, multiline=True),
        created_at=now,
        updated_at=now,
    )
    db.add(rnd)
    await db.flush()
    await create_stages(db, ws, rnd, specs)
    return rnd


async def update_round(
    db: AsyncSession, ws: WorkspaceContext, rnd: Round, changes: Mapping[str, Any], *, now: datetime
) -> Round:
    """PATCH semantics: absent = unchanged, ``None`` = clear (not for required fields).
    Closing sets ``closed_on`` to today unless given; reopening clears it."""
    required = ("name", "status", "instrument", "currency", "target_amount")
    for f in required:
        if f in changes and changes[f] is None:
            raise ValidationFailed(f, f"{f} cannot be empty.")
    if "name" in changes:
        name = clean_round_name(changes["name"])
        if name != rnd.name:
            clash = await _by_name(db, ws, name, exclude=rnd.id)
            if clash is not None:
                raise Duplicate(f"A round named {clash.name!r} already exists.")
            rnd.slug = await _unique_slug(db, ws, name, exclude=rnd.id)
            rnd.name = name
    if "instrument" in changes:
        rnd.instrument = parse_instrument(changes["instrument"])
    if "currency" in changes:
        rnd.currency = clean_currency(changes["currency"])
    if "target_amount" in changes:
        rnd.target_amount = _money(changes["target_amount"], "target_amount", positive=False) or 0
    for f in ("valuation_cap", "pre_money_valuation"):
        if f in changes:
            setattr(rnd, f, _money(changes[f], f, positive=True))
    if "target_close_on" in changes:
        rnd.target_close_on = changes["target_close_on"]
    if "notes" in changes:
        rnd.notes = clean_text(changes["notes"], "notes", max_len=20000, multiline=True)
    status = changes.get("status", rnd.status)
    if status not in ("open", "closed"):
        raise ValidationFailed("status", "status must be open or closed.")
    if status == "closed":
        if "closed_on" in changes and changes["closed_on"] is not None:
            rnd.closed_on = changes["closed_on"]
        elif rnd.status != "closed" or rnd.closed_on is None:
            rnd.closed_on = ws.today(now)
    else:
        if changes.get("closed_on") is not None:
            raise ValidationFailed("closed_on", "Only a closed round has closed_on.")
        rnd.closed_on = None
    rnd.status = status
    rnd.updated_at = now
    await db.flush()
    return rnd


async def delete_round(db: AsyncSession, ws: WorkspaceContext, rnd: Round, *, confirm: str) -> None:
    """Hard delete with a typed confirmation (the round's name or slug)."""
    text = (confirm or "").strip().lower()
    if text not in (rnd.name.lower(), str(rnd.slug).lower()):
        raise ConfirmationRequired(
            f"To delete round {rnd.name!r}, send confirm with its name or slug ({rnd.slug}).",
            details={"expected": [rnd.name, str(rnd.slug)]},
        )
    # Participants first (their stage FK has no cascade), then the round (cascades
    # stages and round activities).
    await db.execute(
        delete(RoundParticipant).where(
            RoundParticipant.workspace_id == ws.workspace_id, RoundParticipant.round_id == rnd.id
        )
    )
    await db.execute(delete(Round).where(Round.workspace_id == ws.workspace_id, Round.id == rnd.id))
    await db.flush()


async def list_rounds(
    db: AsyncSession, ws: WorkspaceContext, *, status: str = "all"
) -> list[Round]:
    stmt = select(Round).where(Round.workspace_id == ws.workspace_id)
    if status in ("open", "closed"):
        stmt = stmt.where(Round.status == status)
    elif status != "all":
        raise ValidationFailed(["query", "status"], "status must be open, closed or all.")
    rows = list(await db.scalars(stmt.order_by(Round.created_at, Round.id)))
    rows.sort(key=lambda r: STATUS_ORDER.get(r.status, 2))
    return rows


async def round_stats(
    db: AsyncSession, ws: WorkspaceContext, round_ids: Sequence[UUID]
) -> dict[UUID, dict[str, Any]]:
    """Per round: participant count per stage id, total, committed (won-stage sum)."""
    out: dict[UUID, dict[str, Any]] = {
        rid: {"by_stage": {}, "total": 0, "committed": 0} for rid in round_ids
    }
    if not round_ids:
        return out
    rows = await db.execute(
        select(
            RoundParticipant.round_id,
            RoundParticipant.stage_id,
            RoundStage.kind,
            func.count(),
            func.coalesce(func.sum(RoundParticipant.amount_committed), 0),
        )
        .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
        .where(
            RoundParticipant.workspace_id == ws.workspace_id,
            RoundParticipant.round_id.in_(list(round_ids)),
        )
        .group_by(RoundParticipant.round_id, RoundParticipant.stage_id, RoundStage.kind)
    )
    for rid, sid, kind, n, committed in rows.tuples():
        st = out[rid]
        st["by_stage"][sid] = int(n)
        st["total"] += int(n)
        if kind == "won":
            st["committed"] += int(committed or 0)
    return out


async def present(
    db: AsyncSession, ws: WorkspaceContext, rounds: Sequence[Round], *, counts: bool = False
) -> list[RoundOut]:
    ids = [r.id for r in rounds]
    stages = await stages_by_round(db, ws, ids)
    stats = await round_stats(db, ws, ids)
    out = []
    for r in rounds:
        st = stats[r.id]
        out.append(
            RoundOut(
                id=r.id,
                slug=str(r.slug),
                name=r.name,
                status=r.status,
                instrument=r.instrument,
                currency=r.currency,
                target_amount=r.target_amount,
                valuation_cap=r.valuation_cap,
                pre_money_valuation=r.pre_money_valuation,
                target_close_on=r.target_close_on,
                closed_on=r.closed_on,
                notes=r.notes,
                stages=[
                    stage_out(s, st["by_stage"].get(s.id, 0) if counts else None)
                    for s in stages[r.id]
                ],
                committed_amount=st["committed"],
                participant_count=st["total"],
                created_at=r.created_at,
                updated_at=r.updated_at,
            )
        )
    return out


async def present_one(
    db: AsyncSession, ws: WorkspaceContext, rnd: Round, *, counts: bool = True
) -> RoundOut:
    await db.refresh(rnd)
    return (await present(db, ws, [rnd], counts=counts))[0]


async def kind_counts(
    db: AsyncSession, ws: WorkspaceContext, rounds: Sequence[Round]
) -> dict[UUID, dict[str, int]]:
    """``{round_id: {total, open, active, won, lost}}``."""
    out = {r.id: {"total": 0, "open": 0, "active": 0, "won": 0, "lost": 0} for r in rounds}
    if not rounds:
        return out
    rows = await db.execute(
        select(RoundParticipant.round_id, RoundStage.kind, func.count())
        .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
        .where(
            RoundParticipant.workspace_id == ws.workspace_id,
            RoundParticipant.round_id.in_([r.id for r in rounds]),
        )
        .group_by(RoundParticipant.round_id, RoundStage.kind)
    )
    for rid, kind, n in rows.tuples():
        out[rid][kind] = int(n)
        out[rid]["total"] += int(n)
    return out
