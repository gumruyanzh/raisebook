"""Smaller research contracts: prompt pinning, median estimates, worker registration and
recovery, the workspace export, usage, housekeeping (RESEARCH-PLAN §3, §4.4, §5.2, §1.14)."""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook import worker
from raisebook.models.enums import ResearchKind
from raisebook.models.research import ResearchRun, ResearchSource
from raisebook.services import housekeeping, jobs, research, spend
from raisebook.services import research_prompts as prompts
from raisebook.services.ai_settings import get_or_default
from tests.research.helpers import AGENT, agent_doc, research_world, run_jobs
from tests.research.openrouter_mock import FAKE_KEY
from tests.research.pipeline_mock import LINKEDIN, SITE, Script

PROMPT_SHA = "87c88a119cab662dc7a845950089e0fd6a7d8d4fa41948a4c89fc7e3c92a2edb"


def test_prompts_are_pinned_and_professional_only() -> None:
    """Changing a prompt is a deliberate act: bump PROMPT_VERSION and this hash together."""
    text = prompts.all_prompt_text()
    assert hashlib.sha256(text.encode()).hexdigest() == PROMPT_SHA, prompts.PROMPT_VERSION
    for system in (prompts.IDENTITY_SYSTEM, prompts.SEARCH_SYSTEM, prompts.writer_system()):
        assert prompts.PROFESSIONAL_ONLY in system
    assert prompts.UNTRUSTED_SOURCES in prompts.writer_system()
    subject = prompts.Subject("Dana Whitfield", firm="Harbor Light Ventures")
    msgs = prompts.identity_messages(subject)
    assert "company" not in msgs[1]["content"].lower()  # identity never sends our profile


def test_research_handlers_are_registered() -> None:
    worker.load_handlers()
    assert {jobs.KIND_RESEARCH_RUN, jobs.KIND_COMPANY_PREFILL, jobs.KIND_RESEARCH_REMOVAL} <= set(
        worker.HANDLERS
    )
    assert jobs.KIND_RESEARCH_RUN in worker.RECOVERY_HOOKS


async def test_median_of_real_costs_after_20_runs(db: AsyncSession, frozen_now: Any) -> None:
    w = await research_world(db, with_key=False)
    from raisebook.auth.principal import worker_context

    ws = await worker_context(
        db,
        workspace_id=w.ws.id,
        actor_type="user",
        via="web",
        actor_user_id=w.owner.id,
        api_key_id=None,
        actor_label=None,
        agent_model=None,
        now=frozen_now,
    )
    assert ws is not None
    row = await get_or_default(db, ws)
    base = await research.per_run_micros(db, ws, ResearchKind.DOSSIER, row)
    assert 150_000 < base < 300_000  # token budgets at Best prices
    for i in range(20):
        db.add(
            ResearchRun(
                workspace_id=w.ws.id,
                investor_id=w.inv.id,
                kind="dossier",
                status="succeeded",
                preset="best",
                cost_micros=100_000 + i * 1_000,
                actor_type="system",
                via="system",
            )
        )
    await db.flush()
    assert await research.per_run_micros(db, ws, ResearchKind.DOSSIER, row) == 109_500


async def test_recovery_hook_releases_and_requeues(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db)
    c = await session_client(w.owner, w.ws)
    run_id = (await c.post(f"/v1/investors/{w.inv.id}/research", json={})).json()["run"]["id"]
    run = await db.get(ResearchRun, run_id)
    assert run is not None
    month = spend.month_of(frozen_now, "UTC")
    assert await spend.reserve_for_run(
        db,
        run_id=run.id,
        workspace_id=w.ws.id,
        month=month,
        amount_micros=5_000,
        cap_micros=25_000_000,
        now=frozen_now,
    )
    run.status = "running"
    await db.flush()
    rec = jobs.RecoveredJob(
        id=run.id,
        kind=jobs.KIND_RESEARCH_RUN,
        workspace_id=w.ws.id,
        payload={"run_id": str(run.id)},
        failed=False,
    )
    await research.on_recover(db, rec, frozen_now)
    await db.refresh(run)
    assert (run.status, run.reserved_micros) == ("queued", 0)
    assert (await spend.usage(db, w.ws.id, month)).reserved_micros == 0
    await research.on_recover(db, jobs.RecoveredJob(**{**rec.__dict__, "failed": True}), frozen_now)
    await db.refresh(run)
    assert (run.status, run.error_code) == ("failed", "worker_lost")


async def test_export_includes_research_without_key_material(
    db: AsyncSession, session_client: Any, key_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db)
    k = key_client(w.key, headers=AGENT)
    assert (
        await k.post(f"/v1/investors/{w.inv.id}/dossier", json={"dossier": agent_doc()})
    ).status_code == 201
    c = await session_client(w.owner, w.ws)
    r = await c.get("/v1/export", params={"format": "json"})
    assert r.status_code == 200
    doc = json.loads(r.content)
    research_part = doc["research"]
    assert research_part["identities"][0]["status"] == "confirmed"
    assert research_part["dossiers"][0]["verdict"] == "possible"
    assert research_part["dossiers"][0]["facts"] and research_part["sources"]
    assert research_part["suggestions"]
    text = r.text
    assert FAKE_KEY not in text and FAKE_KEY[-4:] not in json.dumps(research_part)
    assert "key_last4" not in text and "ciphertext" not in text


async def test_usage_report_and_deletion_cascade(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    Script().install(openrouter_mock)
    c = await session_client(w.owner, w.ws)
    await c.post(f"/v1/investors/{w.inv.id}/research", json={})
    await run_jobs(db)
    u = (await c.get("/v1/research/usage")).json()
    assert u["month"] == "2026-10" and u["calls"] == 4
    assert u["by_kind"]["dossier"]["runs"] == 1 and u["cap_usd"] == 25.0
    assert (await c.get("/v1/research/usage", params={"month": "2026-09"})).json()["calls"] == 0
    # Deleting the investor deletes its research (composite FKs cascade).
    assert (await c.delete(f"/v1/investors/{w.inv.id}")).status_code == 204
    n = await db.scalar(
        select(func.count())
        .select_from(ResearchSource)
        .where(ResearchSource.workspace_id == w.ws.id)
    )
    assert n == 0


async def test_housekeeping_drops_old_runs_but_keeps_cited_sources(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db, with_key=False)
    inv_id = w.inv.id
    k = key_client(w.key, headers=AGENT)
    await k.post(f"/v1/investors/{inv_id}/dossier", json={"dossier": agent_doc()})
    run = await db.scalar(select(ResearchRun).where(ResearchRun.investor_id == inv_id))
    assert run is not None
    run.created_at = frozen_now - timedelta(days=401)
    await db.flush()
    out = await housekeeping.purge(db, now=frozen_now)
    assert out["research_runs"] == 1
    db.expire_all()
    kept = list(
        await db.scalars(select(ResearchSource).where(ResearchSource.investor_id == inv_id))
    )
    assert kept and all(s.run_id is None for s in kept)  # cited sources outlive their run
    view = (await k.get(f"/v1/investors/{inv_id}/dossier")).json()
    assert view["sources"]
