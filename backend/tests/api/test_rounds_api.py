"""Rounds and stages over REST (SPEC §5.5, §3.3)."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from tests.api.helpers import activities_of, dana, participant, world
from tests.factories import make_investor, make_participant, make_round


async def test_create_list_get_round(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    w = await world(db)
    c = key_client(w.key)
    r = await c.post(
        "/v1/rounds",
        json={
            "name": "Series A",
            "target_amount": 8_000_000,
            "instrument": "Priced round",
            "pre_money_valuation": 30_000_000,
            "target_close_on": "2027-01-31",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["slug"] == "series-a" and body["instrument"] == "priced"
    assert body["currency"] == "USD" and body["status"] == "open"
    assert [s["key"] for s in body["stages"]] == [
        "new",
        "research",
        "contacted",
        "replied",
        "meeting",
        "dd",
        "committed",
        "passed",
    ]
    assert body["committed_amount"] == 0 and body["participant_count"] == 0

    # Same name (any case) → 409 duplicate with the existing round.
    r = await c.post("/v1/rounds", json={"name": "series a"})
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "duplicate" and err["details"]["existing"]["slug"] == "series-a"

    rows = (await c.get("/v1/rounds")).json()["data"]
    assert {x["name"] for x in rows} == {"Seed", "Series A"}
    assert (await c.get("/v1/rounds?status=closed")).json()["data"] == []
    for ref in ("series-a", body["id"], "Series A"):
        assert (await c.get(f"/v1/rounds/{ref}")).json()["id"] == body["id"]
    r = await c.get("/v1/rounds/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


async def test_round_detail_counts_and_committed(db: AsyncSession, key_client: Any) -> None:
    w = await world(db)
    a = await make_investor(db, w.ws)
    b = await make_investor(db, w.ws)
    await make_participant(db, w.rnd, a, stage="committed", amount_committed=250_000)
    await make_participant(db, w.rnd, b, stage="meeting", amount_soft=100_000)
    body = (await key_client(w.key).get("/v1/rounds/seed")).json()
    counts = {s["key"]: s["count"] for s in body["stages"]}
    assert counts["committed"] == 1 and counts["meeting"] == 1 and counts["new"] == 0
    assert body["committed_amount"] == 250_000 and body["participant_count"] == 2


async def test_update_close_reopen_rename(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await world(db)
    c = key_client(w.key)
    r = await c.patch("/v1/rounds/seed", json={"status": "closed"})
    assert r.status_code == 200 and r.json()["closed_on"] == "2026-10-12"
    r = await c.patch("/v1/rounds/seed", json={"status": "open"})
    assert r.json()["closed_on"] is None
    r = await c.patch("/v1/rounds/seed", json={"name": "Seed Extension", "valuation_cap": None})
    assert r.json()["slug"] == "seed-extension"
    r = await c.patch("/v1/rounds/seed-extension", json={"target_amount": None})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
    await make_round(db, w.ws, name="Bridge", slug="bridge")
    r = await c.patch("/v1/rounds/bridge", json={"name": "seed extension"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate"
    r = await c.patch("/v1/rounds/bridge", json={"bogus": 1})
    assert r.status_code == 422


async def test_delete_round_needs_confirmation_and_admin(
    db: AsyncSession, key_client: Any, session_client: Any
) -> None:
    w = await world(db)
    inv = await make_investor(db, w.ws)
    await make_participant(db, w.rnd, inv)
    r = await key_client(w.key).request("DELETE", "/v1/rounds/seed", json={"confirm": "Seed"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "insufficient_scope"
    c = await session_client(w.owner, w.ws)
    r = await c.request("DELETE", "/v1/rounds/seed", json={"confirm": "wrong"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "confirmation_required"
    r = await c.request("DELETE", "/v1/rounds/seed", json={"confirm": "seed"})
    assert r.status_code == 204
    assert (await c.get("/v1/rounds/seed")).status_code == 404
    assert await participant(db, w.rnd, inv) is None
    assert (await c.get(f"/v1/investors/{inv.id}")).status_code == 200  # contact stays


async def test_custom_stages_on_create(db: AsyncSession, key_client: Any) -> None:
    w = await world(db)
    stages = [
        {"label": "Target", "color": "slate", "kind": "open"},
        {"label": "Pitching", "color": "cobalt", "kind": "active"},
        {"label": "Term sheet", "color": "amber", "kind": "active"},
        {"label": "Signed", "color": "green", "kind": "won"},
        {"label": "No", "color": "gray", "kind": "lost"},
    ]
    r = await key_client(w.key).post("/v1/rounds", json={"name": "Angels", "stages": stages})
    assert r.status_code == 201, r.text
    assert [s["key"] for s in r.json()["stages"]] == [
        "target",
        "pitching",
        "term_sheet",
        "signed",
        "no",
    ]
    bad = [*stages[:3], {"label": "Signed", "color": "green", "kind": "active"}, stages[4]]
    r = await key_client(w.key).post("/v1/rounds", json={"name": "Bad", "stages": bad})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_stage_config"


async def test_replace_stages(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    w = await world(db)
    inv = await dana(db, w.ws)
    await make_participant(db, w.rnd, inv, stage="dd")
    c = key_client(w.key)
    current = (await c.get("/v1/rounds/seed")).json()["stages"]
    keep = [
        {"key": s["key"], "label": s["label"], "color": s["color"], "kind": s["kind"]}
        for s in current
        if s["key"] != "dd"
    ]
    # Relabel, recolor, add a stage, and swap the won stage to a new one.
    keep[4]["label"] = "Partner meeting"
    new_list = [
        *keep[:5],
        {"label": "Term sheet", "color": "olive", "kind": "active"},
        *keep[5:],
    ]
    r = await c.put("/v1/rounds/seed/stages", json={"stages": new_list})
    assert r.status_code == 409 and r.json()["error"]["code"] == "stage_in_use"
    assert r.json()["error"]["details"]["counts"] == {"dd": 1}
    r = await c.put(
        "/v1/rounds/seed/stages", json={"stages": new_list, "reassign": {"dd": "nowhere"}}
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_stage_config"
    r = await c.put(
        "/v1/rounds/seed/stages", json={"stages": new_list, "reassign": {"dd": "term_sheet"}}
    )
    assert r.status_code == 200, r.text
    stages = r.json()["stages"]
    assert [s["key"] for s in stages] == [
        "new",
        "research",
        "contacted",
        "replied",
        "meeting",
        "term_sheet",
        "committed",
        "passed",
    ]
    assert stages[4]["label"] == "Partner meeting"
    assert stages[5]["count"] == 1
    moves = await activities_of(db, inv, "stage_change")
    assert moves[-1].data == {
        "from": {"key": "dd", "label": "Diligence"},
        "to": {"key": "term_sheet", "label": "Term sheet"},
        "reason": "stage_removed",
    }
    # Swap kinds: the won stage becomes "passed" and vice versa (unique indexes hold).
    swapped = [
        {"key": s["key"], "label": s["label"], "color": s["color"], "kind": s["kind"]}
        for s in stages
    ]
    swapped[6]["kind"], swapped[7]["kind"] = "lost", "won"
    r = await c.put("/v1/rounds/seed/stages", json={"stages": swapped})
    assert r.status_code == 200, r.text
    assert [s["kind"] for s in r.json()["stages"]][6:] == ["lost", "won"]
    # Too few stages.
    r = await c.put("/v1/rounds/seed/stages", json={"stages": swapped[6:]})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_stage_config"


async def test_summary_math(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    from datetime import date, timedelta

    w = await world(db)
    today = date(2026, 10, 12)
    stale_at = frozen_now - timedelta(days=20)
    a, b, c_, d, e = [await make_investor(db, w.ws) for _ in range(5)]
    await make_participant(db, w.rnd, a, stage="committed", amount_committed=500_000)
    await make_participant(db, w.rnd, b, stage="committed")  # won without an amount
    await make_participant(
        db,
        w.rnd,
        c_,
        stage="meeting",
        amount_soft=400_000,
        probability=50,
        follow_up_on=today - timedelta(days=2),
        last_activity_at=stale_at,
    )
    await make_participant(
        db, w.rnd, d, stage="new", amount_soft=100_000, follow_up_on=today, fit=5
    )
    await make_participant(db, w.rnd, e, stage="passed", amount_soft=999_999)
    w.rnd.target_amount = 2_000_000
    w.rnd.target_close_on = today + timedelta(days=30)
    await db.flush()
    s = (await key_client(w.key).get("/v1/rounds/seed/summary")).json()
    assert s["money"] == {
        "currency": "USD",
        "target": 2_000_000,
        "committed": 500_000,
        "pct_of_target": 25.0,
        "soft_circled": 500_000,
        "weighted_pipeline": 200_000,
        "committed_count": 1,
    }
    assert s["counts"] == {"total": 5, "open": 1, "active": 1, "won": 2, "lost": 1}
    funnel = {f["key"]: f for f in s["funnel"]}
    assert funnel["committed"]["count"] == 2 and funnel["committed"]["amount_committed"] == 500_000
    assert s["follow_ups"]["overdue"] == 1 and s["follow_ups"]["today"] == 1
    assert [t["follow_up_state"] for t in s["follow_ups"]["top"]] == ["overdue", "today"]
    assert s["follow_ups"]["top"][0]["days_overdue"] == 2
    assert [x["investor"]["id"] for x in s["stale"]] == [str(c_.id)]
    assert s["stale"][0]["days_since_activity"] == 20
    assert s["round"]["days_to_close"] == 30
    assert any("without an amount" in x for x in s["warnings"])
    assert any("overdue" in x for x in s["warnings"])


async def test_viewer_can_read_but_not_write(db: AsyncSession, session_client: Any) -> None:
    from tests.factories import add_member

    w = await world(db)
    viewer = await add_member(db, w.ws, role="viewer")
    c = await session_client(viewer, w.ws)
    assert (await c.get("/v1/rounds")).status_code == 200
    r = await c.post("/v1/rounds", json={"name": "Nope"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden_role"
