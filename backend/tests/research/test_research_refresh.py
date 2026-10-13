"""Refresh and freshness (RESEARCH-PLAN §4.8; R10): "New since <date>", stale after 90 days,
and the Meeting-stage refresh offer after 30 days. Frozen clock, mocked OpenRouter."""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core import clock
from raisebook.models.round import RoundParticipant
from raisebook.services.dossiers import fact_ids, is_stale, meeting_refresh_offer
from tests.factories import stages_of
from tests.research.helpers import research_world, run_jobs
from tests.research.pipeline_mock import LINKEDIN, SITE, Script, page


def test_diff_keys_match_rewordings_of_the_same_page() -> None:
    a = {"section": "activity", "kind": "deal", "text": "Led the seed in Brightquay."}
    b = {"section": "activity", "kind": "deal", "text": "Led Brightquay's $3M seed round."}
    assert fact_ids(a, "u1")[0] != fact_ids(b, "u1")[0]
    assert fact_ids(a, "u1")[1] == fact_ids(b, "u1")[1]  # same kind + page: the same fact
    assert fact_ids(a, "u1")[1] != fact_ids(a, "u2")[1]


def test_freshness_rules() -> None:
    now = clock.get_now()
    assert not is_stale(now - timedelta(days=90), now)
    assert is_stale(now - timedelta(days=91), now)
    assert meeting_refresh_offer("meeting", now - timedelta(days=31), now)
    assert not meeting_refresh_offer("meeting", now - timedelta(days=30), now)
    assert not meeting_refresh_offer("intro", now - timedelta(days=60), now)
    assert not meeting_refresh_offer("meeting", None, now)


async def test_refresh_marks_what_is_new(
    db: AsyncSession, key_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, linkedin_url=LINKEDIN, website_url=SITE)
    script = Script().install(openrouter_mock)
    c = key_client(w.key)  # an API key outlives the frozen clock's jumps (sessions expire)
    await c.post(f"/v1/investors/{w.inv.id}/research", json={})
    await run_jobs(db)
    first = (await c.get(f"/v1/investors/{w.inv.id}/dossier")).json()
    assert first["new_since"] is None and first["dossier"]["new_fact_keys"] == []

    # 40 days later the investor is in a Meeting stage: the refresh is offered, never run.
    clock.freeze(frozen_now + timedelta(days=40))
    stages = await stages_of(db, w.rnd)
    part = await db.scalar(select(RoundParticipant).where(RoundParticipant.investor_id == w.inv.id))
    assert part is not None
    part.stage_id = stages["meeting"].id
    await db.flush()
    view = (await c.get(f"/v1/investors/{w.inv.id}/dossier")).json()
    assert view["refresh_offer"] is True and view["stale"] is False and view["age_days"] == 40
    row = (await c.get("/v1/rounds/seed/research")).json()["data"][0]
    assert row["refresh_offer"] is True and row["verdict"] == "strong"
    assert len(script.calls) == 4  # nothing ran on its own

    script.extra_pages = {
        "activity": [
            page(
                f"{SITE}/news/stonepine-a",
                "Harbor Light leads Stonepine's Series A",
                "Dana Whitfield joins the Stonepine board.",
                "2026-11-05",
            )
        ]
    }
    script.extra_facts = [
        {
            "key": "f9",
            "section": "activity",
            "kind": "deal",
            "text": "Led Stonepine's Series A in November.",
            "date": "2026-11-05",
            "source_ids": [],
        },
    ]
    r = await c.post(f"/v1/investors/{w.inv.id}/research", json={"kind": "refresh"})
    assert r.status_code == 202 and r.json()["run"]["kind"] == "refresh"

    # The writer cites the new page by its id in the prompt.
    def cite_new(step: str) -> None:
        if step == "write":
            body = script.requests[-1]["messages"][1]["content"]
            sid = next(
                m.group(1)
                for m in re.finditer(r'<source id="(s\d+)" url="([^"]+)"', body)
                if "stonepine-a" in m.group(2)
            )
            script.extra_facts[0]["source_ids"] = [sid]

    script.on_call = cite_new
    await run_jobs(db)
    searches = [b for b in script.requests[4:] if "web_search_options" in b]
    assert all("Only material published after" in b["messages"][1]["content"] for b in searches)
    view = (await c.get(f"/v1/investors/{w.inv.id}/dossier")).json()
    assert view["dossier"]["version"] == 2
    assert view["new_since"] is not None
    assert view["dossier"]["new_fact_keys"] == ["f9"]
    assert "Earlier facts:" in script.requests[-1]["messages"][1]["content"]
    # 100 days after the refresh it may be stale.
    clock.freeze(frozen_now + timedelta(days=141))
    view = (await c.get(f"/v1/investors/{w.inv.id}/dossier")).json()
    assert view["stale"] is True
    inv = (await c.get(f"/v1/investors/{w.inv.id}")).json()
    assert inv["research"]["stale"] is True
