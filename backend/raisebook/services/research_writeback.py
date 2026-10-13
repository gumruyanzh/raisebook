"""Write-back from research to the investor (R7; RESEARCH-PLAN §4.7).

- An **empty** investor field is filled at once, through ``services/investors.update`` (one
  ``investor_updated`` activity with ``data.source = "research"``), and recorded as an
  ``auto_applied`` suggestion: that row is the "from research" mark, shown while the
  investor's value still equals it (a later human edit silently removes the mark).
- A **non-empty, different** value becomes a ``pending`` suggestion ("Research says check
  $250k-1M (you have $50k-250k) — accept / ignore"); the older pending one for that field is
  ``superseded``. A value someone ignored is not suggested again.
- Equal values write nothing. List fields (stage focus, industries) are suggested as the
  union, only when it adds values. Check size is suggested as a pair.
- **Fit** per round participant: verdict Strong 4, Possible 3, Poor 1 (5 = Hot stays a human
  call). Fit 0 (unset) is set; another value becomes a pending ``fit`` suggestion.

Accept applies through the same services as a person's edit (validation, activities,
``updated_at``); "Accept all" shares one ``bulk_id`` so feeds collapse it.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import and_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.actor import Actor
from raisebook.core.errors import APIError, Conflict, Duplicate, ValidationFailed, not_found
from raisebook.models.enums import SuggestionStatus, Verdict
from raisebook.models.investor import Investor
from raisebook.models.research import FieldSuggestion
from raisebook.models.round import Round, RoundParticipant
from raisebook.services import investors as investors_svc
from raisebook.services import participants as parts_svc
from raisebook.services.normalize import linkedin_key, merge_lists, normalize_investor_input
from raisebook.services.stages import stages_for

INVESTOR_SUGGESTION_FIELDS: tuple[str, ...] = (
    "firm",
    "title",
    "type",
    "location",
    "linkedin_url",
    "website_url",
    "email",
    "check_min",
    "check_max",
    "stage_focus",
    "industries",
)
LIST_FIELDS = frozenset({"stage_focus", "industries"})
VERDICT_FIT: dict[str, int] = {Verdict.STRONG: 4, Verdict.POSSIBLE: 3, Verdict.POOR: 1}
FIT_LABELS = {0: "unset", 1: "Poor", 2: "Weak", 3: "Maybe", 4: "Strong", 5: "Hot"}


@dataclass
class WritebackResult:
    applied: list[str] = field(default_factory=list)
    suggested: list[str] = field(default_factory=list)

    @property
    def counts(self) -> dict[str, int]:
        return {"applied": len(self.applied), "suggested": len(self.suggested)}


def _same(field_name: str, a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is b
    if field_name == "linkedin_url":
        return linkedin_key(str(a)) == linkedin_key(str(b))
    if field_name in ("website_url",):
        return str(a).rstrip("/").casefold() == str(b).rstrip("/").casefold()
    if isinstance(a, str) and isinstance(b, str):
        return a.strip().casefold() == b.strip().casefold()
    if isinstance(a, list) and isinstance(b, list):
        return {str(x).casefold() for x in a} == {str(x).casefold() for x in b}
    return bool(a == b)


def _empty(value: Any, name: str = "") -> bool:
    return value is None or value == "" or value == [] or (name == "type" and value == "other")


def _jsonable(value: Any) -> Any:
    return list(value) if isinstance(value, list | tuple) else value


async def _ignored_before(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor_id: UUID,
    field_name: str,
    value: Any,
    round_id: UUID | None = None,
) -> bool:
    rows = await db.scalars(
        select(FieldSuggestion.suggested_value).where(
            FieldSuggestion.workspace_id == ws.workspace_id,
            FieldSuggestion.investor_id == investor_id,
            FieldSuggestion.field == field_name,
            FieldSuggestion.status == SuggestionStatus.IGNORED.value,
            FieldSuggestion.round_id.is_(None)
            if round_id is None
            else FieldSuggestion.round_id == round_id,
        )
    )
    return any(_same(field_name, v, value) for v in rows)


async def _supersede(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor_id: UUID,
    field_name: str,
    round_id: UUID | None,
    now: datetime,
) -> None:
    await db.execute(
        update(FieldSuggestion)
        .where(
            FieldSuggestion.workspace_id == ws.workspace_id,
            FieldSuggestion.investor_id == investor_id,
            FieldSuggestion.field == field_name,
            FieldSuggestion.status == SuggestionStatus.PENDING.value,
            FieldSuggestion.round_id.is_(None)
            if round_id is None
            else FieldSuggestion.round_id == round_id,
        )
        .values(status=SuggestionStatus.SUPERSEDED.value, decided_at=now)
        .execution_options(synchronize_session=False)
    )


def _row(
    ws: WorkspaceContext,
    investor_id: UUID,
    field_name: str,
    current: Any,
    value: Any,
    status: SuggestionStatus,
    *,
    dossier_id: UUID | None,
    run_id: UUID | None,
    round_id: UUID | None = None,
    now: datetime,
) -> FieldSuggestion:
    return FieldSuggestion(
        workspace_id=ws.workspace_id,
        investor_id=investor_id,
        round_id=round_id,
        dossier_id=dossier_id,
        run_id=run_id,
        field=field_name,
        current_value=_jsonable(current),
        suggested_value=_jsonable(value),
        status=status.value,
        created_at=now,
    )


def _normalized(field_name: str, value: Any) -> Any:
    """The value as the investor column would store it, or ValidationFailed."""
    out = normalize_investor_input({field_name: value}, partial=True)
    return out.get(field_name)


async def apply_investor_fields(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor: Investor,
    proposed: Mapping[str, Any],
    *,
    now: datetime,
    actor: Actor | None = None,
    dossier_id: UUID | None = None,
    run_id: UUID | None = None,
) -> WritebackResult:
    """Fill empty fields, suggest the rest (never overwrite). Flushes; the caller commits."""
    result = WritebackResult()
    fills: dict[str, Any] = {}
    pending: list[tuple[str, Any, Any]] = []
    for name in INVESTOR_SUGGESTION_FIELDS:
        if name not in proposed or proposed[name] is None:
            continue
        try:
            value = _normalized(name, proposed[name])
        except APIError:
            continue
        if _empty(value, name):
            continue
        current = getattr(investor, name)
        if name in LIST_FIELDS:
            have = list(current or [])
            union = merge_lists(have, value)
            if not have:
                fills[name] = value
            elif len(union) > len(have):
                pending.append((name, have, union))
            continue
        if _empty(current, name):
            fills[name] = value
        elif not _same(name, current, value):
            pending.append((name, current, value))
    # Check size travels as a pair: suggest both when either differs.
    names = {p[0] for p in pending}
    if names & {"check_min", "check_max"}:
        for pair in ("check_min", "check_max"):
            if pair not in names and pair in proposed and proposed[pair] is not None:
                cur = getattr(investor, pair)
                if cur is not None:
                    pending.append((pair, cur, int(proposed[pair])))
                fills.pop(pair, None)
    lo = fills.get("check_min", investor.check_min)
    hi = fills.get("check_max", investor.check_max)
    if lo is not None and hi is not None and lo > hi:
        fills.pop("check_min", None)
        fills.pop("check_max", None)

    extra = {"source": "research"}
    if dossier_id:
        extra["dossier_id"] = str(dossier_id)
    if run_id:
        extra["run_id"] = str(run_id)
    while fills:
        try:
            await investors_svc.update(
                db, ws, investor, fills, now=now, actor=actor, extra_data=extra
            )
            break
        except Duplicate:
            # Another contact already has this email / LinkedIn: leave it to a person.
            for clash in ("linkedin_url", "email"):
                fills.pop(clash, None)
        except ValidationFailed:
            fills = {}
    for name, value in fills.items():
        db.add(
            _row(
                ws,
                investor.id,
                name,
                None,
                value,
                SuggestionStatus.AUTO_APPLIED,
                dossier_id=dossier_id,
                run_id=run_id,
                now=now,
            )
        )
        result.applied.append(name)
    for name, current, value in pending:
        if await _ignored_before(db, ws, investor.id, name, value):
            continue
        await _supersede(db, ws, investor.id, name, None, now)
        db.add(
            _row(
                ws,
                investor.id,
                name,
                current,
                value,
                SuggestionStatus.PENDING,
                dossier_id=dossier_id,
                run_id=run_id,
                now=now,
            )
        )
        result.suggested.append(name)
    await db.flush()
    return result


async def apply_fit(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor: Investor,
    verdict: str,
    *,
    round_id: UUID | None,
    dossier_id: UUID,
    now: datetime,
    actor: Actor | None = None,
) -> WritebackResult:
    """Verdict → participant fit in the dossier's round (or every open round it is in)."""
    result = WritebackResult()
    fit = VERDICT_FIT.get(verdict)
    if fit is None:
        return result
    stmt = (
        select(RoundParticipant, Round)
        .join(
            Round,
            and_(Round.id == RoundParticipant.round_id, Round.workspace_id == ws.workspace_id),
        )
        .where(
            RoundParticipant.workspace_id == ws.workspace_id,
            RoundParticipant.investor_id == investor.id,
        )
    )
    stmt = stmt.where(Round.id == round_id) if round_id else stmt.where(Round.status == "open")
    for part, rnd in (await db.execute(stmt)).tuples():
        if part.fit == fit:
            continue
        if part.fit == 0:
            stages = await stages_for(db, ws, rnd.id)
            await parts_svc.apply_changes(
                db,
                ws,
                rnd,
                part,
                stages,
                {"fit": fit},
                now=now,
                actor=actor,
                extra_data={"source": "research", "dossier_id": str(dossier_id)},
            )
            db.add(
                _row(
                    ws,
                    investor.id,
                    "fit",
                    0,
                    fit,
                    SuggestionStatus.AUTO_APPLIED,
                    dossier_id=dossier_id,
                    run_id=None,
                    round_id=rnd.id,
                    now=now,
                )
            )
            result.applied.append("fit")
        elif not await _ignored_before(db, ws, investor.id, "fit", fit, rnd.id):
            await _supersede(db, ws, investor.id, "fit", rnd.id, now)
            db.add(
                _row(
                    ws,
                    investor.id,
                    "fit",
                    part.fit,
                    fit,
                    SuggestionStatus.PENDING,
                    dossier_id=dossier_id,
                    run_id=None,
                    round_id=rnd.id,
                    now=now,
                )
            )
            result.suggested.append("fit")
    await db.flush()
    return result


# --- decisions -----------------------------------------------------------------------------------


async def get_suggestion(
    db: AsyncSession, ws: WorkspaceContext, suggestion_id: UUID
) -> FieldSuggestion:
    row = await db.scalar(
        select(FieldSuggestion).where(
            FieldSuggestion.workspace_id == ws.workspace_id, FieldSuggestion.id == suggestion_id
        )
    )
    if row is None:
        raise not_found("Suggestion")
    return row


def _decide(
    row: FieldSuggestion, status: SuggestionStatus, ws: WorkspaceContext, now: datetime
) -> None:
    row.status = status.value
    row.decided_at = now
    for k, v in ws.actor.activity_fields().items():
        setattr(row, f"decider_{k}", v)


def _require_pending(row: FieldSuggestion, wanted: SuggestionStatus) -> bool:
    """True when ``row`` is pending; False when it already has ``wanted`` (repeat call)."""
    if row.status == SuggestionStatus.PENDING.value:
        return True
    if row.status == wanted.value:
        return False
    raise Conflict(
        f"This suggestion was already {row.status.replace('_', ' ')}.",
        details={"status": row.status},
    )


async def accept(
    db: AsyncSession,
    ws: WorkspaceContext,
    row: FieldSuggestion,
    *,
    now: datetime,
    bulk_id: UUID | None = None,
) -> FieldSuggestion:
    """Apply a pending suggestion through the normal services and mark it accepted."""
    if not _require_pending(row, SuggestionStatus.ACCEPTED):
        return row
    extra: dict[str, Any] = {"source": "research", "suggestion_id": str(row.id)}
    if bulk_id:
        extra["bulk_id"] = str(bulk_id)
    investor = await investors_svc.get(db, ws, row.investor_id)
    if row.field == "fit":
        rnd = await db.scalar(
            select(Round).where(Round.workspace_id == ws.workspace_id, Round.id == row.round_id)
        )
        part = (
            await parts_svc.get_participant(db, ws, rnd.id, investor.id)
            if rnd is not None
            else None
        )
        if rnd is None or part is None:
            raise Conflict("The investor is no longer in that round; ignore this suggestion.")
        stages = await stages_for(db, ws, rnd.id)
        await parts_svc.apply_changes(
            db, ws, rnd, part, stages, {"fit": row.suggested_value}, now=now, extra_data=extra
        )
        _decide(row, SuggestionStatus.ACCEPTED, ws, now)
        await db.flush()
        return row
    rows = [row]
    if row.field in ("check_min", "check_max"):
        sibling_field = "check_max" if row.field == "check_min" else "check_min"
        sibling = await db.scalar(
            select(FieldSuggestion).where(
                FieldSuggestion.workspace_id == ws.workspace_id,
                FieldSuggestion.investor_id == row.investor_id,
                FieldSuggestion.field == sibling_field,
                FieldSuggestion.status == SuggestionStatus.PENDING.value,
            )
        )
        if sibling is not None:
            rows.append(sibling)
    changes = {r.field: r.suggested_value for r in rows}
    await investors_svc.update(db, ws, investor, changes, now=now, extra_data=extra)
    for r in rows:
        _decide(r, SuggestionStatus.ACCEPTED, ws, now)
    await db.flush()
    return row


async def ignore(
    db: AsyncSession, ws: WorkspaceContext, row: FieldSuggestion, *, now: datetime
) -> FieldSuggestion:
    if _require_pending(row, SuggestionStatus.IGNORED):
        _decide(row, SuggestionStatus.IGNORED, ws, now)
        await db.flush()
    return row


async def pending_for(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    investor_ids: Sequence[UUID] | None = None,
    round_id: UUID | None = None,
    status: str | None = SuggestionStatus.PENDING.value,
    limit: int = 500,
) -> list[FieldSuggestion]:
    stmt = select(FieldSuggestion).where(FieldSuggestion.workspace_id == ws.workspace_id)
    if status:
        stmt = stmt.where(FieldSuggestion.status == status)
    if investor_ids is not None:
        stmt = stmt.where(FieldSuggestion.investor_id.in_(list(investor_ids)))
    if round_id is not None:
        members = select(RoundParticipant.investor_id).where(
            RoundParticipant.workspace_id == ws.workspace_id, RoundParticipant.round_id == round_id
        )
        stmt = stmt.where(
            FieldSuggestion.investor_id.in_(members),
            (FieldSuggestion.round_id.is_(None)) | (FieldSuggestion.round_id == round_id),
        )
    rows = await db.scalars(
        stmt.order_by(FieldSuggestion.created_at.desc(), FieldSuggestion.id).limit(limit)
    )
    return list(rows)


@dataclass
class AcceptAllResult:
    bulk_id: UUID
    accepted: int = 0
    skipped: list[dict[str, str]] = field(default_factory=list)


async def accept_all(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    investor_ids: Sequence[UUID] | None,
    round_id: UUID | None,
    now: datetime,
) -> AcceptAllResult:
    """Accept every pending suggestion for these investors (or this round's), one bulk id."""
    out = AcceptAllResult(bulk_id=uuid.uuid4())
    rows = await pending_for(db, ws, investor_ids=investor_ids, round_id=round_id, limit=5000)
    for row in rows:
        if row.status != SuggestionStatus.PENDING.value:  # accepted as a check-size sibling
            continue
        try:
            async with db.begin_nested():
                await accept(db, ws, row, now=now, bulk_id=out.bulk_id)
            out.accepted += 1
        except APIError as exc:
            await db.refresh(row)
            out.skipped.append({"id": str(row.id), "field": row.field, "reason": exc.code})
    return out


def suggestion_dict(row: FieldSuggestion) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "investor_id": str(row.investor_id),
        "round_id": str(row.round_id) if row.round_id else None,
        "dossier_id": str(row.dossier_id) if row.dossier_id else None,
        "field": row.field,
        "current_value": row.current_value,
        "suggested_value": row.suggested_value,
        "status": row.status,
        "created_at": row.created_at,
        "decided_at": row.decided_at,
    }


async def from_research_fields(
    db: AsyncSession, ws: WorkspaceContext, investors: Sequence[Investor]
) -> dict[UUID, list[str]]:
    """Fields whose value still equals what research filled in (the "from research" mark)."""
    by_id = {i.id: i for i in investors}
    out: dict[UUID, list[str]] = {i: [] for i in by_id}
    if not by_id:
        return out
    rows = await db.execute(
        select(FieldSuggestion.investor_id, FieldSuggestion.field, FieldSuggestion.suggested_value)
        .where(
            FieldSuggestion.workspace_id == ws.workspace_id,
            FieldSuggestion.investor_id.in_(list(by_id)),
            FieldSuggestion.round_id.is_(None),
            FieldSuggestion.status.in_(
                (SuggestionStatus.AUTO_APPLIED.value, SuggestionStatus.ACCEPTED.value)
            ),
        )
        .order_by(FieldSuggestion.created_at)
    )
    for inv_id, name, value in rows.tuples():
        inv = by_id[inv_id]
        current = getattr(inv, name, None)
        if not _empty(current, name) and _same(name, current, value) and name not in out[inv_id]:
            out[inv_id].append(name)
    return out
