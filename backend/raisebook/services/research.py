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
from datetime import date, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import structlog
from pydantic import BaseModel, ValidationError
from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext, worker_context
from raisebook.config import get_settings
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
    strict_json_schema,
)
from raisebook.services import ai_settings as ai_svc
from raisebook.services import dossiers as dossiers_svc
from raisebook.services import jobs as jobs_svc
from raisebook.services import openrouter, spend
from raisebook.services import research_identity as identity_svc
from raisebook.services import research_prompts as prompts
from raisebook.services import research_removal as removal_svc
from raisebook.services import research_reuse as reuse_svc
from raisebook.services.normalize import clean_url, linkedin_key, norm_firm
from raisebook.services.privacy_filter import notes_for_research
from raisebook.services.research_cost import (
    IDENTITY_STEP,
    SEARCH_STEP,
    WRITER_STEP,
    RunModels,
    StepBudget,
    call_reserve_micros,
    estimate_micros,
    price_of,
    run_reserve_micros,
    writer_only_micros,
    writer_only_reserve_micros,
)
from raisebook.services.research_validate import (
    Anchor,
    RawSource,
    Trust,
    check_sources,
    domain_of,
    domain_resembles_firm,
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
    "reuse": "Reusing your research",
    "filter": "Reading sources",
    "write": "Writing",
    "save": "Checking citations",
}
FALLBACK_RESERVE_MICROS = 500_000  # $0.50 for a call whose model has no known price
MEDIAN_AFTER_RUNS = 20
# A dossier this new is not researched again unless someone asks for a refresh (owner
# decision 2026-10-14): "Research" returns it instead of paying twice.
FRESH_DOSSIER_DAYS = max(30, reuse_svc.FRESH_DAYS)
MAX_PROMPT_SOURCES = 40
MAX_WORKSPACE_FIRMS = 50
KEY_ERRORS = ("openrouter_key_rejected", "openrouter_out_of_credits")
RESUMABLE = (RunStatus.FAILED.value, RunStatus.PARTIAL.value, RunStatus.CAPPED.value)
ACTIVE = tuple(s.value for s in ACTIVE_RUN_STATUSES)


def run_dedupe_key(run_id: UUID) -> str:
    return f"run:{run_id}"


def steps_for(kind: str, *, skip_identity: bool, reuse: bool = False) -> list[str]:
    if kind == ResearchKind.IDENTITY.value:
        return ["identity", "decide"]
    if reuse:
        # Identity and sources come from the owner's other workspace; only the writer runs.
        return ["reuse", "filter", "write", "save"]
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
                # Writer-only runs (reused research) would pull the median down.
                or_(ResearchRun.result.is_(None), ~ResearchRun.result.has_key("reuse")),
            )
            .order_by(ResearchRun.created_at.desc())
            .limit(200)
        )
    )
    if len(costs) >= MEDIAN_AFTER_RUNS:
        return int(statistics.median(costs))
    est = estimate_micros(kind, models_of(row), ai_svc.known_prices(row))
    return est if est is not None else FALLBACK_RESERVE_MICROS * 5


def upper_micros(
    kind: ResearchKind, row: WorkspaceAiSettings, *, skip_identity: bool = False
) -> int | None:
    """What one run holds under the cap while it runs (``run_reserve_micros``)."""
    return run_reserve_micros(
        kind, models_of(row), ai_svc.known_prices(row), skip_identity=skip_identity
    )


async def _usage_now(
    db: AsyncSession, ws: WorkspaceContext, row: WorkspaceAiSettings, now: datetime
) -> spend.Usage:
    return await spend.usage(db, ws.workspace_id, spend.month_of(now, ws.timezone))


def _cap_error(
    used: spend.Usage, cap: int, needed: int, *, fits: int | None = None, count: int | None = None
) -> SpendCapReached:
    left = used.remaining(cap)
    msg = (
        f"This month's ${cap / 1_000_000:,.2f} AI research limit is used up. An owner can "
        "raise it in Settings → AI research."
        if left <= 0
        else f"This research can cost up to ${needed / 1_000_000:,.2f}, and only "
        f"${left / 1_000_000:,.2f} of this month's ${cap / 1_000_000:,.2f} AI research limit "
        "is left. An owner can raise it in Settings → AI research."
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
            "remaining_usd": _usd(left),
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
    run: ResearchRun | None
    created: bool
    estimate_micros: int
    # Why nothing new started: ``fresh`` (a dossier from the last FRESH_DOSSIER_DAYS days),
    # ``identified`` (the identity is already confirmed), ``active`` (a run is going).
    reason: str | None = None
    dossier: Dossier | None = None


async def _run_behind(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor_id: UUID,
    dossier: Dossier | None,
    kinds: Sequence[str],
) -> ResearchRun | None:
    """The run that produced ``dossier`` (or the newest finished run of ``kinds``)."""
    if dossier is not None and dossier.run_id is not None:
        row: ResearchRun | None = await db.scalar(
            select(ResearchRun).where(
                ResearchRun.workspace_id == ws.workspace_id, ResearchRun.id == dossier.run_id
            )
        )
        if row is not None:
            return row
    found: ResearchRun | None = await db.scalar(
        select(ResearchRun)
        .where(
            ResearchRun.workspace_id == ws.workspace_id,
            ResearchRun.investor_id == investor_id,
            ResearchRun.kind.in_(list(kinds)),
            ResearchRun.status == RunStatus.SUCCEEDED.value,
        )
        .order_by(ResearchRun.created_at.desc())
        .limit(1)
    )
    return found


def is_fresh(dossier: Dossier | None, now: datetime) -> bool:
    return dossier is not None and dossier.created_at >= now - timedelta(days=FRESH_DOSSIER_DAYS)


_LOOKUP = object()


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
    force: bool = False,
    donor: Any = _LOOKUP,
) -> Started:
    """Queue a run (the caller commits). Nothing new starts (``created=False``) when:

    - a run of this kind is already queued or running for the investor (double clicks and
      agent retries), ``reason="active"``;
    - a ``dossier`` is asked for while the latest dossier is fresh (``FRESH_DOSSIER_DAYS``):
      that dossier and its run come back, ``reason="fresh"`` (``refresh`` or ``force`` runs);
    - an ``identity`` run is asked for while the identity is confirmed or matched,
      ``reason="identified"`` (``force`` searches again).

    A dossier for a person the same owner researched in another of their workspaces reuses
    that identity and those public sources and runs only the writer (``services.research_reuse``).
    ``donor`` passes one already found (batches), or None for no reuse."""
    if kind not in (ResearchKind.IDENTITY, ResearchKind.DOSSIER, ResearchKind.REFRESH):
        raise ValidationFailed("kind", "kind must be identity, dossier or refresh.")
    row = settings or await _settings_with_key(db, ws)
    existing = await active_run(db, ws, investor.id, kind.value)
    if existing is not None:
        return Started(existing, False, existing.estimate_micros, reason="active")
    await removal_svc.require_not_suppressed(db, investor)
    identity = await identity_svc.get_identity(db, ws, investor.id)
    status = identity.status if identity else IdentityStatus.NONE.value
    if kind == ResearchKind.DOSSIER and not force:
        latest = await dossiers_svc.latest(db, ws, investor.id)
        if latest is not None and is_fresh(latest, now):
            behind = await _run_behind(db, ws, investor.id, latest, reuse_svc.GIVING_KINDS)
            return Started(behind, False, 0, reason="fresh", dossier=latest)
    if kind == ResearchKind.IDENTITY and not force and status in identity_svc.ANCHORED:
        behind = await _run_behind(db, ws, investor.id, None, tuple(k.value for k in ResearchKind))
        return Started(behind, False, 0, reason="identified")
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
    giver: reuse_svc.Donor | None = None
    if kind == ResearchKind.DOSSIER:
        giver = (
            await reuse_svc.find_donor(db, ws, investor, identity, now=now)
            if donor is _LOOKUP
            else donor
        )
    if giver is not None:
        estimate = writer_only_micros(models_of(row), ai_svc.known_prices(row)) or (
            FALLBACK_RESERVE_MICROS
        )
    else:
        estimate = 0 if instant else (per_run or await per_run_micros(db, ws, kind, row))
    if check_cap and not instant:
        # The run holds its upper bound while it runs (R4), so that is what must fit: a run
        # accepted here is never stopped half-way for lack of room.
        upper = (
            writer_only_reserve_micros(models_of(row), ai_svc.known_prices(row))
            if giver is not None
            else upper_micros(kind, row, skip_identity=anchored or bool(investor.linkedin_url))
        )
        needed = max(estimate, upper if upper is not None else FALLBACK_RESERVE_MICROS * 5)
        used = await _usage_now(db, ws, row, now)
        if used.spent_micros + used.reserved_micros + needed > row.monthly_cap_micros:
            raise _cap_error(used, row.monthly_cap_micros, needed)
    steps = steps_for(
        kind.value, skip_identity=anchored or bool(investor.linkedin_url), reuse=giver is not None
    )
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
        result={"reuse": giver.as_result()} if giver is not None else None,
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
        return Started(other, False, other.estimate_micros, reason="active")
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
    needs_identity: int = 0  # dossier runs that match the identity first
    no_profile: bool = False  # dossiers would have no fit verdict
    order: str = "given"  # "fit": best fit first (a round)
    # Dossiers that reuse the owner's research from another workspace: writer only.
    reuse: dict[UUID, reuse_svc.Donor] = field(default_factory=dict)
    writer_micros: int = 0

    def each_micros(self, investor_id: UUID) -> int:
        if investor_id in self.free:
            return 0
        if investor_id in self.reuse:
            return min(self.writer_micros or self.per_run_micros, self.per_run_micros)
        return self.per_run_micros

    def cost_of(self, n: int) -> int:
        return sum(self.each_micros(i.id) for i in self.eligible[:n])

    def as_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind.value,
            "count": self.count,
            "free": len(self.free),
            "paid": self.count - len(self.free),
            "skipped": self.skipped,
            "per_run_usd": _usd(self.per_run_micros),
            "total_usd": _usd(self.total_micros),
            "remaining_usd": _usd(self.remaining_micros),
            "fits": self.fits,
            "needs_identity": self.needs_identity,
            "no_profile": self.no_profile,
            "order": self.order,
            "reused": len(self.reuse),
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
        # Best fit first: when the monthly limit covers only some, Hot and Warm go first.
        .order_by(RoundParticipant.fit.desc(), Investor.name, Investor.id)
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
    ident_rows = (
        {
            r.investor_id: r
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
    idents = {k: r.status for k, r in ident_rows.items()}
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
    # "identified" (identity runs: already has a confirmed identity) and "fresh" (dossiers:
    # one from the last 30 days) are separate buckets so the dialog can say which.
    skipped = {"no_identity": 0, "suppressed": 0, "fresh": 0, "identified": 0, "active": 0}
    eligible: list[Investor] = []
    free: set[UUID] = set()
    needs_identity = 0
    for inv in investors:
        status = idents.get(inv.id, IdentityStatus.NONE.value)
        if inv.id in suppressed:
            skipped["suppressed"] += 1
        elif inv.id in active:
            skipped["active"] += 1
        elif kind == ResearchKind.IDENTITY and status in identity_svc.ANCHORED:
            skipped["identified"] += 1
        elif kind == ResearchKind.DOSSIER and status in identity_svc.BLOCKING:
            skipped["no_identity"] += 1
        elif kind == ResearchKind.DOSSIER and inv.id in recent:
            skipped["fresh"] += 1
        else:
            eligible.append(inv)
            if kind == ResearchKind.IDENTITY and inv.linkedin_url:
                free.add(inv.id)
            if (
                kind == ResearchKind.DOSSIER
                and status not in identity_svc.ANCHORED
                and not inv.linkedin_url
            ):
                needs_identity += 1
    per_run = await per_run_micros(db, ws, kind, row)
    reuse: dict[UUID, reuse_svc.Donor] = {}
    writer = 0
    if kind == ResearchKind.DOSSIER and eligible:
        reuse = await reuse_svc.donors_for(db, ws, eligible, ident_rows, now=now)
        writer = writer_only_micros(models_of(row), ai_svc.known_prices(row)) or per_run
        for inv_id in reuse:
            # A reused identity is copied, never matched again.
            inv_status = idents.get(inv_id, IdentityStatus.NONE.value)
            inv = next(i for i in eligible if i.id == inv_id)
            if inv_status not in identity_svc.ANCHORED and not inv.linkedin_url:
                needs_identity -= 1
    used = await _usage_now(db, ws, row, now)
    remaining = used.remaining(row.monthly_cap_micros)
    paid = [i for i in eligible if i.id not in free]
    fits = len(eligible)
    if per_run > 0 and paid and not reuse:
        # Runs in flight each hold their upper bound (not the estimate) until they settle,
        # so a batch only counts as fitting when the last runs' holds fit too (as many at
        # once as the worker runs).
        extra = max(0, (upper_micros(kind, row) or per_run) - per_run)
        slots = max(1, get_settings().worker_concurrency)

        def fits_k(k: int) -> bool:
            return k * per_run + min(k, slots) * extra <= remaining

        affordable = 0
        while affordable < len(paid) and fits_k(affordable + 1):
            affordable += 1
        if affordable < len(paid):
            fits, counted = 0, 0
            for inv in eligible:
                if inv.id not in free:
                    if counted == affordable:
                        break
                    counted += 1
                fits += 1
    elif per_run > 0 and paid:
        # Mixed costs (some runs reuse research and only write): fit them in order.
        extra = max(0, (upper_micros(kind, row) or per_run) - per_run)
        slots = max(1, get_settings().worker_concurrency)
        total, fits = 0, 0
        for k, inv in enumerate(eligible):
            each = writer if inv.id in reuse else (0 if inv.id in free else per_run)
            if total + each + min(k + 1, slots) * extra > remaining and each > 0:
                break
            total += each
            fits += 1
    return BulkEstimate(
        kind=kind,
        count=len(eligible),
        skipped=skipped,
        per_run_micros=per_run,
        total_micros=sum(
            (writer if i.id in reuse else per_run) for i in eligible if i.id not in free
        ),
        remaining_micros=remaining,
        fits=fits,
        eligible=eligible,
        free=free,
        needs_identity=needs_identity,
        no_profile=kind == ResearchKind.DOSSIER and not await _has_profile(db, ws),
        order="fit" if investor_ids is None else "given",
        reuse=reuse,
        writer_micros=writer,
    )


async def _has_profile(db: AsyncSession, ws: WorkspaceContext) -> bool:
    from raisebook.services.company_profile import is_empty

    row = await db.scalar(
        select(CompanyProfile).where(CompanyProfile.workspace_id == ws.workspace_id)
    )
    return row is not None and not is_empty(row)


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
            donor=est.reuse.get(inv.id),
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
    # Who still needs a person after a "Match all": the identity rows of this batch's
    # investors, as they are now (a pick made since counts as confirmed).
    ident_rows = (
        await db.execute(
            select(InvestorIdentity.status, func.count())
            .join(
                ResearchRun,
                and_(
                    ResearchRun.workspace_id == InvestorIdentity.workspace_id,
                    ResearchRun.investor_id == InvestorIdentity.investor_id,
                ),
            )
            .where(
                ResearchRun.workspace_id == ws.workspace_id,
                ResearchRun.batch_id == batch.id,
                ResearchRun.status.not_in(ACTIVE),
            )
            .group_by(InvestorIdentity.status)
        )
    ).all()
    error_rows = (
        await db.execute(
            select(ResearchRun.error_code, func.count())
            .where(
                ResearchRun.workspace_id == ws.workspace_id,
                ResearchRun.batch_id == batch.id,
                ResearchRun.error_code.is_not(None),
                ResearchRun.status.not_in((*ACTIVE, RunStatus.SUCCEEDED.value)),
            )
            .group_by(ResearchRun.error_code)
        )
    ).all()
    return {
        "id": batch.id,
        "kind": batch.kind,
        "round_id": batch.round_id,
        "total": batch.total,
        "counts": counts,
        "identity": {str(s): int(n) for s, n in ident_rows if s != IdentityStatus.NONE.value},
        "errors": {str(c): int(n) for c, n in error_rows},
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
        result.pop("notes_text", None)
    reuse = result.get("reuse")
    if isinstance(reuse, dict):
        # Which of the owner's workspaces gave the research, and when; nothing else of it.
        result["reuse"] = {
            k: reuse[k] for k in ("workspace_name", "date", "state", "sources") if k in reuse
        }
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


class _UnknownPrice(Exception):
    def __init__(self, model: str) -> None:
        super().__init__(model)
        self.model = model


def _prompt_tokens(messages: Sequence[dict[str, Any]]) -> int:
    """A rough upper estimate of a prompt's tokens (4 characters a token; files and data
    URLs are priced by the caller)."""
    chars = 0
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            chars += len(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    chars += len(part["text"])
    return chars // 4 + 50 * len(messages)


async def _usage_put(db: AsyncSession, run_id: UUID, entry: dict[str, Any]) -> None:
    await db.execute(
        text(
            "UPDATE research_runs SET usage = coalesce(usage, '[]'::jsonb) || CAST(:e AS jsonb)"
            " WHERE id = :run"
        ),
        {"e": json.dumps([entry]), "run": run_id},
    )


async def _usage_drop(db: AsyncSession, run_id: UUID, call_id: str) -> None:
    await db.execute(
        text(
            "UPDATE research_runs SET usage = coalesce((SELECT jsonb_agg(e ORDER BY n)"
            " FROM jsonb_array_elements(usage) WITH ORDINALITY AS t(e, n)"
            " WHERE e->>'call_id' IS DISTINCT FROM :cid), '[]'::jsonb) WHERE id = :run"
        ),
        {"cid": call_id, "run": run_id},
    )


async def _usage_rows(db: AsyncSession, run_id: UUID) -> list[dict[str, Any]] | None:
    row = (
        await db.execute(
            text("SELECT usage FROM research_runs WHERE id = :run FOR UPDATE"), {"run": run_id}
        )
    ).one_or_none()
    if row is None:
        return None
    raw = row[0]
    if isinstance(raw, str):
        raw = json.loads(raw)
    return [dict(e) for e in raw or [] if isinstance(e, dict)]


async def _usage_write(db: AsyncSession, run_id: UUID, entries: list[dict[str, Any]]) -> None:
    await db.execute(
        text("UPDATE research_runs SET usage = CAST(:u AS jsonb) WHERE id = :run"),
        {"u": json.dumps(entries), "run": run_id},
    )


async def record_call(
    db: AsyncSession,
    run_id: UUID,
    entry: dict[str, Any],
    *,
    need: int,
    month: date,
    now: datetime,
) -> None:
    """Settle one finished call on the ledger and the run's usage (same transaction).

    A call that recovery already charged at its reservation (``lost``: its worker stopped
    answering while it was in flight) is corrected to its real cost instead, so a call is
    never counted twice and never missing."""
    entries = await _usage_rows(db, run_id)
    if entries is None:
        return
    prev = next((e for e in entries if e.get("call_id") == entry["call_id"]), None)
    if prev is not None and prev.get("lost"):
        charged = int(prev.get("cost_micros") or 0)
        lost_month = date.fromisoformat(str(prev.get("month") or month.isoformat()))
        await spend.adjust_for_run(
            db,
            run_id=run_id,
            month=lost_month,
            delta_micros=int(entry["cost_micros"]) - charged,
            now=now,
        )
        entry = {**entry, "late": True}
    else:
        await spend.settle_for_run(
            db,
            run_id=run_id,
            actual_micros=int(entry["cost_micros"]),
            consume_micros=need,
            month=month,
            now=now,
        )
    out = [e for e in entries if e.get("call_id") != entry["call_id"]]
    out.append(entry)
    await _usage_write(db, run_id, out)


async def settle_lost_calls(db: AsyncSession, run_id: UUID, *, now: datetime) -> int:
    """Calls still "in flight" when their worker died or was shut down: OpenRouter may have
    billed them, but their cost is unknown. Charge each at what it held (an upper bound,
    marked ``estimated``/``lost``); a late answer from that worker corrects it. Returns the
    number of calls charged."""
    entries = await _usage_rows(db, run_id)
    if not entries:
        return 0
    charged = 0
    for e in entries:
        if not e.get("pending"):
            continue
        amount = int(e.get("reserved_micros") or 0)
        month = date.fromisoformat(str(e.get("month")))
        await spend.settle_for_run(
            db, run_id=run_id, actual_micros=amount, consume_micros=amount, month=month, now=now
        )
        e.pop("pending", None)
        e.update({"lost": True, "estimated": True, "cost_micros": amount})
        charged += 1
    if charged:
        await _usage_write(db, run_id, entries)
    return charged


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
        self.anchor_trusted: Trust = Trust()
        self.prices: dict[str, openrouter.ModelInfo] = {}
        self.notes: str | None = None  # the investor's notes, when the workspace allows it

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
        if status != RunStatus.SUCCEEDED:
            # The step that was running when the run stopped shows as failed, not running.
            prog["steps"] = [
                {**st, "state": "failed"} if st.get("state") == "running" else st
                for st in prog.get("steps", [])
            ]
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
        """Before every call and between steps: the lease is still ours (asked of the
        database), nobody cancelled the run, and the workspace still has its key (R12:
        "Remove key" stops research at once, not after the run)."""
        await self._confirm_lease()
        status = await self.db.scalar(
            select(ResearchRun.status).where(ResearchRun.id == self.run_id)
        )
        has_key = await self.db.scalar(
            select(WorkspaceAiSettings.key_ciphertext.is_not(None)).where(
                WorkspaceAiSettings.workspace_id == self.run.workspace_id
            )
        )
        if status == RunStatus.CANCELLED.value:
            await spend.release_for_run(self.db, run_id=self.run_id, now=self.now())
            await self.db.commit()
            raise _Ended()
        if not has_key:
            await self._end(RunStatus.CANCELLED, ai_svc.NO_KEY_REASON, ai_svc.KEY_REMOVED_MESSAGE)
            raise _Ended()

    async def _confirm_lease(self) -> None:
        confirm = getattr(self.ctx, "confirm_lease", None)
        if confirm is not None:
            await confirm(self.db)
        else:
            self.ctx.check_lease()

    # calls -----------------------------------------------------------------------------------

    async def _info(self, model: str) -> openrouter.ModelInfo:
        """The model's price: stored with the settings, this process's cache, the preset
        snapshot, else OpenRouter's public models list. Unknown → the run cannot hold money
        for the call under the cap, so it stops (``model_price_unknown``)."""
        info = price_of(model, self.prices)
        if info is None:
            try:
                listed = await openrouter.models()
            except openrouter.OpenRouterError:
                listed = {}
            info = listed.get(model)
            if info is not None:
                self.prices[model] = info
        if info is None:
            raise _UnknownPrice(model)
        return info

    async def _hold(self, total: int) -> None:
        """Hold ``total`` for the run's remaining calls before the first of them (R4)."""
        if total <= 0:
            return
        now = self.now()
        await self.db.flush()
        ok = await spend.hold_for_run(
            self.db,
            run_id=self.run.id,
            workspace_id=self.ws.workspace_id,
            month=spend.month_of(now, self.ws.timezone),
            total_micros=total,
            cap_micros=self.settings.monthly_cap_micros,
            now=now,
        )
        await self.db.commit()
        if not ok:
            raise _Capped()

    async def call(
        self,
        step: str,
        model: str,
        messages: list[dict[str, Any]],
        *,
        budget: StepBudget,
        max_tokens: int,
        prompt_tokens: int | None = None,
        searches: bool | None = None,
        **kw: Any,
    ) -> openrouter.ChatResult:
        await self._checkpoint()
        now = self.now()
        info = await self._info(model)
        need = call_reserve_micros(
            info,
            StepBudget(
                1, budget.prompt_tokens, budget.completion_tokens, budget.searches, max_tokens
            ),
            prompt_tokens=prompt_tokens if prompt_tokens is not None else _prompt_tokens(messages),
            searches=searches,
        )
        month = spend.month_of(now, self.ws.timezone)
        await self.db.flush()
        ok = await spend.hold_for_run(
            self.db,
            run_id=self.run.id,
            workspace_id=self.ws.workspace_id,
            month=month,
            total_micros=need,
            cap_micros=self.settings.monthly_cap_micros,
            now=now,
        )
        if not ok:
            await self.db.commit()
            raise _Capped()
        # The call is "in flight" until it is recorded: if this worker dies or is shut down
        # meanwhile, recovery charges it at what it held (OpenRouter may have billed it).
        call_id = uuid4().hex
        await _usage_put(
            self.db,
            self.run.id,
            {
                "call_id": call_id,
                "step": step,
                "model": model,
                "pending": True,
                "reserved_micros": need,
                "month": month.isoformat(),
            },
        )
        await self.db.commit()
        try:
            result = await self.client.chat(model, messages, max_tokens=max_tokens, **kw)
        except openrouter.OpenRouterError:
            await _usage_drop(self.db, self.run.id, call_id)  # refused: nothing was billed
            await self.db.commit()
            raise
        cost = result.usage.cost_micros
        estimated = cost is None
        if cost is None:
            cost = int(
                (
                    info.prompt * result.usage.prompt_tokens
                    + info.completion * result.usage.completion_tokens
                    + info.request
                    + (
                        info.web_search
                        if (budget.searches if searches is None else searches)
                        else 0
                    )
                )
                * 1_000_000
            )
        entry: dict[str, Any] = {
            "call_id": call_id,
            "step": step,
            "model": result.model,
            "generation_id": result.generation_id,
            "prompt_tokens": result.usage.prompt_tokens,
            "completion_tokens": result.usage.completion_tokens,
            "cost_micros": cost,
        }
        if estimated:
            entry["estimated"] = True
        # Recorded even when this worker has lost the lease: the money was spent.
        await record_call(self.db, self.run.id, entry, need=need, month=month, now=self.now())
        await self.db.commit()
        await self._confirm_lease()
        run = await self._reload()
        assert run is not None
        self.run = run
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
        hidden = await removal_svc.suppressed_people(
            self.db, [(c.linkedin_url, c.name, c.firm) for c in candidates]
        )
        candidates = [c for i, c in enumerate(candidates) if i not in hidden]
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
            prompts.search_messages(
                _subject(self.investor, self.anchor), key, since=since, notes=self.notes
            ),
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
        local_ids = {s.url_key: f"s{i}" for i, s in enumerate(sources, start=1)}
        known: list[dict[str, Any]] = []
        for f in ((self.run.result or {}).get("reuse") or {}).get("facts") or []:
            ids = [local_ids[k] for k in f.get("url_keys", []) if k in local_ids]
            if ids:
                known.append(
                    {
                        "section": f.get("section"),
                        "kind": f.get("kind"),
                        "text": f.get("text"),
                        "date": f.get("date"),
                        "source_ids": ids,
                    }
                )
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
            "notes": self.notes,
            "known_facts": known,
        }
        model = self.run.writer_model or self.settings.writer_model
        info = await self._info(model)
        temperature = (
            0.2
            if not info.supported_parameters or "temperature" in info.supported_parameters
            else None
        )
        errors: list[str] = []
        # Some providers (Anthropic among them) refuse the dossier schema as structured output
        # ("compiled grammar is too large"). Then the schema goes in the prompt instead; the
        # answer is validated below either way.
        schema_in_prompt = False
        attempt = 0
        while attempt < 2:
            attempt += 1
            messages = prompts.writer_messages(**messages_kw, errors=errors)
            fmt: dict[str, Any] = {}
            if schema_in_prompt:
                messages = [*messages, _schema_message(WriterDoc)]
            else:
                fmt = {"response_format": response_format(WRITER_FORMAT_NAME, WriterDoc)}
            try:
                result = await self.call(
                    "write",
                    model,
                    messages,
                    budget=WRITER_STEP,
                    max_tokens=6000,
                    temperature=temperature,
                    **fmt,
                )
            except openrouter.OpenRouterError as exc:
                if not schema_in_prompt and exc.status == 400:
                    log.info("research_writer_schema_in_prompt", run_id=str(self.run.id))
                    schema_in_prompt = True
                    attempt -= 1
                    continue
                raise
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
                    "notes_used": bool(self.notes),
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
            trusted_anchor=self.anchor_trusted,
            notes_id=prompts.NOTES_SOURCE_ID if result.get("notes_used") else None,
        )
        if result.get("no_profile"):
            # Without a company profile there is no fit verdict: nothing is written to the
            # round's fit, and the Brief says so instead of showing "Possible".
            outcome.verdict = "unrated"
            outcome.analysis["brief"]["verdict"] = "unrated"
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
        self.prices = ai_svc.known_prices(settings)
        # Investor notes go to the provider only when an owner or admin turned it on (owner
        # decision 2026-10-14): trimmed and privacy-filtered first.
        self.notes = notes_for_research(inv.notes) if settings.use_notes_in_research else None
        self.client = openrouter.OpenRouterClient(key)
        del key
        if await removal_svc.is_suppressed(self.db, inv):
            await self._end(RunStatus.FAILED, "research_suppressed", removal_svc.SUPPRESSED_MESSAGE)
            return False
        ident = await identity_svc.get_identity(self.db, ws, inv.id)
        self._set_anchor(ident)
        if run.status == RunStatus.QUEUED.value:
            run.status = RunStatus.RUNNING.value
            run.started_at = run.started_at or now
            run.updated_at = now
        await self.db.commit()
        return True

    def _set_anchor(self, ident: InvestorIdentity | None) -> None:
        self.anchor = identity_svc.anchor_of(ident, self.investor)
        self.anchor_trusted = identity_svc.trust_of(ident, self.investor)

    async def _plan_micros(self) -> int:
        """What the run's remaining calls hold, reserved before the first of them."""
        ident = await identity_svc.get_identity(self.db, self.ws, self.investor.id)
        anchored = ident is not None and ident.status in identity_svc.ANCHORED
        total = 0
        if self.run.kind != ResearchKind.IDENTITY.value and self._reusing():
            if not (self._done("write") and (self.run.result or {}).get("draft")):
                writer = await self._info(self.run.writer_model or self.settings.writer_model)
                total += call_reserve_micros(writer, WRITER_STEP)
            return total
        if not anchored and not self.investor.linkedin_url and not self._done("identity"):
            model = self.run.identity_model or self.settings.identity_model
            total += call_reserve_micros(await self._info(model), IDENTITY_STEP)
        if self.run.kind == ResearchKind.IDENTITY.value:
            return total
        search = await self._info(self.run.search_model or self.settings.search_model)
        for key in SEARCH_KEYS:
            if not self._done(f"search:{key}"):
                total += call_reserve_micros(search, SEARCH_STEP)
        if not (self._done("write") and (self.run.result or {}).get("draft")):
            writer = await self._info(self.run.writer_model or self.settings.writer_model)
            total += call_reserve_micros(writer, WRITER_STEP)
        return total

    def _reusing(self) -> bool:
        """Planned to reuse the owner's research, and that has not fallen through."""
        reuse = (self.run.result or {}).get("reuse")
        return isinstance(reuse, dict) and reuse.get("state") != "unavailable"

    async def reuse_step(self) -> bool:
        """Copy the identity anchor and the accepted public sources (and the public facts) of
        the same person's fresh research in another workspace of the same owner, so this run
        only writes (``services.research_reuse``, the one cross-workspace read). False when
        that research is no longer there (removed, gone stale, ownership changed): the run
        then researches as usual."""
        if self._done("reuse"):
            return True
        self._mark("reuse", "running")
        await self.db.commit()
        now = self.now()
        ident = await identity_svc.get_identity(self.db, self.ws, self.investor.id)
        donor = await reuse_svc.find_donor(self.db, self.ws, self.investor, ident, now=now)
        sources = await reuse_svc.donor_sources(self.db, donor) if donor is not None else []
        if donor is None or not sources:
            return await self._reuse_unavailable()
        if ident is None or ident.status not in identity_svc.ANCHORED:
            got = donor.identity
            row = await identity_svc.ensure_identity(self.db, self.ws, self.investor.id, now)
            identity_svc._set_anchor(
                row,
                status=IdentityStatus(got["status"]),
                source=IdentitySource(got["source"] or IdentitySource.AUTO.value),
                linkedin_url=got["linkedin_url"],
                firm=got["firm"] or self.investor.firm,
                firm_website=got["firm_website"],
                title=got["title"] or self.investor.title,
                confidence=got["confidence"],
                run_id=self.run.id,
                ws=self.ws,
                now=now,
            )
            await self.db.flush()
            await identity_svc.write_back_identity(
                self.db, self.ws, self.investor, row, now=now, run_id=self.run.id
            )
            ident = row
        if await self._stop_if_suppressed():
            raise _Ended()
        self._set_anchor(ident)
        stored = await self._store_sources(
            [
                openrouter.WebSource(
                    url=src.url,
                    title=src.title,
                    snippet=src.snippet,
                    published_at=src.published_at.isoformat() if src.published_at else None,
                )
                for src in sources
            ],
            check=True,
        )
        if not any(r.accepted for r in stored):
            return await self._reuse_unavailable()
        facts = await reuse_svc.donor_facts(self.db, donor, sources)
        self.run.result = {
            **(self.run.result or {}),
            "reuse": {
                **donor.as_result(),
                "state": "done",
                "sources": sum(1 for r in stored if r.accepted),
                "facts": facts,
            },
        }
        self._mark("reuse", "done")
        await self.db.commit()
        return True

    async def _reuse_unavailable(self) -> bool:
        reuse = dict((self.run.result or {}).get("reuse") or {})
        reuse["state"] = "unavailable"
        self.run.result = {**(self.run.result or {}), "reuse": reuse}
        self._mark("reuse", "skipped")
        await self.db.commit()
        log.info("research_reuse_unavailable", run_id=str(self.run.id))
        return False

    async def _stop_if_suppressed(self) -> bool:
        """The identity research found may be someone who asked not to be researched (R13)."""
        if await removal_svc.is_suppressed(self.db, self.investor):
            await self._end(RunStatus.FAILED, "research_suppressed", removal_svc.SUPPRESSED_MESSAGE)
            return True
        return False

    async def execute(self) -> None:
        if not await self._prepare():
            return
        try:
            await self._hold(await self._plan_micros())
            if self.run.kind == ResearchKind.IDENTITY.value:
                await self.identity_step()
                if await self._stop_if_suppressed():
                    return
                await self._end(RunStatus.SUCCEEDED)
                return
            reused = self._reusing() and await self.reuse_step()
            if not reused and (self.run.result or {}).get("reuse"):
                # The other workspace's research is gone: research as usual, holding enough
                # for the identity and search calls first.
                await self._hold(await self._plan_micros())
            if not reused and not await self.identity_step():
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
            if await self._stop_if_suppressed():
                return
            ident = await identity_svc.get_identity(self.db, self.ws, self.investor.id)
            self._set_anchor(ident)
            since = None
            if self.run.kind == ResearchKind.REFRESH.value:
                prev = await dossiers_svc.latest(self.db, self.ws, self.investor.id)
                since = prev.created_at.date().isoformat() if prev else None
            if not reused:
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
            used = await spend.usage(
                self.db, self.ws.workspace_id, spend.month_of(self.now(), self.ws.timezone)
            )
            cap = self.settings.monthly_cap_micros
            left = used.remaining(cap)
            await self._end(
                RunStatus.CAPPED,
                "spend_cap_reached",
                (
                    f"This month's ${cap / 1_000_000:,.2f} AI research limit is used up."
                    if left <= 0
                    else f"Only ${left / 1_000_000:,.2f} of this month's ${cap / 1_000_000:,.2f}"
                    " AI research limit is left, less than this research can cost."
                )
                + " An owner can raise it in Settings → AI research; then resume.",
            )
        except _UnknownPrice as exc:
            await self._end(
                RunStatus.FAILED,
                "model_unavailable",
                f"OpenRouter no longer lists {exc.model}, so its price is unknown and research "
                "cannot keep it under your monthly limit. Pick another model in Settings → AI "
                "research, then resume.",
            )
        except openrouter.OpenRouterError as exc:
            await self._failed_call(exc)

    async def _failed_call(self, exc: openrouter.OpenRouterError) -> None:
        run = await self._reload()
        assert run is not None
        self.run = run
        if exc.transient and self.ctx.job.attempts < self.ctx.job.max_attempts:
            # Still running, retried later: the error shows meanwhile ("OpenRouter is not
            # answering; retrying"), and nothing stays held while it waits.
            run.error_code = exc.code
            run.error_message = exc.message[:500]
            run.updated_at = self.now()
            await spend.release_for_run(self.db, run_id=run.id, now=self.now())
            await self.db.commit()
            raise jobs_svc.TransientJobError(exc.code, retry_after_s=exc.retry_after_s)
        gathered = (await source_counts(self.db, self.ws, [run.id]))[run.id]["gathered"]
        status = RunStatus.PARTIAL if gathered else RunStatus.FAILED
        await self._end(status, exc.code, exc.message)
        if exc.code in KEY_ERRORS:
            await self._stop_workspace_research(exc)
        raise jobs_svc.PermanentJobError(exc.code)

    async def _stop_workspace_research(self, exc: openrouter.OpenRouterError) -> None:
        """OpenRouter refused the workspace's key: every other queued run would fail the
        same way, so they stop now, and Settings shows why (instead of a batch failing one
        by one)."""
        now = self.now()
        await ai_svc.mark_key_error(self.db, self.ws.workspace_id, exc.code, now=now)
        queued = list(
            await self.db.scalars(
                select(ResearchRun).where(
                    ResearchRun.workspace_id == self.ws.workspace_id,
                    ResearchRun.status == RunStatus.QUEUED.value,
                    ResearchRun.kind != ResearchKind.AGENT.value,
                )
            )
        )
        await _cancel_runs(self.db, queued, now=now, code=exc.code, message=exc.message[:500])
        await self.db.commit()


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
    await settle_lost_calls(db, run_id, now=now)
    await spend.release_for_run(db, run_id=run_id, now=now)
    run = await db.get(ResearchRun, run_id, populate_existing=True)
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
    prog = dict(run.progress or {})
    prog["step"] = None
    prog["steps"] = [
        {**st, "state": "pending" if not rec.failed else "failed"}
        if st.get("state") == "running"
        else st
        for st in prog.get("steps", [])
    ]
    run.progress = prog
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
    _check_agent_identity_urls(doc)
    await removal_svc.require_not_suppressed(
        db,
        investor,
        extra_linkedin=[doc.identity.linkedin_url],
        extra_names=[(doc.identity.name, doc.identity.firm or investor.firm)],
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
        trust = identity_svc.trust_of(ident, investor)
    else:
        await _require_agent_identity_fits(db, ws, investor, ident, doc)
        anchor = Anchor.of(
            name=doc.identity.name,
            firm=doc.identity.firm or investor.firm,
            firm_website=doc.identity.firm_website or investor.website_url,
            linkedin_url=doc.identity.linkedin_url or investor.linkedin_url,
            title=doc.identity.title or investor.title,
        )
        trust = Trust(domain=domain_resembles_firm(anchor.firm_domain, anchor.firm))
    raw_sources = [RawSource(s.id, s.url, s.title, s.snippet, s.published_at) for s in doc.sources]
    checked, src_removed = check_sources(raw_sources, anchor)
    accepted = {c.local_id for c in checked if c.check.accepted}
    outcome = finalize(
        doc,
        accepted_ids=accepted,
        source_dates={c.local_id: c.published_at for c in checked},
        agent=True,
        anchor=anchor,
        trusted_anchor=trust,
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


def _check_agent_identity_urls(doc: DossierDoc) -> None:
    """The identity's links become the investor's: http(s) only, LinkedIn a profile URL."""
    bad: list[dict[str, Any]] = []
    li = doc.identity.linkedin_url
    if li is not None:
        try:
            url = clean_url(li, "linkedin_url")
        except ValidationFailed:
            url = None
        if url is None or domain_of(url) is None or linkedin_key(url) is None:
            bad.append(
                {
                    "loc": ["identity", "linkedin_url"],
                    "msg": "Use a LinkedIn profile URL like https://www.linkedin.com/in/…",
                }
            )
    site = doc.identity.firm_website
    if site is not None:
        try:
            ok = domain_of(clean_url(site, "firm_website")) is not None
        except ValidationFailed:
            ok = False
        if not ok:
            bad.append({"loc": ["identity", "firm_website"], "msg": "Use an http(s) website URL."})
    if bad:
        raise InvalidDossier("The dossier's identity links are not valid URLs.", details=bad)


async def _require_agent_identity_fits(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor: Investor,
    ident: InvestorIdentity | None,
    doc: DossierDoc,
) -> None:
    """With no confirmed identity yet, an agent's dossier may set it, but only for this
    investor (R3, R11): the same name (initials and nicknames allowed) and, when both are
    known, the same firm. While "Is this them?" waits for a person, nothing deeper is saved;
    a candidate someone rejected cannot come back this way."""
    status = ident.status if ident is not None else IdentityStatus.NONE.value
    if status == IdentityStatus.NEEDS_PICK.value:
        raise IdentityRequired(
            "Pick who this is first (Is this them?): choose one of the candidates with "
            + how(ws, "match_identity", f"POST /v1/investors/{investor.id}/identity")
            + ", then save the dossier.",
            details={"identity_status": status},
        )
    reasons: list[str] = []
    if identity_svc.name_points(doc.identity.name, investor.name) <= 0:
        reasons.append(f"the name {doc.identity.name!r} is not {investor.name!r}")
    if (
        investor.firm
        and doc.identity.firm
        and norm_firm(investor.firm) != norm_firm(doc.identity.firm)
    ):
        reasons.append(f"the firm {doc.identity.firm!r} is not {investor.firm!r}")
    if status == IdentityStatus.REJECTED.value and doc.identity.linkedin_url:
        rejected = {
            linkedin_key(c.linkedin_url)
            for c in await identity_svc.candidates_of(db, ws, investor.id)
            if c.linkedin_url
        }
        if linkedin_key(doc.identity.linkedin_url) in rejected:
            reasons.append("a person already said this profile is not them")
    if reasons:
        raise IdentityMismatch(
            "This dossier is about someone else: " + "; ".join(reasons) + ".",
            details={"investor": {"name": investor.name, "firm": investor.firm}},
        )


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


def _schema_message(model: type[BaseModel]) -> dict[str, Any]:
    """The answer format as a prompt, for providers that refuse it as structured output."""
    return {
        "role": "user",
        "content": "Answer with ONLY one JSON object (no prose, no code fences) that matches "
        "this JSON Schema exactly:\n"
        + json.dumps(strict_json_schema(model), ensure_ascii=False, separators=(",", ":")),
    }
