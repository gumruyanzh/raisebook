"""Agent UX review fixes: no silent data loss on dedupe, name-only matching, round
creation and defaulting, compact results, readable validation errors."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from raisebook import __version__
from tests.api.helpers import world
from tests.factories import make_investor, make_participant, make_round, make_workspace


async def test_matched_add_keeps_notes_and_reports_skipped_fields(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db)
    await make_investor(db, w.ws, name="Jonas Feld", firm="Ridgeline", email="jonas@example.com")
    res = await mcp_call(
        w.key,
        "add_investor",
        {
            "name": "Jonas Feld",
            "firm": "Ridgeline",
            "notes": "Said he'd intro us to the Ridgeline partners.",
            "email": "jonas.f@example.com",
        },
    )
    assert res.ok, res.text
    d = res.data
    assert d["created"] is False and d["matched_on"] == "name_firm"
    assert "Ridgeline partners" in d["investor"]["notes"]  # default fill_empty appends notes
    assert d["not_applied"] == ["email"] and "update_investor" in d["hint"]
    # return_existing changes nothing but says what was dropped.
    res = await mcp_call(
        w.key,
        "add_investor",
        {
            "name": "Jonas Feld",
            "firm": "Ridgeline",
            "title": "Partner",
            "on_duplicate": "return_existing",
        },
    )
    assert res.data["not_applied"] == ["title"] and "fill_empty" in res.data["hint"]
    assert "title" not in res.data["investor"]


async def test_name_only_add_matches_the_one_person(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db)
    jonas = await make_investor(db, w.ws, name="Jonas Feld", firm="Ridgeline")
    res = await mcp_call(w.key, "add_investor", {"name": "jonas feld", "location": "Berlin"})
    assert res.ok, res.text
    assert res.data["matched_on"] == "name" and res.data["investor"]["id"] == str(jonas.id)
    assert res.data["filled_fields"] == ["location"]
    # A firmless contact is matched when the firm becomes known, and the firm is filled.
    solo = await make_investor(db, w.ws, name="Mara Quist", firm=None)
    res = await mcp_call(w.key, "add_investor", {"name": "Mara Quist", "firm": "Lumen Fund"})
    assert res.data["investor"]["id"] == str(solo.id)
    assert res.data["investor"]["firm"] == "Lumen Fund"


async def test_name_only_add_with_several_matches_asks(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db)
    await make_investor(db, w.ws, name="Sam Okafor", firm="Kelpline Ventures")
    await make_investor(db, w.ws, name="Sam Okafor", firm="Brightquay Capital")
    res = await mcp_call(w.key, "add_investor", {"name": "Sam Okafor"})
    assert not res.ok and res.code == "ambiguous_reference"
    assert "Kelpline" in res.text and "Brightquay" in res.text
    res = await mcp_call(
        w.key, "add_investor", {"name": "Sam Okafor", "on_duplicate": "create_anyway"}
    )
    assert res.ok and res.data["created"] is True


async def test_add_investor_with_follow_up_in_one_call(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db)
    res = await mcp_call(
        w.key,
        "add_investor",
        {
            "name": "Priya Raman",
            "firm": "Tidewater Capital",
            "type": "Family Office",
            "stage": "contacted",
            "fit": 4,
            "follow_up_on": "2026-10-16",
            "follow_up_note": "Send the deck",
            "next_step": "Deck",
            "amount_soft": "250k",
        },
    )
    assert res.ok, res.text
    d = res.data
    p = d["participant"]
    assert p["stage"] == {"key": "contacted", "label": "Contacted"}
    assert p["follow_up_on"] == "2026-10-16" and p["follow_up_note"] == "Send the deck"
    assert p["amount_soft"] == 250_000 and p["next_step"] == "Deck"
    assert "investor" not in p and "rounds" not in d["investor"]
    assert d["investor"]["type"] == "family_office" and d["round"] == "seed"
    for noise in ("color", "position", "created_at", "updated_at", "stage_changed_at"):
        assert noise not in p and noise not in p["stage"]


async def test_past_follow_up_is_flagged(db: AsyncSession, mcp_call: Any, frozen_now: Any) -> None:
    w = await world(db)
    inv = await make_investor(db, w.ws, name="Dana Whitfield")
    await make_participant(db, w.rnd, inv)
    res = await mcp_call(w.key, "set_follow_up", {"investor": "Dana Whitfield", "on": "2025-10-16"})
    assert res.ok and "before today" in res.data["warning"]
    res = await mcp_call(w.key, "set_follow_up", {"investor": "Dana Whitfield", "on": "2026-10-16"})
    assert "warning" not in res.data


async def test_add_investors_batch(db: AsyncSession, mcp_call: Any, frozen_now: Any) -> None:
    w = await world(db)
    await make_investor(db, w.ws, name="Dana Whitfield", email="dana@example.com")
    items = [
        {"name": "Dana Whitfield", "email": "dana@example.com", "stage": "meeting"},
        {"name": "Tomas Pell", "firm": "Kelpline", "fit": 5, "follow_up_on": "2026-10-14"},
        {"name": "Bad Stage", "stage": "nowhere"},
    ]
    res = await mcp_call(w.key, "add_investors", {"items": items, "round": "seed"})
    assert res.ok, res.text
    r = res.data["results"]
    assert r[0]["created"] is False and r[0]["matched_on"] == "email" and r[0]["stage"] == "meeting"
    assert r[1]["created"] is True and r[1]["stage"] == "new"
    assert r[2]["error"].startswith("stage_not_found")
    assert res.data["counts"] == {"created": 1, "existing": 1, "errors": 1}
    s = await mcp_call(w.key, "search_investors", {"query": "Bad Stage"})
    assert s.data.get("results", []) == []  # the failed item left nothing behind


async def test_create_round_and_hints_without_rest_paths(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    from tests.factories import make_api_key

    ws = await make_workspace(db)
    _, key = await make_api_key(db, ws, scopes="read,write")
    res = await mcp_call(key, "add_investor", {"name": "Ada", "stage": "new"})
    assert not res.ok and res.code == "round_required"
    assert "create_round" in res.text and "/v1/" not in res.text
    res = await mcp_call(key, "create_round", {"name": "Seed", "target_amount": "2M"})
    assert res.ok, res.text
    assert res.data["created"] is True and res.data["round"]["target_amount"] == 2_000_000
    assert [s["key"] for s in res.data["round"]["stages"]][:2] == ["new", "research"]
    again = await mcp_call(key, "create_round", {"name": "seed"})
    assert again.data["created"] is False and again.data["round"]["id"] == res.data["round"]["id"]
    res = await mcp_call(key, "move_stage", {"investor": "Ada", "stage": "meeting"})
    assert res.code == "not_found" and "add_investor" in res.text and "/v1/" not in res.text


async def test_round_defaults_to_the_investors_only_open_round(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db)
    ext = await make_round(db, w.ws, name="Seed Extension", slug="seed-extension")
    dana = await make_investor(db, w.ws, name="Dana Whitfield")
    both = await make_investor(db, w.ws, name="Tomas Pell")
    await make_participant(db, ext, dana)
    await make_participant(db, w.rnd, both)
    await make_participant(db, ext, both)
    res = await mcp_call(w.key, "move_stage", {"investor": "Dana Whitfield", "stage": "meeting"})
    assert res.ok, res.text
    assert res.data["participant"]["round_slug"] == "seed-extension"
    res = await mcp_call(w.key, "set_follow_up", {"investor": "Tomas Pell", "in_days": 2})
    assert not res.ok and res.code == "round_required"


async def test_validation_errors_are_readable_and_values_lenient(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db)
    res = await mcp_call(w.key, "add_investor", {"name": "X", "fit": 7})
    assert not res.ok
    assert res.text.startswith("validation_error: fit must be at most 5 (got 7)"), res.text
    assert "pydantic" not in res.text
    res = await mcp_call(w.key, "add_investor", {"name": "X", "type": "astrologer"})
    assert res.code == "validation_error" and "vc" in res.text and "astrologer" in res.text
    res = await mcp_call(w.key, "add_investor", {"name": "Vera Lind", "type": "VC"})
    assert res.ok and res.data["investor"]["type"] == "vc"
    res = await mcp_call(
        w.key, "log_activity", {"investor": "Vera Lind", "kind": "Call", "body": "Intro call"}
    )
    assert res.ok, res.text
    assert (
        res.data["activity"]["by"] == "key 1 (agent via mcp)"
        or "agent via mcp" in res.data["activity"]["by"]
    )
    res = await mcp_call(w.key, "update_investor", {"investor": "Vera Lind", "set": {"oops": 1}})
    assert res.code == "validation_error" and "set.oops is not a known field" in res.text


async def test_server_info_weekday_and_compact_text(
    db: AsyncSession, mcp_rpc: Any, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db)
    r = await mcp_rpc(
        w.key,
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "t", "version": "1"},
        },
    )
    assert r.json()["result"]["serverInfo"]["version"] == __version__
    res = await mcp_call(w.key, "get_workspace")
    assert res.data["workspace"]["weekday"] == "Monday"  # 2026-10-12
    assert "\n" not in res.text and ", " not in res.text[:40]


async def test_unknown_email_suggests_by_email(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db)
    await make_investor(db, w.ws, name="Dana Whitfield", email="dana@harborlight.example.com")
    res = await mcp_call(w.reader, "get_investor", {"investor": "dana@harborlight.example"})
    assert res.code == "not_found" and "dana@harborlight.example.com" not in res.text
    assert "Dana Whitfield" in res.text
    res = await mcp_call(w.reader, "search_investors", {"query": "Whitfeld"})
    assert res.ok and res.data["suggestions"][0]["name"] == "Dana Whitfield"


async def test_import_preview_is_pruned_and_skips_are_explained(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db)
    dana = await make_investor(db, w.ws, name="Dana Whitfield", email="dana@example.com")
    await make_participant(db, w.rnd, dana, stage="contacted")
    csv = (
        "Name,Email,Stage,Fit\n"
        "Dana Whitfield,dana@example.com,Meeting,5\n"
        "Tomas Pell,tomas@example.com,New,3\n"
        "Iris Vale,iris@example.com,,\n"
    )
    res = await mcp_call(w.key, "import_investors_csv", {"csv": csv, "round": "seed"})
    assert res.ok, res.text
    rows = res.data["rows"]
    assert [r["row"] for r in rows] == [2]  # plain creates are only counted
    assert "not applied" in rows[0]["warnings"][0] and "update" in rows[0]["warnings"][0]
    assert res.data["counts"]["create"] == 2
    assert len(res.text) < 2_000
    res = await mcp_call(
        w.key, "import_investors_csv", {"csv": csv, "round": "seed", "dry_run": False}
    )
    assert res.ok, res.text
    assert sorted(c["name"] for c in res.data["created"]) == ["Iris Vale", "Tomas Pell"]
    assert {c["row"] for c in res.data["created"]} == {3, 4}


async def test_rest_add_reports_not_applied(db: AsyncSession, key_client: Any) -> None:
    w = await world(db)
    await make_investor(db, w.ws, name="Jonas Feld", firm="Ridgeline", email="jonas@example.com")
    c = key_client(w.key)
    r = await c.post(
        "/v1/investors", json={"name": "Jonas Feld", "firm": "Ridgeline", "notes": "Intro"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["matched_on"] == "name_firm" and r.json()["not_applied"] == ["notes"]
