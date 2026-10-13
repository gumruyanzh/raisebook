"""MCP ``import_investors_csv`` and ``export_round`` over the real ``/mcp`` route."""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.mcp.tools import data as data_tools
from raisebook.models.activity import Activity
from raisebook.models.imports import ImportRun
from raisebook.models.investor import Investor
from tests.factories import (
    make_api_key,
    make_investor,
    make_participant,
    make_round,
    make_workspace,
)

CSV = (
    "Name,Firm,Email,Pipeline stage,Fit\n"
    "Dana Whitfield,Harbor Light Ventures,dana@example.com,Meeting,hot\n"
    "Marcus Odell,Juniper Angels,marcus@example.com,Contacted,4\n"
    ",No Name Fund,,,\n"
)
AGENT = {"X-Agent-Name": "claude-code", "X-Agent-Model": "claude-opus-4-5"}


async def n_investors(db: AsyncSession, ws: Any) -> int:
    return int(
        await db.scalar(
            select(func.count()).select_from(Investor).where(Investor.workspace_id == ws.id)
        )
        or 0
    )


async def test_tools_are_listed_with_annotations(db: AsyncSession, mcp_rpc: Any) -> None:
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws, scopes="read,write")
    r = await mcp_rpc(raw, "tools/list")
    tools = {t["name"]: t for t in r.json()["result"]["tools"]}
    imp, exp = tools["import_investors_csv"], tools["export_round"]
    assert imp["annotations"]["readOnlyHint"] is False
    assert imp["annotations"]["idempotentHint"] is False
    assert imp["annotations"]["destructiveHint"] is False
    assert exp["annotations"]["readOnlyHint"] is True
    assert imp["description"].startswith("Import investors from CSV text")
    assert exp["description"].startswith("Export a round's pipeline")
    props = imp["inputSchema"]["properties"]
    assert set(props) == {
        "csv",
        "round",
        "mapping",
        "default_stage",
        "on_duplicate",
        "source",
        "dry_run",
    }
    assert props["dry_run"]["default"] is True
    assert imp["inputSchema"]["required"] == ["csv"]


async def test_import_dry_run_then_commit(db: AsyncSession, mcp_call: Any, frozen_now: Any) -> None:
    ws = await make_workspace(db)
    await make_round(db, ws, name="Seed")
    _, raw = await make_api_key(db, ws, scopes="read,write", agent_name="research-bot")
    r = await mcp_call(raw, "import_investors_csv", {"csv": CSV, "round": "Seed"}, AGENT)
    assert r.ok, r.text
    assert r.data["dry_run"] is True
    assert r.data["counts"] == {
        "create": 2,
        "update": 0,
        "skip": 0,
        "error": 1,
        "add_to_round": 2,
        "cells_left_empty": 0,
    }
    assert "dry_run=false" in r.data["next"]
    assert await n_investors(db, ws) == 0
    assert await db.scalar(select(func.count()).select_from(ImportRun)) == 0

    r = await mcp_call(
        raw, "import_investors_csv", {"csv": CSV, "round": "Seed", "dry_run": False}, AGENT
    )
    assert r.ok, r.text
    assert r.data["dry_run"] is False
    assert r.data["counts"]["created"] == 2 and r.data["counts"]["errors"] == 1
    assert await n_investors(db, ws) == 2
    acts = list(await db.scalars(select(Activity).where(Activity.workspace_id == ws.id)))
    assert acts
    for a in acts:
        assert a.actor_type == "agent" and a.via == "import"
        assert a.actor_label == "claude-code" and a.agent_model == "claude-opus-4-5"
    run = await db.scalar(select(ImportRun).where(ImportRun.workspace_id == ws.id))
    assert run is not None and run.actor_type == "agent" and run.actor_label == "claude-code"

    # Repeating the import is safe: everything is skipped.
    r = await mcp_call(raw, "import_investors_csv", {"csv": CSV, "round": "Seed"})
    assert r.data["counts"]["skip"] == 2 and r.data["counts"]["create"] == 0


async def test_import_needs_write_scope(db: AsyncSession, mcp_call: Any, frozen_now: Any) -> None:
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws, scopes="read")
    r = await mcp_call(raw, "import_investors_csv", {"csv": CSV})
    assert not r.ok and r.code == "insufficient_scope"


async def test_import_errors(
    db: AsyncSession, mcp_call: Any, monkeypatch: Any, frozen_now: Any
) -> None:
    ws = await make_workspace(db)
    other = await make_workspace(db)
    await make_round(db, other, name="Theirs")
    _, raw = await make_api_key(db, ws, scopes="read,write")
    r = await mcp_call(raw, "import_investors_csv", {"csv": CSV, "round": "Theirs"})
    assert not r.ok and r.code == "not_found"
    r = await mcp_call(raw, "import_investors_csv", {"csv": CSV, "mapping": {"Nope": "name"}})
    assert not r.ok and r.code == "import_invalid"
    monkeypatch.setattr(data_tools, "MAX_CSV_BYTES", 10)
    r = await mcp_call(raw, "import_investors_csv", {"csv": CSV})
    assert not r.ok and r.code == "payload_too_large"


async def test_export_round(db: AsyncSession, mcp_call: Any, frozen_now: Any) -> None:
    ws = await make_workspace(db)
    seed = await make_round(db, ws, name="Seed")
    dana = await make_investor(db, ws, name="Dana Whitfield", email="dana@example.com")
    await make_participant(db, seed, dana, stage="committed", fit=5, amount_committed=250_000)
    _, raw = await make_api_key(db, ws, scopes="read")

    r = await mcp_call(raw, "export_round", {})  # the single open round
    assert r.ok, r.text
    assert r.data["round"] == {"slug": "seed", "name": "Seed"}
    assert r.data["format"] == "json" and r.data["row_count"] == 1
    assert '"raisebook.round"' in r.data["content"]

    r = await mcp_call(raw, "export_round", {"round": "seed", "format": "csv"})
    assert r.ok and r.data["filename"].endswith(".csv")
    assert r.data["content"].startswith("investor_id,name,")
    assert "250000" in r.data["content"]

    r = await mcp_call(raw, "export_round", {"include_activities": True})
    assert r.ok and '"timeline"' in r.data["content"]


async def test_export_round_errors(
    db: AsyncSession, mcp_call: Any, monkeypatch: Any, frozen_now: Any
) -> None:
    ws = await make_workspace(db)
    await make_round(db, ws, name="Seed")
    await make_round(db, ws, name="Bridge")
    other = await make_workspace(db)
    theirs = await make_round(db, other, name="Theirs")
    _, raw = await make_api_key(db, ws, scopes="read")
    their_id = str(theirs.id)  # tool errors roll back the shared test session

    r = await mcp_call(raw, "export_round", {})
    assert not r.ok and r.code == "round_required"
    for ref in (their_id, "theirs"):
        r = await mcp_call(raw, "export_round", {"round": ref})
        assert not r.ok and r.code == "not_found", ref

    monkeypatch.setattr(data_tools, "MAX_INLINE_EXPORT", 10)
    r = await mcp_call(raw, "export_round", {"round": "seed", "format": "csv"})
    assert not r.ok and r.code == "payload_too_large"
    assert "/v1/rounds/seed/export?format=csv" in r.message


async def test_import_reports_left_empty_cells_like_rest(
    db: AsyncSession, mcp_call: Any, key_client: Any, frozen_now: Any
) -> None:
    """P0-6 over MCP: the same rows import, with the same counts and warning kinds as REST."""
    from tests.services.test_imports import MESSY

    ws = await make_workspace(db)
    await make_round(db, ws, name="Seed")
    _, raw = await make_api_key(db, ws, scopes="read,write", agent_name="research-bot")
    r = await mcp_call(raw, "import_investors_csv", {"csv": MESSY, "round": "Seed"}, AGENT)
    assert r.ok, r.text
    rest = await key_client(raw).post(
        "/v1/imports/preview", json={"content": MESSY, "round": "Seed"}
    )
    assert rest.status_code == 200, rest.text
    assert r.data["counts"] == rest.json()["counts"]
    assert r.data["warning_kinds"] == rest.json()["warning_kinds"]
    assert r.data["counts"]["error"] == 1 and r.data["counts"]["cells_left_empty"] == 6
    flagged = {row["row"] for row in r.data["rows"] if row.get("warnings")}
    assert flagged == {2, 3, 4}
