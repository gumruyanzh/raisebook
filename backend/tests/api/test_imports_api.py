"""``/v1/imports`` (SPEC §5.8): preview, commit, runs, permissions, isolation, limits."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core import ratelimit
from raisebook.models.activity import Activity
from raisebook.models.investor import Investor
from tests.factories import (
    add_member,
    make_api_key,
    make_investor,
    make_round,
    make_workspace,
    owner_of,
)
from tests.matrix import ALL, PRINCIPALS, WRITERS, Row, run_row

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
CSV = "Name,Email,Pipeline stage\nDana Whitfield,dana@example.com,Meeting\n"


async def count_investors(db: AsyncSession, ws: Any) -> int:
    return int(
        await db.scalar(
            select(func.count()).select_from(Investor).where(Investor.workspace_id == ws.id)
        )
        or 0
    )


ROWS = [
    Row("import preview", "POST", "/v1/imports/preview", allowed=WRITERS, body={"content": CSV}),
    Row("import commit", "POST", "/v1/imports", allowed=WRITERS, body={"content": CSV}),
    Row("list imports", "GET", "/v1/imports", allowed=ALL),
]


@pytest.mark.parametrize("principal", PRINCIPALS)
@pytest.mark.parametrize("row", ROWS, ids=lambda r: r.name)
async def test_permissions(
    row: Row, principal: str, db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    await run_row(row, principal, db, session_client, key_client)


async def test_preview_then_commit_over_rest(
    db: AsyncSession, session_client: Any, frozen_now: Any
) -> None:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    await make_round(db, ws, name="Seed")
    c = await session_client(owner, ws)
    body = {
        "format": "csv",
        "content": (FIXTURES / "investors_basic.csv").read_text(),
        "round": "seed",
        "filename": "investors_basic.csv",
    }
    r = await c.post("/v1/imports/preview", json=body)
    assert r.status_code == 200, r.text
    pv = r.json()
    assert pv["counts"] == {"create": 4, "update": 0, "skip": 1, "error": 3, "add_to_round": 4}
    assert pv["columns"][0] == "Full Name" and pv["mapping"]["Full Name"] == "name"
    assert await count_investors(db, ws) == 0

    r = await c.post("/v1/imports", json=body)
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["counts"]["created"] == 4 and res["counts"]["errors"] == 3
    assert res["round"]["slug"] == "seed"
    assert await count_investors(db, ws) == 4

    r = await c.get("/v1/imports")
    assert r.status_code == 200
    (run,) = r.json()["data"]
    assert run["id"] == res["import_run_id"] and run["filename"] == "investors_basic.csv"
    assert run["actor_type"] == "user" and run["round_name"] == "Seed"


async def test_agent_import_is_attributed(
    db: AsyncSession, key_client: Any, frozen_now: Any
) -> None:
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws, scopes="read,write", name="Agent key")
    c = key_client(raw, headers={"X-Agent-Name": "codex", "X-Agent-Model": "gpt-test"})
    r = await c.post("/v1/imports", json={"content": CSV})
    assert r.status_code == 200, r.text
    acts = list(await db.scalars(select(Activity).where(Activity.workspace_id == ws.id)))
    assert acts and all(
        a.actor_type == "agent"
        and a.actor_label == "codex"
        and a.agent_model == "gpt-test"
        and a.via == "import"
        for a in acts
    )
    runs = (await c.get("/v1/imports")).json()["data"]
    assert runs[0]["actor_type"] == "agent" and runs[0]["actor_label"] == "codex"


async def test_errors(db: AsyncSession, session_client: Any, frozen_now: Any) -> None:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    c = await session_client(owner, ws)
    r = await c.post("/v1/imports/preview", json={"content": "Name\nDana\n", "round": "nope"})
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    r = await c.post(
        "/v1/imports/preview", json={"content": "Name\nDana\n", "mapping": {"Nope": "name"}}
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "import_invalid"
    r = await c.post("/v1/imports/preview", json={"content": "Name\nDana\n", "colour": "red"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
    r = await c.post(
        "/v1/imports/preview", json={"format": "prototype_json", "content": "not json"}
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "import_invalid"


async def test_isolation(
    db: AsyncSession, session_client: Any, key_client: Any, frozen_now: Any
) -> None:
    a = await make_workspace(db)
    b = await make_workspace(db)
    theirs = await make_round(db, b, name="Theirs")
    await make_investor(db, b, name="Dana Whitfield", email="dana@example.com")
    b_owner = await owner_of(db, b)
    await (await session_client(b_owner, b)).post("/v1/imports", json={"content": CSV})
    _, raw = await make_api_key(db, a, scopes="read,write")
    c = key_client(raw)
    for ref in (str(theirs.id), str(theirs.slug), theirs.name):
        r = await c.post("/v1/imports/preview", json={"content": CSV, "round": ref})
        assert r.status_code == 404, ref
    r = await c.post("/v1/imports/preview", json={"content": CSV})
    assert r.json()["rows"][0]["action"] == "create"  # B's Dana is invisible to A
    assert (await c.get("/v1/imports")).json()["data"] == []
    # A session member of A addressing B with X-Workspace gets workspace_not_found.
    a_owner = await owner_of(db, a)
    sc = await session_client(a_owner, b)
    r = await sc.post("/v1/imports/preview", json={"content": CSV})
    assert r.status_code == 404 and r.json()["error"]["code"] == "workspace_not_found"


async def test_rate_limit(
    db: AsyncSession, key_client: Any, monkeypatch: Any, frozen_now: Any
) -> None:
    monkeypatch.setitem(ratelimit.LIMITS, "import", ratelimit.Limit(2, 3600))
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws, scopes="read,write")
    c = key_client(raw)
    for _ in range(2):
        assert (await c.post("/v1/imports/preview", json={"content": CSV})).status_code == 200
    r = await c.post("/v1/imports", json={"content": CSV})
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"
    assert "Retry-After" in r.headers


async def test_viewer_cannot_import_but_can_list(
    db: AsyncSession, session_client: Any, frozen_now: Any
) -> None:
    ws = await make_workspace(db)
    viewer = await add_member(db, ws, role="viewer")
    c = await session_client(viewer, ws)
    r = await c.post("/v1/imports", json={"content": CSV})
    assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden_role"
    assert (await c.get("/v1/imports")).status_code == 200
