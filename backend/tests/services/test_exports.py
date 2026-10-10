"""Exports (SPEC §8.3): round CSV/JSON, investors CSV, workspace JSON, formula guard."""

from __future__ import annotations

import json
from datetime import date
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core.actor import Actor
from raisebook.models.enums import ActorType, Via
from raisebook.services import csv_io, exports
from tests.factories import (
    add_member,
    make_activity,
    make_api_key,
    make_investor,
    make_participant,
    make_round,
    make_workspace,
    owner_of,
)
from tests.services.test_imports import ctx_for


async def seeded(db: AsyncSession) -> dict[str, Any]:
    ws = await make_workspace(db, name="Kestrel Robotics")
    owner = await owner_of(db, ws)
    ctx = ctx_for(ws, owner)
    seed = await make_round(db, ws, name="Seed", target_amount=2_000_000)
    pre = await make_round(db, ws, name="Pre-seed", status="closed")
    dana = await make_investor(
        db, ws, name="Dana Whitfield", email="dana@example.com", tags=["lead", "hardware"]
    )
    marcus = await make_investor(db, ws, name="Marcus Odell", firm=None, email=None)
    await make_participant(
        db, seed, dana, stage="committed", fit=5, amount_committed=750_000, owner_user_id=owner.id
    )
    await make_participant(
        db,
        seed,
        marcus,
        stage="meeting",
        fit=3,
        amount_soft=100_000,
        follow_up_on=date(2026, 10, 14),
    )
    await make_participant(db, pre, dana, stage="passed", fit=2)
    agent = Actor(ActorType.AGENT, Via.MCP, label="claude-code", model="claude-opus-4-5")
    await make_activity(db, dana, rnd=seed, kind="call", actor=agent, body="Discussed terms.")
    await make_api_key(db, ws, name="secret key")
    return {
        "ws": ws,
        "owner": owner,
        "ctx": ctx,
        "seed": seed,
        "pre": pre,
        "dana": dana,
        "marcus": marcus,
    }


async def test_round_csv(db: AsyncSession, frozen_now: Any) -> None:
    s = await seeded(db)
    f = await exports.export_round(db, s["ctx"], s["seed"], fmt="csv", now=frozen_now)
    assert f.filename == f"raisebook-{s['ws'].slug}-seed-20261012.csv"
    assert f.media_type.startswith("text/csv") and f.row_count == 2
    parsed = csv_io.parse_csv(f.content)
    assert tuple(parsed.columns) == exports.ROUND_CSV_COLUMNS
    rows = [dict(zip(parsed.columns, r, strict=True)) for r in parsed.rows]
    # Ordered by stage position: meeting before committed.
    assert [r["name"] for r in rows] == ["Marcus Odell", "Dana Whitfield"]
    dana = rows[1]
    assert dana["stage"] == "committed" and dana["stage_label"] == "Committed"
    assert dana["fit"] == "5" and dana["priority"] == "hot"
    assert dana["amount_committed"] == "750000"
    assert dana["tags"] == "lead; hardware"
    assert dana["owner_email"] == s["owner"].email
    assert dana["last_activity_at"] == ""
    assert rows[0]["follow_up_on"] == "2026-10-14" and rows[0]["priority"] == "maybe"


async def test_round_json_with_activities(db: AsyncSession, frozen_now: Any) -> None:
    s = await seeded(db)
    f = await exports.export_round(
        db, s["ctx"], s["seed"], fmt="json", now=frozen_now, include_activities=True
    )
    doc = json.loads(f.content)
    assert doc["format"] == "raisebook.round" and doc["version"] == 1
    assert doc["round"]["committed_amount"] == 750_000
    assert doc["round"]["participant_count"] == 2
    assert [st["key"] for st in doc["round"]["stages"]][:2] == ["new", "research"]
    dana = next(p for p in doc["participants"] if p["investor"]["name"] == "Dana Whitfield")
    assert dana["stage"]["key"] == "committed"
    (call,) = [a for a in dana["timeline"] if a["kind"] == "call"]
    assert call["actor"] == {
        "type": "agent",
        "label": "claude-code",
        "via": "mcp",
        "agent_model": "claude-opus-4-5",
    }
    plain = json.loads(
        (await exports.export_round(db, s["ctx"], s["seed"], fmt="json", now=frozen_now)).content
    )
    assert "timeline" not in plain["participants"][0]


async def test_investors_csv(db: AsyncSession, frozen_now: Any) -> None:
    s = await seeded(db)
    f = await exports.export_investors_csv(db, s["ctx"], now=frozen_now)
    parsed = csv_io.parse_csv(f.content)
    rows = {r[1]: dict(zip(parsed.columns, r, strict=True)) for r in parsed.rows}
    assert set(rows) == {"Dana Whitfield", "Marcus Odell"}
    assert rows["Dana Whitfield"]["rounds"] in (
        "Seed: Committed; Pre-seed: Passed",
        "Pre-seed: Passed; Seed: Committed",
    )
    only = await exports.export_investors_csv(db, s["ctx"], now=frozen_now, ids=[s["marcus"].id])
    assert only.row_count == 1


async def test_workspace_json_has_everything_but_secrets(db: AsyncSession, frozen_now: Any) -> None:
    s = await seeded(db)
    await add_member(db, s["ws"], role="viewer")
    other = await make_workspace(db)
    await make_investor(db, other, name="Not Mine", email="notmine@example.com")
    f = await exports.export_workspace_json(db, s["ctx"], now=frozen_now)
    doc = json.loads(f.content)
    assert doc["format"] == "raisebook.export" and doc["version"] == 1
    assert doc["workspace"]["id"] == str(s["ws"].id)
    assert {r["name"] for r in doc["rounds"]} == {"Seed", "Pre-seed"}
    assert {i["name"] for i in doc["investors"]} == {"Dana Whitfield", "Marcus Odell"}
    assert len(doc["participants"]) == 3
    assert {p["stage_key"] for p in doc["participants"]} == {"committed", "meeting", "passed"}
    assert len(doc["members"]) == 2
    assert any(a["kind"] == "call" for a in doc["activities"])
    text = f.content
    for secret in ("rb_live_", "rb_test_", "key_hash", "token", "secret key", "notmine"):
        assert secret not in text


async def test_csv_formula_guard(db: AsyncSession, frozen_now: Any) -> None:
    s = await seeded(db)
    evil = await make_investor(
        db, s["ws"], name='=HYPERLINK("http://example.com")', email=None, title="+1 555"
    )
    await make_participant(db, s["seed"], evil, stage="new", next_step="@call them")
    f = await exports.export_round(db, s["ctx"], s["seed"], fmt="csv", now=frozen_now)
    parsed = csv_io.parse_csv(f.content)
    row = next(
        dict(zip(parsed.columns, r, strict=True)) for r in parsed.rows if "HYPERLINK" in r[1]
    )
    assert row["name"].startswith("'=")
    assert row["title"] == "'+1 555"
    assert row["next_step"] == "'@call them"
