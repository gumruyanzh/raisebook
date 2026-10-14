"""Investor research is unfinished and off by default (``RAISEBOOK_RESEARCH_ENABLED``).

With the flag off, nothing about it is served: no REST routes, no MCP tools, and no research
line in the MCP instructions. The public pages promise exactly 21 MCP tools (17 + the four
meeting tools).
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from raisebook.config import reset_settings_cache

CORE_TOOLS = {
    "get_workspace",
    "list_rounds",
    "get_round_summary",
    "create_round",
    "search_investors",
    "get_investor",
    "add_investor",
    "add_investors",
    "update_investor",
    "add_to_round",
    "move_stage",
    "log_activity",
    "set_follow_up",
    "record_commitment",
    "list_due_follow_ups",
    "import_investors_csv",
    "export_round",
    "schedule_meeting",
    "list_meetings",
    "update_meeting",
    "complete_meeting",
}
RESEARCH_TOOLS = {
    "get_dossier",
    "list_research_runs",
    "research_investor",
    "match_identity",
    "save_dossier",
}


@pytest.fixture
def research_off(monkeypatch: Any) -> Iterator[None]:
    monkeypatch.setenv("RAISEBOOK_RESEARCH_ENABLED", "false")
    reset_settings_cache()
    yield
    monkeypatch.undo()
    reset_settings_cache()


async def _tool_names() -> set[str]:
    from raisebook.mcp.server import create_mcp_server

    server = create_mcp_server()
    return {t.name for t in await server.list_tools()}


async def test_research_off_serves_21_core_tools(research_off: None) -> None:
    from raisebook.mcp.server import create_mcp_server

    names = await _tool_names()
    assert names == CORE_TOOLS
    assert not names & RESEARCH_TOOLS
    instructions = create_mcp_server().instructions or ""
    for word in ("research", "dossier", "OpenRouter"):
        assert word not in instructions


async def test_research_off_has_no_research_routes(research_off: None) -> None:
    from raisebook.main import create_app

    paths = set(create_app().openapi()["paths"])
    assert paths, "openapi lists the core routes"
    leaked = [
        p
        for p in paths
        if any(w in p for w in ("research", "dossier", "ai-settings", "company-profile"))
        or "identit" in p
        or "suggestion" in p
    ]
    assert leaked == []


async def test_research_on_adds_the_five_tools() -> None:
    names = await _tool_names()
    assert RESEARCH_TOOLS <= names
    assert names - RESEARCH_TOOLS == CORE_TOOLS


async def test_research_off_leaves_no_trace_in_openapi_or_bodies(
    research_off: None, db: Any, key_client: Any
) -> None:
    """The public OpenAPI document, investor bodies and the JSON export say nothing about
    research while the flag is off."""
    import json

    from raisebook.main import create_app
    from tests.api.helpers import world

    spec = json.dumps(create_app().openapi()).lower()
    for word in ("dossier", "research-plan", "researchsummary", "openrouter"):
        assert word not in spec, word

    w = await world(db)
    c = key_client(w.key)
    r = await c.post("/v1/investors", json={"name": "Mira Cole", "firm": "Tallow Ventures"})
    assert r.status_code == 201, r.text
    inv = r.json()["investor"]
    assert "research" not in inv
    got = await c.get(f"/v1/investors/{inv['id']}")
    assert got.status_code == 200 and "research" not in got.json()
    export = await c.get("/v1/export?format=json")
    assert export.status_code == 200 and "research" not in export.json()
