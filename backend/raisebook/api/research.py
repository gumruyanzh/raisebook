"""Investor research over REST (RESEARCH-PLAN §6.3, §6.4; R3, R4, R7, R10, R11).

Reading (dossiers, identities, runs, suggestions, usage) needs ``raisebook:read`` (viewers
included). Starting research, picking an identity, deciding suggestions and saving an agent
dossier need ``raisebook:write``. Research runs on the workspace's own OpenRouter key within
the monthly cap; ``POST /v1/investors/{id}/dossier`` (agents' own research) needs no key.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import (
    WorkspaceContext,
    get_now,
    get_session,
    get_workspace_ctx,
    get_write_ctx,
)
from raisebook.core.errors import ValidationFailed, not_found
from raisebook.core.refs import resolve_round
from raisebook.models.enums import ResearchKind
from raisebook.models.research import ResearchSource
from raisebook.schemas.common import ERROR_RESPONSES, DataList
from raisebook.schemas.research import (
    AcceptAllIn,
    AcceptAllOut,
    BatchIn,
    BatchOut,
    BatchStartedOut,
    CancelledOut,
    CandidateOut,
    CandidateSource,
    DossierVersionOut,
    DossierViewOut,
    EstimateIn,
    EstimateOut,
    IdentityOut,
    IdentityPickIn,
    RoundResearchRow,
    RunOut,
    RunPage,
    RunStartedOut,
    SaveDossierIn,
    SaveDossierOut,
    StartedDossier,
    StartResearchIn,
    SuggestionOut,
    SuggestionPage,
    UsageReportOut,
)
from raisebook.services import dossiers as dossiers_svc
from raisebook.services import investors as investors_svc
from raisebook.services import research as research_svc
from raisebook.services import research_identity as identity_svc
from raisebook.services import research_writeback as writeback_svc
from raisebook.services.research_cost import usd_to_micros

router = APIRouter(prefix="/v1", tags=["research"], responses=ERROR_RESPONSES)


async def run_out(db: AsyncSession, ws: WorkspaceContext, run: Any) -> RunOut:
    counts = await research_svc.source_counts(db, ws, [run.id])
    return RunOut.model_validate(research_svc.run_dict(run, counts.get(run.id)))


def _label(confidence: float) -> str:
    if confidence >= identity_svc.IDENTITY_AUTO_THRESHOLD:
        return "likely"
    if confidence >= 0.5:
        return "possible"
    return "unlikely"


async def identity_out(db: AsyncSession, ws: WorkspaceContext, investor_id: UUID) -> IdentityOut:
    row = await identity_svc.get_identity(db, ws, investor_id)
    cands = await identity_svc.candidates_of(db, ws, investor_id)
    src_ids = {s for c in cands for s in c.evidence_source_ids}
    sources = (
        {
            s.id: s
            for s in await db.scalars(
                select(ResearchSource).where(
                    ResearchSource.workspace_id == ws.workspace_id,
                    ResearchSource.id.in_(list(src_ids)),
                )
            )
        }
        if src_ids
        else {}
    )
    active = await research_svc.active_run(db, ws, investor_id, ResearchKind.IDENTITY.value)
    base = identity_svc.identity_dict(row)
    return IdentityOut(
        investor_id=investor_id,
        **base,
        candidates=[
            CandidateOut(
                id=c.id,
                rank=c.rank,
                name=c.name,
                title=c.title,
                firm=c.firm,
                linkedin_url=c.linkedin_url,
                firm_website=c.firm_website,
                confidence=float(c.confidence),
                confidence_label=_label(float(c.confidence)),
                picked=c.picked,
                sources=[
                    CandidateSource(id=s.id, url=s.url, domain=s.domain, title=s.title)
                    for s in (sources.get(i) for i in c.evidence_source_ids)
                    if s is not None
                ],
            )
            for c in cands
        ]
        if base["status"] not in ("matched", "confirmed")
        else [],
        active_run={"id": active.id, "status": active.status} if active else None,
    )


# --- runs ----------------------------------------------------------------------------------------


@router.post("/investors/{investor_id}/research", status_code=202, response_model=RunStartedOut)
async def start_research(
    investor_id: UUID,
    body: StartResearchIn,
    response: Response,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> RunStartedOut:
    """Research one investor on the workspace's OpenRouter key: ``identity`` (who is this,
    ≈ $0.01), ``dossier`` (default) or ``refresh``. 202 with the queued run. 200 with
    ``created: false`` when nothing new started, so nothing is paid twice: ``reason: active``
    (a run is already going), ``fresh`` (a dossier from the last 30 days: open ``dossier``
    instead; ``kind=refresh`` or ``force`` researches again) or ``identified`` (the identity
    is already confirmed). A dossier for someone the same owner researched in another of
    their workspaces within 30 days reuses that identity and its public sources and runs only
    the writer (``run.result.reuse``). 422 ``no_ai_key`` / ``spend_cap_reached``, 409
    ``identity_required`` (pick who this is first) or ``research_suppressed``."""
    inv = await investors_svc.get(db, ws, investor_id)
    rnd = await resolve_round(db, ws, body.round, required=False)
    started = await research_svc.start_run(
        db,
        ws,
        inv,
        kind=ResearchKind(body.kind),
        now=now,
        round_id=rnd.id if rnd else None,
        force=body.force,
    )
    await db.commit()
    if not started.created:
        response.status_code = 200
    return RunStartedOut(
        run=await run_out(db, ws, started.run) if started.run is not None else None,
        estimate_usd=round(started.estimate_micros / 1_000_000, 6),
        created=started.created,
        reason=started.reason,
        dossier=StartedDossier(
            id=started.dossier.id,
            version=started.dossier.version,
            created_at=started.dossier.created_at,
        )
        if started.dossier is not None
        else None,
    )


@router.get("/research/runs", response_model=RunPage)
async def list_runs(
    investor_id: UUID | None = None,
    batch_id: UUID | None = None,
    status: str | None = Query(None, max_length=40),
    kind: str | None = Query(None, max_length=40),
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = None,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> RunPage:
    """Research runs, newest first (filters: investor, batch, status, kind)."""
    if investor_id is not None:
        await investors_svc.get(db, ws, investor_id)
    if batch_id is not None:
        await research_svc.get_batch(db, ws, batch_id)
    rows, nxt = await research_svc.list_runs(
        db,
        ws,
        investor_id=investor_id,
        batch_id=batch_id,
        status=status,
        kind=kind,
        limit=limit,
        cursor=cursor,
    )
    counts = await research_svc.source_counts(db, ws, [r.id for r in rows])
    return RunPage(
        data=[RunOut.model_validate(research_svc.run_dict(r, counts.get(r.id))) for r in rows],
        next_cursor=nxt,
    )


@router.get("/research/runs/{run_id}", response_model=RunOut)
async def get_run(
    run_id: UUID,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> RunOut:
    """One run: progress steps, cost so far, error and source counts. Poll it every 2 s while
    queued or running."""
    return await run_out(db, ws, await research_svc.get_run(db, ws, run_id))


@router.post("/research/runs/{run_id}/cancel", response_model=RunOut)
async def cancel_run(
    run_id: UUID,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> RunOut:
    """Cancel a queued or running run (a running one stops before its next call)."""
    run = await research_svc.cancel_run(db, ws, await research_svc.get_run(db, ws, run_id), now=now)
    await db.commit()
    return await run_out(db, ws, run)


@router.post("/research/runs/{run_id}/resume", response_model=RunOut)
async def resume_run(
    run_id: UUID,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> RunOut:
    """Resume a failed, partial or capped run: finished steps are not paid for twice."""
    run = await research_svc.resume_run(db, ws, await research_svc.get_run(db, ws, run_id), now=now)
    await db.commit()
    return await run_out(db, ws, run)


@router.get("/research/usage", response_model=UsageReportOut)
async def usage(
    month: str | None = Query(None, pattern=r"^\d{4}-\d{2}$"),
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> UsageReportOut:
    """AI spend for a month (default: this month in the workspace timezone), by run kind."""
    return UsageReportOut.model_validate(
        await research_svc.usage_report(db, ws, month=month, now=now)
    )


# --- bulk ----------------------------------------------------------------------------------------


@router.post("/research/estimate", response_model=EstimateOut)
async def estimate(
    body: EstimateIn,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> EstimateOut:
    """What researching these investors (or a round's) would cost, before confirming."""
    rnd = await resolve_round(db, ws, body.round, required=False)
    est = await research_svc.bulk_estimate(
        db,
        ws,
        kind=ResearchKind(body.kind),
        now=now,
        investor_ids=body.investor_ids,
        round_id=rnd.id if rnd else None,
    )
    return EstimateOut.model_validate(est.as_dict())


@router.post("/research/batches", status_code=202, response_model=BatchStartedOut)
async def create_batch(
    body: BatchIn,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> BatchStartedOut:
    """Research a selection after the person confirmed the estimate (``confirm_usd``). 409
    ``estimate_changed`` with the new total; 422 ``spend_cap_reached`` when not all fit (send
    ``allow_partial`` to research the ones that do)."""
    rnd = await resolve_round(db, ws, body.round, required=False)
    batch, n = await research_svc.create_batch(
        db,
        ws,
        kind=ResearchKind(body.kind),
        now=now,
        confirm_micros=usd_to_micros(body.confirm_usd),
        allow_partial=body.allow_partial,
        investor_ids=body.investor_ids,
        round_id=rnd.id if rnd else None,
    )
    await db.commit()
    return BatchStartedOut(
        batch=BatchOut.model_validate(await research_svc.batch_dict(db, ws, batch)), runs=n
    )


@router.get("/research/batches/{batch_id}", response_model=BatchOut)
async def get_batch(
    batch_id: UUID,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> BatchOut:
    """A batch's runs by status and what they cost so far (poll while ``active`` > 0)."""
    batch = await research_svc.get_batch(db, ws, batch_id)
    return BatchOut.model_validate(await research_svc.batch_dict(db, ws, batch))


@router.post("/research/batches/{batch_id}/cancel", response_model=CancelledOut)
async def cancel_batch(
    batch_id: UUID,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> CancelledOut:
    """Cancel the batch's queued runs; running ones stop before their next call."""
    batch = await research_svc.get_batch(db, ws, batch_id)
    n = await research_svc.cancel_batch(db, ws, batch, now=now)
    await db.commit()
    return CancelledOut(cancelled=n)


# --- identity ------------------------------------------------------------------------------------


@router.get("/investors/{investor_id}/identity", response_model=IdentityOut)
async def get_identity(
    investor_id: UUID,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> IdentityOut:
    """Who research thinks this investor is: the anchor, or 2-3 candidates to pick from."""
    await investors_svc.get(db, ws, investor_id)
    return await identity_out(db, ws, investor_id)


@router.post("/investors/{investor_id}/identity", response_model=IdentityOut)
async def pick_identity(
    investor_id: UUID,
    body: IdentityPickIn,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> IdentityOut:
    """ "Is this them?": pick a candidate (``candidate_id`` or ``rank``), say ``none`` of them
    fit, or enter their ``linkedin_url``. Empty fields are filled from the confirmed identity."""
    inv = await investors_svc.get(db, ws, investor_id)
    await identity_svc.pick(
        db,
        ws,
        inv,
        now=now,
        candidate_id=body.candidate_id,
        rank=body.rank,
        none=body.none,
        linkedin_url=body.linkedin_url,
        firm_website=body.firm_website,
        title=body.title,
    )
    await db.commit()
    return await identity_out(db, ws, investor_id)


# --- dossiers ------------------------------------------------------------------------------------


@router.get("/investors/{investor_id}/dossier", response_model=DossierViewOut)
async def get_dossier(
    investor_id: UUID,
    version: int | None = Query(None, ge=1),
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> DossierViewOut:
    """The latest dossier (or ``version``): Brief, sections, cited sources, "new since", the
    stale and meeting-refresh flags, and pending suggestions. 404 ``no_dossier``."""
    inv = await investors_svc.get(db, ws, investor_id)
    return DossierViewOut.model_validate(
        await dossiers_svc.view(db, ws, inv, now=now, version=version)
    )


@router.get("/investors/{investor_id}/dossiers", response_model=DataList[DossierVersionOut])
async def list_dossiers(
    investor_id: UUID,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> DataList[DossierVersionOut]:
    """Saved versions (the last 5), newest first."""
    await investors_svc.get(db, ws, investor_id)
    rows = await dossiers_svc.versions(db, ws, investor_id)
    return DataList(data=[DossierVersionOut.model_validate(r) for r in rows])


@router.post("/investors/{investor_id}/dossier", status_code=201, response_model=SaveDossierOut)
async def save_dossier(
    investor_id: UUID,
    body: SaveDossierIn,
    response: Response,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> SaveDossierOut:
    """Save a dossier an agent researched itself (schema v1; the REST twin of MCP
    ``save_dossier``). Same rules as model dossiers: every fact cites a fetched source about
    this investor, the identity matches the confirmed one, professional information only.
    Uncited facts are dropped and listed. Costs nothing; needs no OpenRouter key."""
    inv = await investors_svc.get(db, ws, investor_id)
    rnd = await resolve_round(db, ws, body.round, required=False)
    saved = await research_svc.save_agent_dossier(
        db,
        ws,
        inv,
        body.dossier,
        now=now,
        round_id=rnd.id if rnd else None,
        idempotency_key=body.idempotency_key,
    )
    await db.commit()
    if saved.repeated:
        response.status_code = 200
    return SaveDossierOut.model_validate({**saved.result, "repeated": saved.repeated})


# --- suggestions ---------------------------------------------------------------------------------


@router.get("/research/suggestions", response_model=SuggestionPage)
async def list_suggestions(
    investor_id: UUID | None = None,
    round: str | None = Query(None, max_length=200),
    status: str | None = Query("pending", max_length=20),
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> SuggestionPage:
    """Research suggestions ("Research says check $250k-1M (you have $50k-250k)")."""
    if investor_id is not None:
        await investors_svc.get(db, ws, investor_id)
    rnd = await resolve_round(db, ws, round, required=False)
    rows = await writeback_svc.pending_for(
        db,
        ws,
        investor_ids=[investor_id] if investor_id else None,
        round_id=rnd.id if rnd else None,
        status=status or None,
    )
    return SuggestionPage(
        data=[SuggestionOut.model_validate(writeback_svc.suggestion_dict(r)) for r in rows]
    )


@router.post("/research/suggestions/accept-all", response_model=AcceptAllOut)
async def accept_all(
    body: AcceptAllIn,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> AcceptAllOut:
    """Accept every pending suggestion for these investors (or a round's), one ``bulk_id``."""
    if body.investor_ids is None and body.round is None:
        raise ValidationFailed("investor_ids", "Pass investor_ids or round.")
    if body.investor_ids:
        found = await investors_svc.get_many(db, ws, body.investor_ids)
        if len(found) != len(set(body.investor_ids)):
            raise not_found("Investor")
    rnd = await resolve_round(db, ws, body.round, required=False)
    res = await writeback_svc.accept_all(
        db, ws, investor_ids=body.investor_ids, round_id=rnd.id if rnd else None, now=now
    )
    await db.commit()
    return AcceptAllOut(accepted=res.accepted, skipped=res.skipped, bulk_id=res.bulk_id)


@router.post("/research/suggestions/{suggestion_id}/accept", response_model=SuggestionOut)
async def accept_suggestion(
    suggestion_id: UUID,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> SuggestionOut:
    """Apply a suggestion through the normal edit path (activity, validation)."""
    row = await writeback_svc.get_suggestion(db, ws, suggestion_id)
    await writeback_svc.accept(db, ws, row, now=now)
    await db.commit()
    return SuggestionOut.model_validate(writeback_svc.suggestion_dict(row))


@router.post("/research/suggestions/{suggestion_id}/ignore", response_model=SuggestionOut)
async def ignore_suggestion(
    suggestion_id: UUID,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> SuggestionOut:
    """Ignore a suggestion; the same value is never suggested again."""
    row = await writeback_svc.get_suggestion(db, ws, suggestion_id)
    await writeback_svc.ignore(db, ws, row, now=now)
    await db.commit()
    return SuggestionOut.model_validate(writeback_svc.suggestion_dict(row))


# --- the round view ------------------------------------------------------------------------------


@router.get("/rounds/{round}/research", response_model=DataList[RoundResearchRow])
async def round_research(
    round: str,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> DataList[RoundResearchRow]:
    """Per participant: identity status, verdict, dossier date and staleness, pending
    suggestions, the active run and the meeting-refresh offer (one request for the board,
    Triage and bulk actions)."""
    rnd = await resolve_round(db, ws, round, required=True)
    assert rnd is not None
    rows = await research_svc.round_summary(db, ws, rnd, now=now)
    return DataList(data=[RoundResearchRow.model_validate(r) for r in rows])
