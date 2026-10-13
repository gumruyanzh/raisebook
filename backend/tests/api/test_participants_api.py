"""Round participants over REST (SPEC §5.6, §8.1)."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from tests.api.helpers import activities_of, dana, participant, world
from tests.factories import add_member, make_investor, make_participant, make_round


async def test_add_is_idempotent_and_applies_fields(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await world(db)
    inv = await dana(db, w.ws)
    c = key_client(w.key)
    url = "/v1/rounds/seed/participants"
    r = await c.post(url, json={"investor_id": str(inv.id), "fit": 5})
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["created"] is True and p["stage"]["key"] == "new" and p["priority"] == "hot"
    assert p["investor"]["name"] == "Dana Whitfield" and p["round_slug"] == "seed"
    assert [a.kind for a in await activities_of(db, inv)] == ["added_to_round"]

    r = await c.post(url, json={"investor_id": str(inv.id)})
    assert r.status_code == 200 and r.json()["created"] is False
    assert len(await activities_of(db, inv)) == 1  # repeat = no-op

    r = await c.post(
        url,
        json={
            "investor_id": str(inv.id),
            "stage": "Meeting",
            "probability": 40,
            "follow_up_on": "2026-10-15",
            "follow_up_note": "Send deck",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["stage"]["key"] == "meeting" and body["follow_up_state"] == "soon"
    kinds = [a.kind for a in await activities_of(db, inv)]
    assert kinds == ["added_to_round", "stage_change", "follow_up_set", "participant_updated"]

    r = await c.post(url, json={"investor_id": str(inv.id), "stage": "nope"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "stage_not_found"
    assert "meeting" in r.json()["error"]["details"]["valid"]


async def test_patch_writes_one_activity_per_change_type(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await world(db)
    inv = await dana(db, w.ws)
    editor = await add_member(db, w.ws, role="editor")
    await make_participant(db, w.rnd, inv, stage="contacted", fit=2)
    c = key_client(w.key)
    url = f"/v1/rounds/seed/participants/{inv.id}"
    r = await c.patch(
        url,
        json={
            "stage": "replied",
            "note": "They answered within a day.",
            "fit": 4,
            "amount_soft": 250_000,
            "amount_committed": 100_000,
            "follow_up_on": "2026-10-20",
            "next_step": "Book a partner meeting",
            "owner_user_id": str(editor.id),
        },
    )
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["fit"] == 4 and p["priority"] == "warm" and p["committed_on"] == "2026-10-12"
    assert p["owner"]["user_id"] == str(editor.id) and p["follow_up_state"] == "later"
    acts = await activities_of(db, inv)
    by_kind = {a.kind: a for a in acts}
    assert set(by_kind) == {"stage_change", "commitment", "follow_up_set", "participant_updated"}
    assert by_kind["stage_change"].body == "They answered within a day."
    assert by_kind["commitment"].data == {
        "amount": 100_000,
        "currency": "USD",
        "committed_on": "2026-10-12",
    }
    changes = by_kind["participant_updated"].data["changes"]
    assert set(changes) == {"fit", "amount_soft", "next_step", "owner"}
    assert changes["owner"]["to"] == editor.name

    r = await c.patch(url, json={"fit": 4})
    assert len(await activities_of(db, inv)) == len(acts)  # no-op
    r = await c.patch(url, json={"owner_user_id": str((await make_investor(db, w.ws)).id)})
    assert r.status_code == 422
    r = await c.patch(url, json={"fit": 9})
    assert r.status_code == 422


async def test_move_stage_follow_up_commitment_and_remove(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await world(db)
    inv = await dana(db, w.ws)
    await make_participant(db, w.rnd, inv, stage="meeting")
    c = key_client(w.key)
    base = f"/v1/rounds/seed/participants/{inv.id}"

    r = await c.post(f"{base}/stage", json={"stage": "dd", "note": "Data room opened"})
    body = r.json()
    assert body["changed"] is True and body["from"]["key"] == "meeting"
    assert body["to"]["key"] == "dd" and body["participant"]["stage"]["key"] == "dd"
    r = await c.post(f"{base}/stage", json={"stage": "Diligence"})
    assert r.json()["changed"] is False

    r = await c.post(f"{base}/follow-up", json={"in_days": 3, "note": "Check on DD"})
    assert r.json()["changed"] is True
    assert r.json()["participant"]["follow_up_on"] == "2026-10-15"
    r = await c.post(f"{base}/follow-up", json={"on": "2026-10-15", "note": "Check on DD"})
    assert r.json()["changed"] is False
    r = await c.post(f"{base}/follow-up", json={"on": "2026-10-15", "in_days": 1})
    assert r.status_code == 422
    r = await c.post(f"{base}/follow-up", json={"clear": True})
    assert r.json()["participant"].get("follow_up_on") is None
    fu = (await activities_of(db, inv, "follow_up_set"))[-1]
    assert fu.data["to"] is None and fu.data["from"] == "2026-10-15"

    r = await c.post(f"{base}/commitment", json={"amount": 300_000, "note": "Signed the SAFE"})
    body = r.json()
    assert body["moved_stage"] is True and body["previous_amount"] is None
    assert body["round_committed_total"] == 300_000
    assert body["participant"]["stage"]["key"] == "committed"
    move = (await activities_of(db, inv, "stage_change"))[-1]
    assert move.data["reason"] == "commitment" and move.body == "Signed the SAFE"
    before = len(await activities_of(db, inv))
    r = await c.post(f"{base}/commitment", json={"amount": 300_000})
    assert r.json()["moved_stage"] is False and r.json()["previous_amount"] == 300_000
    assert len(await activities_of(db, inv)) == before  # repeat = no-op
    r = await c.post(f"{base}/commitment", json={"amount": 350_000})
    assert r.json()["round_committed_total"] == 350_000
    commit = (await activities_of(db, inv, "commitment"))[-1]
    assert commit.data["previous_amount"] == 300_000 and commit.data["amount"] == 350_000

    r = await c.delete(base)
    assert r.status_code == 204
    assert await participant(db, w.rnd, inv) is None
    assert (await activities_of(db, inv, "removed_from_round"))[0].data == {
        "stage": {"key": "committed", "label": "Committed"}
    }
    r = await c.post(f"{base}/stage", json={"stage": "dd"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_in_round"
    assert "/v1/rounds/seed/participants" in r.json()["error"]["message"]
    assert (await c.get(base)).status_code == 409


async def test_commitment_adds_to_round(db: AsyncSession, key_client: Any) -> None:
    w = await world(db)
    inv = await dana(db, w.ws)
    r = await key_client(w.key).post(
        f"/v1/rounds/seed/participants/{inv.id}/commitment", json={"amount": 100_000}
    )
    assert r.status_code == 200, r.text
    assert r.json()["participant"]["stage"]["key"] == "committed"
    assert r.json()["moved_stage"] is True
    kinds = [a.kind for a in await activities_of(db, inv)]
    assert kinds == ["added_to_round", "commitment"]


async def test_bulk_add(db: AsyncSession, key_client: Any) -> None:
    w = await world(db)
    a, b, c_ = [await make_investor(db, w.ws) for _ in range(3)]
    await make_participant(db, w.rnd, a)
    c = key_client(w.key)
    r = await c.post(
        "/v1/rounds/seed/participants/bulk",
        json={"investor_ids": [str(a.id), str(b.id), str(c_.id)], "stage": "research"},
    )
    assert r.json() == {"added": 2, "already": 1}
    assert (await participant(db, w.rnd, b)) is not None
    other = await make_round(db, w.ws, name="Bridge", slug="bridge")
    stranger_ws_inv = await make_investor(db, (await world(db, name="Other")).ws)
    r = await c.post(
        "/v1/rounds/bridge/participants/bulk",
        json={"investor_ids": [str(a.id), str(stranger_ws_inv.id)]},
    )
    assert r.status_code == 404
    assert await participant(db, other, a) is None  # nothing added


async def test_list_filters_and_sorts(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    from datetime import date

    w = await world(db)
    owner = w.owner
    a = await make_investor(db, w.ws, name="Ada Ellery", firm="Zeta Fund", tags=["AI"])
    b = await make_investor(db, w.ws, name="Bo Strand", firm="Alpha Partners", type="angel")
    c_ = await make_investor(db, w.ws, name="Cy Holloway", firm="Mid Capital")
    await make_participant(
        db, w.rnd, a, stage="meeting", fit=5, follow_up_on=date(2026, 10, 1), owner_user_id=owner.id
    )
    await make_participant(db, w.rnd, b, stage="new", fit=2, amount_soft=500_000)
    await make_participant(db, w.rnd, c_, stage="committed", fit=3, amount_committed=50_000)
    cl = key_client(w.key)
    url = "/v1/rounds/seed/participants"

    async def names(**params: Any) -> list[str]:
        r = await cl.get(url, params=params)
        assert r.status_code == 200, r.text
        return [p["investor"]["name"] for p in r.json()["data"]]

    assert await names() == ["Ada Ellery", "Cy Holloway", "Bo Strand"]
    assert await names(sort="name") == ["Ada Ellery", "Bo Strand", "Cy Holloway"]
    assert await names(sort="firm") == ["Bo Strand", "Cy Holloway", "Ada Ellery"]
    assert await names(sort="stage") == ["Bo Strand", "Ada Ellery", "Cy Holloway"]
    assert await names(sort="amount") == ["Bo Strand", "Cy Holloway", "Ada Ellery"]
    assert await names(stage=["new", "Committed"]) == ["Cy Holloway", "Bo Strand"]
    assert await names(fit_min=3) == ["Ada Ellery", "Cy Holloway"]
    assert await names(type="angel") == ["Bo Strand"]
    assert await names(tag="ai") == ["Ada Ellery"]
    assert await names(follow_up="due") == ["Ada Ellery"]
    assert await names(follow_up="none") == ["Cy Holloway", "Bo Strand"]
    assert await names(owner=str(owner.id)) == ["Ada Ellery"]
    assert await names(owner="none") == ["Cy Holloway", "Bo Strand"]
    assert await names(q="alpha") == ["Bo Strand"]
    r = (await cl.get(url, params={"limit": 2})).json()
    assert r["total"] == 3 and r["next_cursor"]
    r = (await cl.get(url, params={"limit": 2, "cursor": r["next_cursor"]})).json()
    assert [p["investor"]["name"] for p in r["data"]] == ["Bo Strand"]
    assert (await cl.get(url, params={"stage": "zzz"})).status_code == 422
    p = (await cl.get(f"{url}/{a.id}")).json()
    assert p["follow_up_state"] == "overdue" and p["owner"]["email"] == owner.email


# --- bulk update (UX pass 1, P1-6) ---------------------------------------------------------


async def _thirty(db: AsyncSession, w: Any) -> list[Any]:
    from datetime import date

    stages = ["new", "research", "contacted", "meeting", "dd"]
    out = []
    for i in range(30):
        inv = await make_investor(db, w.ws, tags=["warm"] if i % 2 else [])
        await make_participant(
            db,
            w.rnd,
            inv,
            stage=stages[i % len(stages)],
            fit=i % 6,
            follow_up_on=date(2026, 10, 1 + i % 20) if i % 3 else None,
            follow_up_note="Check in" if i % 3 else None,
        )
        out.append(inv)
    return out


async def test_bulk_move_is_one_request_and_restore_undoes_it(
    db: AsyncSession, session_client: Any, frozen_now: Any
) -> None:
    from sqlalchemy import select

    from raisebook.models.activity import Activity

    w = await world(db)
    invs = await _thirty(db, w)
    c = await session_client(w.owner, w.ws)
    before = {
        p["investor"]["id"]: p
        for p in (await c.get("/v1/rounds/seed/participants?limit=100")).json()["data"]
    }
    ids = [str(i.id) for i in invs]

    r = await c.post(
        "/v1/rounds/seed/participants/bulk-update",
        json={"op": "stage", "investor_ids": ids, "stage": "Passed"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["changed"] == 30 and body["unchanged"] == 0 and body["op"] == "stage"
    assert {p["stage"]["key"] for p in body["participants"]} == {"passed"}
    assert [p["investor"]["id"] for p in body["participants"]] == ids
    acts = list(await db.scalars(select(Activity).where(Activity.kind == "stage_change")))
    assert len(acts) == 30
    assert {a.data["bulk_id"] for a in acts} == {body["bulk_id"]}

    # Repeating it is a no-op.
    r = await c.post(
        "/v1/rounds/seed/participants/bulk-update",
        json={"op": "stage", "investor_ids": ids, "stage": "passed"},
    )
    assert r.json()["changed"] == 0 and r.json()["unchanged"] == 30

    # Undo: put every investor's previous stage back in one request.
    items = [{"investor_id": i, "stage": before[i]["stage"]["key"]} for i in ids]
    r = await c.post(
        "/v1/rounds/seed/participants/bulk-update", json={"op": "restore", "items": items}
    )
    assert r.status_code == 200, r.text
    after = {p["investor"]["id"]: p["stage"]["key"] for p in r.json()["participants"]}
    assert after == {i: before[i]["stage"]["key"] for i in ids}
    # The Undo's own activities say so (timelines drop the move and its undo as a pair).
    undone = [
        a
        for a in await db.scalars(select(Activity).where(Activity.kind == "stage_change"))
        if a.data.get("bulk_id") == r.json()["bulk_id"]
    ]
    assert len(undone) == 30 and all(a.data.get("undo") is True for a in undone)
    assert not any(a.data.get("undo") for a in acts)


async def test_bulk_follow_up_owner_fit_tags_and_remove(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    w = await world(db)
    invs = await _thirty(db, w)
    editor = await add_member(db, w.ws, role="editor")
    c = key_client(w.key)
    url = "/v1/rounds/seed/participants/bulk-update"
    ids = [str(i.id) for i in invs[:6]]

    r = await c.post(
        url, json={"op": "follow_up", "investor_ids": ids, "follow_up_on": "2026-10-19"}
    )
    assert r.status_code == 200, r.text
    assert {p["follow_up_on"] for p in r.json()["participants"]} == {"2026-10-19"}
    r = await c.post(url, json={"op": "follow_up", "investor_ids": ids, "follow_up_on": None})
    ps = r.json()["participants"]
    assert all(p.get("follow_up_on") is None and p.get("follow_up_note") is None for p in ps)

    r = await c.post(
        url, json={"op": "owner", "investor_ids": ids, "owner_user_id": str(editor.id)}
    )
    assert {p["owner"]["user_id"] for p in r.json()["participants"]} == {str(editor.id)}
    r = await c.post(url, json={"op": "owner", "investor_ids": ids, "owner_user_id": None})
    assert all(p.get("owner") is None for p in r.json()["participants"])
    stranger = await make_investor(db, w.ws)  # not a member: an investor id
    r = await c.post(
        url, json={"op": "owner", "investor_ids": ids, "owner_user_id": str(stranger.id)}
    )
    assert r.status_code == 422

    r = await c.post(url, json={"op": "fit", "investor_ids": ids, "fit": 5})
    assert {p["priority"] for p in r.json()["participants"]} == {"hot"}

    r = await c.post(url, json={"op": "add_tag", "investor_ids": ids, "tag": "Warm"})
    assert r.json()["changed"] == 3  # the odd ones already have "warm"
    for p in r.json()["participants"]:
        assert [t.casefold() for t in p["investor"]["tags"]] == ["warm"]
    r = await c.post(url, json={"op": "remove_tag", "investor_ids": ids, "tag": "warm"})
    assert r.json()["changed"] == 6
    assert all(p["investor"]["tags"] == [] for p in r.json()["participants"])
    tagged = await activities_of(db, invs[0], "investor_updated")
    assert tagged and tagged[-1].data["bulk_id"] == r.json()["bulk_id"]

    r = await c.post(url, json={"op": "stage", "investor_ids": ids})
    assert r.status_code == 422
    r = await c.post(url, json={"op": "fit", "investor_ids": ids, "fit": 9})
    assert r.status_code == 422
    assert (
        await c.post(url, json={"op": "stage", "investor_ids": [], "stage": "new"})
    ).status_code == 422

    r = await c.post(url, json={"op": "remove", "investor_ids": ids})
    assert r.status_code == 200 and r.json()["removed"] == ids and r.json()["participants"] == []
    assert await participant(db, w.rnd, invs[0]) is None
    removed = await activities_of(db, invs[0], "removed_from_round")
    assert removed[0].data["bulk_id"] == r.json()["bulk_id"]
    # Undo a removal: restore adds them back with their fields.
    items = [
        {"investor_id": i, "stage": "meeting", "fit": 4, "next_step": "Send deck"} for i in ids
    ]
    r = await c.post(url, json={"op": "restore", "items": items})
    assert r.status_code == 200, r.text
    assert r.json()["changed"] == 6
    assert {(p["stage"]["key"], p["fit"], p["next_step"]) for p in r.json()["participants"]} == {
        ("meeting", 4, "Send deck")
    }


async def test_bulk_is_all_or_nothing(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    w = await world(db)
    invs = await _thirty(db, w)
    outsider = await make_investor(db, w.ws)  # in the workspace, not in the round
    other = await make_investor(db, (await world(db, name="Other")).ws)
    c = key_client(w.key)
    url = "/v1/rounds/seed/participants/bulk-update"
    ids = [str(i.id) for i in invs[:3]]

    r = await c.post(
        url, json={"op": "stage", "investor_ids": [*ids, str(other.id)], "stage": "passed"}
    )
    assert r.status_code == 404
    r = await c.post(
        url, json={"op": "stage", "investor_ids": [*ids, str(outsider.id)], "stage": "passed"}
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_in_round"
    assert outsider.name in r.json()["error"]["message"]
    for inv in invs[:3]:
        p = await participant(db, w.rnd, inv)
        assert p is not None
        await db.refresh(p)
    assert [a.kind for a in await activities_of(db, invs[0])] == []
    r = await c.post(
        url, json={"op": "stage", "investor_ids": [str(invs[0].id)] * 1001, "stage": "new"}
    )
    assert r.status_code == 422
    reader = key_client(w.reader)
    r = await reader.post(url, json={"op": "fit", "investor_ids": ids, "fit": 1})
    assert r.status_code == 403
