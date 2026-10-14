"""Never pay twice for the same research (owner decisions 2026-10-14, RESEARCH-SPEC #14 to #16):

1. A fresh dossier (under ``FRESH_DOSSIER_DAYS``) is returned instead of researched again,
   unless ``kind=refresh`` or ``force``; a confirmed identity is not matched again.
2. Research the same owner did in another of their workspaces is reused (identity + public
   sources + public facts; only the writer runs). The single named cross-workspace read:
   a non-owner, or workspaces of different owners, never reuse.
3. Investor notes as starting facts, only when ``use_notes_in_research`` is on.

Fictional people only; OpenRouter is the scripted mock.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core import clock
from raisebook.models.ai import CompanyProfile, WorkspaceAiSettings
from raisebook.models.research import (
    Dossier,
    DossierFacts,
    InvestorIdentity,
    ResearchRun,
    ResearchSource,
)
from raisebook.models.workspace import Workspace
from raisebook.services import research as research_svc
from raisebook.services.privacy_filter import notes_for_research
from raisebook.services.research_reuse import FRESH_DAYS
from tests.factories import (
    add_member,
    make_api_key,
    make_investor,
    make_participant,
    make_round,
    make_workspace,
)
from tests.research.helpers import RW, research_world, run_jobs, set_key
from tests.research.pipeline_mock import COST, FIRM, LINKEDIN, NAME, SITE, Script

FULL = ["identity", "search:activity", "search:thesis", "search:fund", "write"]
ANCHORED_FULL = ["search:activity", "search:thesis", "search:fund", "write"]


async def start(c: Any, inv_id: Any, kind: str = "dossier", **body: Any) -> Any:
    return await c.post(f"/v1/investors/{inv_id}/research", json={"kind": kind, **body})


async def researched(db: AsyncSession, c: Any, w: RW, script: Script) -> dict[str, Any]:
    r = await start(c, w.inv.id)
    assert r.status_code == 202, r.text
    assert await run_jobs(db) == ["succeeded"]
    view: dict[str, Any] = (await c.get(f"/v1/investors/{w.inv.id}/dossier")).json()
    return view


async def runs_of(db: AsyncSession, ws_id: Any) -> int:
    return int(
        await db.scalar(
            select(func.count()).select_from(ResearchRun).where(ResearchRun.workspace_id == ws_id)
        )
        or 0
    )


# --- 1. no accidental repeats --------------------------------------------------------------------


def test_fresh_window_is_at_least_30_days() -> None:
    assert research_svc.FRESH_DOSSIER_DAYS >= 30 and FRESH_DAYS >= 30


async def test_fresh_dossier_is_returned_not_researched_again(
    db: AsyncSession, key_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    script = Script().install(openrouter_mock)
    c = key_client(w.key)
    view = await researched(db, c, w, script)
    first_run = view["dossier"]["run_id"]
    calls = len(script.calls)
    n_runs = await runs_of(db, w.ws.id)

    # 10 days later "Research" again: the same dossier comes back, nothing is paid.
    clock.freeze(frozen_now + timedelta(days=10))
    r = await start(c, w.inv.id)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] is False and body["reason"] == "fresh"
    assert body["dossier"]["id"] == view["dossier"]["id"] and body["dossier"]["version"] == 1
    assert body["run"]["id"] == first_run
    assert await runs_of(db, w.ws.id) == n_runs and len(script.calls) == calls
    assert await run_jobs(db) == []

    # A refresh, or force, does research again.
    r = await start(c, w.inv.id, force=True)
    assert r.status_code == 202 and r.json()["created"] is True and r.json()["reason"] is None
    assert await run_jobs(db) == ["succeeded"]
    r = await start(c, w.inv.id, "refresh")
    assert r.status_code == 202 and r.json()["run"]["kind"] == "refresh"
    await run_jobs(db)

    # Past the fresh window a plain dossier run researches again.
    clock.freeze(frozen_now + timedelta(days=10 + research_svc.FRESH_DOSSIER_DAYS + 1))
    r = await start(c, w.inv.id)
    assert r.status_code == 202 and r.json()["created"] is True


async def test_confirmed_identity_is_not_matched_again(
    db: AsyncSession, key_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db)
    script = Script().install(openrouter_mock)
    c = key_client(w.key)
    assert (await start(c, w.inv.id, "identity")).status_code == 202
    await run_jobs(db)
    assert script.calls == ["identity"]
    r = await start(c, w.inv.id, "identity")
    assert r.status_code == 200 and r.json()["created"] is False
    assert r.json()["reason"] == "identified" and r.json()["run"]["kind"] == "identity"
    assert await run_jobs(db) == [] and script.calls == ["identity"]
    r = await start(c, w.inv.id, "identity", force=True)
    assert r.status_code == 202 and r.json()["created"] is True


async def test_mcp_research_investor_returns_the_fresh_dossier(
    db: AsyncSession, mcp_call: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    Script().install(openrouter_mock)
    res = await mcp_call(w.key, "research_investor", {"investor": NAME})
    assert res.ok and res.data["created"] is True
    await run_jobs(db)
    again = await mcp_call(w.key, "research_investor", {"investor": NAME})
    assert again.ok, again.text
    assert again.data["created"] is False and again.data["reason"] == "fresh"
    assert again.data["dossier"]["version"] == 1 and "get_dossier" in again.data["next"]
    forced = await mcp_call(w.key, "research_investor", {"investor": NAME, "force": True})
    assert forced.ok and forced.data["created"] is True
    tools = await mcp_call(w.key, "research_investor", {"investor": NAME, "kind": "refresh"})
    assert tools.ok


async def test_mcp_tool_description_says_it_never_pays_twice() -> None:
    from raisebook.mcp.server import create_mcp_server

    server = create_mcp_server()
    tools = {t.name: t for t in await server.list_tools()}
    desc = tools["research_investor"].description or ""
    assert "Never pays twice" in desc and "reason fresh" in desc and "Reused research" in desc


async def test_batch_skips_fresh_dossiers(
    db: AsyncSession, key_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    Script().install(openrouter_mock)
    c = key_client(w.key)
    await start(c, w.inv.id)
    await run_jobs(db)
    est = (
        await c.post(
            "/v1/research/estimate", json={"kind": "dossier", "investor_ids": [str(w.inv.id)]}
        )
    ).json()
    assert est["count"] == 0 and est["skipped"]["fresh"] == 1


# --- 2. reuse across the same owner's workspaces -------------------------------------------------


async def second_workspace(
    db: AsyncSession,
    w: RW,
    *,
    owner: Any | None = None,
    name: str = "Kestrel Labs",
    **investor_fields: Any,
) -> RW:
    """Another workspace (of ``owner``, by default the first one's owner) with the same person."""
    ws = await make_workspace(db, owner=owner or w.owner, name=name)
    rnd = await make_round(db, ws, name="Pre-seed", slug="pre-seed")
    investor_fields.setdefault("title", "Partner")
    inv = await make_investor(db, ws, name=NAME, firm=FIRM, **investor_fields)
    await make_participant(db, rnd, inv)
    editor = await add_member(db, ws, role="editor")
    _, key = await make_api_key(db, ws, scopes="read,write", created_by=owner or w.owner)
    await set_key(db, ws)
    db.add(
        CompanyProfile(
            workspace_id=ws.id,
            pitch="Kestrel Labs makes picking arms for pharmacies.",
            sectors=["robotics", "health"],
            stage="pre-seed",
            traction=["2 pilots"],
            created_at=clock.get_now(),
            updated_at=clock.get_now(),
        )
    )
    await db.flush()
    return RW(ws, owner or w.owner, editor, editor, rnd, inv, key, key)


async def test_owner_reuses_research_from_another_workspace(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    a = await research_world(db, linkedin_url=LINKEDIN)
    script = Script().install(openrouter_mock)
    ca = await session_client(a.owner, a.ws)
    view_a = await researched(db, ca, a, script)
    assert script.calls == ANCHORED_FULL
    a_dossier = await db.get(Dossier, view_a["dossier"]["id"])
    assert a_dossier is not None
    a_talking = [t["text"] for t in a_dossier.analysis["talking_points"]]

    clock.freeze(frozen_now + timedelta(days=3))
    b = await second_workspace(db, a, linkedin_url=LINKEDIN)
    cb = await session_client(a.owner, b.ws)
    est = (
        await cb.post(
            "/v1/research/estimate", json={"kind": "dossier", "investor_ids": [str(b.inv.id)]}
        )
    ).json()
    assert est["reused"] == 1
    # Writer only: Opus's writer budget, not identity + three searches + writer.
    full = (await cb.get("/v1/workspace/ai-settings")).json()["estimates"]["current"]
    assert 0 < est["total_usd"] < full
    script.calls.clear()
    script.requests.clear()
    r = await start(cb, b.inv.id, round="pre-seed")
    assert r.status_code == 202, r.text
    run = r.json()["run"]
    assert [s["key"] for s in run["progress"]["steps"]] == ["reuse", "filter", "write", "save"]
    assert run["estimate_usd"] == pytest.approx(est["total_usd"])
    assert run["result"]["reuse"] == {
        "workspace_name": "Kestrel Robotics",
        "date": frozen_now.date().isoformat(),
    }
    assert await run_jobs(db) == ["succeeded"]
    assert script.calls == ["write"]  # no identity call, no searches

    # The writer saw the copied public sources and facts, never A's private analysis.
    prompt = script.requests[0]["messages"][1]["content"]
    assert "KNOWN FACTS" in prompt and "Brightquay" in prompt
    assert "Kestrel Labs makes picking arms" in prompt  # B's own company
    assert "autonomous forklifts" not in prompt  # never A's company profile
    for text_ in a_talking:
        assert text_ not in prompt

    view_b = (await cb.get(f"/v1/investors/{b.inv.id}/dossier")).json()
    reused = view_b["dossier"]["reused"]
    assert reused["workspace_name"] == "Kestrel Robotics"
    assert reused["line"] == f"Reused research from Kestrel Robotics ({frozen_now.date()})"
    assert view_b["sources"] and all(
        s["id"] not in {x["id"] for x in view_a["sources"]} for s in view_b["sources"]
    )
    copied = list(
        await db.scalars(select(ResearchSource).where(ResearchSource.workspace_id == b.ws.id))
    )
    assert copied and all(s.investor_id == b.inv.id and s.accepted for s in copied)
    ident = await db.scalar(
        select(InvestorIdentity).where(InvestorIdentity.workspace_id == b.ws.id)
    )
    assert ident is not None and ident.status in ("matched", "confirmed")
    # The cost is the writer call alone.
    run_b = (await cb.get(f"/v1/research/runs/{run['id']}")).json()
    assert run_b["cost_usd"] == pytest.approx(COST["write"])
    got = (await cb.get(f"/v1/research/runs/{run['id']}")).json()["result"]["reuse"]
    assert "facts" not in got and "run_id" not in got and "workspace_id" not in got


async def test_reuse_copies_the_identity_by_name_and_firm_domain(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    a = await research_world(db)  # A matches the identity with a search first
    script = Script().install(openrouter_mock)
    ca = await session_client(a.owner, a.ws)
    await researched(db, ca, a, script)
    assert script.calls == FULL
    b = await second_workspace(db, a, website_url=SITE)  # no LinkedIn on B's investor
    cb = await session_client(a.owner, b.ws)
    script.calls.clear()
    r = await start(cb, b.inv.id)
    assert r.status_code == 202 and r.json()["run"]["progress"]["steps"][0]["key"] == "reuse"
    assert await run_jobs(db) == ["succeeded"]
    assert script.calls == ["write"]
    ident = (await cb.get(f"/v1/investors/{b.inv.id}/identity")).json()
    assert ident["status"] == "matched" and ident["linkedin_url"] == LINKEDIN
    inv = (await cb.get(f"/v1/investors/{b.inv.id}")).json()
    assert inv["linkedin_url"] == LINKEDIN  # the copied anchor filled the empty field


async def test_api_key_of_the_owner_reuses_but_not_an_editors_key(
    db: AsyncSession, key_client: Any, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    a = await research_world(db, linkedin_url=LINKEDIN)
    script = Script().install(openrouter_mock)
    await researched(db, await session_client(a.owner, a.ws), a, script)
    b = await second_workspace(db, a, linkedin_url=LINKEDIN)
    _, editor_key = await make_api_key(db, b.ws, scopes="read,write", created_by=b.editor)
    ce = key_client(editor_key)
    r = await start(ce, b.inv.id)
    assert r.json()["run"]["progress"]["steps"][0]["key"] == "search:activity"
    assert (await ce.post(f"/v1/research/runs/{r.json()['run']['id']}/cancel")).status_code == 200
    r = await start(key_client(b.key), b.inv.id)  # created by the owner
    assert r.json()["run"]["progress"]["steps"][0]["key"] == "reuse"


# --- 2b. isolation: the single cross-workspace read never crosses owners -------------------------


async def test_non_owner_member_never_reuses(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    a = await research_world(db, linkedin_url=LINKEDIN)
    script = Script().install(openrouter_mock)
    await researched(db, await session_client(a.owner, a.ws), a, script)
    b = await second_workspace(db, a, linkedin_url=LINKEDIN)
    # B's editor (not an owner of B) starts it: full research, nothing read from A.
    script.calls.clear()
    r = await start(await session_client(b.editor, b.ws), b.inv.id)
    assert r.status_code == 202 and "reuse" not in (r.json()["run"]["result"] or {})
    assert await run_jobs(db) == ["succeeded"]
    assert script.calls == ANCHORED_FULL
    view = await (await session_client(b.editor, b.ws)).get(f"/v1/investors/{b.inv.id}/dossier")
    assert view.json()["dossier"]["reused"] is None


async def test_owner_here_but_only_editor_there_never_reuses(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    a = await research_world(db, linkedin_url=LINKEDIN)
    script = Script().install(openrouter_mock)
    await researched(db, await session_client(a.owner, a.ws), a, script)
    # A's editor owns workspace B: they are not an owner of A, so A never gives to B.
    b = await second_workspace(db, a, owner=a.editor, linkedin_url=LINKEDIN)
    script.calls.clear()
    r = await start(await session_client(a.editor, b.ws), b.inv.id)
    assert r.status_code == 202 and "reuse" not in (r.json()["run"]["result"] or {})
    assert await run_jobs(db) == ["succeeded"]
    assert script.calls == ANCHORED_FULL


async def test_workspaces_of_different_owners_never_reuse(
    db: AsyncSession, session_client: Any, key_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    a = await research_world(db, linkedin_url=LINKEDIN)
    script = Script().install(openrouter_mock)
    await researched(db, await session_client(a.owner, a.ws), a, script)
    other = await research_world(db, linkedin_url=LINKEDIN)  # another founder, same investor
    script.calls.clear()
    for c in (await session_client(other.owner, other.ws), key_client(other.key)):
        est = (
            await c.post(
                "/v1/research/estimate",
                json={"kind": "dossier", "investor_ids": [str(other.inv.id)]},
            )
        ).json()
        assert est["reused"] == 0
    r = await start(await session_client(other.owner, other.ws), other.inv.id)
    assert r.status_code == 202 and "reuse" not in (r.json()["run"]["result"] or {})
    assert await run_jobs(db) == ["succeeded"]
    assert script.calls == ANCHORED_FULL
    a_urls = set(
        await db.scalars(select(ResearchSource.id).where(ResearchSource.workspace_id == a.ws.id))
    )
    o_urls = set(
        await db.scalars(
            select(ResearchSource.id).where(ResearchSource.workspace_id == other.ws.id)
        )
    )
    assert a_urls and o_urls and not (a_urls & o_urls)


async def test_stale_or_missing_research_is_not_reused(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    a = await research_world(db, linkedin_url=LINKEDIN)
    script = Script().install(openrouter_mock)
    await researched(db, await session_client(a.owner, a.ws), a, script)
    b = await second_workspace(db, a, linkedin_url=LINKEDIN)
    cb = await session_client(a.owner, b.ws)
    # A different person (another LinkedIn) is never matched.
    other = await make_investor(
        db, b.ws, name=NAME, firm=FIRM, linkedin_url="https://www.linkedin.com/in/example-other"
    )
    r = await start(cb, other.id)
    assert r.json()["run"]["progress"]["steps"][0]["key"] == "search:activity"
    # Past the fresh window, A's research is not reused.
    clock.freeze(frozen_now + timedelta(days=FRESH_DAYS + 1))
    cb = await session_client(a.owner, b.ws)
    r = await start(cb, b.inv.id)
    assert r.json()["run"]["progress"]["steps"][0]["key"] == "search:activity"


async def test_reuse_falls_back_when_the_research_is_gone_before_it_runs(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    a = await research_world(db, linkedin_url=LINKEDIN)
    script = Script().install(openrouter_mock)
    await researched(db, await session_client(a.owner, a.ws), a, script)
    b = await second_workspace(db, a, linkedin_url=LINKEDIN)
    cb = await session_client(a.owner, b.ws)
    r = await start(cb, b.inv.id)
    assert r.json()["run"]["progress"]["steps"][0]["key"] == "reuse"
    # A's sources disappear (a removal request, say) before the worker runs.
    await db.execute(
        ResearchSource.__table__.delete().where(ResearchSource.workspace_id == a.ws.id)
    )
    script.calls.clear()
    assert await run_jobs(db) == ["succeeded"]
    assert script.calls == ANCHORED_FULL
    run = (await cb.get(f"/v1/research/runs/{r.json()['run']['id']}")).json()
    assert run["result"]["reuse"]["state"] == "unavailable"
    assert (await cb.get(f"/v1/investors/{b.inv.id}/dossier")).json()["dossier"]["reused"] is None


async def test_reuse_reads_no_private_analysis_and_writes_nothing_in_the_giver(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    a = await research_world(db, linkedin_url=LINKEDIN, notes="Met at the robotics dinner.")
    row = await db.get(WorkspaceAiSettings, a.ws.id)
    assert row is not None
    row.use_notes_in_research = True
    await db.flush()
    script = Script().install(openrouter_mock)
    script.extra_facts = [
        {
            "key": "n1",
            "section": "profile",
            "kind": "other",
            "text": "Met the founder at a robotics dinner.",
            "source_ids": ["notes"],
        }
    ]
    await researched(db, await session_client(a.owner, a.ws), a, script)
    before = {
        "runs": await runs_of(db, a.ws.id),
        "dossiers": await db.scalar(
            select(func.count()).select_from(Dossier).where(Dossier.workspace_id == a.ws.id)
        ),
    }
    b = await second_workspace(db, a, linkedin_url=LINKEDIN)
    script.extra_facts = []
    script.requests.clear()
    await start(await session_client(a.owner, b.ws), b.inv.id)
    await run_jobs(db)
    prompt = script.requests[0]["messages"][1]["content"]
    assert "robotics dinner" not in prompt  # A's notes and from-notes claims stay in A
    facts_b = await db.scalar(select(DossierFacts).where(DossierFacts.workspace_id == b.ws.id))
    assert facts_b is not None and all("dinner" not in f["text"] for f in facts_b.facts)
    d_b = await db.scalar(select(Dossier).where(Dossier.workspace_id == b.ws.id))
    assert d_b is not None and "from_notes" not in d_b.analysis
    assert before["runs"] == await runs_of(db, a.ws.id)
    assert before["dossiers"] == await db.scalar(
        select(func.count()).select_from(Dossier).where(Dossier.workspace_id == a.ws.id)
    )


async def test_sample_workspaces_never_give(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    a = await research_world(db, linkedin_url=LINKEDIN)
    script = Script().install(openrouter_mock)
    await researched(db, await session_client(a.owner, a.ws), a, script)
    await db.execute(update(Workspace).where(Workspace.id == a.ws.id).values(is_sandbox=True))
    b = await second_workspace(db, a, linkedin_url=LINKEDIN)
    r = await start(await session_client(a.owner, b.ws), b.inv.id)
    assert r.json()["run"]["progress"]["steps"][0]["key"] == "search:activity"


# --- 3. investor notes as starting facts ---------------------------------------------------------

NOTES = (
    "Met Dana at the Oakland robotics dinner; she asked about our pilots.\n"
    "Her mobile: +1 (415) 555-0199, lives at 12 Ocean Avenue.\n"
    "Her husband is a cardiologist.\n"
    "Prefers decks under 12 slides."
)


def test_notes_are_filtered_and_trimmed() -> None:
    out = notes_for_research(NOTES)
    assert out is not None
    assert "robotics dinner" in out and "12 slides" in out
    assert "555-0199" not in out and "Ocean Avenue" not in out and "husband" not in out
    long = notes_for_research("word " * 2000)
    assert long is not None and len(long) <= 2010 and long.endswith("…")
    assert notes_for_research("") is None and notes_for_research("+1 (415) 555-0199") is None


async def test_notes_setting_defaults_off_and_only_admins_change_it(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db)
    owner = await session_client(w.owner, w.ws)
    got = (await owner.get("/v1/workspace/ai-settings")).json()
    assert got["use_notes_in_research"] is False
    editor = await session_client(w.editor, w.ws)
    r = await editor.patch("/v1/workspace/ai-settings", json={"use_notes_in_research": True})
    assert r.status_code == 403
    r = await owner.patch("/v1/workspace/ai-settings", json={"use_notes_in_research": True})
    assert r.status_code == 200 and r.json()["use_notes_in_research"] is True
    assert (await editor.get("/v1/workspace/ai-settings")).json()["use_notes_in_research"] is True


async def test_notes_stay_home_when_the_setting_is_off(
    db: AsyncSession, key_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, notes=NOTES)
    script = Script().install(openrouter_mock)
    await start(key_client(w.key), w.inv.id)
    await run_jobs(db)
    sent = "\n".join(str(b["messages"]) for b in script.requests)
    assert "robotics dinner" not in sent and "Already known" not in sent and "NOTES" not in sent


async def test_notes_guide_searches_and_show_as_from_your_notes(
    db: AsyncSession, key_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, notes=NOTES)
    row = await db.get(WorkspaceAiSettings, w.ws.id)
    assert row is not None
    row.use_notes_in_research = True
    await db.flush()
    script = Script().install(openrouter_mock)
    script.extra_facts = [
        {
            "key": "n1",
            "section": "profile",
            "kind": "other",
            "text": "Prefers pitch decks under 12 slides.",
            "source_ids": ["notes"],
        }
    ]
    c = key_client(w.key)
    await start(c, w.inv.id)
    assert await run_jobs(db) == ["succeeded"]
    searches = [b for b in script.requests if "web_search_options" in b or "plugins" in b]
    assert len(searches) == 3
    for b in searches:
        user = b["messages"][1]["content"]
        assert "Already known from the founder's notes (verify, don't repeat" in user
        assert "robotics dinner" in user
        assert "555-0199" not in user and "Ocean Avenue" not in user and "husband" not in user
    writer = script.requests[-1]["messages"][1]["content"]
    assert "NOTES:" in writer and "robotics dinner" in writer and "555-0199" not in writer

    view = (await c.get(f"/v1/investors/{w.inv.id}/dossier")).json()
    notes = view["dossier"]["analysis"]["from_notes"]
    assert notes == [{"section": "profile", "text": "Prefers pitch decks under 12 slides."}]
    # Never a cited public fact, never verified.
    assert all("12 slides" not in f["text"] for f in view["facts"])
    assert all("12 slides" not in u["text"] for u in view["dossier"]["unverified"])
    facts = await db.scalar(select(DossierFacts).where(DossierFacts.workspace_id == w.ws.id))
    assert facts is not None and all("12 slides" not in f["text"] for f in facts.facts)
    run = (await c.get("/v1/research/runs", params={"investor_id": str(w.inv.id)})).json()
    assert "notes_text" not in (run["data"][0]["result"] or {})


async def test_mcp_get_dossier_labels_notes_and_reuse(
    db: AsyncSession, mcp_call: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, notes=NOTES)
    row = await db.get(WorkspaceAiSettings, w.ws.id)
    assert row is not None
    row.use_notes_in_research = True
    await db.flush()
    script = Script().install(openrouter_mock)
    script.extra_facts = [
        {
            "key": "n1",
            "section": "profile",
            "kind": "other",
            "text": "Prefers pitch decks under 12 slides.",
            "source_ids": ["notes"],
        }
    ]
    await mcp_call(w.key, "research_investor", {"investor": NAME})
    await run_jobs(db)
    got = await mcp_call(w.key, "get_dossier", {"investor": NAME})
    assert got.ok and got.data["from_your_notes"] == ["Prefers pitch decks under 12 slides."]
    assert "reused" not in got.data
