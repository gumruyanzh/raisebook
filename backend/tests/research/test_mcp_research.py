"""MCP research tools over the real ``/mcp`` route (RESEARCH-PLAN §7): research_investor,
match_identity, list_research_runs, save_dossier and get_dossier (REST twin of save_dossier:
test_save_dossier.py)."""

from __future__ import annotations

import copy
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.research import Dossier
from tests.research.helpers import AGENT, agent_doc, research_world, run_jobs
from tests.research.pipeline_mock import AMBIGUOUS, LINKEDIN, NAME, SITE, Script


async def test_research_investor_runs_and_reports(
    db: AsyncSession, mcp_call: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    inv_id = w.inv.id
    Script().install(openrouter_mock)
    dry = await mcp_call(w.key, "research_investor", {"investor": NAME, "dry_run": True})
    assert dry.ok and dry.data["dry_run"] is True and dry.data["count"] == 1
    res = await mcp_call(
        w.key, "research_investor", {"investor": NAME, "round": "seed"}, headers=AGENT
    )
    assert res.ok, res.text
    assert res.data["status"] == "queued" and res.data["created"] is True
    again = await mcp_call(w.key, "research_investor", {"investor": str(inv_id)})
    assert again.data["id"] == res.data["id"] and again.data["created"] is False
    await run_jobs(db)
    runs = await mcp_call(w.key, "list_research_runs", {"investor": NAME})
    assert runs.ok and runs.data["runs"][0]["status"] == "succeeded"
    assert runs.data["runs"][0]["investor"] == NAME
    assert runs.data["runs"][0]["cost_usd"] > 0
    got = await mcp_call(w.key, "get_dossier", {"investor": NAME})
    assert got.ok and got.data["author"] == "anthropic/claude-opus-5.5"
    assert got.data["unverified"], "model-memory claims are labelled, not mixed in"
    # Errors tell the agent what to do next.
    nores = await mcp_call(w.reader, "list_research_runs", {"status": "failed"})
    assert nores.ok and nores.data == {"runs": []}


async def test_research_investor_errors(db: AsyncSession, mcp_call: Any, frozen_now: Any) -> None:
    w = await research_world(db, with_key=False)
    res = await mcp_call(w.key, "research_investor", {"investor": NAME})
    assert not res.ok and res.code == "no_ai_key"
    assert "save_dossier" not in res.text or "Settings" in res.text


async def test_match_identity_flow(
    db: AsyncSession, mcp_call: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, firm=None)
    Script(identity=list(AMBIGUOUS)).install(openrouter_mock)
    res = await mcp_call(w.key, "match_identity", {"investor": NAME})
    assert res.ok and res.data["run"]["kind"] == "identity", res.text
    await run_jobs(db)
    res = await mcp_call(w.key, "match_identity", {"investor": NAME})
    assert res.data["identity"]["status"] == "needs_pick"
    assert [c["rank"] for c in res.data["candidates"]] == [1, 2]
    blocked = await mcp_call(w.key, "research_investor", {"investor": NAME})
    assert not blocked.ok and blocked.code == "identity_required"
    assert "match_identity" in blocked.text  # MCP hints name tools, not REST paths
    res = await mcp_call(w.key, "match_identity", {"investor": NAME, "pick": "1"}, headers=AGENT)
    assert res.data["identity"]["status"] == "confirmed"
    assert res.data["identity"]["source"] == "agent"
    res = await mcp_call(w.key, "match_identity", {"investor": NAME, "pick": "9"})
    assert not res.ok and res.code == "not_found"


async def test_mcp_save_dossier_and_get_dossier(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await research_world(db, with_key=False)
    inv_id = w.inv.id  # failed tool calls roll back (and expire) the shared session
    res = await mcp_call(
        w.key, "save_dossier", {"investor": NAME, "dossier": agent_doc()}, headers=AGENT
    )
    assert res.ok, res.text
    assert res.data["by"] == "by claude-code" and res.data["kept"]["facts"] == 2
    got = await mcp_call(w.key, "get_dossier", {"investor": str(inv_id)})
    assert got.ok, got.text
    d = got.data
    assert d["author"] == "by claude-code" and d["verdict"] == "possible"
    assert d["sections"]["brief"]["why"] == "Seed robotics, smaller checks."
    assert any("[s" in line for line in d["sections"]["activity"])
    assert all(s["url"].startswith("https://") for s in d["sources"])
    one = await mcp_call(w.key, "get_dossier", {"investor": NAME, "section": "activity"})
    assert set(one.data["sections"]) == {"brief", "activity"}
    # Validation errors name the field; uncited dossiers are refused.
    bad = copy.deepcopy(agent_doc())
    bad["facts"][0]["section"] = "gossip"
    res = await mcp_call(w.key, "save_dossier", {"investor": NAME, "dossier": bad})
    assert not res.ok and res.code == "invalid_dossier" and "section" in res.text
    # A read-only key cannot save.
    res = await mcp_call(w.reader, "save_dossier", {"investor": NAME, "dossier": agent_doc()})
    assert not res.ok and res.code in ("insufficient_scope", "unknown_tool", None)
    assert (
        await db.scalar(text("SELECT count(*) FROM dossiers WHERE investor_id = :i"), {"i": inv_id})
        == 1
    )
    d_row = await db.scalar(select(Dossier).where(Dossier.investor_id == inv_id))
    assert d_row is not None and d_row.author_kind == "agent"
