"""Agent dossiers through ``POST /v1/investors/{id}/dossier``, the REST twin of MCP
``save_dossier`` (MCP: test_mcp_research.py) (RESEARCH-PLAN §7; R11). The same
validator and privacy filter as model dossiers; no OpenRouter key, no spend."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.activity import Activity
from raisebook.models.research import InvestorIdentity, ResearchRun
from tests.research.helpers import AGENT, agent_doc, ledger, research_world
from tests.research.pipeline_mock import LINKEDIN, NAME, SITE


async def test_rest_twin_validates_marks_and_costs_nothing(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db, with_key=False)  # no OpenRouter key needed (R11)
    c = key_client(w.key, headers=AGENT)
    r = await c.post(f"/v1/investors/{w.inv.id}/dossier", json={"dossier": agent_doc()})
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["by"] == "by claude-code" and out["version"] == 1
    assert out["kept"] == {"facts": 2, "sources_accepted": 2}
    dropped = {d["key"]: d["reason"] for d in out["dropped"]}
    assert dropped == {
        "f3": "uncited",  # cites the Instagram page, which is never a source
        "f4": "uncited",
        "f5": "privacy",
        "ways_in.1": "workspace_basis_not_allowed",
    }
    rejected = {s["id"]: s["reason"] for s in out["sources_rejected"]}
    assert rejected == {"a3": "personal_domain", "a4": "anchor_mismatch"}
    assert out["privacy_removed"] >= 2
    view = (await c.get(f"/v1/investors/{w.inv.id}/dossier")).json()
    assert view["author"] == {"kind": "agent", "label": "claude-code", "by": "by claude-code"}
    texts = " ".join(f["text"] for f in view["facts"])
    assert "555-0142" not in texts and "husband" not in texts
    assert view["dossier"]["unverified"] == []  # agents' uncited claims are dropped, not kept
    # No anchor existed: the agent's identity is now the confirmed one (source agent).
    ident = await db.scalar(
        select(InvestorIdentity).where(InvestorIdentity.investor_id == w.inv.id)
    )
    assert ident is not None and (ident.status, ident.source) == ("confirmed", "agent")
    # The timeline shows the dossier "by claude-code" (agent actor), and no money moved.
    act = await db.scalar(
        select(Activity).where(
            Activity.investor_id == w.inv.id,
            Activity.kind == "research",
            Activity.data["event"].astext == "dossier",
        )
    )
    assert act is not None and act.actor_type == "agent" and act.actor_label == "claude-code"
    assert act.agent_model == "claude-opus-5-5"
    assert await ledger(db, w.ws) == (0, 0, 0)
    run = await db.scalar(select(ResearchRun).where(ResearchRun.investor_id == w.inv.id))
    assert run is not None and (run.kind, run.status, run.cost_micros) == ("agent", "succeeded", 0)


async def test_identity_mismatch_and_no_cited_facts(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    db.add(
        InvestorIdentity(
            workspace_id=w.ws.id,
            investor_id=w.inv.id,
            status="confirmed",
            source="existing",
            linkedin_url=LINKEDIN,
            linkedin_key="in/example-dana-whitfield",
            firm_website=SITE,
            firm_domain="harborlight.example",
            created_at=frozen_now,
            updated_at=frozen_now,
        )
    )
    await db.flush()
    c = key_client(w.key, headers=AGENT)
    other = agent_doc(identity={"name": NAME, "linkedin_url": LINKEDIN + "-chef"})
    r = await c.post(f"/v1/investors/{w.inv.id}/dossier", json={"dossier": other})
    assert r.status_code == 409 and r.json()["error"]["code"] == "identity_mismatch"
    assert r.json()["error"]["details"]["anchor"]["linkedin_key"] == "in/example-dana-whitfield"
    uncited = agent_doc()
    for f in uncited["facts"]:
        f["source_ids"] = ["a3"]
    r = await c.post(f"/v1/investors/{w.inv.id}/dossier", json={"dossier": uncited})
    assert r.status_code == 422 and r.json()["error"]["code"] == "no_cited_facts"
    assert r.json()["error"]["details"]["dropped"]
    bad = agent_doc(analysis={"brief": {"verdict": "amazing", "why": "x"}})
    r = await c.post(f"/v1/investors/{w.inv.id}/dossier", json={"dossier": bad})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_dossier"
    assert any("verdict" in str(d["loc"]) for d in r.json()["error"]["details"])
    assert (
        await db.scalar(
            text("SELECT count(*) FROM dossiers WHERE investor_id = :i"), {"i": w.inv.id}
        )
        == 0
    )


async def test_idempotency_key_and_versions(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db, with_key=False)
    c = key_client(w.key, headers=AGENT)
    body = {"dossier": agent_doc(), "idempotency_key": "dana-2026-10-12"}
    a = await c.post(f"/v1/investors/{w.inv.id}/dossier", json=body)
    b = await c.post(f"/v1/investors/{w.inv.id}/dossier", json=body)
    assert a.status_code == 201 and b.status_code == 200
    assert a.json()["dossier_id"] == b.json()["dossier_id"] and b.json()["repeated"] is True
    for _ in range(6):
        r = await c.post(f"/v1/investors/{w.inv.id}/dossier", json={"dossier": agent_doc()})
        assert r.status_code == 201
    versions = (await c.get(f"/v1/investors/{w.inv.id}/dossiers")).json()["data"]
    assert [v["version"] for v in versions] == [7, 6, 5, 4, 3]  # the last 5 are kept
    assert (
        await c.get(f"/v1/investors/{w.inv.id}/dossier", params={"version": 1})
    ).status_code == 404
