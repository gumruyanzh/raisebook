"""Write-back and suggestions (services/research_writeback.py; RESEARCH-PLAN §4.7; R7):
empty fields are filled with a "from research" mark, nothing is overwritten, and suggestions
are accepted, ignored or accepted in bulk through the normal edit paths."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.activity import Activity
from raisebook.models.research import FieldSuggestion
from raisebook.models.round import RoundParticipant
from tests.factories import make_investor, make_participant
from tests.research.helpers import AGENT, agent_doc, research_world


def doc_with(suggestions: dict[str, Any], verdict: str = "possible") -> dict[str, Any]:
    d = agent_doc(suggestions=suggestions)
    d["analysis"]["brief"]["verdict"] = verdict
    return d


async def save(c: Any, inv_id: Any, doc: dict[str, Any], **kw: Any) -> Any:
    r = await c.post(f"/v1/investors/{inv_id}/dossier", json={"dossier": doc, **kw})
    assert r.status_code == 201, r.text
    return r.json()


async def test_fill_empty_suggest_conflicts_never_overwrite(
    db: AsyncSession, key_client: Any, session_client: Any, frozen_now: Any
) -> None:
    w = await research_world(
        db,
        with_key=False,
        location=None,
        check_min=50_000,
        check_max=250_000,
        industries=["fintech"],
    )
    c = key_client(w.key, headers=AGENT)
    out = await save(
        c,
        w.inv.id,
        doc_with(
            {
                "title": {"value": "General Partner", "fact_keys": ["f1"]},
                "location": {"value": "Oakland, CA", "fact_keys": ["f1"]},
                "check_min": {"value": 250_000, "fact_keys": ["f1"]},
                "check_max": {"value": 1_000_000, "fact_keys": ["f1"]},
                "industries": {"value": ["robotics", "fintech"], "fact_keys": ["f1"]},
                "type": {"value": "vc", "fact_keys": ["f1"]},
            }
        ),
    )
    assert out["suggestions"]["applied"] >= 1
    inv = (await c.get(f"/v1/investors/{w.inv.id}")).json()
    assert inv["location"] == "Oakland, CA"  # empty → filled
    assert inv["title"] == "Partner"  # never overwritten
    assert (inv["check_min"], inv["check_max"]) == (50_000, 250_000)
    assert inv["industries"] == ["fintech"]
    assert "location" in inv["research"]["from_research"]
    pending = {
        s["field"]: s
        for s in (
            await c.get("/v1/research/suggestions", params={"investor_id": str(w.inv.id)})
        ).json()["data"]
    }
    # The agent's LinkedIn waits for a person even though the field was empty (an agent's
    # identity is not trusted to write contact details unasked); its firm site matches the
    # firm's name, so it was filled.
    assert set(pending) == {"title", "check_min", "check_max", "industries", "linkedin_url"}
    assert pending["linkedin_url"]["current_value"] is None
    assert inv["website_url"] == "https://harborlight.example"
    assert pending["check_min"]["current_value"] == 50_000
    assert pending["industries"]["suggested_value"] == ["fintech", "robotics"]
    # A human edit removes the "from research" mark silently.
    u = await session_client(w.owner, w.ws)
    await u.patch(f"/v1/investors/{w.inv.id}", json={"location": "Berkeley, CA"})
    inv = (await u.get(f"/v1/investors/{w.inv.id}")).json()
    assert "location" not in inv["research"]["from_research"]
    acts = list(
        await db.scalars(
            select(Activity).where(
                Activity.investor_id == w.inv.id, Activity.kind == "investor_updated"
            )
        )
    )
    assert any(a.data.get("source") == "research" and "location" in a.data["fields"] for a in acts)


async def test_accept_ignore_supersede_and_never_resuggest_ignored(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db, with_key=False, check_min=50_000, check_max=250_000)
    c = key_client(w.key, headers=AGENT)
    await save(
        c,
        w.inv.id,
        doc_with(
            {
                "title": {"value": "General Partner", "fact_keys": ["f1"]},
                "check_min": {"value": 250_000, "fact_keys": ["f1"]},
                "check_max": {"value": 1_000_000, "fact_keys": ["f1"]},
            }
        ),
    )
    rows = {s["field"]: s for s in (await c.get("/v1/research/suggestions")).json()["data"]}
    # Ignore the title; accept the check size (both halves travel together).
    r = await c.post(f"/v1/research/suggestions/{rows['title']['id']}/ignore")
    assert r.json()["status"] == "ignored"
    r = await c.post(f"/v1/research/suggestions/{rows['check_min']['id']}/accept")
    assert r.status_code == 200 and r.json()["status"] == "accepted", r.text
    inv = (await c.get(f"/v1/investors/{w.inv.id}")).json()
    assert (inv["check_min"], inv["check_max"]) == (250_000, 1_000_000)
    again = await c.post(f"/v1/research/suggestions/{rows['check_min']['id']}/accept")
    assert again.status_code == 200  # repeat-safe
    conflict = await c.post(f"/v1/research/suggestions/{rows['title']['id']}/accept")
    assert conflict.status_code == 409
    # A newer dossier with the same ignored title suggests nothing; a new value suggests again.
    await save(c, w.inv.id, doc_with({"title": {"value": "General Partner", "fact_keys": ["f1"]}}))
    pend = (await c.get("/v1/research/suggestions")).json()["data"]
    assert [s for s in pend if s["field"] == "title"] == []
    await save(c, w.inv.id, doc_with({"title": {"value": "Managing Partner", "fact_keys": ["f1"]}}))
    await save(c, w.inv.id, doc_with({"title": {"value": "Venture Partner", "fact_keys": ["f1"]}}))
    titles = list(
        await db.scalars(
            select(FieldSuggestion).where(
                FieldSuggestion.investor_id == w.inv.id, FieldSuggestion.field == "title"
            )
        )
    )
    assert sorted(t.status for t in titles) == ["ignored", "pending", "superseded"]


async def test_fit_mapping_per_round_participant(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db, with_key=False)
    other = await make_investor(db, w.ws, name="Ines Calloway", firm="Harbor Light Ventures")
    await make_participant(db, w.rnd, other, fit=2)
    c = key_client(w.key, headers=AGENT)
    await save(c, w.inv.id, doc_with({}, verdict="strong"), round="seed")
    part = await db.scalar(select(RoundParticipant).where(RoundParticipant.investor_id == w.inv.id))
    assert part is not None and part.fit == 4  # unset → Strong (4)
    doc = doc_with({}, verdict="poor")
    doc["identity"] = {"name": "Ines Calloway", "firm": "Harbor Light Ventures"}
    for s in doc["sources"]:
        s["title"] = (s.get("title") or "").replace("Dana Whitfield", "Ines Calloway")
    await save(c, other.id, doc, round="seed")
    part2 = await db.scalar(
        select(RoundParticipant).where(RoundParticipant.investor_id == other.id)
    )
    await db.refresh(part2)
    assert part2 is not None and part2.fit == 2  # set by a person: a suggestion instead
    sug = await db.scalar(
        select(FieldSuggestion).where(
            FieldSuggestion.investor_id == other.id, FieldSuggestion.field == "fit"
        )
    )
    assert sug is not None and (sug.current_value, sug.suggested_value) == (2, 1)
    assert sug.round_id == w.rnd.id


async def test_accept_all_shares_one_bulk_id(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await research_world(db, with_key=False, check_min=1, check_max=2)
    c = key_client(w.key, headers=AGENT)
    await save(
        c,
        w.inv.id,
        doc_with(
            {
                "title": {"value": "General Partner", "fact_keys": ["f1"]},
                "check_min": {"value": 250_000, "fact_keys": ["f1"]},
                "check_max": {"value": 1_000_000, "fact_keys": ["f1"]},
            }
        ),
    )
    r = await c.post("/v1/research/suggestions/accept-all", json={"round": "seed"})
    assert r.status_code == 200, r.text
    out = r.json()
    # title, check size (check_max rode along with check_min) and the agent's LinkedIn
    assert out["accepted"] == 3 and out["skipped"] == []
    inv = (await c.get(f"/v1/investors/{w.inv.id}")).json()
    assert inv["title"] == "General Partner" and inv["check_max"] == 1_000_000
    acts = list(
        await db.scalars(
            select(Activity).where(
                Activity.investor_id == w.inv.id,
                Activity.kind == "investor_updated",
                Activity.data["bulk_id"].astext == out["bulk_id"],
            )
        )
    )
    assert len(acts) == 3
    assert (await c.post("/v1/research/suggestions/accept-all", json={})).status_code == 422
