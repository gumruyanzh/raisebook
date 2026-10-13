"""Activities and follow-ups over REST (SPEC §5.6, §5.7, §4.6 delete rules, §4.7 actors)."""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from tests.api.helpers import dana, world
from tests.factories import add_member, make_api_key, make_investor, make_participant, make_round


async def test_log_and_idempotency(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    w = await world(db, agent_name="codex")
    inv = await dana(db, w.ws)
    await make_participant(db, w.rnd, inv)
    c = key_client(w.key, headers={"X-Agent-Name": "claude-code", "X-Agent-Model": "opus"})
    payload = {
        "investor_id": str(inv.id),
        "kind": "email",
        "body": "Sent the deck and the pilot metrics.",
        "round": "seed",
        "direction": "outbound",
        "occurred_at": "2026-10-11",
        "idempotency_key": "msg-001@example.com",
    }
    r = await c.post("/v1/activities", json=payload)
    assert r.status_code == 201, r.text
    a = r.json()
    assert a["duplicate"] is False and a["round_slug"] == "seed"
    assert a["occurred_at"] == "2026-10-11T12:00:00Z"  # bare date = 12:00 local (UTC here)
    assert a["data"] == {"direction": "outbound"} and a["investor_name"] == "Dana Whitfield"
    assert a["actor"] == {
        "type": "agent",
        "label": "claude-code",
        "user_id": None,
        "api_key_id": str(w.key_id),
        "agent_model": "opus",
        "via": "api",
    }
    assert a["deletable"] is True
    r = await c.post("/v1/activities", json=payload)
    assert r.status_code == 200 and r.json()["duplicate"] is True and r.json()["id"] == a["id"]
    # The header is an alias.
    p2 = {k: v for k, v in payload.items() if k != "idempotency_key"}
    r = await c.post("/v1/activities", json=p2, headers={"Idempotency-Key": "msg-001@example.com"})
    assert r.json()["duplicate"] is True
    r = await c.post("/v1/activities", json=p2, headers={"Idempotency-Key": "msg-002"})
    assert r.status_code == 201

    # The participant's last activity moved to the (past) occurred_at.
    from tests.api.helpers import participant

    part = await participant(db, w.rnd, inv)
    assert part is not None and part.last_activity_at is not None

    bad = {**p2, "occurred_at": "2040-01-01"}
    r = await c.post("/v1/activities", json=bad)
    assert r.status_code == 422
    r = await c.post("/v1/activities", json={**p2, "kind": "stage_change"})
    assert r.status_code == 422
    r = await c.post("/v1/activities", json={**p2, "occurred_at": "yesterday"})
    assert r.status_code == 422


async def test_list_filters(db: AsyncSession, key_client: Any, session_client: Any) -> None:
    w = await world(db)
    inv = await dana(db, w.ws)
    other = await make_investor(db, w.ws)
    kc = key_client(w.key)
    sc = await session_client(w.owner, w.ws)
    await kc.post(
        "/v1/activities",
        json={"investor_id": str(inv.id), "kind": "call", "body": "Intro call", "round": "seed"},
    )
    await sc.post("/v1/activities", json={"investor_id": str(inv.id), "kind": "note", "body": "x"})
    await sc.post(
        "/v1/activities", json={"investor_id": str(other.id), "kind": "note", "body": "y"}
    )
    rows = (await kc.get("/v1/activities", params={"investor_id": str(inv.id)})).json()["data"]
    assert len(rows) == 2
    rows = (await kc.get("/v1/activities", params={"actor_type": "user"})).json()["data"]
    assert {r["actor"]["label"] for r in rows} == {w.owner.name}
    assert all(r["actor"]["via"] == "web" for r in rows)
    rows = (await kc.get("/v1/activities", params={"round": "seed"})).json()["data"]
    assert [r["kind"] for r in rows] == ["call"]
    rows = (await kc.get("/v1/activities", params={"kind": ["call", "note"]})).json()["data"]
    assert len(rows) == 3
    page = (await kc.get("/v1/activities", params={"limit": 2})).json()
    assert len(page["data"]) == 2 and page["next_cursor"]


async def test_delete_rules(db: AsyncSession, key_client: Any, session_client: Any) -> None:
    w = await world(db)
    inv = await dana(db, w.ws)
    editor = await add_member(db, w.ws, role="editor")
    _, other_key = await make_api_key(db, w.ws, scopes="read,write,admin")
    kc = key_client(w.key)
    ec = await session_client(editor, w.ws)
    oc = await session_client(w.owner, w.ws)

    async def log(c: Any) -> str:
        r = await c.post(
            "/v1/activities", json={"investor_id": str(inv.id), "kind": "note", "body": "n"}
        )
        return str(r.json()["id"])

    by_key, by_editor, by_owner = await log(kc), await log(ec), await log(oc)
    # A key may delete only its own entries, even with admin scope.
    r = await key_client(other_key).delete(f"/v1/activities/{by_key}")
    assert r.status_code == 403 and r.json()["error"]["code"] == "insufficient_scope"
    # An editor may delete only their own.
    r = await ec.delete(f"/v1/activities/{by_owner}")
    assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden_role"
    assert (await ec.delete(f"/v1/activities/{by_editor}")).status_code == 204
    # The owner may delete any manual entry.
    assert (await oc.delete(f"/v1/activities/{by_key}")).status_code == 204
    assert (await kc.delete(f"/v1/activities/{by_owner}")).status_code == 403
    # System entries are never deletable.
    r = await kc.get(
        "/v1/activities", params={"investor_id": str(inv.id), "kind": "investor_created"}
    )
    sys_rows = r.json()["data"]
    if sys_rows:
        r = await oc.delete(f"/v1/activities/{sys_rows[0]['id']}")
        assert r.status_code == 409 and r.json()["error"]["code"] == "not_deletable"
    await kc.post("/v1/rounds/seed/participants", json={"investor_id": str(inv.id)})
    added = (
        await kc.get(
            "/v1/activities", params={"investor_id": str(inv.id), "kind": "added_to_round"}
        )
    ).json()["data"][0]
    assert added["deletable"] is False
    r = await oc.delete(f"/v1/activities/{added['id']}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_deletable"
    # Viewer: no write scope.
    viewer = await add_member(db, w.ws, role="viewer")
    vc = await session_client(viewer, w.ws)
    r = await vc.delete(f"/v1/activities/{by_owner}")
    assert r.status_code == 403


async def test_deleted_user_shows_as_former_member(
    db: AsyncSession, key_client: Any, session_client: Any
) -> None:
    from sqlalchemy import delete

    from raisebook.models.user import User

    w = await world(db)
    inv = await dana(db, w.ws)
    editor = await add_member(db, w.ws, role="editor")
    ec = await session_client(editor, w.ws)
    await ec.post("/v1/activities", json={"investor_id": str(inv.id), "kind": "note", "body": "z"})
    await db.execute(delete(User).where(User.id == editor.id))
    db.expire_all()
    rows = (await key_client(w.key).get("/v1/activities", params={"actor_type": "user"})).json()[
        "data"
    ]
    assert rows[0]["actor"]["label"] == "Former member"
    assert rows[0]["actor"]["user_id"] is None  # ON DELETE SET NULL


async def test_follow_ups(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    w = await world(db, timezone="America/Los_Angeles")
    closed = await make_round(db, w.ws, name="Pre-seed", slug="pre-seed", status="closed")
    a, b, c_, d, e = [await make_investor(db, w.ws) for _ in range(5)]
    today = date(2026, 10, 12)  # 10:00 in Los Angeles
    await make_participant(db, w.rnd, a, follow_up_on=date(2026, 10, 9), fit=3)
    await make_participant(db, w.rnd, b, follow_up_on=today, fit=5)
    await make_participant(db, w.rnd, c_, follow_up_on=date(2026, 10, 16))
    await make_participant(db, w.rnd, d, stage="passed", follow_up_on=date(2026, 10, 1))
    await make_participant(db, closed, e, follow_up_on=date(2026, 10, 1))
    c = key_client(w.key)
    r = (await c.get("/v1/follow-ups")).json()
    assert r["today"] == "2026-10-12"
    assert [i["investor"]["id"] for i in r["data"]] == [str(a.id), str(b.id)]
    assert r["data"][0]["follow_up_state"] == "overdue" and r["data"][0]["days_overdue"] == 3
    assert r["counts"] == {"overdue": 1, "today": 1, "upcoming": 0}
    r = (await c.get("/v1/follow-ups", params={"within_days": 7})).json()
    assert [i["investor"]["id"] for i in r["data"]] == [str(a.id), str(b.id), str(c_.id)]
    assert r["counts"]["upcoming"] == 1 and r["data"][2]["follow_up_state"] == "soon"
    r = (await c.get("/v1/follow-ups", params={"include_overdue": "false"})).json()
    assert [i["investor"]["id"] for i in r["data"]] == [str(b.id)]
    r = (await c.get("/v1/follow-ups", params={"round": "pre-seed"})).json()
    assert [i["investor"]["id"] for i in r["data"]] == [str(e.id)]
    assert (await c.get("/v1/follow-ups", params={"round": "nope"})).status_code == 404


async def test_collapse_runs_groups_an_import_and_lists_it_back(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    """A feed with ``collapse_runs`` shows an import as one entry sized in ``run``; the
    run's key lists every activity of it; a manual note stays its own entry."""
    w = await world(db)
    c = key_client(w.key)
    csv = "Name,Firm,Email\n" + "".join(
        f"Imported Person {i},Fictional Fund {i},imported{i}@example.com\n" for i in range(6)
    )
    r = await c.post("/v1/imports", json={"content": csv, "round": "seed", "filename": "six.csv"})
    assert r.status_code == 200, r.text
    run_id = r.json()["import_run_id"]
    inv = await dana(db, w.ws)
    await make_participant(db, w.rnd, inv)
    r = await c.post(
        "/v1/activities",
        json={
            "investor_id": str(inv.id),
            "kind": "note",
            "body": "Coffee next week.",
            "round": "seed",
        },
    )
    assert r.status_code == 201

    full = (await c.get("/v1/activities", params={"round": "seed", "limit": 200})).json()["data"]
    imported = [a for a in full if a["import_run_id"] == run_id]
    assert len(imported) >= 6 and all(a["run"] is None for a in full)

    feed = (await c.get("/v1/activities", params={"round": "seed", "collapse_runs": "true"})).json()
    runs = [a for a in feed["data"] if a["run"]]
    assert len(runs) == 1
    run = runs[0]["run"]
    assert run["key"] == run_id and run["kind"] == "import"
    assert run["size"] == len(imported) and run["investors"] == 6
    assert run["filename"] == "six.csv"
    assert any(a["kind"] == "note" and a["run"] is None for a in feed["data"])
    assert len(feed["data"]) == len(full) - len(imported) + 1

    params = {"run": run_id, "round": "seed", "limit": 200}
    back = (await c.get("/v1/activities", params=params)).json()["data"]
    assert {a["id"] for a in back} == {a["id"] for a in imported}
    # Without the round filter the run also holds the contact-level "added" entries.
    everything = (await c.get("/v1/activities", params={"run": run_id, "limit": 200})).json()
    assert len(everything["data"]) > len(back)
    assert all(a["import_run_id"] == run_id for a in everything["data"])


async def test_collapse_runs_groups_a_bulk_change(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    """Activities that share ``data.bulk_id`` collapse the same way, keyed by that id."""
    from raisebook.services import activities as act_svc
    from tests.services.test_imports import ctx_for

    w = await world(db)
    invs = [
        await make_investor(db, w.ws, name=f"Bulk Person {i}", email=f"bulk{i}@example.com")
        for i in range(3)
    ]
    ctx = ctx_for(w.ws, w.owner)
    for inv in invs:
        await make_participant(db, w.rnd, inv)
        await act_svc.log(
            db,
            ctx,
            investor_id=inv.id,
            round_id=w.rnd.id,
            kind="stage_change",
            data={"bulk_id": "bulk-123", "to": {"key": "passed", "label": "Passed"}},
            now=frozen_now,
        )
    await db.flush()
    c = key_client(w.key)
    feed = (await c.get("/v1/activities", params={"collapse_runs": "true"})).json()["data"]
    bulk = [a for a in feed if a["run"]]
    assert len(bulk) == 1 and bulk[0]["run"] == {
        "key": "bulk-123",
        "kind": "bulk",
        "size": 3,
        "investors": 3,
        "filename": None,
    }
