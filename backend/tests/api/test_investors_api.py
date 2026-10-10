"""Investor contacts over REST (SPEC §5.7, §3.4 dedupe, §8.1 activities)."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.activity import Activity
from raisebook.models.investor import Investor
from raisebook.models.round import RoundParticipant
from tests.api.helpers import activities_of, dana, world
from tests.factories import make_investor, make_participant, make_round

DANA = {
    "name": "Dana Whitfield",
    "firm": "Harbor Light Ventures",
    "title": "Partner",
    "type": "VC",
    "email": "Dana@Example.com",
    "linkedin_url": "https://www.linkedin.com/in/example-dana/",
    "x_url": "@example_dana",
    "check_note": "$250k-$1M, leads",
    "tags": ["robotics", "Robotics", "hardware"],
    "industries": ["Industrial"],
    "source": "SF Tech Week 2026",
}


async def test_create_normalizes_and_logs(db: AsyncSession, key_client: Any) -> None:
    w = await world(db, agent_name="codex")
    c = key_client(w.key, headers={"X-Agent-Model": "gpt-5-codex"})
    r = await c.post("/v1/investors", json=DANA)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["created"] is True and body.get("matched_on") is None
    inv = body["investor"]
    assert inv["email"] == "dana@example.com" and inv["type"] == "vc"
    assert inv["x_url"] == "https://x.com/example_dana"
    assert inv["check_min"] == 250_000 and inv["check_max"] == 1_000_000
    assert inv["tags"] == ["robotics", "hardware"] and inv["rounds"] == []
    row = await db.get(Investor, inv["id"])
    assert row is not None and row.linkedin_key == "in/example-dana"
    acts = await activities_of(db, row)
    assert [a.kind for a in acts] == ["investor_created"]
    assert acts[0].actor_type == "agent" and acts[0].via == "api"
    assert acts[0].actor_label == "codex" and acts[0].agent_model == "gpt-5-codex"
    assert acts[0].api_key_id == w.key_id


async def test_dedupe_paths(db: AsyncSession, key_client: Any) -> None:
    w = await world(db)
    c = key_client(w.key)
    first = (await c.post("/v1/investors", json=DANA)).json()["investor"]

    r = await c.post("/v1/investors", json={"name": "D. Whitfield", "email": "DANA@example.com"})
    assert r.status_code == 200
    assert r.json()["created"] is False and r.json()["matched_on"] == "email"
    assert r.json()["investor"]["id"] == first["id"]

    r = await c.post(
        "/v1/investors",
        json={"name": "Someone", "linkedin_url": "linkedin.com/in/EXAMPLE-dana?trk=x"},
    )
    assert r.json()["matched_on"] == "linkedin"

    r = await c.post("/v1/investors", json={"name": "dana whitfield", "firm": "Harbor Light"})
    assert r.json()["matched_on"] == "name_firm" and r.json()["investor"]["id"] == first["id"]

    # fill_empty fills empty fields and merges tags, never overwrites.
    r = await c.post(
        "/v1/investors",
        json={
            "name": "Dana Whitfield",
            "firm": "Harbor Light Ventures",
            "title": "CEO",
            "location": "Oakland, CA",
            "tags": ["climate"],
            "on_duplicate": "fill_empty",
        },
    )
    body = r.json()
    assert body["created"] is False and sorted(body["filled_fields"]) == ["location", "tags"]
    assert body["investor"]["title"] == "Partner"
    assert body["investor"]["tags"] == ["robotics", "hardware", "climate"]

    # create_anyway ignores name+firm, but never creates an email duplicate.
    r = await c.post(
        "/v1/investors",
        json={"name": "Dana Whitfield", "firm": "Harbor Light", "on_duplicate": "create_anyway"},
    )
    assert r.status_code == 201 and r.json()["created"] is True
    r = await c.post(
        "/v1/investors",
        json={"name": "X", "email": "dana@example.com", "on_duplicate": "create_anyway"},
    )
    assert r.status_code == 200 and r.json()["matched_on"] == "email"
    rows = list(await db.scalars(select(Investor).where(Investor.workspace_id == w.ws.id)))
    assert len(rows) == 2


async def test_get_patch_and_activity_rules(
    db: AsyncSession, key_client: Any, session_client: Any, frozen_now: Any
) -> None:
    w = await world(db, agent_name="claude-code")
    inv = await dana(db, w.ws, tags=["robotics"])
    rnd2 = await make_round(db, w.ws, name="Pre-seed", slug="pre-seed", status="closed")
    await make_participant(db, w.rnd, inv, stage="meeting", fit=4)
    await make_participant(db, rnd2, inv, stage="committed", amount_committed=50_000)
    c = key_client(w.key)
    got = (await c.get(f"/v1/investors/{inv.id}")).json()
    assert {r["round_slug"] for r in got["rounds"]} == {"seed", "pre-seed"}
    seed = next(r for r in got["rounds"] if r["round_slug"] == "seed")
    assert seed["stage"]["key"] == "meeting" and seed["fit"] == 4

    r = await c.patch(
        f"/v1/investors/{inv.id}",
        json={
            "title": "General Partner",
            "location": None,
            "add_tags": ["AI", "robotics"],
            "remove_tags": ["ROBOTICS"],
            "append_notes": "Asked for the data room.",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "General Partner" and body["tags"] == ["AI"]
    assert body["notes"] == "[2026-10-12, claude-code] Asked for the data room."
    upd = (await activities_of(db, inv, "investor_updated"))[-1]
    assert sorted(upd.data["fields"]) == ["notes", "tags", "title"]
    assert upd.data["changes"]["notes"] == {"appended": True}
    assert upd.data["changes"]["title"] == {"from": None, "to": "General Partner"}

    # No-op: same values → no activity.
    before = len(await activities_of(db, inv))
    r = await c.patch(f"/v1/investors/{inv.id}", json={"title": "General Partner"})
    assert r.status_code == 200
    assert len(await activities_of(db, inv)) == before

    # A signed-in user's notes edit writes no activity; other fields still do.
    s = await session_client(w.owner, w.ws)
    r = await s.patch(f"/v1/investors/{inv.id}", json={"notes": "Rewritten by hand."})
    assert r.status_code == 200 and r.json()["notes"] == "Rewritten by hand."
    assert len(await activities_of(db, inv)) == before
    r = await s.patch(f"/v1/investors/{inv.id}", json={"notes": "Again", "title": "GP"})
    upd = (await activities_of(db, inv, "investor_updated"))[-1]
    assert upd.data["fields"] == ["title"] and upd.actor_type == "user"

    # Validation and conflicts.
    r = await c.patch(f"/v1/investors/{inv.id}", json={"name": None})
    assert r.status_code == 422
    other = await make_investor(db, w.ws, email="other@example.com")
    r = await c.patch(f"/v1/investors/{other.id}", json={"email": "DANA@example.com"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate"
    assert r.json()["error"]["details"]["existing"]["id"] == str(inv.id)
    r = await c.patch(f"/v1/investors/{inv.id}", json={"email": "bad"})
    assert r.status_code == 422
    assert r.json()["error"]["details"][0]["loc"] == ["body", "email"]


async def test_resolve(db: AsyncSession, key_client: Any) -> None:
    w = await world(db)
    inv = await dana(db, w.ws)
    await make_investor(db, w.ws, name="Sam Okafor", firm="Kelpline Ventures")
    await make_investor(db, w.ws, name="Sam Okafor", firm="Brightquay Capital")
    c = key_client(w.key)
    for ref in (
        str(inv.id),
        "dana@example.com",
        "https://linkedin.com/in/example-dana",
        "Dana Whitfield",
        "dana whitfield @ Harbor Light",
    ):
        r = await c.get("/v1/investors/resolve", params={"ref": ref})
        assert r.status_code == 200, (ref, r.text)
        assert r.json()["investor"]["id"] == str(inv.id)
    r = await c.get("/v1/investors/resolve", params={"ref": "Sam Okafor"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "ambiguous_reference"
    assert len(r.json()["error"]["details"]["candidates"]) == 2
    r = await c.get("/v1/investors/resolve", params={"ref": "Sam Okafor @ Kelpline"})
    assert r.status_code == 200
    r = await c.get("/v1/investors/resolve", params={"ref": "Dana Whitfeld"})
    assert r.status_code == 404
    assert r.json()["error"]["details"]["suggestions"][0]["name"] == "Dana Whitfield"
    assert "Did you mean" in r.json()["error"]["message"]


async def test_list_filters_and_paging(db: AsyncSession, key_client: Any) -> None:
    w = await world(db)
    a = await make_investor(
        db,
        w.ws,
        name="Ines Calloway",
        firm="Stonepine Seed",
        tags=["Robotics"],
        industries=["industrial"],
        type="angel",
    )
    a.search_text = "ines calloway stonepine seed robotics industrial warehouse pilots"
    b = await make_investor(db, w.ws, name="Tomas Pell", firm=None, tags=["fintech"])
    await make_investor(db, w.ws, name="Grace Montoya", firm="Kelpline Ventures")
    await make_participant(db, w.rnd, b)
    await db.flush()
    c = key_client(w.key)
    r = (await c.get("/v1/investors", params={"q": "warehouse ROBOTICS"})).json()
    assert [x["name"] for x in r["data"]] == ["Ines Calloway"] and r["total"] == 1
    assert (await c.get("/v1/investors", params={"q": "warehouse fintech"})).json()["total"] == 0
    r = (await c.get("/v1/investors", params={"tag": "robotics"})).json()
    assert [x["id"] for x in r["data"]] == [str(a.id)]
    r = (await c.get("/v1/investors", params={"industry": ["Industrial", "x"]})).json()
    assert [x["id"] for x in r["data"]] == [str(a.id)]
    assert (await c.get("/v1/investors", params={"type": "angel"})).json()["total"] == 1
    r = (await c.get("/v1/investors", params={"round": "seed"})).json()
    assert [x["id"] for x in r["data"]] == [str(b.id)]
    r = (await c.get("/v1/investors", params={"not_in_round": "seed"})).json()
    assert r["total"] == 2
    r = (await c.get("/v1/investors", params={"limit": 2})).json()
    assert [x["name"] for x in r["data"]] == ["Grace Montoya", "Ines Calloway"]
    assert r["total"] == 3 and r["next_cursor"]
    r2 = (await c.get("/v1/investors", params={"limit": 2, "cursor": r["next_cursor"]})).json()
    assert [x["name"] for x in r2["data"]] == ["Tomas Pell"] and r2["next_cursor"] is None
    r = await c.get("/v1/investors", params={"sort": "bogus"})
    assert r.status_code == 422
    r = await c.get("/v1/investors", params={"q": "100%_"})
    assert r.status_code == 200 and r.json()["total"] == 0


async def test_delete_cascades(db: AsyncSession, key_client: Any) -> None:
    w = await world(db)
    inv = await dana(db, w.ws)
    await make_participant(db, w.rnd, inv)
    c = key_client(w.key)
    await c.post("/v1/activities", json={"investor_id": str(inv.id), "kind": "note", "body": "Hi"})
    r = await c.delete(f"/v1/investors/{inv.id}")
    assert r.status_code == 204
    assert await db.get(Investor, inv.id) is None
    left = await db.scalar(select(Activity).where(Activity.investor_id == inv.id))
    assert left is None
    part = await db.scalar(select(RoundParticipant).where(RoundParticipant.investor_id == inv.id))
    assert part is None
    assert (await c.delete(f"/v1/investors/{inv.id}")).status_code == 404
    r = await key_client(w.reader).delete(f"/v1/investors/{inv.id}")
    assert r.status_code == 403


async def test_create_validation(db: AsyncSession, key_client: Any) -> None:
    w = await world(db)
    c = key_client(w.key)
    r = await c.post("/v1/investors", json={"name": "  "})
    assert r.status_code == 422
    r = await c.post("/v1/investors", json={"name": "A", "type": "wizard"})
    assert r.status_code == 422 and "investor type" in r.json()["error"]["message"]
    r = await c.post("/v1/investors", json={"name": "A", "website_url": "javascript:alert(1)"})
    assert r.status_code == 422
    r = await c.post("/v1/investors", json={"name": "A", "check_min": "250k", "check_max": "1M"})
    assert r.status_code == 201 and r.json()["investor"]["check_max"] == 1_000_000
    r = await c.post("/v1/investors", json={"name": "A", "surprise": 1})
    assert r.status_code == 422
