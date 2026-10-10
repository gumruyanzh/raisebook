"""Export routes (SPEC §5.8): files, headers, permissions, isolation, rate limit."""

from __future__ import annotations

import json
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core import ratelimit
from tests.factories import (
    add_member,
    make_api_key,
    make_investor,
    make_participant,
    make_round,
    make_workspace,
    owner_of,
)
from tests.matrix import ALL, PRINCIPALS, Ctx, Row, run_row


async def _round_setup(db: AsyncSession, ctx: Ctx) -> dict[str, Any]:
    return {"round": await make_round(db, ctx.ws, name="Seed")}


ROWS = [
    Row("export workspace", "GET", "/v1/export?format=json", allowed=ALL),
    Row("export investors", "GET", "/v1/investors/export?format=csv", allowed=ALL),
    Row(
        "export round",
        "GET",
        lambda c, _p: f"/v1/rounds/{c.extra['round'].slug}/export?format=csv",
        allowed=ALL,
        setup=_round_setup,
    ),
]


@pytest.mark.parametrize("principal", PRINCIPALS)
@pytest.mark.parametrize("row", ROWS, ids=lambda r: r.name)
async def test_permissions(
    row: Row, principal: str, db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    r = await run_row(row, principal, db, session_client, key_client)
    assert r.status_code == 200, r.text


async def test_files_and_headers(db: AsyncSession, session_client: Any, frozen_now: Any) -> None:
    ws = await make_workspace(db, name="Kestrel Robotics")
    viewer = await add_member(db, ws, role="viewer")
    rnd = await make_round(db, ws, name="Seed")
    inv = await make_investor(db, ws, name="Dana Whitfield", email="dana@example.com")
    await make_participant(db, rnd, inv, stage="meeting", fit=4)
    c = await session_client(viewer, ws)

    r = await c.get("/v1/rounds/seed/export?format=csv")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert r.headers["content-disposition"] == (
        f'attachment; filename="raisebook-{ws.slug}-seed-20261012.csv"'
    )
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["x-row-count"] == "1"
    assert r.text.startswith("investor_id,name,firm")
    assert "Dana Whitfield" in r.text

    r = await c.get(f"/v1/rounds/{rnd.id}/export?format=json&include_activities=true")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    doc = r.json()
    assert doc["format"] == "raisebook.round" and doc["participants"][0]["timeline"] == []

    r = await c.get("/v1/export?format=json")
    assert r.status_code == 200 and json.loads(r.text)["format"] == "raisebook.export"
    r = await c.get("/v1/investors/export")
    assert r.status_code == 200 and "rounds" in r.text.splitlines()[0]
    r = await c.get(f"/v1/investors/export?ids={inv.id}")
    assert r.headers["x-row-count"] == "1"

    r = await c.get("/v1/export?format=csv")
    assert r.status_code == 422
    r = await c.get("/v1/rounds/seed/export?format=xml")
    assert r.status_code == 422


async def test_isolation(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    a = await make_workspace(db)
    b = await make_workspace(db)
    theirs = await make_round(db, b, name="Theirs")
    their_inv = await make_investor(db, b, name="Secret Person", email="secret@example.com")
    await make_participant(db, theirs, their_inv)
    _, raw = await make_api_key(db, a, scopes="read")
    c = key_client(raw)
    for ref in (str(theirs.id), str(theirs.slug)):
        r = await c.get(f"/v1/rounds/{ref}/export?format=json")
        assert r.status_code == 404, ref
    r = await c.get("/v1/export?format=json")
    assert "Secret Person" not in r.text and "secret@example.com" not in r.text
    r = await c.get(f"/v1/investors/export?ids={their_inv.id}")
    assert r.status_code == 200 and "Secret Person" not in r.text
    assert r.headers["x-row-count"] == "0"
    _ = await owner_of(db, a)


async def test_rate_limit(
    db: AsyncSession, key_client: Any, monkeypatch: Any, frozen_now: Any
) -> None:
    monkeypatch.setitem(ratelimit.LIMITS, "export", ratelimit.Limit(1, 3600))
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws, scopes="read")
    c = key_client(raw)
    assert (await c.get("/v1/investors/export")).status_code == 200
    r = await c.get("/v1/export")
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"
