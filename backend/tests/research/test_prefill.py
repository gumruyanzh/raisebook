"""Company profile prefill from a website and/or deck (RESEARCH-PLAN §4.4 item 4, §6.2; R6)."""

from __future__ import annotations

import base64
import json
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.ai import CompanyProfile
from raisebook.models.research import ResearchUpload
from tests.research.helpers import ledger, research_world, run_jobs
from tests.research.pipeline_mock import COST, Script

PDF = b"%PDF-1.7\n% fictional deck for Kestrel Robotics\n%%EOF\n"


async def test_prefill_drafts_without_saving(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, profile=False)
    script = Script().install(openrouter_mock)
    c = await session_client(w.editor, w.ws)
    r = await c.post(
        "/v1/workspace/company-profile/prefill",
        data={"website_url": "kestrel.example"},
        files={"deck": ("Kestrel deck.pdf", PDF, "application/pdf")},
    )
    assert r.status_code == 202, r.text
    run_id = r.json()["run"]["id"]
    assert r.json()["run"]["kind"] == "prefill"
    assert await db.scalar(select(func.count()).select_from(ResearchUpload)) == 1
    assert await run_jobs(db) == ["succeeded"]
    body = script.requests[0]
    parts = body["messages"][1]["content"]
    file_part = next(p for p in parts if p["type"] == "file")
    assert file_part["file"]["filename"] == "Kestrel deck.pdf"
    assert (
        file_part["file"]["file_data"]
        == "data:application/pdf;base64," + base64.b64encode(PDF).decode()
    )
    assert body["plugins"] == [
        {"id": "web", "max_results": 5, "include_domains": ["kestrel.example"]}
    ]
    assert body["response_format"]["json_schema"]["name"] == "raisebook_company_profile_v1"
    run = (await c.get(f"/v1/research/runs/{run_id}")).json()
    assert run["status"] == "succeeded"
    assert run["result"]["draft"]["pitch"].startswith("Kestrel builds")
    assert run["result"]["deck_filename"] == "Kestrel deck.pdf"
    assert run["cost_usd"] == COST["prefill"]
    # The deck is gone and nothing was saved: the founder reviews, then PUTs.
    assert await db.scalar(select(func.count()).select_from(ResearchUpload)) == 0
    assert (
        await db.scalar(select(CompanyProfile).where(CompanyProfile.workspace_id == w.ws.id))
        is None
    )
    assert (await ledger(db, w.ws))[0] == 20_000
    assert json.dumps(run).find("JVBER") == -1  # the PDF never comes back in a response


async def test_prefill_validation(
    db: AsyncSession, session_client: Any, openrouter_mock: Any, frozen_now: Any
) -> None:
    w = await research_world(db, profile=False)
    c = await session_client(w.owner, w.ws)
    r = await c.post(
        "/v1/workspace/company-profile/prefill",
        files={"deck": ("deck.pdf", b"PK\x03\x04 not a pdf", "application/pdf")},
    )
    assert r.status_code == 422 and r.json()["error"]["details"] is not None
    r = await c.post("/v1/workspace/company-profile/prefill", data={})
    assert r.status_code == 422
    big = PDF + b"0" * (10 * 1024 * 1024)
    r = await c.post(
        "/v1/workspace/company-profile/prefill",
        files={"deck": ("deck.pdf", big, "application/pdf")},
    )
    assert r.status_code == 413
    v = await session_client(w.viewer, w.ws)
    r = await v.post("/v1/workspace/company-profile/prefill", data={"website_url": "a.example"})
    assert r.status_code == 403
