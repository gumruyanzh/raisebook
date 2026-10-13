"""Regression tests for the findings of the research verification pass (correctness,
security and UX lenses). Fictional people only; OpenRouter is the scripted mock."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook import worker
from raisebook.auth.principal import worker_context
from raisebook.models.investor import Investor
from raisebook.models.research import (
    FieldSuggestion,
    InvestorIdentity,
    ResearchRemovalRequest,
)
from raisebook.models.round import RoundParticipant
from raisebook.services import ai_settings as ai_svc
from raisebook.services import openrouter, research_removal
from raisebook.services.openrouter import OpenRouterClient
from tests.factories import make_investor, make_participant
from tests.research.helpers import (
    AGENT,
    agent_doc,
    ledger,
    research_world,
    run_jobs,
    run_of,
)
from tests.research.pipeline_mock import (
    AMBIGUOUS,
    COST,
    FIRM,
    LINKEDIN,
    NAME,
    SITE,
    Script,
)


async def start(c: Any, inv_id: Any, kind: str = "dossier", **body: Any) -> Any:
    return await c.post(f"/v1/investors/{inv_id}/research", json={"kind": kind, **body})


async def ctx_of(db: AsyncSession, w: Any, now: Any) -> Any:
    ws = await worker_context(
        db,
        workspace_id=w.ws.id,
        actor_type="user",
        via="web",
        actor_user_id=w.owner.id,
        api_key_id=None,
        actor_label=None,
        agent_model=None,
        now=now,
    )
    assert ws is not None
    return ws


def wrap_chat(monkeypatch: pytest.MonkeyPatch, after: Any) -> None:
    """Run ``after(step_index, body)`` (async) right after each chat call returns."""
    orig = OpenRouterClient.chat
    n = {"i": 0}

    async def chat(self: Any, model: str, messages: Any, **kw: Any) -> Any:
        res = await orig(self, model, messages, **kw)
        n["i"] += 1
        await after(n["i"], kw)
        return res

    monkeypatch.setattr(OpenRouterClient, "chat", chat)


# --- correctness: save_dossier and "Is this them?" -----------------------------------------


async def test_save_dossier_never_skips_is_this_them_or_takes_someone_else(
    db: AsyncSession, key_client: Any, openrouter_mock: Any, session_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db)
    d = await make_investor(db, w.ws, name="D. Whitfield")
    await make_participant(db, w.rnd, d)
    Script(identity=list(AMBIGUOUS)).install(openrouter_mock)
    s = await session_client(w.owner, w.ws)
    await start(s, d.id, "identity")
    await run_jobs(db)
    assert (await s.get(f"/v1/investors/{d.id}/identity")).json()["status"] == "needs_pick"
    c = key_client(w.key, headers=AGENT)
    zorro = agent_doc(
        identity={
            "name": "Quentin Zorro",
            "firm": "Zorro Capital",
            "linkedin_url": "https://www.linkedin.com/in/example-quentin-zorro",
            "firm_website": "https://zorro.example",
        }
    )
    r = await c.post(f"/v1/investors/{d.id}/dossier", json={"dossier": zorro})
    assert r.status_code == 409 and r.json()["error"]["code"] == "identity_required"
    # Candidates stay; nothing was filled.
    ident = (await s.get(f"/v1/investors/{d.id}/identity")).json()
    assert ident["status"] == "needs_pick" and len(ident["candidates"]) == 2
    inv = (await s.get(f"/v1/investors/{d.id}")).json()
    assert inv["linkedin_url"] is None and inv["website_url"] is None

    # No identity yet: a dossier about a different name is someone else.
    other = await make_investor(db, w.ws, name="Priya Strand", firm="Stonepine Seed")
    r = await c.post(f"/v1/investors/{other.id}/dossier", json={"dossier": zorro})
    assert r.status_code == 409 and r.json()["error"]["code"] == "identity_mismatch"
    assert "Quentin Zorro" in r.json()["error"]["message"]


async def test_agent_identity_links_must_be_http_linkedin_profiles(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db, with_key=False)
    c = key_client(w.key, headers=AGENT)
    doc = agent_doc(
        identity={
            "name": NAME,
            "linkedin_url": "javascript:alert(document.domain)//linkedin.com/in/x",
        }
    )
    r = await c.post(f"/v1/investors/{w.inv.id}/dossier", json={"dossier": doc})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_dossier"
    doc = agent_doc(identity={"name": NAME, "firm_website": "ftp://harborlight.example"})
    r = await c.post(f"/v1/investors/{w.inv.id}/dossier", json={"dossier": doc})
    assert r.status_code == 422
    ident = await db.scalar(
        select(InvestorIdentity).where(InvestorIdentity.investor_id == w.inv.id)
    )
    assert ident is None


# --- correctness: Remove key, lost leases, crashes and shutdowns ------------------------------


async def test_remove_key_stops_a_running_run_before_its_next_call(
    db: AsyncSession,
    session_client: Any,
    openrouter_mock: Any,
    frozen_now: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    script = Script().install(openrouter_mock)
    ws = await ctx_of(db, w, frozen_now)

    async def after(i: int, _: Any) -> None:
        if i == 1:  # the owner presses "Remove key" while the first search is in flight
            assert await ai_svc.remove_key(db, ws, now=frozen_now) == 1
            await db.commit()

    wrap_chat(monkeypatch, after)
    c = await session_client(w.owner, w.ws)
    run_id = (await start(c, w.inv.id)).json()["run"]["id"]
    await run_jobs(db)
    assert script.calls == ["search:activity"]  # nothing after the removal
    run = await run_of(db, run_id)
    assert run.status == "cancelled" and run.error_code == "no_key"
    # The call already in flight was billed, so it is recorded; nothing stays held.
    assert run.cost_micros == round(COST["search"] * 1_000_000)
    assert await ledger(db, w.ws) == (run.cost_micros, 0, 1)


async def test_a_worker_that_lost_its_lease_records_its_call_and_writes_nothing_else(
    db: AsyncSession,
    session_client: Any,
    openrouter_mock: Any,
    frozen_now: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    script = Script().install(openrouter_mock)

    async def after(i: int, kw: Any) -> None:
        if kw.get("response_format"):  # the writer: meanwhile another worker took the job
            await db.execute(
                text("UPDATE jobs SET locked_by = 'worker-b' WHERE status = 'running'")
            )
            await db.commit()

    wrap_chat(monkeypatch, after)
    c = await session_client(w.owner, w.ws)
    run_id = (await start(c, w.inv.id)).json()["run"]["id"]
    assert await run_jobs(db) == ["lost"]
    assert script.calls[-1] == "write"
    run = await run_of(db, run_id)
    assert "draft" not in (run.result or {})  # results are worker B's to write
    writes = [u for u in run.usage if u["step"] == "write"]
    assert len(writes) == 1 and writes[0]["cost_micros"] == round(COST["write"] * 1_000_000)
    spent, _, calls = await ledger(db, w.ws)
    assert spent == run.cost_micros and calls == 4


async def test_settling_with_nothing_held_never_raises(
    db: AsyncSession, session_client: Any, frozen_now: Any
) -> None:
    from raisebook.services import research, spend

    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    c = await session_client(w.owner, w.ws)
    run_id = (await start(c, w.inv.id)).json()["run"]["id"]
    month = frozen_now.date().replace(day=1)
    # Worker A's late answer after worker B used up the run's hold: still recorded.
    await research.record_call(
        db,
        run_id,
        {"call_id": "a1", "step": "write", "cost_micros": 126_000},
        need=189_000,
        month=month,
        now=frozen_now,
    )
    run = await run_of(db, run_id)
    assert run.cost_micros == 126_000 and await ledger(db, w.ws) == (126_000, 0, 1)
    assert spend.month_of(frozen_now, "UTC") == month


class WorkerKilled(BaseException):
    """SIGKILL: nothing in the worker gets to run."""


async def test_a_call_in_flight_when_the_worker_dies_is_charged_once(
    db: AsyncSession,
    session_client: Any,
    openrouter_mock: Any,
    frozen_now: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    script = Script().install(openrouter_mock)
    killed = {"done": False}

    async def after(i: int, kw: Any) -> None:
        if kw.get("response_format") and not killed["done"]:
            killed["done"] = True
            raise WorkerKilled()  # OpenRouter billed the writer; the worker never saw it

    wrap_chat(monkeypatch, after)
    c = await session_client(w.owner, w.ws)
    run_id = (await start(c, w.inv.id)).json()["run"]["id"]
    with pytest.raises(WorkerKilled):
        await run_jobs(db)
    await db.execute(text("UPDATE jobs SET locked_until = :t"), {"t": frozen_now - timedelta(1)})
    w2 = worker.Worker(
        lambda: _same(db),
        handlers=dict(worker.HANDLERS),
        recovery_hooks=dict(worker.RECOVERY_HOOKS),
        worker_id="test-worker-2",
    )
    assert len(await w2.recover()) == 1
    run = await run_of(db, run_id)
    lost = [u for u in run.usage if u.get("lost")]
    assert len(lost) == 1 and lost[0]["step"] == "write" and lost[0]["estimated"]
    assert run.status == "queued" and run.reserved_micros == 0
    assert all(st["state"] != "running" for st in run.progress["steps"])
    assert await run_jobs(db) == ["succeeded"]
    assert script.calls.count("write") == 2  # billed twice by OpenRouter …
    run = await run_of(db, run_id)
    writes = [u for u in run.usage if u["step"] == "write"]
    assert len(writes) == 2  # … and recorded twice (one at its reservation, marked lost)
    spent, reserved, _ = await ledger(db, w.ws)
    assert spent == run.cost_micros == sum(u["cost_micros"] for u in run.usage)
    assert reserved == 0


async def test_shutdown_mid_call_requeues_the_run_and_gives_back_its_hold(
    db: AsyncSession,
    session_client: Any,
    openrouter_mock: Any,
    frozen_now: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    Script().install(openrouter_mock)
    stopped = {"done": False}

    async def after(i: int, kw: Any) -> None:
        if kw.get("response_format") and not stopped["done"]:
            stopped["done"] = True
            raise asyncio.CancelledError()  # SIGTERM, grace period over

    wrap_chat(monkeypatch, after)
    c = await session_client(w.owner, w.ws)
    run_id = (await start(c, w.inv.id)).json()["run"]["id"]
    with pytest.raises(asyncio.CancelledError):
        await run_jobs(db)
    run = await run_of(db, run_id)
    assert run.status == "queued" and run.reserved_micros == 0
    assert run.progress["step"] is None
    assert all(st["state"] != "running" for st in run.progress["steps"])
    assert await ledger(db, w.ws) == (run.cost_micros, 0, 4)  # 3 searches + the lost writer
    assert await run_jobs(db) == ["succeeded"]


def _same(db: AsyncSession) -> Any:
    from tests.research.helpers import _same_session

    return _same_session(db)


# --- correctness and security: prices the worker knows ------------------------------------


async def test_advanced_model_prices_survive_a_restart_and_reach_the_worker(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE, cap_usd=1)
    Script().install(openrouter_mock)
    c = await session_client(w.owner, w.ws)
    r = await c.patch("/v1/workspace/ai-settings", json={"writer_model": "openai/gpt-5.6-terra"})
    assert r.status_code == 200, r.text
    before = r.json()["estimates"]["current"]
    assert before is not None
    openrouter.reset_models_cache()  # an API restart, or the worker's own process
    after = (await c.get("/v1/workspace/ai-settings")).json()["estimates"]["current"]
    assert after == before
    est = (
        await c.post(
            "/v1/research/estimate", json={"kind": "dossier", "investor_ids": [str(w.inv.id)]}
        )
    ).json()
    assert est["per_run_usd"] == pytest.approx(before)
    # The worker holds the real price ($0.50 a call would not fit under $1).
    run_id = (await start(c, w.inv.id)).json()["run"]["id"]
    await run_jobs(db)
    assert (await run_of(db, run_id)).status == "succeeded"


async def test_a_model_without_a_known_price_never_spends(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    script = Script().install(openrouter_mock)
    c = await session_client(w.owner, w.ws)
    run_id = (await start(c, w.inv.id)).json()["run"]["id"]
    await db.execute(
        text("UPDATE research_runs SET writer_model = 'acme/unlisted-writer' WHERE id = :r"),
        {"r": run_id},
    )
    await run_jobs(db)
    run = await run_of(db, run_id)
    assert run.status == "failed" and run.error_code == "model_unavailable"
    assert script.calls == [] and await ledger(db, w.ws) == (0, 0, 0)


# --- security: injected identities and contact details -------------------------------------


async def test_an_injected_identity_never_auto_fills_contact_details(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, title=None, email=None)
    injected = [
        {
            "name": NAME,
            "firm": FIRM,
            "linkedin_url": "https://www.linkedin.com/in/attacker-controlled",
            "firm_website": "https://evil-harbor.example",
            "confidence": 1.0,
            "evidence": [],
        }
    ]
    Script(identity=injected).install(openrouter_mock)
    c = await session_client(w.owner, w.ws)
    await start(c, w.inv.id, "identity")
    await run_jobs(db)
    ident = (await c.get(f"/v1/investors/{w.inv.id}/identity")).json()
    assert ident["status"] == "needs_pick"
    assert ident["candidates"][0]["firm_website"] is None  # no citation on that domain
    inv = (await c.get(f"/v1/investors/{w.inv.id}")).json()
    assert inv["linkedin_url"] is None and inv["website_url"] is None and inv["email"] is None


async def test_writer_suggested_contact_details_off_the_anchor_wait_for_a_person(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db, with_key=False, linkedin_url=LINKEDIN, website_url=None)
    db.add(
        InvestorIdentity(
            workspace_id=w.ws.id,
            investor_id=w.inv.id,
            status="confirmed",
            source="existing",
            linkedin_url=LINKEDIN,
            linkedin_key="in/example-dana-whitfield",
            firm=FIRM,
            created_at=frozen_now,
            updated_at=frozen_now,
        )
    )
    await db.flush()
    doc = agent_doc(
        identity={"name": NAME, "firm": FIRM, "linkedin_url": LINKEDIN},
        suggestions={
            "website_url": {"value": "https://evil-harbor.example", "fact_keys": ["f2"]},
        },
    )
    doc["sources"][1]["url"] = "https://evil-harbor.example/dana"
    doc["sources"][1]["title"] = "Dana Whitfield - Harbor Light Ventures"
    c = key_client(w.key, headers=AGENT)
    r = await c.post(f"/v1/investors/{w.inv.id}/dossier", json={"dossier": doc})
    assert r.status_code == 201, r.text
    inv = await db.get(Investor, w.inv.id, populate_existing=True)
    assert inv is not None and inv.website_url is None
    sug = await db.scalar(
        select(FieldSuggestion).where(
            FieldSuggestion.investor_id == w.inv.id, FieldSuggestion.field == "website_url"
        )
    )
    assert sug is not None and sug.status == "pending"


# --- security and correctness: removals and suppression -------------------------------------


async def test_removal_suppression_survives_the_reset_and_covers_identities(
    db: AsyncSession, client: Any, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, title=None)
    Script().install(openrouter_mock)
    c = await session_client(w.owner, w.ws)
    await start(c, w.inv.id)
    await run_jobs(db)
    inv = (await c.get(f"/v1/investors/{w.inv.id}")).json()
    assert inv["linkedin_url"] == LINKEDIN  # filled by research (cited, auto-matched)

    # Someone else asks about Dana from a mailbox that proves nothing.
    req = await research_removal.create_request(
        db,
        name="Whoever",
        email="attacker@mailbox.example",
        linkedin_url=LINKEDIN,
        firm=None,
        message=None,
        now=frozen_now,
        sender=None,
    )
    req.status = "verified"
    await db.flush()
    proof = await research_removal.proof_of(db, req)
    assert proof["strength"] == "weak" and proof["warning"]
    with pytest.raises(Exception) as exc:
        await research_removal.enqueue_apply(db, req.id, now=frozen_now)
    assert getattr(exc.value, "code", "") == "conflict"
    # The operator checked other proof: applied.
    await research_removal.enqueue_apply(db, req.id, now=frozen_now, proof_checked=True)
    assert await run_jobs(db) == ["succeeded"]
    row = await db.get(ResearchRemovalRequest, req.id, populate_existing=True)
    assert row is not None and row.status == "applied"

    # The "from research" LinkedIn was reset, yet research stays off for this person.
    r = await start(c, w.inv.id)
    assert r.status_code == 409 and r.json()["error"]["code"] == "research_suppressed"
    # A new contact for the same person (another spelling) cannot get them back either:
    # the identity run drops the suppressed candidate, and picking them is refused.
    twin = await make_investor(db, w.ws, name="Dana Whitfield-Ng", firm="Harbour Light")
    await make_participant(db, w.rnd, twin)
    await start(c, twin.id, "identity")
    await run_jobs(db)
    ident = (await c.get(f"/v1/investors/{twin.id}/identity")).json()
    assert all(x["linkedin_url"] != LINKEDIN for x in ident["candidates"])
    r = await c.post(f"/v1/investors/{twin.id}/identity", json={"linkedin_url": LINKEDIN})
    assert r.status_code == 409 and r.json()["error"]["code"] == "research_suppressed"


async def test_a_work_email_on_the_firm_domain_is_strong_proof(
    db: AsyncSession, frozen_now: Any
) -> None:
    req = await research_removal.create_request(
        db,
        name=NAME,
        email="dana@harborlight.example",
        linkedin_url=None,
        firm=FIRM,
        message=None,
        now=frozen_now,
        sender=None,
    )
    assert (await research_removal.proof_of(db, req))["strength"] == "strong"
    done = research_removal.done_email("dana@harborlight.example")
    assert "records" not in done.text  # no oracle on how much research existed


# --- write-back -----------------------------------------------------------------------------


async def test_strong_never_suggests_lowering_hot(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db, with_key=False)
    part = await db.scalar(select(RoundParticipant).where(RoundParticipant.investor_id == w.inv.id))
    assert part is not None
    part.fit = 5
    await db.flush()
    c = key_client(w.key, headers=AGENT)
    doc = agent_doc()
    doc["analysis"]["brief"]["verdict"] = "strong"
    r = await c.post(f"/v1/investors/{w.inv.id}/dossier", json={"dossier": doc, "round": "seed"})
    assert r.status_code == 201, r.text
    sug = await db.scalar(
        select(FieldSuggestion).where(
            FieldSuggestion.investor_id == w.inv.id, FieldSuggestion.field == "fit"
        )
    )
    assert sug is None
    await db.refresh(part)
    assert part.fit == 5


# --- UX: bulk order, a rejected key stops the batch ----------------------------------------


async def test_capped_bulk_research_takes_the_best_fit_first(
    db: AsyncSession, session_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db, cap_usd=0.35, linkedin_url=LINKEDIN)  # Dana: fit 0
    hot = await make_investor(db, w.ws, name="Zed Yarrow", firm="Kelpline Capital")
    await make_participant(db, w.rnd, hot, fit=5)
    c = await session_client(w.owner, w.ws)
    est = (await c.post("/v1/research/estimate", json={"kind": "dossier", "round": "seed"})).json()
    assert est["order"] == "fit" and est["fits"] == 1
    r = await c.post(
        "/v1/research/batches",
        json={"kind": "dossier", "round": "seed", "confirm_usd": 1, "allow_partial": True},
    )
    assert r.status_code == 202, r.text
    runs = (await c.get("/v1/research/runs")).json()["data"]
    assert [x["investor_id"] for x in runs] == [str(hot.id)]  # Hot before "Dana" by name


async def test_a_rejected_key_stops_the_rest_of_the_batch_and_shows_in_settings(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db)
    others = [
        await make_investor(db, w.ws, name=n, firm=FIRM) for n in ("Ines Calloway", "Tomas Okafor")
    ]
    for o in others:
        await make_participant(db, w.rnd, o)
    openrouter_mock.route("POST", "/chat/completions", lambda _: _401())  # key refused
    c = await session_client(w.owner, w.ws)
    est = (await c.post("/v1/research/estimate", json={"kind": "identity", "round": "seed"})).json()
    r = await c.post(
        "/v1/research/batches",
        json={"kind": "identity", "round": "seed", "confirm_usd": est["total_usd"]},
    )
    assert r.status_code == 202, r.text
    batch_id = r.json()["batch"]["id"]
    statuses = await run_jobs(db)
    assert statuses == ["failed"]  # the first refusal ends the others before they run
    b = (await c.get(f"/v1/research/batches/{batch_id}")).json()
    assert b["errors"] == {"openrouter_key_rejected": 3} and b["active"] == 0
    s = (await c.get("/v1/workspace/ai-settings")).json()
    assert s["key_error"] == "openrouter_key_rejected" and s["key_error_at"]


def _401() -> Any:
    import httpx

    return httpx.Response(401, json={"error": {"message": "invalid key"}})
