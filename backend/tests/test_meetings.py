"""Meetings over REST and MCP, the ICS download and the private calendar feed (SPEC §5.9,
§6.8). The clock is frozen at Monday 2026-10-12 17:00 UTC. Fictional data only."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.meeting import Meeting, MeetingGuest
from raisebook.services.ics import escape, fold
from tests.api.helpers import activities_of, participant, world
from tests.factories import (
    add_member,
    make_investor,
    make_participant,
    make_round,
    make_workspace,
    owner_of,
)

AGENT = {"X-Agent-Name": "claude-code", "X-Agent-Model": "claude-opus-5-5"}


async def _dana(db: AsyncSession, ws: Any) -> Any:
    return await make_investor(
        db, ws, name="Dana Whitfield", firm="Harbor Light Ventures", email="dana@example.com"
    )


async def test_schedule_moves_to_meeting_and_is_idempotent(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await world(db, timezone="America/Los_Angeles")
    inv = await _dana(db, w.ws)
    await make_participant(db, w.rnd, inv, stage="contacted")
    c = key_client(w.key, headers=AGENT)
    body = {
        "investor_id": str(inv.id),
        "starts_at": "2026-10-14T11:00",  # workspace time (PDT, UTC-7)
        "video_url": "meet.example.com/abc-defg",
        "agenda": "Pilot metrics, round terms.",
    }
    r = await c.post("/v1/meetings", json=body)
    assert r.status_code == 201, r.text
    out = r.json()
    m = out["meeting"]
    assert m["starts_at"] == "2026-10-14T18:00:00Z" and m["ends_at"] == "2026-10-14T18:30:00Z"
    assert m["duration_minutes"] == 30 and m["timezone"] == "America/Los_Angeles"
    assert m["video_url"] == "https://meet.example.com/abc-defg"
    assert m["title"] == "Meeting with Dana Whitfield (Harbor Light Ventures)"
    assert m["round"]["slug"] == "seed"  # the investor's only open round
    assert m["source"] == "agent" and m["created_by"]["label"] == "claude-code"
    assert out["created"] is True
    assert out["moved_stage"]["from"]["key"] == "contacted"
    assert out["moved_stage"]["to"]["key"] == "meeting"
    assert out["participant"]["stage"]["key"] == "meeting"
    assert out["participant"]["next_meeting"]["id"] == m["id"]
    kinds = [a.kind for a in await activities_of(db, inv)]
    assert "meeting_scheduled" in kinds and "stage_change" in kinds
    # Same investor, same start: the same meeting, nothing written.
    n = len(kinds)
    r = await c.post("/v1/meetings", json=body)
    assert r.status_code == 200 and r.json()["created"] is False
    assert r.json()["meeting"]["id"] == m["id"]
    assert len(await activities_of(db, inv)) == n
    # The board sees it on the participant.
    r = await c.get("/v1/rounds/seed/participants")
    p = r.json()["data"][0]
    assert p["next_meeting"]["starts_at"] == "2026-10-14T18:00:00Z"


async def test_stage_rules(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    w = await world(db)
    c = key_client(w.key)
    later = await make_investor(db, w.ws, name="Marcus Ellery", firm="Kelpline Ventures")
    await make_participant(db, w.rnd, later, stage="dd")
    r = await c.post(
        "/v1/meetings", json={"investor_id": str(later.id), "starts_at": "2026-10-15T10:00:00Z"}
    )
    assert r.json()["moved_stage"] is None  # Diligence is past Meeting: no move back
    off = await make_investor(db, w.ws, name="Ines Calloway", firm="Brightquay Capital")
    await make_participant(db, w.rnd, off, stage="new")
    r = await c.post(
        "/v1/meetings",
        json={
            "investor_id": str(off.id),
            "starts_at": "2026-10-15T10:00:00Z",
            "move_to_meeting_stage": False,
        },
    )
    assert r.json()["moved_stage"] is None
    assert (await participant(db, w.rnd, off)).stage_id is not None  # type: ignore[union-attr]
    # Not in the round yet, round given: added at the Meeting stage.
    fresh = await make_investor(db, w.ws, name="Tomas Okafor", firm="Stonepine Seed")
    r = await c.post(
        "/v1/meetings",
        json={"investor_id": str(fresh.id), "starts_at": "2026-10-16T10:00:00Z", "round": "seed"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["moved_stage"]["from"] is None
    assert r.json()["moved_stage"]["to"]["key"] == "meeting"
    # No round at all: a contact-only meeting.
    loose = await make_investor(db, w.ws, name="Helena Strand", firm=None)
    r = await c.post(
        "/v1/meetings", json={"investor_id": str(loose.id), "starts_at": "2026-10-16T12:00:00Z"}
    )
    assert r.json()["meeting"].get("round") is None and r.json()["moved_stage"] is None


async def test_validation(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    w = await world(db)
    inv = await _dana(db, w.ws)
    c = key_client(w.key)
    base = {"investor_id": str(inv.id)}
    for starts, msg in (
        ("2026-10-14", "needs a time"),
        ("soon", "RFC 3339"),
        ("2030-01-01T10:00:00Z", "2 years"),
    ):
        r = await c.post("/v1/meetings", json={**base, "starts_at": starts})
        assert r.status_code == 422 and msg in r.text, r.text
    r = await c.post(
        "/v1/meetings",
        json={**base, "starts_at": "2026-10-14T10:00:00Z", "ends_at": "2026-10-14T09:00:00Z"},
    )
    assert r.status_code == 422 and "after starts_at" in r.text
    r = await c.post(
        "/v1/meetings", json={**base, "starts_at": "2026-10-14T10:00:00Z", "video_url": "nope"}
    )
    assert r.status_code == 422
    # Guests must be from the same firm.
    colleague = await make_investor(db, w.ws, name="Grace Pell", firm="Harbor Light")
    other = await make_investor(db, w.ws, name="Jonah Holloway", firm="Kelpline Ventures")
    r = await c.post(
        "/v1/meetings",
        json={**base, "starts_at": "2026-10-14T10:00:00Z", "guest_ids": [str(other.id)]},
    )
    assert r.status_code == 422 and "same firm" in r.text
    r = await c.post(
        "/v1/meetings",
        json={**base, "starts_at": "2026-10-14T10:00:00Z", "guest_ids": [str(colleague.id)]},
    )
    assert r.status_code == 201, r.text
    assert [g["name"] for g in r.json()["meeting"]["guests"]] == ["Grace Pell"]
    # The guest sees it too.
    r = await c.get("/v1/meetings", params={"investor_id": str(colleague.id)})
    assert len(r.json()["data"]) == 1


async def test_reschedule_cancel_history(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await world(db)
    inv = await _dana(db, w.ws)
    await make_participant(db, w.rnd, inv, stage="replied")
    c = key_client(w.key)
    r = await c.post(
        "/v1/meetings", json={"investor_id": str(inv.id), "starts_at": "2026-10-14T18:00:00Z"}
    )
    mid = r.json()["meeting"]["id"]
    r = await c.patch(
        f"/v1/meetings/{mid}",
        json={"starts_at": "2026-10-15T18:00:00Z", "note": "They asked to move it."},
    )
    assert r.status_code == 200 and r.json()["changed"] is True
    m = r.json()["meeting"]
    assert m["starts_at"] == "2026-10-15T18:00:00Z" and m["duration_minutes"] == 30
    assert [h["change"] for h in m["history"]] == ["scheduled", "rescheduled"]
    assert m["history"][1]["from_starts_at"] == "2026-10-14T18:00:00Z"
    # Same values: a no-op.
    r = await c.patch(f"/v1/meetings/{mid}", json={"starts_at": "2026-10-15T18:00:00Z"})
    assert r.json()["changed"] is False
    r = await c.patch(f"/v1/meetings/{mid}", json={"status": "cancelled"})
    assert r.json()["meeting"]["status"] == "cancelled"
    assert r.json()["meeting"]["cancelled_at"] is not None
    # Rescheduling a cancelled meeting brings it back.
    r = await c.patch(f"/v1/meetings/{mid}", json={"starts_at": "2026-10-20T18:00:00Z"})
    m = r.json()["meeting"]
    assert m["status"] == "scheduled"
    assert [h["change"] for h in m["history"]] == [
        "scheduled",
        "rescheduled",
        "cancelled",
        "rescheduled",
    ]
    row = await db.scalar(select(Meeting).where(Meeting.id == m["id"]))
    assert row is not None and row.sequence == 3
    updates = await activities_of(db, inv, "meeting_updated")
    assert updates[0].body == "They asked to move it."


async def test_complete_and_lists(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    w = await world(db)
    inv = await _dana(db, w.ws)
    await make_participant(db, w.rnd, inv, stage="meeting")
    c = key_client(w.key)
    past = await c.post(
        "/v1/meetings", json={"investor_id": str(inv.id), "starts_at": "2026-10-12T15:00:00Z"}
    )
    assert past.status_code == 201 and "in the past" in past.json()["warnings"][0]
    fut = await c.post(
        "/v1/meetings", json={"investor_id": str(inv.id), "starts_at": "2026-10-19T15:00:00Z"}
    )
    past_id, fut_id = past.json()["meeting"]["id"], fut.json()["meeting"]["id"]
    assert past.json()["meeting"]["needs_outcome"] is True
    r = await c.get("/v1/meetings", params={"when": "needs_outcome"})
    assert [m["id"] for m in r.json()["data"]] == [past_id]
    r = await c.get("/v1/meetings", params={"when": "upcoming"})
    assert [m["id"] for m in r.json()["data"]] == [fut_id]
    # A future meeting cannot be marked done yet.
    r = await c.post(f"/v1/meetings/{fut_id}/complete", json={"outcome": "x"})
    assert r.status_code == 422
    r = await c.post(
        f"/v1/meetings/{past_id}/complete",
        json={
            "outcome": "Strong interest; wants the cohort data.",
            "next_step": "Send cohort data",
            "follow_up_in_days": 3,
        },
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["meeting"]["status"] == "done" and out["meeting"]["needs_outcome"] is False
    assert out["activity"]["kind"] == "meeting"
    assert out["activity"]["data"]["meeting_id"] == past_id
    assert out["activity"]["occurred_at"] == "2026-10-12T15:00:00Z"
    assert out["participant"]["next_step"] == "Send cohort data"
    assert out["participant"]["follow_up_on"] == "2026-10-15"
    # Repeating changes nothing; a done meeting cannot be rescheduled.
    r = await c.post(f"/v1/meetings/{past_id}/complete", json={"outcome": "again"})
    assert r.json()["changed"] is False
    r = await c.patch(f"/v1/meetings/{past_id}", json={"starts_at": "2026-10-20T10:00:00Z"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "meeting_done"
    # The round summary counts what is coming.
    r = await c.get("/v1/rounds/seed/summary")
    assert r.json()["meetings"]["upcoming"] == 1
    assert r.json()["meetings"]["next"][0]["investor_name"] == "Dana Whitfield"
    # Viewers (read keys) cannot schedule.
    r = await key_client(w.reader).post(
        "/v1/meetings", json={"investor_id": str(inv.id), "starts_at": "2026-10-20T10:00:00Z"}
    )
    assert r.status_code == 403


async def test_deletes_follow_investors(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    w = await world(db)
    inv = await _dana(db, w.ws)
    guest = await make_investor(db, w.ws, name="Grace Pell", firm="Harbor Light Ventures")
    c = key_client(w.key)
    r = await c.post(
        "/v1/meetings",
        json={
            "investor_id": str(inv.id),
            "starts_at": "2026-10-14T18:00:00Z",
            "guest_ids": [str(guest.id)],
        },
    )
    mid = r.json()["meeting"]["id"]
    assert (await c.delete(f"/v1/investors/{guest.id}")).status_code == 204
    assert (await db.scalars(select(MeetingGuest))).all() == []
    assert (await c.get(f"/v1/meetings/{mid}")).json()["guests"] == []
    assert (await c.delete(f"/v1/investors/{inv.id}")).status_code == 204
    assert (await c.get(f"/v1/meetings/{mid}")).status_code == 404
    # A round delete keeps the meeting, without the round.
    other = await make_investor(db, w.ws, name="Priya Montoya", firm=None)
    rnd = await make_round(db, w.ws, name="Bridge", slug="bridge")
    r = await c.post(
        "/v1/meetings",
        json={"investor_id": str(other.id), "starts_at": "2026-10-14T19:00:00Z", "round": "bridge"},
    )
    mid = r.json()["meeting"]["id"]
    owner = key_client(await _admin_key(db, w.ws))
    assert (
        await owner.request("DELETE", "/v1/rounds/bridge", json={"confirm": rnd.name})
    ).status_code == 204
    assert (await c.get(f"/v1/meetings/{mid}")).json().get("round") is None
    # A meeting entered by mistake can be deleted.
    assert (await c.delete(f"/v1/meetings/{mid}")).status_code == 204
    assert (await c.get(f"/v1/meetings/{mid}")).status_code == 404


async def _admin_key(db: AsyncSession, ws: Any) -> str:
    from tests.factories import make_api_key

    _, raw = await make_api_key(db, ws, scopes="read,write,admin")
    return raw


async def test_export_includes_meetings(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    w = await world(db)
    inv = await _dana(db, w.ws)
    c = key_client(w.key)
    await c.post(
        "/v1/meetings",
        json={"investor_id": str(inv.id), "starts_at": "2026-10-14T18:00:00Z", "location": "HQ"},
    )
    r = await c.get("/v1/export", params={"format": "json"})
    doc = json.loads(r.text)
    assert doc["meetings"][0]["location"] == "HQ"
    assert doc["meetings"][0]["investor_id"] == str(inv.id)
    assert doc["meetings"][0]["status"] == "scheduled"


async def test_ics_and_feed(
    db: AsyncSession, key_client: Any, session_client: Any, client: Any, frozen_now: Any
) -> None:
    w = await world(db, name="Kestrel Test")
    inv = await _dana(db, w.ws)
    c = key_client(w.key)
    r = await c.post(
        "/v1/meetings",
        json={
            "investor_id": str(inv.id),
            "starts_at": "2026-10-14T18:00:00Z",
            "location": "Pier 9, Suite 2; ask at desk",
        },
    )
    mid = r.json()["meeting"]["id"]
    r = await c.get(f"/v1/meetings/{mid}/ics")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/calendar")
    text = r.text
    assert "BEGIN:VEVENT" in text and f"UID:meeting-{mid}@raisebook.org" in text
    assert "DTSTART:20261014T180000Z" in text and "DTEND:20261014T183000Z" in text
    assert "LOCATION:Pier 9\\, Suite 2\\; ask at desk" in text
    # The owner's feed covers both of their workspaces and nothing else.
    second = await make_workspace(db, owner=w.owner, name="Second Co")
    rnd2 = await make_round(db, second, name="Seed", slug="seed")
    inv2 = await make_investor(db, second, name="Rafael Strand", firm=None)
    await make_participant(db, rnd2, inv2, stage="replied")
    stranger_ws = await make_workspace(db, name="Stranger Inc")
    inv3 = await make_investor(db, stranger_ws, name="Secret Person", firm=None)
    db.add(
        Meeting(
            workspace_id=stranger_ws.id,
            investor_id=inv3.id,
            title="Stranger meeting",
            starts_at=frozen_now,
            ends_at=frozen_now.replace(hour=18),
            timezone="UTC",
            actor_type="system",
            actor_label="raisebook",
            via="system",
        )
    )
    await db.flush()
    s2 = await session_client(w.owner, second)
    r = await s2.post(
        "/v1/meetings", json={"investor_id": str(inv2.id), "starts_at": "2026-10-15T09:00:00Z"}
    )
    assert r.status_code == 201, r.text
    assert (await s2.get("/v1/me/calendar-feed")).json()["active"] is False
    r = await s2.post("/v1/me/calendar-feed")
    assert r.status_code == 201
    url = r.json()["url"]
    assert url.startswith("http") and r.json()["webcal_url"].startswith("webcal://")
    path = url[url.index("/v1/") :]
    r = await client.get(path)
    assert r.status_code == 200, r.text
    assert "Meeting with Dana Whitfield" in r.text and "Rafael Strand" in r.text
    assert "Stranger" not in r.text and "Secret Person" not in r.text
    assert "· Kestrel Test" in r.text  # several workspaces: each event says which one
    status = (await s2.get("/v1/me/calendar-feed")).json()
    assert status["active"] is True and status["last_used_at"] is not None
    # Rotating kills the old URL; revoking kills the feed.
    r = await s2.post("/v1/me/calendar-feed")
    assert (await client.get(path)).status_code == 404
    new_path = r.json()["url"][r.json()["url"].index("/v1/") :]
    assert (await client.get(new_path)).status_code == 200
    assert (await s2.delete("/v1/me/calendar-feed")).status_code == 204
    assert (await client.get(new_path)).status_code == 404
    assert (await client.get("/v1/calendar/nonsense.ics")).status_code == 404
    # Leaving a workspace drops its meetings from the feed.
    member = await add_member(db, w.ws, role="viewer")
    sm = await session_client(member, w.ws)
    feed = (await sm.post("/v1/me/calendar-feed")).json()["url"]
    fpath = feed[feed.index("/v1/") :]
    assert "Dana Whitfield" in (await client.get(fpath)).text
    assert (await sm.delete(f"/v1/members/{member.id}")).status_code == 204
    assert "Dana Whitfield" not in (await client.get(fpath)).text
    _ = await owner_of(db, w.ws)


def test_ics_escaping_and_folding() -> None:
    assert escape("a,b;c\\d\ne") == "a\\,b\\;c\\\\d\\ne"
    line = "DESCRIPTION:" + "é" * 80
    folded = fold(line)
    assert all(len(p.encode()) <= 75 for p in folded.split("\r\n"))
    assert folded.replace("\r\n ", "") == line


async def test_mcp_meeting_tools(db: AsyncSession, mcp_call: Any, frozen_now: Any) -> None:
    w = await world(db, timezone="America/New_York")
    inv = await _dana(db, w.ws)
    await make_participant(db, w.rnd, inv, stage="contacted")
    res = await mcp_call(
        w.key,
        "schedule_meeting",
        {
            "investor": "Dana Whitfield",
            "starts_at": "2026-10-12T15:00",
            "duration_minutes": 45,
            "location": "Harbor Light office",
            "source": "email",
        },
        headers=AGENT,
    )
    assert res.ok, res.text
    m = res.data["meeting"]
    assert m["local"] == "Monday 2026-10-12 15:00 (America/New_York)"
    assert m["minutes"] == 45 and m["source"] == "email"
    assert m["by"] == "claude-code · claude-opus-5-5 (agent via mcp)"
    assert res.data["moved_stage"] == {
        "from": {"key": "contacted", "label": "Contacted"},
        "to": {"key": "meeting", "label": "Meeting"},
    }
    assert res.data["created"] is True
    again = await mcp_call(
        w.key, "schedule_meeting", {"investor": "Dana Whitfield", "starts_at": "2026-10-12T15:00"}
    )
    assert again.data["created"] is False and again.data["meeting"]["id"] == m["id"]
    res = await mcp_call(w.key, "list_meetings", {"when": "today"})
    assert [x["id"] for x in res.data["items"]] == [m["id"]]
    assert res.data["counts"]["needs_outcome"] == 0
    res = await mcp_call(
        w.key, "update_meeting", {"meeting_id": m["id"], "starts_at": "2026-10-12T12:00"}
    )
    assert res.ok and res.data["changed"] is True, res.text
    assert res.data["meeting"]["history"][-1]["change"] == "rescheduled"
    res = await mcp_call(w.key, "list_meetings", {"when": "needs_outcome"})
    assert [x["id"] for x in res.data["items"]] == [m["id"]]
    res = await mcp_call(
        w.key,
        "complete_meeting",
        {
            "meeting_id": m["id"],
            "outcome": "Good meeting; partner meeting next.",
            "follow_up_on": "2026-10-19",
        },
    )
    assert res.ok, res.text
    assert res.data["meeting"]["status"] == "done"
    assert res.data["participant"]["follow_up_on"] == "2026-10-19"
    res = await mcp_call(w.key, "update_meeting", {"meeting_id": m["id"], "status": "cancelled"})
    assert not res.ok and res.code == "meeting_done"
    res = await mcp_call(w.key, "complete_meeting", {"meeting_id": "not-an-id"})
    assert not res.ok and res.code == "validation_error"
    res = await mcp_call(w.reader, "schedule_meeting", {"investor": "Dana", "starts_at": "x"})
    assert not res.ok


async def test_dst_local_times(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    """Workspace times across DST changes: stored in UTC, real durations, no skipped times."""
    w = await world(db, timezone="America/Los_Angeles")
    inv = await _dana(db, w.ws)
    c = key_client(w.key)
    # After the fall-back change (PST, UTC-8): 11:00 local is 19:00Z, in the ICS too.
    r = await c.post(
        "/v1/meetings", json={"investor_id": str(inv.id), "starts_at": "2026-11-03T11:00"}
    )
    assert r.json()["meeting"]["starts_at"] == "2026-11-03T19:00:00Z", r.text
    mid = r.json()["meeting"]["id"]
    assert "DTSTART:20261103T190000Z" in (await c.get(f"/v1/meetings/{mid}/ics")).text
    # 01:45 on the fall-back night, 30 minutes: really 30 minutes (not 1 h 30).
    r = await c.post(
        "/v1/meetings",
        json={"investor_id": str(inv.id), "starts_at": "2026-11-01T01:45", "duration_minutes": 30},
    )
    assert r.status_code == 201, r.text
    m = r.json()["meeting"]
    assert (m["starts_at"], m["ends_at"]) == ("2026-11-01T08:45:00Z", "2026-11-01T09:15:00Z")
    # 02:30 on the spring-forward night does not exist: a clear 422, not a 500.
    r = await c.post(
        "/v1/meetings", json={"investor_id": str(inv.id), "starts_at": "2027-03-14T02:30"}
    )
    assert r.status_code == 422 and "does not exist" in r.text
    # List bounds without an offset are workspace time too.
    r = await c.get("/v1/meetings", params={"from": "2026-11-03T10:30", "to": "2026-11-03T11:30"})
    assert r.status_code == 200, r.text
    assert [x["id"] for x in r.json()["data"]] == [mid]


async def test_closed_round_never_moves(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    w = await world(db)
    closed = await make_round(db, w.ws, name="Pre-seed", slug="pre-seed")
    closed.status = "closed"
    await db.flush()
    inv = await _dana(db, w.ws)
    c = key_client(w.key)
    r = await c.post(
        "/v1/meetings",
        json={
            "investor_id": str(inv.id),
            "starts_at": "2026-10-15T10:00:00Z",
            "round": "pre-seed",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["moved_stage"] is None
    assert any("not open" in x for x in r.json()["warnings"])
    assert await participant(db, closed, inv) is None
