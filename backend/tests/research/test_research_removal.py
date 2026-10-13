"""The Research Policy removal process (RESEARCH-PLAN §1.12, §6.5, §6.8; R13): request →
email → verify → apply in every workspace → suppression."""

from __future__ import annotations

from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core import ratelimit
from raisebook.models.activity import Activity
from raisebook.models.investor import Investor
from raisebook.models.research import (
    Dossier,
    InvestorIdentity,
    ResearchRemovalRequest,
    ResearchSource,
    ResearchSuppression,
)
from raisebook.services import housekeeping, research_removal
from raisebook.services import jobs as jobs_svc
from tests.research.helpers import AGENT, agent_doc, research_world, run_jobs
from tests.research.pipeline_mock import LINKEDIN, NAME

REQUEST = {
    "name": NAME,
    "email": "dana@harborlight.example",
    "linkedin_url": LINKEDIN,
    "firm": "Harbor Light Ventures",
    "message": "Please remove what you store about me.",
}


async def _count(db: AsyncSession, model: Any, inv_ids: list[Any]) -> int:
    return int(
        await db.scalar(
            select(func.count()).select_from(model).where(model.investor_id.in_(inv_ids))
        )
        or 0
    )


async def test_request_verify_apply_and_suppress(
    db: AsyncSession, client: Any, key_client: Any, outbox: list[Any], frozen_now: Any
) -> None:
    # Two workspaces researched the same (fictional) person.
    a = await research_world(db, with_key=False, location=None)
    b = await research_world(db, with_key=False)
    ids = [a.inv.id, b.inv.id]
    for w in (a, b):
        c = key_client(w.key, headers=AGENT)
        doc = agent_doc(suggestions={"location": {"value": "Oakland, CA", "fact_keys": ["f1"]}})
        r = await c.post(f"/v1/investors/{w.inv.id}/dossier", json={"dossier": doc})
        assert r.status_code == 201, r.text
    assert await _count(db, Dossier, ids) == 2
    # b's person edits the filled location: it is theirs now, so removal leaves it.
    await db.execute(
        Investor.__table__.update().where(Investor.id == b.inv.id).values(location="Berkeley")
    )

    r = await client.post("/v1/research-policy/removal-requests", json=REQUEST)
    assert r.status_code == 202 and "confirmation link" in r.json()["message"]
    assert len(outbox) == 1 and outbox[0].to == "dana@harborlight.example"
    token = parse_qs(urlsplit(outbox[0].link).query)["token"][0]
    req = await db.scalar(select(ResearchRemovalRequest))
    assert req is not None and req.status == "unverified" and token.encode() not in req.token_hash
    r = await client.post("/v1/research-policy/removal-requests/verify", json={"token": token})
    assert r.status_code == 200, r.text
    bad = await client.post("/v1/research-policy/removal-requests/verify", json={"token": "x" * 20})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_token"

    await research_removal.enqueue_apply(db, req.id, now=frozen_now)
    assert await run_jobs(db) == ["succeeded"]
    await db.refresh(req)
    assert req.status == "applied"
    counts = req.applied_counts or {}
    assert counts["investors"] == 2 and counts["dossiers"] == 2 and counts["values_reset"] >= 1
    for model in (Dossier, ResearchSource, InvestorIdentity):
        assert await _count(db, model, ids) == 0, model
    assert (
        await db.scalar(
            select(func.count())
            .select_from(Activity)
            .where(Activity.investor_id.in_(ids), Activity.kind == "research")
        )
        == 0
    )
    # Contacts stay; untouched auto-filled values are reset, edited ones stay.
    inv_a = await db.get(Investor, a.inv.id, populate_existing=True)
    inv_b = await db.get(Investor, b.inv.id, populate_existing=True)
    assert inv_a is not None and inv_a.name == NAME and inv_a.location is None
    assert inv_b is not None and inv_b.location == "Berkeley"
    assert outbox[-1].subject == "Your Raisebook research removal is done"
    assert await db.scalar(select(func.count()).select_from(ResearchSuppression)) == 1

    # From now on research refuses this person: model and agent alike.
    c = key_client(a.key, headers=AGENT)
    r = await c.post(f"/v1/investors/{a.inv.id}/dossier", json={"dossier": agent_doc()})
    assert r.status_code == 409 and r.json()["error"]["code"] == "research_suppressed"
    from tests.research.helpers import set_key

    await set_key(db, a.ws)
    r = await c.post(f"/v1/investors/{a.inv.id}/research", json={})
    assert r.json()["error"]["code"] == "research_suppressed"


async def test_requests_never_enumerate_and_are_rate_limited(
    db: AsyncSession, client: Any, outbox: list[Any], frozen_now: Any
) -> None:
    for _ in range(3):
        r = await client.post("/v1/research-policy/removal-requests", json=REQUEST)
        assert r.status_code == 202
    r = await client.post("/v1/research-policy/removal-requests", json=REQUEST)
    assert r.status_code == 202  # the 4th is silently not sent (3 per email per day)
    assert len(outbox) == 3
    other = {**REQUEST, "email": "someone.else@example.com"}
    r = await client.post("/v1/research-policy/removal-requests", json=other)
    assert r.status_code == 202
    r = await client.post("/v1/research-policy/removal-requests", json=other)
    assert r.status_code == 429  # 5 per IP per hour
    ratelimit.memory_backend().reset()
    bad = await client.post("/v1/research-policy/removal-requests", json={**REQUEST, "email": "x"})
    assert bad.status_code == 422


async def test_housekeeping_purges_old_requests(db: AsyncSession, frozen_now: Any) -> None:
    old = await research_removal.create_request(
        db,
        name="Old Request",
        email="old@example.com",
        linkedin_url=None,
        firm=None,
        message=None,
        now=frozen_now - timedelta(days=8),
        sender=None,
    )
    fresh = await research_removal.create_request(
        db,
        name="New Request",
        email="new@example.com",
        linkedin_url=None,
        firm=None,
        message=None,
        now=frozen_now,
        sender=None,
    )
    old_id, fresh_id = old.id, fresh.id
    out = await housekeeping.purge(db, now=frozen_now)
    assert out["removal_requests"] == 1
    db.expire_all()
    assert await db.get(ResearchRemovalRequest, old_id) is None
    assert await db.get(ResearchRemovalRequest, fresh_id) is not None
    assert jobs_svc.KIND_RESEARCH_REMOVAL == "research.removal"
