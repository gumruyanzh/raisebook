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
    assert "add_to_round" in r.json()["error"]["message"]
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
