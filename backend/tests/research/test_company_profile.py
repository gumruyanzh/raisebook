"""The company profile (R6; RESEARCH-PLAN §6.2). Fictional company data only."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import add_member, make_api_key, make_workspace, owner_of

PROFILE = {
    "pitch": "Kestrel builds   pick-and-place robots for small warehouses.",
    "sectors": ["Robotics", "Logistics", "robotics", "  "],
    "stage": "seed",
    "location": "Oakland, CA",
    "traction": ["12 paying pilots", "$40k MRR", "2 OEM partnerships"],
    "wants_lead": "lead",
    "check_min": 250_000,
    "check_max": 1_000_000,
    "strategic_help": "Intros to 3PL operators.",
    "website_url": "kestrel-robotics.example.com",
}


async def test_empty_profile_reads_as_empty(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db, currency="EUR")
    c = await session_client(await owner_of(db, ws), ws)
    r = await c.get("/v1/workspace/company-profile")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["is_empty"] is True and body["currency"] == "EUR"
    assert body["sectors"] == [] and body["traction"] == [] and body["pitch"] is None


async def test_put_cleans_and_replaces(
    db: AsyncSession, session_client: Any, frozen_now: Any
) -> None:
    ws = await make_workspace(db)
    c = await session_client(await owner_of(db, ws), ws)
    r = await c.put("/v1/workspace/company-profile", json=PROFILE)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pitch"] == "Kestrel builds pick-and-place robots for small warehouses."
    assert body["sectors"] == ["Robotics", "Logistics"]  # trimmed, deduped, blanks dropped
    assert body["website_url"] == "https://kestrel-robotics.example.com"
    assert body["is_empty"] is False and body["updated_at"] == "2026-10-12T17:00:00Z"
    assert (await c.get("/v1/workspace/company-profile")).json() == body
    # PUT is a full replace: omitted fields are cleared.
    r = await c.put("/v1/workspace/company-profile", json={"pitch": "Just a pitch"})
    assert r.json()["sectors"] == [] and r.json()["check_min"] is None
    r = await c.put("/v1/workspace/company-profile", json={})
    assert r.json()["is_empty"] is True


async def test_put_validation(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    c = await session_client(await owner_of(db, ws), ws)
    bad_bodies: list[dict[str, Any]] = [
        {"pitch": "x" * 201},
        {"traction": ["a", "b", "c", "d"]},
        {"traction": ["x" * 201]},
        {"sectors": [f"s{i}" for i in range(11)]},
        {"check_min": 500, "check_max": 100},
        {"check_min": -1},
        {"stage": "series-z"},
        {"wants_lead": "maybe"},
        {"website_url": "javascript:alert(1)"},
        {"website_url": "not a url"},
        {"strategic_help": "x" * 501},
        {"unknown_field": 1},
    ]
    for body in bad_bodies:
        r = await c.put("/v1/workspace/company-profile", json=body)
        assert r.status_code == 422, (body, r.text)
        assert r.json()["error"]["code"] == "validation_error"


async def test_permissions(db: AsyncSession, session_client: Any, key_client: Any) -> None:
    ws = await make_workspace(db)
    viewer = await add_member(db, ws, role="viewer")
    editor = await add_member(db, ws, role="editor")
    _, read_key = await make_api_key(db, ws, scopes="read")
    _, write_key = await make_api_key(db, ws, scopes="read,write")
    cv = await session_client(viewer, ws)
    assert (await cv.get("/v1/workspace/company-profile")).status_code == 200
    r = await cv.put("/v1/workspace/company-profile", json={"pitch": "x"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden_role"
    r = await key_client(read_key).put("/v1/workspace/company-profile", json={"pitch": "x"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "insufficient_scope"
    ce = await session_client(editor, ws)
    assert (await ce.put("/v1/workspace/company-profile", json=PROFILE)).status_code == 200
    r = await key_client(write_key).put("/v1/workspace/company-profile", json={"pitch": "Agent"})
    assert r.status_code == 200 and r.json()["pitch"] == "Agent"


async def test_workspace_export_includes_profile_and_settings_without_key(
    db: AsyncSession, session_client: Any, openrouter_mock: Any
) -> None:
    from tests.research.openrouter_mock import FAKE_KEY

    ws = await make_workspace(db)
    c = await session_client(await owner_of(db, ws), ws)
    assert (await c.put("/v1/workspace/company-profile", json=PROFILE)).status_code == 200
    assert (await c.put("/v1/workspace/ai-settings/key", json={"key": FAKE_KEY})).status_code == 200
    r = await c.get("/v1/export", params={"format": "json"})
    assert r.status_code == 200, r.text
    doc = json.loads(r.content)
    research = doc["research"]
    assert research["company_profile"]["pitch"].startswith("Kestrel builds")
    assert research["company_profile"]["traction"] == PROFILE["traction"]
    assert research["ai_settings"] == {
        "preset": "best",
        "identity_model": "perplexity/sonar",
        "search_model": "perplexity/sonar-pro",
        "writer_model": "anthropic/claude-opus-5.5",
        "monthly_cap_usd": 25.0,
        "use_notes_in_research": False,
    }
    raw = r.text
    assert FAKE_KEY not in raw and FAKE_KEY[-4:] not in raw and "key_" not in raw
