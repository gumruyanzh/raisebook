"""Research runs: start, estimate, batches, the worker handler, resume and cancel
(RESEARCH-PLAN §4.1, §5; R2 to R4, R10 to R12).

A run is one press of a button (or one MCP call): ``identity``, ``dossier`` or ``refresh`` for
an investor (``prefill`` lives in ``services/company_profile``; ``agent`` runs are created
already finished by ``save_dossier``). It runs in the worker (``research.run`` jobs carry the
run id only) **as the person or key that asked**, after re-checking they still have write
access, and only with the workspace's own OpenRouter key.

Steps, each committed with its cost before the next starts (``progress.steps``)::

    identity:  identity → decide
    dossier:   identity (skipped when anchored) → search:activity → search:thesis →
               search:fund → filter → write → save
    refresh:   the same, searches limited to "since <last dossier>", then the diff

**Money** (R4): before every OpenRouter call the run reserves that call's upper-bound
estimate (``services/spend``; never over the monthly cap, even with many workers), then
settles OpenRouter's reported cost. A refused reservation ends the run ``capped`` (everything
gathered so far is kept; resumable). **Resume** re-runs a failed, partial or capped run:
finished steps are skipped, so nothing already paid for is paid twice.
"""

from __future__ import annotations

import json
import re
import statistics
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

import structlog
from pydantic import ValidationError
from sqlalchemy import and_, func, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext, worker_context
from raisebook.core.errors import (
    Conflict,
    EstimateChanged,
    IdentityMismatch,
    IdentityRequired,
    InvalidDossier,
    NoAiKey,
    NoCitedFacts,
    NotFound,
    ResearchUnavailable,
    SpendCapReached,
    ValidationFailed,
    not_found,
)
from raisebook.core.refs import how
from raisebook.models.ai import CompanyProfile, WorkspaceAiSettings
from raisebook.models.enums import (
    ACTIVE_RUN_STATUSES,
    IdentitySource,
    IdentityStatus,
    ResearchKind,
    RunStatus,
)
from raisebook.models.investor import Investor
from raisebook.models.research import (
    Dossier,
    InvestorIdentity,
    ResearchBatch,
    ResearchRun,
    ResearchSource,
)
from raisebook.models.round import Round, RoundParticipant, RoundStage
from raisebook.schemas.common import decode_cursor, encode_cursor
from raisebook.schemas.dossier import (
    WRITER_FORMAT_NAME,
    DossierDoc,
    WriterDoc,
    response_format,
)
from raisebook.services import ai_settings as ai_svc
from raisebook.services import dossiers as dossiers_svc
from raisebook.services import jobs as jobs_svc
from raisebook.services import openrouter, spend
from raisebook.services import research_identity as identity_svc
from raisebook.services import research_prompts as prompts
from raisebook.services import research_removal as removal_svc
from raisebook.services.research_cost import (
    IDENTITY_STEP,
    SEARCH_STEP,
    WRITER_STEP,
    RunModels,
    StepBudget,
    estimate_micros,
    price_of,
    step_micros,
)
from raisebook.services.research_validate import (
    Anchor,
    RawSource,
    check_sources,
    finalize,
    identity_matches,
    parse_date,
)

log = structlog.get_logger("raisebook.research")

SEARCH_KEYS = ("activity", "thesis", "fund")
STEP_LABELS: dict[str, str] = {
    "identity": "Finding who this is",
    "decide": "Checking the match",
    "search:activity": prompts.SEARCH_LABELS["activity"],
    "search:thesis": prompts.SEARCH_LABELS["thesis"],
    "search:fund": prompts.SEARCH_LABELS["fund"],
    "filter": "Reading sources",
    "write": "Writing",
    "save": "Checking citations",
}
RESERVE_FACTOR = 1.5
FALLBACK_RESERVE_MICROS = 500_000  # $0.50 for a call whose model has no known price
MEDIAN_AFTER_RUNS = 20
FRESH_DOSSIER_DAYS = 30
MAX_PROMPT_SOURCES = 40
MAX_WORKSPACE_FIRMS = 50
RESUMABLE = (RunStatus.FAILED.value, RunStatus.PARTIAL.value, RunStatus.CAPPED.value)
ACTIVE = tuple(s.value for s in ACTIVE_RUN_STATUSES)


def run_dedupe_key(run_id: UUID) -> str:
    return f"run:{run_id}"


def steps_for(kind: str, *, skip_identity: bool) -> list[str]:
    if kind == ResearchKind.IDENTITY.value:
        return ["identity", "decide"]
    steps = [] if skip_identity else ["identity"]
    return [*steps, *(f"search:{k}" for k in SEARCH_KEYS), "filter", "write", "save"]


def initial_progress(steps: Sequence[str]) -> dict[str, Any]:
    return {
        "step": None,
        "steps": [{"key": s, "label": STEP_LABELS.get(s, s), "state": "pending"} for s in steps],
        "done": 0,
        "total": len(steps),
    }


def _usd(micros: int | None) -> float | None:
    return None if micros is None else round(micros / 1_000_000, 6)


def models_of(row: WorkspaceAiSettings) -> RunModels:
    return RunModels(row.identity_model, row.search_model, row.writer_model)


# --- estimates (R4, R9) ----------------------------------------------------------------------


async def per_run_micros(
    db: AsyncSession, ws: WorkspaceContext, kind: ResearchKind, row: WorkspaceAiSettings
) -> int:
    """The estimate for one run: the workspace's median real cost once it has
    :data:`MEDIAN_AFTER_RUNS` finished runs of this kind and preset, else token budgets."""
    costs = list(
        await db.scalars(
            select(ResearchRun.cost_micros)
            .where(
                ResearchRun.workspace_id == ws.workspace_id,
                ResearchRun.kind == kind.value,
                ResearchRun.preset == row.preset,
                ResearchRun.status == RunStatus.SUCCEEDED.value,
                ResearchRun.cost_micros > 0,
            )
            .order_by(ResearchRun.created_at.desc())
            .limit(200)
        )
    )
    if len(costs) >= MEDIAN_AFTER_RUNS:
        return int(statistics.median(costs))
    est = estimate_micros(kind, models_of(row), openrouter.cached_models())
    return est if est is not None else FALLBACK_RESERVE_MICROS * 5


async def _usage_now(
    db: AsyncSession, ws: WorkspaceContext, row: WorkspaceAiSettings, now: datetime
) -> spend.Usage:
    return await spend.usage(db, ws.workspace_id, spend.month_of(now, ws.timezone))


def _cap_error(
    used: spend.Usage, cap: int, needed: int, *, fits: int | None = None, count: int | None = None
) -> SpendCapReached:
    msg = (
        f"Monthly AI limit reached (${cap / 1_000_000:,.2f}). An owner can raise it in "
        "Settings → AI research."
    )
    if fits is not None and count is not None:
        msg = (
            f"Only {fits} of {count} fit under your ${cap / 1_000_000:,.2f} monthly limit. "
            "Send allow_partial=true to research those, or raise the limit in Settings → AI "
            "research."
        )
    return SpendCapReached(
        msg,
        details={
            "spent_usd": _usd(used.spent_micros),
            "reserved_usd": _usd(used.reserved_micros),
            "cap_usd": _usd(cap),
            "needed_usd": _usd(needed),
            **({"fits": fits, "count": count} if fits is not None else {}),
        },
    )


# --- starting runs -------------------------------------------------------------------------------


async def active_run(
    db: AsyncSession, ws: WorkspaceContext, investor_id: UUID, kind: str
) -> ResearchRun | None:
    row: ResearchRun | None = await db.scalar(
        select(ResearchRun).where(
            ResearchRun.workspace_id == ws.workspace_id,
            ResearchRun.investor_id == investor_id,
            ResearchRun.kind == kind,
            ResearchRun.status.in_(ACTIVE),
        )
    )
    return row


async def _settings_with_key(db: AsyncSession, ws: WorkspaceContext) -> WorkspaceAiSettings:
    ai_svc.require_keyring()
    row = await ai_svc.get_or_default(db, ws)
    if not row.has_key:
        raise NoAiKey()
    if ai_svc.key_status(row) != "ok":
        raise NoAiKey(
            "The saved OpenRouter key can no longer be read on this server. An owner can enter "
            "it again in Settings → AI research."
        )
    return row


@dataclass
class Started:
    run: ResearchRun
    created: bool
    estimate_micros: int


async def start_run(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor: Investor,
    *,
    kind: ResearchKind,
    now: datetime,
    round_id: UUID | None = None,
    batch_id: UUID | None = None,
    priority: int = jobs_svc.PRIORITY_SINGLE,
    check_cap: bool = True,
    settings: WorkspaceAiSettings | None = None,
    per_run: int | None = None,
) -> Started:
    """Queue a run (the caller commits). A run of this kind already queued or running for the
    investor is returned instead (double clicks and agent retries start nothing new)."""
    if kind not in (ResearchKind.IDENTITY, ResearchKind.DOSSIER, ResearchKind.REFRESH):
        raise ValidationFailed("kind", "kind must be identity, dossier or refresh.")
    row = settings or await _settings_with_key(db, ws)
    existing = await active_run(db, ws, investor.id, kind.value)
    if existing is not None:
        return Started(existing, False, existing.estimate_micros)
    await removal_svc.require_not_suppressed(db, investor)
    identity = await identity_svc.get_identity(db, ws, investor.id)
    status = identity.status if identity else IdentityStatus.NONE.value
    if kind != ResearchKind.IDENTITY and status in identity_svc.BLOCKING:
        raise IdentityRequired(
            "Pick who this is first: "
            + (
                "choose one of the candidates"
                if status == IdentityStatus.NEEDS_PICK.value
                else "enter their LinkedIn URL"
            )
            + " with "
            + how(ws, "match_identity", f"POST /v1/investors/{investor.id}/identity")
            + ".",
            details={"identity_status": status},
        )
    if kind == ResearchKind.REFRESH and await dossiers_svc.latest(db, ws, investor.id) is None:
        kind = ResearchKind.DOSSIER
    anchored = status in identity_svc.ANCHORED
    instant = kind == ResearchKind.IDENTITY and (anchored or bool(investor.linkedin_url))
    estimate = 0 if instant else (per_run or await per_run_micros(db, ws, kind, row))
    if check_cap and not instant:
        used = await _usage_now(db, ws, row, now)
        if used.spent_micros + used.reserved_micros + estimate > row.monthly_cap_micros:
            raise _cap_error(used, row.monthly_cap_micros, estimate)
    steps = steps_for(kind.value, skip_identity=anchored or bool(investor.linkedin_url))
    run = ResearchRun(
        workspace_id=ws.workspace_id,
        investor_id=investor.id,
        round_id=round_id,
        batch_id=batch_id,
        kind=kind.value,
        status=RunStatus.QUEUED.value,
        preset=row.preset,
        identity_model=row.identity_model,
        search_model=row.search_model,
        writer_model=row.writer_model,
        estimate_micros=estimate,
        progress=initial_progress(steps),
        usage=[],
        created_at=now,
        updated_at=now,
    )
    run.set_actor(ws.actor)
    try:
        async with db.begin_nested():
            db.add(run)
            await db.flush()
    except IntegrityError:
        # Another request queued the same kind for this investor a moment ago.
        other = await active_run(db, ws, investor.id, kind.value)
        if other is None:
            raise
        return Started(other, False, other.estimate_micros)
    if instant:
        await _finish_instant_identity(db, ws, investor, run, now=now)
        return Started(run, True, 0)
    if not anchored and kind != ResearchKind.IDENTITY and investor.linkedin_url:
        confirmed = await identity_svc.confirm_existing(db, ws, investor, now=now)
        if confirmed is not None:
            await identity_svc.write_back_identity(
                db, ws, investor, confirmed, now=now, run_id=run.id
            )
    ident = await identity_svc.ensure_identity(db, ws, investor.id, now)
    if ident.status == IdentityStatus.NONE.value:
        ident.status = IdentityStatus.PENDING.value
        ident.updated_at = now
    await jobs_svc.enqueue(
        db,
        kind=jobs_svc.KIND_RESEARCH_RUN,
        now=now,
        workspace_id=ws.workspace_id,
        payload={"run_id": str(run.id)},
        dedupe_key=run_dedupe_key(run.id),
        priority=priority,
    )
    await db.flush()
    return Started(run, True, estimate)


async def _finish_instant_identity(
    db: AsyncSession, ws: WorkspaceContext, investor: Investor, run: ResearchRun, *, now: datetime
) -> None:
    """An identity run that needs no model call: already anchored, or a LinkedIn URL a person
    entered (confirmed without a call, R3)."""
    ident = await identity_svc.get_identity(db, ws, investor.id)
    if ident is None or ident.status not in identity_svc.ANCHORED:
        ident = await identity_svc.confirm_existing(db, ws, investor, now=now)
        assert ident is not None
        await identity_svc.write_back_identity(db, ws, investor, ident, now=now, run_id=run.id)
    run.status = RunStatus.SUCCEEDED.value
    run.started_at = now
    run.finished_at = now
    run.result = {"identity": {"status": ident.status, "source": ident.source}}
    run.progress = {
        **initial_progress(["identity", "decide"]),
        "steps": [
            {"key": k, "label": STEP_LABELS[k], "state": "done"} for k in ("identity", "decide")
        ],
        "done": 2,
    }
    run.updated_at = now
    await db.flush()


# --- bulk ---------------------------------------------------------------------------------------


@dataclass
class BulkEstimate:
    kind: ResearchKind
    count: int
    skipped: dict[str, int]
    per_run_micros: int
    total_micros: int
    remaining_micros: int
    fits: int
    eligible: list[Investor] = field(default_factory=list)
    free: set[UUID] = field(default_factory=set)  # no model call needed

    def cost_of(self, n: int) -> int:
        paid = [i for i in self.eligible[:n] if i.id not in self.free]
        return self.per_run_micros * len(paid)

    def as_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind.value,
            "count": self.count,
            "skipped": self.skipped,
            "per_run_usd": _usd(self.per_run_micros),
            "total_usd": _usd(self.total_micros),
            "remaining_usd": _usd(self.remaining_micros),
            "fits": self.fits,
        }


async def _investors_for(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor_ids: Sequence[UUID] | None,
    round_id: UUID | None,
) -> list[Investor]:
    if investor_ids is not None:
        wanted = list(dict.fromkeys(investor_ids))
        rows = {
            r.id: r
            for r in await db.scalars(
                select(Investor).where(
                    Investor.workspace_id == ws.workspace_id, Investor.id.in_(wanted)
                )
            )
        }
        missing = [str(i) for i in wanted if i not in rows]
        if missing:
            raise NotFound(
                f"{len(missing)} investor id(s) not found in this workspace.",
                details={"missing": missing[:20]},
            )
        return [rows[i] for i in wanted]
    if round_id is None:
        raise ValidationFailed("investor_ids", "Pass investor_ids or round.")
    found = await db.scalars(
        select(Investor)
        .join(
            RoundParticipant,
            and_(
                RoundParticipant.investor_id == Investor.id,
                RoundParticipant.workspace_id == ws.workspace_id,
            ),
        )
        .where(Investor.workspace_id == ws.workspace_id, RoundParticipant.round_id == round_id)
        .order_by(Investor.name, Investor.id)
        .limit(1000)
    )
    return list(found)


async def bulk_estimate(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    kind: ResearchKind,
    now: datetime,
    investor_ids: Sequence[UUID] | None = None,
    round_id: UUID | None = None,
    settings: WorkspaceAiSettings | None = None,
) -> BulkEstimate:
    """What "Research selected" / "Match identities" would cost, before anyone confirms."""
    if kind not in (ResearchKind.IDENTITY, ResearchKind.DOSSIER):
        raise ValidationFailed("kind", "kind must be identity or dossier.")
    row = settings or await ai_svc.get_or_default(db, ws)
    investors = await _investors_for(db, ws, investor_ids, round_id)
    ids = [i.id for i in investors]
    idents = (
        {
            r.investor_id: r.status
            for r in await db.scalars(
                select(InvestorIdentity).where(
                    InvestorIdentity.workspace_id == ws.workspace_id,
                    InvestorIdentity.investor_id.in_(ids),
                )
            )
        }
        if ids
        else {}
    )
    active = (
        set(
            await db.scalars(
                select(ResearchRun.investor_id).where(
                    ResearchRun.workspace_id == ws.workspace_id,
                    ResearchRun.investor_id.in_(ids),
                    ResearchRun.kind == kind.value,
                    ResearchRun.status.in_(ACTIVE),
                )
            )
        )
        if ids
        else set()
    )
    fresh_since = now - timedelta(days=FRESH_DOSSIER_DAYS)
    recent = (
        set(
            await db.scalars(
                select(Dossier.investor_id).where(
                    Dossier.workspace_id == ws.workspace_id,
                    Dossier.investor_id.in_(ids),
                    Dossier.created_at >= fresh_since,
                )
            )
        )
        if ids and kind == ResearchKind.DOSSIER
        else set()
    )
    suppressed = await removal_svc.suppressed_ids(db, investors)
    skipped = {"no_identity": 0, "suppressed": 0, "fresh": 0, "active": 0}
    eligible: list[Investor] = []
    free: set[UUID] = set()
    for inv in investors:
        status = idents.get(inv.id, IdentityStatus.NONE.value)
        if inv.id in suppressed:
            skipped["suppressed"] += 1
        elif inv.id in active:
            skipped["active"] += 1
        elif kind == ResearchKind.IDENTITY and status in identity_svc.ANCHORED:
            skipped["fresh"] += 1
        elif kind == ResearchKind.DOSSIER and status in identity_svc.BLOCKING:
            skipped["no_identity"] += 1
        elif kind == ResearchKind.DOSSIER and inv.id in recent:
            skipped["fresh"] += 1
        else:
            eligible.append(inv)
            if kind == ResearchKind.IDENTITY and inv.linkedin_url:
                free.add(inv.id)
    per_run = await per_run_micros(db, ws, kind, row)
    used = await _usage_now(db, ws, row, now)
    remaining = used.remaining(row.monthly_cap_micros)
    paid = [i for i in eligible if i.id not in free]
    fits = len(eligible)
    if per_run > 0 and per_run * len(paid) > remaining:
        affordable = remaining // per_run
        fits, counted = 0, 0
        for inv in eligible:
            if inv.id not in free:
                if counted == affordable:
                    break
                counted += 1
            fits += 1
    return BulkEstimate(
        kind=kind,
        count=len(eligible),
        skipped=skipped,
        per_run_micros=per_run,
        total_micros=per_run * len(paid),
        remaining_micros=remaining,
        fits=fits,
        eligible=eligible,
        free=free,
    )


async def create_batch(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    kind: ResearchKind,
    now: datetime,
    confirm_micros: int,
    allow_partial: bool,
    investor_ids: Sequence[UUID] | None = None,
    round_id: UUID | None = None,
) -> tuple[ResearchBatch, int]:
    """Queue one run per eligible investor after the person confirmed the estimate."""
    est = await bulk_estimate(
        db, ws, kind=kind, now=now, investor_ids=investor_ids, round_id=round_id
    )
    row = await _settings_with_key(db, ws)
    if est.count == 0:
        raise ValidationFailed(
            "investor_ids",
            "Nothing to research: every selected investor is skipped (see the estimate).",
        )
    take = est.count
    if est.fits < est.count:
        if not allow_partial or est.fits == 0:
            used = await _usage_now(db, ws, row, now)
            raise _cap_error(
                used, row.monthly_cap_micros, est.total_micros, fits=est.fits, count=est.count
            )
        take = est.fits
    cost = est.cost_of(take)
    if confirm_micros < cost:
        raise EstimateChanged(
            f"The estimate changed to ${cost / 1_000_000:,.2f}. Confirm the new amount.",
            details={
                "total_usd": _usd(cost),
                "count": take,
                "per_run_usd": _usd(est.per_run_micros),
            },
        )
    batch = ResearchBatch(
        workspace_id=ws.workspace_id,
        kind=kind.value,
        round_id=round_id,
        total=take,
        estimate_micros=cost,
        confirmed_micros=confirm_micros,
        created_at=now,
    )
    batch.set_actor(ws.actor)
    db.add(batch)
    await db.flush()
    for inv in est.eligible[:take]:
        await start_run(
            db,
            ws,
            inv,
            kind=kind,
            now=now,
            round_id=round_id,
            batch_id=batch.id,
            priority=jobs_svc.PRIORITY_BULK,
            check_cap=False,
            settings=row,
            per_run=est.per_run_micros,
        )
    return batch, take


async def get_batch(db: AsyncSession, ws: WorkspaceContext, batch_id: UUID) -> ResearchBatch:
    row: ResearchBatch | None = await db.scalar(
        select(ResearchBatch).where(
            ResearchBatch.workspace_id == ws.workspace_id, ResearchBatch.id == batch_id
        )
    )
    if row is None:
        raise not_found("Research batch")
    return row


async def batch_dict(
    db: AsyncSession, ws: WorkspaceContext, batch: ResearchBatch
) -> dict[str, Any]:
    rows = (
        await db.execute(
            select(
                ResearchRun.status,
                func.count(),
                func.coalesce(func.sum(ResearchRun.cost_micros), 0),
            )
            .where(ResearchRun.workspace_id == ws.workspace_id, ResearchRun.batch_id == batch.id)
            .group_by(ResearchRun.status)
        )
    ).all()
    counts = {str(s): int(n) for s, n, _ in rows}
    spent = sum(int(c) for _, _, c in rows)
    return {
        "id": batch.id,
        "kind": batch.kind,
        "round_id": batch.round_id,
        "total": batch.total,
        "counts": counts,
        "active": sum(counts.get(s, 0) for s in ACTIVE),
        "estimate_usd": _usd(batch.estimate_micros),
        "spent_usd": _usd(spent),
        "created_at": batch.created_at,
    }


async def _cancel_runs(
    db: AsyncSession,
    runs: Sequence[ResearchRun],
    *,
    now: datetime,
    code: str = "cancelled",
    message: str = "Cancelled.",
) -> int:
    n = 0
    for run in runs:
        if run.status not in ACTIVE:
            continue
        run.status = RunStatus.CANCELLED.value
        run.error_code = code
        run.error_message = message
        run.finished_at = now
        run.updated_at = now
        await db.flush()
        await spend.release_for_run(db, run_id=run.id, now=now)
        await db.execute(
            text(
                "UPDATE jobs SET status = 'cancelled', last_error = :code, finished_at = :now,"
                " updated_at = :now WHERE dedupe_key = :key AND status = 'queued'"
            ),
            {"code": code, "now": now, "key": run_dedupe_key(run.id)},
        )
        n += 1
    await _reset_pending_identities(db, runs, now)
    return n


async def _reset_pending_identities(
    db: AsyncSession, runs: Sequence[ResearchRun], now: datetime
) -> None:
    """An identity left ``pending`` by a run that will not finish goes back to ``none``."""
    for run in runs:
        if run.investor_id is None:
            continue
        await db.execute(
            update(InvestorIdentity)
            .where(
                InvestorIdentity.workspace_id == run.workspace_id,
                InvestorIdentity.investor_id == run.investor_id,
                InvestorIdentity.status == IdentityStatus.PENDING.value,
            )
            .values(status=IdentityStatus.NONE.value, updated_at=now)
            .execution_options(synchronize_session=False)
        )


async def cancel_batch(
    db: AsyncSession, ws: WorkspaceContext, batch: ResearchBatch, *, now: datetime
) -> int:
    """Queued runs end ``cancelled``; running ones stop before their next call."""
    runs = list(
        await db.scalars(
            select(ResearchRun).where(
                ResearchRun.workspace_id == ws.workspace_id,
                ResearchRun.batch_id == batch.id,
                ResearchRun.status.in_(ACTIVE),
            )
        )
    )
    return await _cancel_runs(db, runs, now=now)


# --- runs: read, cancel, resume -----------------------------------------------------------------


async def get_run(db: AsyncSession, ws: WorkspaceContext, run_id: UUID) -> ResearchRun:
    row: ResearchRun | None = await db.scalar(
        select(ResearchRun).where(
            ResearchRun.workspace_id == ws.workspace_id, ResearchRun.id == run_id
        )
    )
    if row is None:
        raise not_found("Research run")
    return row


async def source_counts(
    db: AsyncSession, ws: WorkspaceContext, run_ids: Sequence[UUID]
) -> dict[UUID, dict[str, int]]:
    out: dict[UUID, dict[str, int]] = {r: {"gathered": 0, "accepted": 0} for r in run_ids}
    if not run_ids:
        return out
    rows = await db.execute(
        select(ResearchSource.run_id, ResearchSource.accepted, func.count())
        .where(
            ResearchSource.workspace_id == ws.workspace_id,
            ResearchSource.run_id.in_(list(run_ids)),
        )
        .group_by(ResearchSource.run_id, ResearchSource.accepted)
    )
    for run_id, accepted, n in rows.tuples():
        if run_id is None:
            continue
        out[run_id]["gathered"] += int(n)
        if accepted:
            out[run_id]["accepted"] += int(n)
    return out


def run_dict(run: ResearchRun, sources: dict[str, int] | None = None) -> dict[str, Any]:
    result = dict(run.result or {})
    if run.kind != ResearchKind.PREFILL.value:
        result.pop("draft", None)  # the writer's raw output stays internal
        result.pop("workspace_facts", None)
    result.pop("idempotency_key", None)
    return {
        "id": run.id,
        "investor_id": run.investor_id,
        "round_id": run.round_id,
        "batch_id": run.batch_id,
        "kind": run.kind,
        "status": run.status,
        "preset": run.preset,
        "models": {
            "identity": run.identity_model,
            "search": run.search_model,
            "writer": run.writer_model,
        },
        "estimate_usd": _usd(run.estimate_micros),
        "cost_usd": _usd(run.cost_micros),
        "progress": run.progress or {},
        "error": {"code": run.error_code, "message": run.error_message} if run.error_code else None,
        "dossier_id": run.dossier_id,
        "result": result or None,
        "sources": sources or {"gathered": 0, "accepted": 0},
        "can_resume": run.status in RESUMABLE,
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "by": {"type": run.actor_type, "label": run.actor_label, "via": run.via},
    }


async def list_runs(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    investor_id: UUID | None = None,
    batch_id: UUID | None = None,
    status: str | None = None,
    kind: str | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> tuple[list[ResearchRun], str | None]:
    stmt = select(ResearchRun).where(ResearchRun.workspace_id == ws.workspace_id)
    if investor_id is not None:
        stmt = stmt.where(ResearchRun.investor_id == investor_id)
    if batch_id is not None:
        stmt = stmt.where(ResearchRun.batch_id == batch_id)
    if status:
        stmt = stmt.where(ResearchRun.status == status)
    if kind:
        stmt = stmt.where(ResearchRun.kind == kind)
    cur = decode_cursor(cursor)
    if cur:
        at = datetime.fromisoformat(str(cur["at"]))
        rid = UUID(str(cur["id"]))
        stmt = stmt.where(
            (ResearchRun.created_at < at)
            | ((ResearchRun.created_at == at) & (ResearchRun.id < rid))
        )
    rows = list(
        await db.scalars(
            stmt.order_by(ResearchRun.created_at.desc(), ResearchRun.id.desc()).limit(limit + 1)
        )
    )
    nxt = None
    if len(rows) > limit:
        rows = rows[:limit]
        last = rows[-1]
        nxt = encode_cursor({"at": last.created_at.isoformat(), "id": str(last.id)})
    return rows, nxt


async def cancel_run(
    db: AsyncSession, ws: WorkspaceContext, run: ResearchRun, *, now: datetime
) -> ResearchRun:
    if run.status in ACTIVE:
        await _cancel_runs(db, [run], now=now)
    return run


async def resume_run(
    db: AsyncSession, ws: WorkspaceContext, run: ResearchRun, *, now: datetime
) -> ResearchRun:
    """Run a failed, partial or capped run again; finished steps are skipped (RE)."""
    if run.status in ACTIVE:
        return run
    if run.status not in RESUMABLE or run.kind not in (
        ResearchKind.IDENTITY.value,
        ResearchKind.DOSSIER.value,
        ResearchKind.REFRESH.value,
    ):
        raise Conflict(
            f"Only failed, partial or capped runs can be resumed (this one is {run.status}).",
            details={"status": run.status},
        )
    row = await _settings_with_key(db, ws)
    used = await _usage_now(db, ws, row, now)
    if used.remaining(row.monthly_cap_micros) <= 0:
        raise _cap_error(used, row.monthly_cap_micros, run.estimate_micros)
    if run.investor_id is not None and await active_run(db, ws, run.investor_id, run.kind):
        raise Conflict("Another run of this kind is already going for this investor.")
    run.status = RunStatus.QUEUED.value
    run.error_code = None
    run.error_message = None
    run.finished_at = None
    run.updated_at = now
    await db.flush()
    await jobs_svc.enqueue(
        db,
        kind=jobs_svc.KIND_RESEARCH_RUN,
        now=now,
        workspace_id=ws.workspace_id,
        payload={"run_id": str(run.id)},
        dedupe_key=run_dedupe_key(run.id),
        priority=jobs_svc.PRIORITY_SINGLE,
    )
    return run


async def usage_report(
    db: AsyncSession, ws: WorkspaceContext, *, month: str | None, now: datetime
) -> dict[str, Any]:
    row = await ai_svc.get_or_default(db, ws)
    if month:
        try:
            first = datetime.strptime(month, "%Y-%m").date()
        except ValueError:
            raise ValidationFailed("month", "month must be YYYY-MM.") from None
    else:
        first = spend.month_of(now, ws.timezone)
    used = await spend.usage(db, ws.workspace_id, first)
    nxt = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
    rows = (
        await db.execute(
            text(
                "SELECT kind, count(*), coalesce(sum(cost_micros), 0) FROM research_runs"
                " WHERE workspace_id = :ws"
                " AND (created_at AT TIME ZONE :tz)::date >= :a"
                " AND (created_at AT TIME ZONE :tz)::date < :b"
                " GROUP BY kind"
            ),
            {"ws": ws.workspace_id, "tz": ws.timezone, "a": first, "b": nxt},
        )
    ).all()
    return {
        "month": first.strftime("%Y-%m"),
        "spent_usd": _usd(used.spent_micros),
        "reserved_usd": _usd(used.reserved_micros),
        "calls": used.calls,
        "cap_usd": _usd(row.monthly_cap_micros),
        "remaining_usd": _usd(used.remaining(row.monthly_cap_micros)),
        "by_kind": {str(k): {"runs": int(n), "cost_usd": _usd(int(c))} for k, n, c in rows},
    }


# --- the worker handler -------------------------------------------------------------------------


class _Ended(Exception):
    """The run reached a terminal state that is already written."""


class _Capped(Exception):
    pass


def _subject(investor: Investor, anchor: Anchor) -> prompts.Subject:
    return prompts.Subject(
        name=investor.name,
        firm=anchor.firm or investor.firm,
        title=anchor.title or investor.title,
        location=investor.location,
        linkedin_url=investor.linkedin_url,
        website_url=investor.website_url,
        firm_domain=anchor.firm_domain,
    )


_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def parse_json_object(content: str) -> Any:
    text_ = (content or "").strip()
    m = _JSON_FENCE.search(text_)
    if m:
        text_ = m.group(1).strip()
    start = text_.find("{")
    end = text_.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object")
    return json.loads(text_[start : end + 1])


def schema_errors(exc: ValidationError) -> list[str]:
    out = []
    for err in exc.errors(include_url=False)[:20]:
        loc = ".".join(str(x) for x in err.get("loc", ()))
        out.append(f"{loc or 'document'}: {err.get('msg', 'invalid')}")
    return out


class Runner:
    """One ``research.run`` job: one session, one commit per step."""

    def __init__(self, ctx: Any, db: AsyncSession, run_id: UUID) -> None:
        self.ctx = ctx
        self.db = db
        self.run_id = run_id
        self.run: ResearchRun
        self.ws: WorkspaceContext
        self.investor: Investor
        self.settings: WorkspaceAiSettings
        self.client: openrouter.OpenRouterClient
        self.anchor: Anchor

    def now(self) -> datetime:
        now: datetime = self.ctx.now()
        return now

    async def _reload(self) -> ResearchRun | None:
        row: ResearchRun | None = await self.db.scalar(
            select(ResearchRun)
            .where(ResearchRun.id == self.run_id)
            .execution_options(populate_existing=True)
        )
        return row

    # progress -----------------------------------------------------------------------------

    def _done(self, step: str) -> bool:
        return any(
            s["key"] == step and s["state"] == "done"
            for s in (self.run.progress or {}).get("steps", [])
        )

    def _mark(self, step: str, state: str, **extra: Any) -> None:
        prog = dict(self.run.progress or {})
        steps = [dict(s) for s in prog.get("steps", [])]
        if not any(s["key"] == step for s in steps):
            steps.append({"key": step, "label": STEP_LABELS.get(step, step), "state": "pending"})
        for s in steps:
            if s["key"] == step:
                s["state"] = state
        prog["steps"] = steps
        prog["step"] = step if state == "running" else prog.get("step")
        prog["done"] = sum(1 for s in steps if s["state"] in ("done", "skipped"))
        prog["total"] = len(steps)
        prog.update(extra)
        self.run.progress = prog
        self.run.updated_at = self.now()

    async def _end(
        self, status: RunStatus, code: str | None = None, message: str | None = None
    ) -> None:
        now = self.now()
        await self.db.flush()
        await spend.release_for_run(self.db, run_id=self.run.id, now=now)
        run = await self._reload()
        assert run is not None
        self.run = run
        run.status = status.value
        run.error_code = code
        run.error_message = message[:500] if message else None
        run.finished_at = now
        run.updated_at = now
        prog = dict(run.progress or {})
        prog["step"] = None
        run.progress = prog
        if status in (RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.CAPPED, RunStatus.PARTIAL):
            await _reset_pending_identities(self.db, [run], now)
        await self.db.commit()
        log.info(
            "research_run_ended",
            run_id=str(run.id),
            kind=run.kind,
            status=status.value,
            code=code,
            cost_micros=run.cost_micros,
        )

    async def _checkpoint(self) -> None:
        """Between steps: the lease is still ours and nobody cancelled the run."""
        self.ctx.check_lease()
        status = await self.db.scalar(
            select(ResearchRun.status).where(ResearchRun.id == self.run_id)
        )
        if status == RunStatus.CANCELLED.value:
            await spend.release_for_run(self.db, run_id=self.run_id, now=self.now())
            await self.db.commit()
            raise _Ended()

    # calls -----------------------------------------------------------------------------------

    async def call(
        self,
        step: str,
        model: str,
        messages: list[dict[str, Any]],
        *,
        budget: StepBudget,
        max_tokens: int,
        **kw: Any,
    ) -> openrouter.ChatResult:
        await self._checkpoint()
        now = self.now()
        prices = openrouter.cached_models()
        info = price_of(model, prices)
        one = StepBudget(1, budget.prompt_tokens, budget.completion_tokens, budget.searches)
        amount = (
            int(step_micros(info, one) * RESERVE_FACTOR)
            if info is not None
            else FALLBACK_RESERVE_MICROS
        )
        month = spend.month_of(now, self.ws.timezone)
        await self.db.flush()
        ok = await spend.reserve_for_run(
            self.db,
            run_id=self.run.id,
            workspace_id=self.ws.workspace_id,
            month=month,
            amount_micros=amount,
            cap_micros=self.settings.monthly_cap_micros,
            now=now,
        )
        await self.db.commit()
        if not ok:
            raise _Capped()
        try:
            result = await self.client.chat(model, messages, max_tokens=max_tokens, **kw)
        except openrouter.OpenRouterError:
            await spend.release_for_run(self.db, run_id=self.run.id, now=self.now())
            await self.db.commit()
            raise
        cost = result.usage.cost_micros
        estimated = cost is None
        if cost is None:
            cost = (
                int(
                    (
                        info.prompt * result.usage.prompt_tokens
                        + info.completion * result.usage.completion_tokens
                        + info.request
                        + (info.web_search if budget.searches else 0)
                    )
                    * 1_000_000
                )
                if info is not None
                else amount
            )
        await spend.settle_for_run(self.db, run_id=self.run.id, actual_micros=cost, now=self.now())
        run = await self._reload()
        assert run is not None
        self.run = run
        entry: dict[str, Any] = {
            "step": step,
            "model": result.model,
            "generation_id": result.generation_id,
            "prompt_tokens": result.usage.prompt_tokens,
            "completion_tokens": result.usage.completion_tokens,
            "cost_micros": cost,
        }
        if estimated:
            entry["estimated"] = True
        run.usage = [*(run.usage or []), entry]
        run.updated_at = self.now()
        await self.db.commit()
        return result

    # steps -----------------------------------------------------------------------------------

    async def _store_sources(
        self, found: Sequence[openrouter.WebSource], *, check: bool
    ) -> list[ResearchSource]:
        now = self.now()
        raw = [
            RawSource(str(i), s.url, s.title, s.snippet, parse_date(s.published_at))
            for i, s in enumerate(found)
        ]
        checked, removed = check_sources(raw, self.anchor)
        if removed:
            prog = dict(self.run.progress or {})
            prog["privacy_removed"] = int(prog.get("privacy_removed", 0)) + removed
            self.run.progress = prog
        for c in checked:
            if c.check.reason == "duplicate":
                continue
            accepted = c.check.accepted if check else False
            await self.db.execute(
                pg_insert(ResearchSource)
                .values(
                    workspace_id=self.ws.workspace_id,
                    run_id=self.run.id,
                    investor_id=self.investor.id,
                    url=c.url,
                    url_key=c.url_key,
                    domain=c.domain,
                    title=c.title,
                    snippet=c.snippet,
                    published_at=c.published_at,
                    fetched_at=now,
                    matched_anchor=c.check.matched if accepted else None,
                    accepted=accepted,
                    rejected_reason=c.check.reason if check and not accepted else None,
                    created_at=now,
                )
                .on_conflict_do_nothing(
                    index_elements=["run_id", "url_key"], index_where=text("run_id IS NOT NULL")
                )
            )
        await self.db.flush()
        keys = [c.url_key for c in checked]
        rows = await self.db.scalars(
            select(ResearchSource).where(
                ResearchSource.workspace_id == self.ws.workspace_id,
                ResearchSource.run_id == self.run.id,
                ResearchSource.url_key.in_(keys),
            )
        )
        by_key = {r.url_key: r for r in rows}
        # Keep the citation order (identity evidence is referenced by number).
        out: list[ResearchSource] = []
        seen: dict[str, ResearchSource] = {}
        for c in checked:
            if c.url_key in by_key:
                seen.setdefault(c.url_key, by_key[c.url_key])
                out.append(seen[c.url_key])
        return out

    async def identity_step(self) -> bool:
        """True when the investor is anchored afterwards."""
        ident = await identity_svc.get_identity(self.db, self.ws, self.investor.id)
        if ident is not None and ident.status in identity_svc.ANCHORED:
            planned = {st["key"] for st in (self.run.progress or {}).get("steps", [])}
            if "identity" in planned and not self._done("identity"):
                self._mark("identity", "skipped")
            return True
        if self._done("identity") and ident is not None:
            return ident.status in identity_svc.ANCHORED
        if self.investor.linkedin_url:
            ident = await identity_svc.confirm_existing(
                self.db, self.ws, self.investor, now=self.now()
            )
            assert ident is not None
            await identity_svc.write_back_identity(
                self.db, self.ws, self.investor, ident, now=self.now(), run_id=self.run.id
            )
            self._mark("identity", "done")
            await self.db.commit()
            return True
        self._mark("identity", "running")
        await self.db.commit()
        model = self.run.identity_model or self.settings.identity_model
        result = await self.call(
            "identity",
            model,
            prompts.identity_messages(_subject(self.investor, self.anchor)),
            budget=IDENTITY_STEP,
            max_tokens=900,
            **openrouter.search_options(model, context_size="low", max_results=5),
        )
        stored = await self._store_sources(result.sources, check=False)
        candidates = identity_svc.parse_candidates(result.content)
        decision = identity_svc.decide(candidates, self.investor, list(result.sources))
        row = await identity_svc.record_decision(
            self.db,
            self.ws,
            self.investor,
            decision,
            run_id=self.run.id,
            source_ids=[s.id for s in stored],
            now=self.now(),
        )
        self.run.result = {
            **(self.run.result or {}),
            "identity": {
                "status": row.status,
                "candidates": len(decision.candidates),
                "confidence": float(row.confidence) if row.confidence is not None else None,
            },
        }
        self._mark("identity", "done")
        if self.run.kind == ResearchKind.IDENTITY.value:
            self._mark("decide", "done")
        await self.db.commit()
        return row.status in identity_svc.ANCHORED

    async def search_step(self, key: str, since: str | None) -> None:
        step = f"search:{key}"
        if self._done(step):
            return
        self._mark(step, "running")
        await self.db.commit()
        model = self.run.search_model or self.settings.search_model
        result = await self.call(
            step,
            model,
            prompts.search_messages(_subject(self.investor, self.anchor), key, since=since),
            budget=SEARCH_STEP,
            max_tokens=1200,
            **openrouter.search_options(model, context_size="medium", max_results=8),
        )
        await self._store_sources(result.sources, check=True)
        self._mark(step, "done")
        await self.db.commit()

    async def _accepted_sources(self) -> list[ResearchSource]:
        rows = await self.db.scalars(
            select(ResearchSource)
            .where(
                ResearchSource.workspace_id == self.ws.workspace_id,
                ResearchSource.run_id == self.run.id,
                ResearchSource.accepted.is_(True),
            )
            .order_by(ResearchSource.created_at, ResearchSource.id)
            .limit(MAX_PROMPT_SOURCES)
        )
        return list(rows)

    async def _workspace_facts(self) -> dict[str, Any]:
        firms = await self.db.scalars(
            select(Investor.firm)
            .join(RoundParticipant, RoundParticipant.investor_id == Investor.id)
            .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
            .where(
                Investor.workspace_id == self.ws.workspace_id,
                Investor.firm.is_not(None),
                Investor.id != self.investor.id,
                RoundStage.kind.in_(("active", "won")),
            )
            .distinct()
            .limit(MAX_WORKSPACE_FIRMS)
        )
        return {
            "warm_intro_by": self.investor.warm_intro_by,
            "source": self.investor.source,
            "firms_committed_or_active": sorted({f for f in firms if f}),
        }

    @staticmethod
    def _fact_values(facts: dict[str, Any]) -> list[str]:
        out = [facts.get("warm_intro_by"), facts.get("source")]
        return [v for v in [*out, *facts.get("firms_committed_or_active", [])] if v]

    async def _company(self) -> dict[str, Any] | None:
        row = await self.db.scalar(
            select(CompanyProfile).where(CompanyProfile.workspace_id == self.ws.workspace_id)
        )
        if row is None:
            return None
        from raisebook.services.company_profile import is_empty

        if is_empty(row):
            return None
        return {
            "pitch": row.pitch,
            "sectors": list(row.sectors or []),
            "stage": row.stage,
            "location": row.location,
            "traction": list(row.traction or []),
            "wants_lead": row.wants_lead,
            "check_min": row.check_min,
            "check_max": row.check_max,
            "currency": self.ws.currency,
            "strategic_help": row.strategic_help,
        }

    async def _round_terms(self) -> dict[str, Any] | None:
        if self.run.round_id is None:
            return None
        rnd = await self.db.scalar(
            select(Round).where(
                Round.workspace_id == self.ws.workspace_id, Round.id == self.run.round_id
            )
        )
        if rnd is None:
            return None
        return {
            "name": rnd.name,
            "target": rnd.target_amount,
            "instrument": rnd.instrument,
            "valuation_cap": rnd.valuation_cap,
            "currency": rnd.currency,
        }

    async def write_step(self, since: str | None) -> bool:
        """The writer call; False when the run ended ``partial``."""
        if self._done("write") and (self.run.result or {}).get("draft"):
            return True
        sources = await self._accepted_sources()
        if not sources:
            await self._end(
                RunStatus.PARTIAL,
                "no_sources",
                "No source matched this investor's identity, so the dossier was not written. "
                "Check the identity, then resume.",
            )
            return False
        self._mark("write", "running")
        await self.db.commit()
        prev_keys: list[str] = []
        if self.run.kind == ResearchKind.REFRESH.value:
            prev = await dossiers_svc.latest(self.db, self.ws, self.investor.id)
            if prev is not None:
                pf = await dossiers_svc.facts_of(self.db, prev)
                prev_keys = [f["key"] for f in (pf.facts if pf else [])]
        workspace_facts = await self._workspace_facts()
        messages_kw: dict[str, Any] = {
            "anchor": self.anchor.as_dict(),
            "sources": [
                prompts.SourceForPrompt(
                    f"s{i}",
                    s.url,
                    s.title,
                    s.published_at.isoformat() if s.published_at else None,
                    s.snippet,
                )
                for i, s in enumerate(sources, start=1)
            ],
            "company": await self._company(),
            "round_terms": await self._round_terms(),
            "workspace_facts": workspace_facts,
            "previous_fact_keys": prev_keys,
            "since": since,
        }
        model = self.run.writer_model or self.settings.writer_model
        info = (openrouter.cached_models() or {}).get(model)
        temperature = 0.2 if info is None or "temperature" in info.supported_parameters else None
        errors: list[str] = []
        for attempt in (1, 2):
            result = await self.call(
                "write",
                model,
                prompts.writer_messages(**messages_kw, errors=errors),
                budget=WRITER_STEP,
                max_tokens=6000,
                response_format=response_format(WRITER_FORMAT_NAME, WriterDoc),
                temperature=temperature,
            )
            try:
                doc = WriterDoc.model_validate(parse_json_object(result.content))
            except ValidationError as exc:
                errors = schema_errors(exc)
            except ValueError:
                errors = ["The answer was not a JSON object matching the schema."]
            else:
                self.run.result = {
                    **(self.run.result or {}),
                    "draft": doc.model_dump(mode="json"),
                    "workspace_facts": self._fact_values(workspace_facts),
                    "no_profile": messages_kw["company"] is None,
                }
                self._mark("write", "done")
                await self.db.commit()
                return True
            log.info("research_writer_invalid", run_id=str(self.run.id), attempt=attempt)
        await self._end(
            RunStatus.PARTIAL,
            "invalid_dossier",
            f"{len(sources)} sources gathered, but the writer model's dossier did not match the "
            "schema twice. Resume to try again, or pick another writer model.",
        )
        return False

    async def save_step(self) -> None:
        sources = await self._accepted_sources()
        local = {f"s{i}": s for i, s in enumerate(sources, start=1)}
        result = dict(self.run.result or {})
        doc = WriterDoc.model_validate(result["draft"])
        if result.get("no_profile"):
            doc.analysis.brief.verdict = "possible"
            doc.analysis.brief.why = prompts.NO_PROFILE_WHY
            doc.analysis.fit = type(doc.analysis.fit)()
            doc.analysis.talking_points = []
        outcome = finalize(
            doc,
            accepted_ids=set(local),
            source_dates={k: s.published_at for k, s in local.items()},
            agent=False,
            workspace_facts=result.get("workspace_facts", []),
            anchor=self.anchor,
        )
        prog_removed = int((self.run.progress or {}).get("privacy_removed", 0))
        if not outcome.facts:
            self._mark("save", "failed", privacy_removed=prog_removed + outcome.privacy_removed)
            await self._end(
                RunStatus.PARTIAL,
                "no_cited_facts",
                f"{len(sources)} sources gathered, but no claim in the dossier cited them, so "
                "it was not saved. Resume to write it again.",
            )
            return
        ident = await identity_svc.get_identity(self.db, self.ws, self.investor.id)
        stored = await dossiers_svc.store(
            self.db,
            self.ws,
            self.investor,
            outcome,
            sources=local,
            identity={**self.anchor.as_dict(), **identity_svc.identity_dict(ident)},
            author_kind="model",
            author_label=self.run.writer_model or "model",
            now=self.now(),
            run_id=self.run.id,
            round_id=self.run.round_id,
        )
        self.run.dossier_id = stored.dossier.id
        result.pop("draft", None)
        result.pop("workspace_facts", None)
        result.update(
            {
                "dossier_id": str(stored.dossier.id),
                "version": stored.dossier.version,
                "facts": len(stored.facts),
                "moved_to_unverified": outcome.moved_to_unverified,
                "dropped": len(outcome.dropped),
                "new_facts": len(stored.new_fact_keys),
                "writeback": stored.writeback.counts,
            }
        )
        self.run.result = result
        self._mark("save", "done", privacy_removed=prog_removed + outcome.privacy_removed)
        await self.db.flush()
        await self._end(RunStatus.SUCCEEDED)

    async def _prepare(self) -> bool:
        run = await self._reload()
        if run is None or run.status not in ACTIVE:
            return False
        self.run = run
        now = self.now()
        ws = await worker_context(
            self.db,
            workspace_id=run.workspace_id,
            actor_type=run.actor_type,
            via=run.via,
            actor_user_id=run.actor_user_id,
            api_key_id=run.api_key_id,
            actor_label=run.actor_label,
            agent_model=run.agent_model,
            now=now,
        )
        if ws is None:
            await self._end(
                RunStatus.CANCELLED,
                "requester_lost_access",
                "The person or key that started this research no longer has write access.",
            )
            return False
        self.ws = ws
        inv = await self.db.scalar(
            select(Investor).where(
                Investor.workspace_id == ws.workspace_id, Investor.id == run.investor_id
            )
        )
        if inv is None:
            return False
        self.investor = inv
        settings = await ai_svc.get_row(self.db, ws.workspace_id)
        try:
            key = await ai_svc.open_key(self.db, ws.workspace_id)
        except (NoAiKey, ResearchUnavailable) as exc:
            await self._end(RunStatus.FAILED, "no_ai_key", exc.message)
            raise jobs_svc.PermanentJobError("no_ai_key") from None
        assert settings is not None
        self.settings = settings
        self.client = openrouter.OpenRouterClient(key)
        del key
        if await removal_svc.is_suppressed(self.db, inv):
            await self._end(RunStatus.FAILED, "research_suppressed", removal_svc.SUPPRESSED_MESSAGE)
            return False
        ident = await identity_svc.get_identity(self.db, ws, inv.id)
        self.anchor = identity_svc.anchor_of(ident, inv)
        if run.status == RunStatus.QUEUED.value:
            run.status = RunStatus.RUNNING.value
            run.started_at = run.started_at or now
            run.updated_at = now
        await self.db.commit()
        return True

    async def execute(self) -> None:
        if not await self._prepare():
            return
        try:
            if self.run.kind == ResearchKind.IDENTITY.value:
                await self.identity_step()
                await self._end(RunStatus.SUCCEEDED)
                return
            if not await self.identity_step():
                ident = await identity_svc.get_identity(self.db, self.ws, self.investor.id)
                await self._end(
                    RunStatus.BLOCKED_IDENTITY,
                    "identity_required",
                    "We are not sure who this is. Pick the right person (Is this them?), then "
                    "research again."
                    if ident is not None and ident.status == IdentityStatus.NEEDS_PICK.value
                    else "No matching professional profile was found. Enter their LinkedIn URL, "
                    "then research again.",
                )
                return
            ident = await identity_svc.get_identity(self.db, self.ws, self.investor.id)
            self.anchor = identity_svc.anchor_of(ident, self.investor)
            since = None
            if self.run.kind == ResearchKind.REFRESH.value:
                prev = await dossiers_svc.latest(self.db, self.ws, self.investor.id)
                since = prev.created_at.date().isoformat() if prev else None
            for key in SEARCH_KEYS:
                await self.search_step(key, since)
            await self._checkpoint()
            accepted = len(await self._accepted_sources())
            self._mark("filter", "done", sources_accepted=accepted)
            await self.db.commit()
            if not await self.write_step(since):
                return
            await self._checkpoint()
            await self.save_step()
        except _Ended:
            return
        except _Capped:
            await self._end(
                RunStatus.CAPPED,
                "spend_cap_reached",
                f"Monthly AI limit reached (${self.settings.monthly_cap_micros / 1_000_000:,.2f})."
                " An owner can raise it in Settings → AI research; then resume.",
            )
        except openrouter.OpenRouterError as exc:
            await self._failed_call(exc)

    async def _failed_call(self, exc: openrouter.OpenRouterError) -> None:
        run = await self._reload()
        assert run is not None
        self.run = run
        if exc.transient and self.ctx.job.attempts < self.ctx.job.max_attempts:
            run.error_code = exc.code
            run.error_message = exc.message[:500]
            run.updated_at = self.now()
            await self.db.commit()
            raise jobs_svc.TransientJobError(exc.code, retry_after_s=exc.retry_after_s)
        gathered = (await source_counts(self.db, self.ws, [run.id]))[run.id]["gathered"]
        status = RunStatus.PARTIAL if gathered else RunStatus.FAILED
        await self._end(status, exc.code, exc.message)
        raise jobs_svc.PermanentJobError(exc.code)


async def run_job(ctx: Any) -> None:
    """``research.run`` handler (registered with the worker)."""
    run_id = UUID(str(ctx.job.payload["run_id"]))
    async with ctx.session() as db:
        await Runner(ctx, db, run_id).execute()


async def on_recover(db: AsyncSession, rec: jobs_svc.RecoveredJob, now: datetime) -> None:
    """A worker died holding this run: give back its reservation; fail it if the job is out
    of attempts (it stays resumable)."""
    raw = rec.payload.get("run_id")
    if not raw:
        return
    run_id = UUID(str(raw))
    await spend.release_for_run(db, run_id=run_id, now=now)
    run = await db.get(ResearchRun, run_id)
    if run is None or run.status not in ACTIVE:
        return
    if rec.failed:
        run.status = RunStatus.FAILED.value
        run.error_code = "worker_lost"
        run.error_message = "The worker stopped answering several times. Resume to try again."
        run.finished_at = now
        await _reset_pending_identities(db, [run], now)
    else:
        run.status = RunStatus.QUEUED.value
    run.updated_at = now
    await db.flush()


# --- agent dossiers (R11) -------------------------------------------------------------------------


@dataclass
class AgentSave:
    dossier: Dossier
    run: ResearchRun
    result: dict[str, Any]
    repeated: bool = False


async def save_agent_dossier(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor: Investor,
    raw: Any,
    *,
    now: datetime,
    round_id: UUID | None = None,
    idempotency_key: str | None = None,
) -> AgentSave:
    """``save_dossier``: an agent researched with its own tools and submits a DossierDoc. Same
    rules as model dossiers (schema, suppression, identity anchor, citations, privacy); costs
    the workspace nothing and works without an OpenRouter key."""
    key = (idempotency_key or "").strip() or None
    if key is not None:
        if len(key) > 200:
            raise ValidationFailed("idempotency_key", "idempotency_key is at most 200 chars.")
        prev = await db.scalar(
            select(ResearchRun).where(
                ResearchRun.workspace_id == ws.workspace_id,
                ResearchRun.investor_id == investor.id,
                ResearchRun.kind == ResearchKind.AGENT.value,
                ResearchRun.result["idempotency_key"].astext == key,
            )
        )
        if prev is not None and prev.dossier_id is not None:
            d = await db.get(Dossier, prev.dossier_id)
            if d is not None:
                out = dict(prev.result or {})
                out.pop("idempotency_key", None)
                return AgentSave(d, prev, out, repeated=True)
    try:
        doc = raw if isinstance(raw, DossierDoc) else DossierDoc.model_validate(raw)
    except ValidationError as exc:
        raise InvalidDossier(
            "The dossier does not match schema v1. Fix the fields listed in details.",
            details=[
                {"loc": list(e.get("loc", ())), "msg": e.get("msg"), "type": e.get("type")}
                for e in exc.errors(include_url=False)[:50]
            ],
        ) from None
    await removal_svc.require_not_suppressed(
        db, investor, extra_linkedin=[doc.identity.linkedin_url]
    )
    ident = await identity_svc.get_identity(db, ws, investor.id)
    anchored = ident is not None and ident.status in identity_svc.ANCHORED
    if anchored:
        anchor = identity_svc.anchor_of(ident, investor)
        if not identity_matches(
            doc.identity.name, doc.identity.linkedin_url, doc.identity.firm_website, anchor
        ):
            raise IdentityMismatch(
                "This dossier is about someone else: its identity does not match the confirmed "
                "one (same LinkedIn profile, or the same firm domain and name). Research the "
                "person below.",
                details={"anchor": anchor.as_dict()},
            )
    else:
        anchor = Anchor.of(
            name=doc.identity.name,
            firm=doc.identity.firm or investor.firm,
            firm_website=doc.identity.firm_website or investor.website_url,
            linkedin_url=doc.identity.linkedin_url or investor.linkedin_url,
            title=doc.identity.title or investor.title,
        )
    raw_sources = [RawSource(s.id, s.url, s.title, s.snippet, s.published_at) for s in doc.sources]
    checked, src_removed = check_sources(raw_sources, anchor)
    accepted = {c.local_id for c in checked if c.check.accepted}
    outcome = finalize(
        doc,
        accepted_ids=accepted,
        source_dates={c.local_id: c.published_at for c in checked},
        agent=True,
        anchor=anchor,
    )
    rejected = [
        {"id": c.local_id, "reason": c.check.reason}
        for c in checked
        if not c.check.accepted and c.check.reason
    ]
    if not outcome.facts:
        raise NoCitedFacts(
            "No fact cites an accepted source, so nothing was saved. Every fact needs at least "
            "one source you fetched that is about this investor (their LinkedIn profile, their "
            "firm's site, or a page naming them with their firm).",
            details={
                "dropped": [d.as_dict() for d in outcome.dropped][:50],
                "sources_rejected": rejected[:50],
            },
        )
    run = ResearchRun(
        workspace_id=ws.workspace_id,
        investor_id=investor.id,
        round_id=round_id,
        kind=ResearchKind.AGENT.value,
        status=RunStatus.SUCCEEDED.value,
        progress={},
        usage=[],
        started_at=now,
        finished_at=now,
        created_at=now,
        updated_at=now,
    )
    run.set_actor(ws.actor)
    db.add(run)
    await db.flush()
    by_local: dict[str, ResearchSource] = {}
    for c in checked:
        if c.check.reason == "duplicate":
            continue
        src = ResearchSource(
            workspace_id=ws.workspace_id,
            run_id=run.id,
            investor_id=investor.id,
            url=c.url,
            url_key=c.url_key,
            domain=c.domain,
            title=c.title,
            snippet=c.snippet,
            published_at=c.published_at,
            fetched_at=next(
                (s.fetched_at for s in doc.sources if s.id == c.local_id and s.fetched_at), now
            ),
            matched_anchor=c.check.matched if c.check.accepted else None,
            accepted=c.check.accepted,
            rejected_reason=None if c.check.accepted else c.check.reason,
            created_at=now,
        )
        db.add(src)
        by_local[c.local_id] = src
    await db.flush()
    if not anchored:
        row = await identity_svc.ensure_identity(db, ws, investor.id, now)
        identity_svc._set_anchor(
            row,
            status=IdentityStatus.CONFIRMED,
            source=IdentitySource.AGENT,
            linkedin_url=doc.identity.linkedin_url or investor.linkedin_url,
            firm=anchor.firm,
            firm_website=doc.identity.firm_website or investor.website_url,
            title=anchor.title,
            confidence=None,
            run_id=run.id,
            ws=ws,
            now=now,
        )
        await db.flush()
        await identity_svc.write_back_identity(db, ws, investor, row, now=now, run_id=run.id)
        ident = row
    stored = await dossiers_svc.store(
        db,
        ws,
        investor,
        outcome,
        sources=by_local,
        identity={**anchor.as_dict(), **identity_svc.identity_dict(ident)},
        author_kind="agent",
        author_label=ws.actor.label or ("member" if ws.actor.is_user else "agent"),
        now=now,
        run_id=run.id,
        round_id=round_id,
    )
    result = {
        "dossier_id": str(stored.dossier.id),
        "version": stored.dossier.version,
        "by": f"by {stored.dossier.author_label}",
        "kept": {
            "facts": len(stored.facts),
            "sources_accepted": len(accepted),
        },
        "dropped": [d.as_dict() for d in outcome.dropped][:100],
        "sources_rejected": rejected[:100],
        "privacy_removed": outcome.privacy_removed + src_removed,
        "suggestions": stored.writeback.counts,
        "new_facts": len(stored.new_fact_keys),
    }
    run.dossier_id = stored.dossier.id
    run.result = {**result, **({"idempotency_key": key} if key else {})}
    await db.flush()
    return AgentSave(stored.dossier, run, result)


# --- summaries for lists, the board and Triage ------------------------------------------------


async def round_summary(
    db: AsyncSession, ws: WorkspaceContext, rnd: Round, *, now: datetime
) -> list[dict[str, Any]]:
    """``GET /v1/rounds/{round}/research``: one line per participant."""
    from raisebook.services.research_summary import summaries

    rows = (
        await db.execute(
            select(RoundParticipant.investor_id, RoundStage.key)
            .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
            .where(
                RoundParticipant.workspace_id == ws.workspace_id,
                RoundParticipant.round_id == rnd.id,
            )
        )
    ).all()
    stage_of = {inv: key for inv, key in rows}
    sums = await summaries(db, ws, list(stage_of), now=now, stage_keys=stage_of)
    return [{"investor_id": inv, **sums[inv]} for inv in stage_of]
