"""The company profile (R6; RESEARCH-PLAN §1.3, §6.2): one per workspace, rounds inherit it.

It tells research who "we" are: one-line pitch, sectors, stage, location, three traction
points and what the company wants from investors. Identity matching works without it; the
dossier's Fit verdict and Talking points need it. Prefill from a website and/or deck: one
writer call on the workspace's own key drafts the fields into ``run.result.draft``; the deck
is held only until that job ends; nothing is saved until the founder PUTs the profile.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext, worker_context
from raisebook.core.errors import NoAiKey, PayloadTooLarge, ResearchUnavailable, ValidationFailed
from raisebook.models.ai import CompanyProfile
from raisebook.models.enums import ResearchKind, RunStatus
from raisebook.models.research import ResearchRun, ResearchUpload
from raisebook.schemas.ai_settings import CompanyProfileIn, CompanyProfileOut
from raisebook.schemas.dossier import PREFILL_FORMAT_NAME, CompanyProfileDraft, response_format
from raisebook.services import ai_settings, openrouter, spend
from raisebook.services import jobs as jobs_svc
from raisebook.services import research_prompts as prompts
from raisebook.services.normalize import clean_url
from raisebook.services.research_cost import PREFILL_STEP, estimate_micros
from raisebook.services.research_validate import domain_of

EDITABLE = (
    "pitch",
    "sectors",
    "stage",
    "location",
    "traction",
    "wants_lead",
    "check_min",
    "check_max",
    "strategic_help",
    "website_url",
)


async def get_profile(db: AsyncSession, ws: WorkspaceContext) -> CompanyProfile | None:
    row: CompanyProfile | None = await db.scalar(
        select(CompanyProfile).where(CompanyProfile.workspace_id == ws.workspace_id)
    )
    return row


def is_empty(row: CompanyProfile | None) -> bool:
    if row is None:
        return True
    return not any(getattr(row, f) for f in EDITABLE) and row.check_min is None


def profile_out(row: CompanyProfile | None, ws: WorkspaceContext) -> CompanyProfileOut:
    def get(name: str, default: Any = None) -> Any:
        return getattr(row, name) if row is not None else default

    return CompanyProfileOut(
        pitch=get("pitch"),
        sectors=list(get("sectors", []) or []),
        stage=get("stage"),
        location=get("location"),
        traction=list(get("traction", []) or []),
        wants_lead=get("wants_lead"),
        check_min=get("check_min"),
        check_max=get("check_max"),
        currency=ws.currency,
        strategic_help=get("strategic_help"),
        website_url=get("website_url"),
        deck_filename=get("deck_filename"),
        prefilled_at=get("prefilled_at"),
        updated_at=get("updated_at"),
        is_empty=is_empty(row),
    )


async def put_profile(
    db: AsyncSession, ws: WorkspaceContext, body: CompanyProfileIn, *, now: datetime
) -> CompanyProfile:
    """Replace the whole profile (validated by :class:`CompanyProfileIn`)."""
    row = await get_profile(db, ws)
    if row is None:
        row = CompanyProfile(workspace_id=ws.workspace_id, created_at=now)
        db.add(row)
    data = body.model_dump()
    for name in EDITABLE:
        value = data[name]
        if name in ("stage", "wants_lead") and value is not None:
            value = str(value.value if hasattr(value, "value") else value)
        setattr(row, name, value)
    row.updated_at = now
    row.updated_by_user_id = ws.actor.user_id
    await db.flush()
    return row


def export_dict(row: CompanyProfile | None) -> dict[str, Any] | None:
    """For the workspace JSON export (no deck: it is never kept)."""
    if row is None:
        return None
    return {
        **{name: getattr(row, name) for name in EDITABLE},
        "sectors": list(row.sectors or []),
        "traction": list(row.traction or []),
        "deck_filename": row.deck_filename,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


# --- prefill from a website and/or deck (R6; RESEARCH-PLAN §4.4 item 4, §6.2) -------------

MAX_DECK_BYTES = 10 * 1024 * 1024
PDF_MAGIC = b"%PDF-"


@dataclass(frozen=True)
class Deck:
    filename: str
    content: bytes


def check_deck(filename: str | None, content: bytes) -> Deck:
    if len(content) > MAX_DECK_BYTES:
        raise PayloadTooLarge("The deck is larger than 10 MB. Export a smaller PDF.")
    if not content.startswith(PDF_MAGIC):
        raise ValidationFailed("deck", "The deck must be a PDF file.")
    name = (filename or "deck.pdf").replace("/", "_").replace("\\", "_").strip()[:255] or "deck.pdf"
    return Deck(name, content)


async def start_prefill(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    website_url: str | None,
    deck: Deck | None,
    now: datetime,
) -> ResearchRun:
    """Queue the prefill run (the caller commits). The draft lands in ``run.result.draft``;
    nothing is saved to the profile until the founder PUTs it."""
    from raisebook.services import research as research_svc

    site = clean_url(website_url, "website_url") if website_url else None
    if site is None and deck is None:
        raise ValidationFailed("website_url", "Give a website URL, a deck PDF, or both.")
    row = await research_svc._settings_with_key(db, ws)
    active: ResearchRun | None = await db.scalar(
        select(ResearchRun).where(
            ResearchRun.workspace_id == ws.workspace_id,
            ResearchRun.kind == ResearchKind.PREFILL.value,
            ResearchRun.status.in_(("queued", "running")),
        )
    )
    if active is not None:
        return active
    estimate = (
        estimate_micros(
            ResearchKind.PREFILL, research_svc.models_of(row), openrouter.cached_models()
        )
        or research_svc.FALLBACK_RESERVE_MICROS
    )
    used = await spend.usage(db, ws.workspace_id, spend.month_of(now, ws.timezone))
    if used.spent_micros + used.reserved_micros + estimate > row.monthly_cap_micros:
        raise research_svc._cap_error(used, row.monthly_cap_micros, estimate)
    run = ResearchRun(
        workspace_id=ws.workspace_id,
        kind=ResearchKind.PREFILL.value,
        status=RunStatus.QUEUED.value,
        preset=row.preset,
        identity_model=row.identity_model,
        search_model=row.search_model,
        writer_model=row.writer_model,
        estimate_micros=estimate,
        progress={
            "step": None,
            "steps": [
                {"key": "read", "label": "Reading your deck and website", "state": "pending"},
                {"key": "draft", "label": "Drafting the profile", "state": "pending"},
            ],
            "done": 0,
            "total": 2,
        },
        usage=[],
        result={"website_url": site, "deck_filename": deck.filename if deck else None},
        created_at=now,
        updated_at=now,
    )
    run.set_actor(ws.actor)
    db.add(run)
    await db.flush()
    if deck is not None:
        db.add(
            ResearchUpload(
                workspace_id=ws.workspace_id,
                run_id=run.id,
                filename=deck.filename,
                content=deck.content,
                created_at=now,
            )
        )
    await jobs_svc.enqueue(
        db,
        kind=jobs_svc.KIND_COMPANY_PREFILL,
        now=now,
        workspace_id=ws.workspace_id,
        payload={"run_id": str(run.id)},
        dedupe_key=f"prefill:{run.id}",
        priority=jobs_svc.PRIORITY_SINGLE,
    )
    await db.flush()
    return run


async def _drop_uploads(db: AsyncSession, run_id: Any) -> None:
    await db.execute(delete(ResearchUpload).where(ResearchUpload.run_id == run_id))


async def prefill_job(ctx: Any) -> None:
    """``company.prefill`` handler: one writer call reads the deck (``file`` input) and/or the
    website (the ``web`` plugin limited to its domain) and returns a draft."""
    from raisebook.services import research as research_svc

    run_id = UUID(str(ctx.job.payload["run_id"]))
    async with ctx.session() as db:
        runner = research_svc.Runner(ctx, db, run_id)
        run = await runner._reload()
        if run is None or run.status not in ("queued", "running"):
            return
        runner.run = run
        ws = await worker_context(
            db,
            workspace_id=run.workspace_id,
            actor_type=run.actor_type,
            via=run.via,
            actor_user_id=run.actor_user_id,
            api_key_id=run.api_key_id,
            actor_label=run.actor_label,
            agent_model=run.agent_model,
            now=runner.now(),
        )
        if ws is None:
            await _drop_uploads(db, run.id)
            await runner._end(RunStatus.CANCELLED, "requester_lost_access", "Access was removed.")
            return
        runner.ws = ws
        settings = await ai_settings.get_row(db, ws.workspace_id)
        try:
            key = await ai_settings.open_key(db, ws.workspace_id)
        except (NoAiKey, ResearchUnavailable) as exc:
            await _drop_uploads(db, run.id)
            await runner._end(RunStatus.FAILED, "no_ai_key", exc.message)
            raise jobs_svc.PermanentJobError("no_ai_key") from None
        assert settings is not None
        runner.settings = settings
        runner.client = openrouter.OpenRouterClient(key)
        del key
        run.status = RunStatus.RUNNING.value
        run.started_at = run.started_at or runner.now()
        runner._mark("read", "running")
        await db.commit()
        upload = await db.scalar(select(ResearchUpload).where(ResearchUpload.run_id == run.id))
        site = (run.result or {}).get("website_url")
        data_url = (
            "data:application/pdf;base64," + base64.b64encode(upload.content).decode()
            if upload is not None
            else None
        )
        kwargs: dict[str, Any] = {}
        domain = domain_of(site)
        if site and domain:
            kwargs["plugins"] = [{"id": "web", "max_results": 5, "include_domains": [domain]}]
        model = run.writer_model or settings.writer_model
        try:
            result = await runner.call(
                "prefill",
                model,
                prompts.prefill_messages(
                    website_url=site,
                    deck_name=upload.filename if upload else None,
                    deck_data_url=data_url,
                ),
                budget=PREFILL_STEP,
                max_tokens=2000,
                response_format=response_format(PREFILL_FORMAT_NAME, CompanyProfileDraft),
                **kwargs,
            )
        except research_svc._Capped:
            await _drop_uploads(db, run.id)
            await runner._end(RunStatus.CAPPED, "spend_cap_reached", "Monthly AI limit reached.")
            return
        except openrouter.OpenRouterError as exc:
            if exc.transient and ctx.job.attempts < ctx.job.max_attempts:
                raise jobs_svc.TransientJobError(
                    exc.code, retry_after_s=exc.retry_after_s
                ) from None
            await _drop_uploads(db, run.id)
            await runner._end(RunStatus.FAILED, exc.code, exc.message)
            raise jobs_svc.PermanentJobError(exc.code) from None
        runner.run = await runner._reload() or run
        try:
            draft = CompanyProfileDraft.model_validate(
                research_svc.parse_json_object(result.content)
            )
        except (ValueError, ValidationError):
            await _drop_uploads(db, run.id)
            await runner._end(
                RunStatus.FAILED,
                "invalid_draft",
                "The model's draft did not match the profile form. Try again or fill it in.",
            )
            return
        runner.run.result = {**(runner.run.result or {}), "draft": draft.model_dump(mode="json")}
        runner._mark("read", "done")
        runner._mark("draft", "done")
        await _drop_uploads(db, run.id)
        await db.flush()
        await runner._end(RunStatus.SUCCEEDED)


async def on_prefill_recover(db: AsyncSession, rec: Any, now: datetime) -> None:
    raw = rec.payload.get("run_id")
    if raw:
        await spend.release_for_run(db, run_id=UUID(str(raw)), now=now)
        if rec.failed:
            await _drop_uploads(db, UUID(str(raw)))
            await db.execute(
                update(ResearchRun)
                .where(
                    ResearchRun.id == UUID(str(raw)), ResearchRun.status.in_(("queued", "running"))
                )
                .values(status="failed", error_code="worker_lost", finished_at=now, updated_at=now)
            )
