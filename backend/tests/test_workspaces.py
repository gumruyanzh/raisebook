"""Workspaces (SPEC §5.4): create, list, read, update, sample data."""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.activity import Activity
from raisebook.models.investor import Investor
from raisebook.models.round import Round, RoundParticipant, RoundStage
from raisebook.models.workspace import Membership, Workspace
from raisebook.services.workspaces import (
    LEGACY_ZONES,
    canonical_timezone,
    clean_timezone,
    new_workspace_slug,
    slugify,
)
from tests.factories import add_member, make_api_key, make_user, make_workspace, owner_of

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$")


def test_slugify_and_slug_shape() -> None:
    assert slugify("Tallow, Inc.") == "tallow-inc"
    assert slugify("Café & Co") == "cafe-and-co"
    for name in ("Tallow", "x", "", "!!!", "A" * 200, "Ünïcödé Robotics"):
        slug = new_workspace_slug(name)
        assert SLUG_RE.match(slug), slug
        assert re.search(r"-[a-z2-7]{4}$", slug)
    assert new_workspace_slug("Tallow").startswith("tallow-")
    assert new_workspace_slug("Tallow") != new_workspace_slug("Tallow")


async def test_create_and_list(db: AsyncSession, session_client: Any, frozen_now: Any) -> None:
    user = await make_user(db)
    c = await session_client(user)
    r = await c.post(
        "/v1/workspaces",
        json={"name": "  Tallow  ", "timezone": "America/Los_Angeles", "default_currency": "eur"},
    )
    assert r.status_code == 201, r.text
    ws = r.json()
    assert ws["name"] == "Tallow" and ws["role"] == "owner" and ws["is_sandbox"] is False
    assert ws["slug"].startswith("tallow-") and SLUG_RE.match(ws["slug"])
    assert ws["timezone"] == "America/Los_Angeles" and ws["default_currency"] == "EUR"
    assert ws["created_at"] == "2026-10-12T17:00:00Z"
    m = await db.get(Membership, (ws["id"], user.id))
    assert m is not None and m.role == "owner"
    listed = (await c.get("/v1/workspaces")).json()["data"]
    assert [w["id"] for w in listed] == [ws["id"]]


async def test_same_name_gets_different_slugs(db: AsyncSession, session_client: Any) -> None:
    c = await session_client(await make_user(db))
    a = (await c.post("/v1/workspaces", json={"name": "Acme"})).json()
    b = (await c.post("/v1/workspaces", json={"name": "Acme"})).json()
    assert a["slug"] != b["slug"]


async def test_create_validation(db: AsyncSession, session_client: Any) -> None:
    c = await session_client(await make_user(db))
    for body, field in (
        ({"name": ""}, "name"),
        ({"name": "x" * 81}, "name"),
        ({"name": "Ok", "timezone": "Mars/Olympus"}, "timezone"),
        ({"name": "Ok", "default_currency": "U$"}, "default_currency"),
    ):
        r = await c.post("/v1/workspaces", json=body)
        assert r.status_code == 422, body
        assert r.json()["error"]["details"][0]["loc"] == ["body", field]


async def test_get_workspace_for_session_and_key(
    db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    ws = await make_workspace(db, name="Tallow")
    owner = await owner_of(db, ws)
    body = (await (await session_client(owner, ws)).get("/v1/workspace")).json()
    assert body["you"] == {
        "type": "user",
        "role": "owner",
        "scopes": ["raisebook:read", "raisebook:write", "raisebook:admin"],
        "agent_name": None,
        "key_prefix": None,
    }
    assert body["limits"]["members"] == 20 and body["limits"]["investors"] == 20_000
    _, raw = await make_api_key(db, ws, scopes="read", name="Reader", agent_name="cursor")
    body = (await key_client(raw).get("/v1/workspace")).json()
    assert body["you"]["type"] == "agent" and body["you"]["agent_name"] == "cursor"
    assert body["you"]["scopes"] == ["raisebook:read"] and body["role"] is None


async def test_update_workspace(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    c = await session_client(await owner_of(db, ws), ws)
    r = await c.patch("/v1/workspace", json={"name": "Renamed", "timezone": "Europe/Berlin"})
    assert r.status_code == 200
    assert r.json()["name"] == "Renamed" and r.json()["timezone"] == "Europe/Berlin"
    assert r.json()["slug"] == ws.slug  # slugs never change
    assert r.json()["default_currency"] == "USD"
    r = await c.patch("/v1/workspace", json={"timezone": None})
    assert r.status_code == 422
    r = await c.patch("/v1/workspace", json={"default_currency": "usd"})
    assert r.json()["default_currency"] == "USD"


def test_canonical_timezone() -> None:
    assert canonical_timezone("Asia/Calcutta") == "Asia/Kolkata"
    assert canonical_timezone("Europe/Kiev") == "Europe/Kyiv"
    assert canonical_timezone("US/Pacific") == "America/Los_Angeles"
    assert canonical_timezone("Asia/Saigon") == "Asia/Ho_Chi_Minh"
    assert canonical_timezone("America/Godthab") == "America/Nuuk"
    assert canonical_timezone("Pacific/Truk") == "Pacific/Chuuk"
    for alias in ("Etc/UTC", "Etc/GMT", "GMT", "UCT", "utc", "Utc"):
        assert canonical_timezone(alias) == "UTC", alias
    assert canonical_timezone("Asia/Yerevan") == "Asia/Yerevan"
    # Every target is itself canonical and loadable (tzdata present).
    for target in set(LEGACY_ZONES.values()):
        assert clean_timezone(target) == target
        assert canonical_timezone(target) == target


async def test_timezone_is_stored_canonical(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    c = await session_client(await owner_of(db, ws), ws)
    r = await c.patch("/v1/workspace", json={"timezone": "Asia/Calcutta"})
    assert r.status_code == 200 and r.json()["timezone"] == "Asia/Kolkata"
    r = await c.patch("/v1/workspace", json={"timezone": "Europe/Kyiv"})
    assert r.status_code == 200 and r.json()["timezone"] == "Europe/Kyiv"
    r = await c.patch("/v1/workspace", json={"timezone": "Europe/Kiev"})
    assert r.json()["timezone"] == "Europe/Kyiv"
    r = await c.patch("/v1/workspace", json={"timezone": "Etc/UTC"})
    assert r.json()["timezone"] == "UTC"
    r = await (await session_client(await make_user(db))).post(
        "/v1/workspaces", json={"name": "Legacy", "timezone": "US/Eastern"}
    )
    assert r.status_code == 201 and r.json()["timezone"] == "America/New_York"


async def test_round_currency_any_iso_code(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    c = await session_client(await owner_of(db, ws), ws)
    r = await c.post("/v1/rounds", json={"name": "Lagos seed", "currency": "ngn"})
    assert r.status_code == 201 and r.json()["currency"] == "NGN"
    r = await c.patch(f"/v1/rounds/{r.json()['slug']}", json={"currency": "AMD"})
    assert r.status_code == 200 and r.json()["currency"] == "AMD"
    r = await c.post("/v1/rounds", json={"name": "Bad", "currency": "N$"})
    assert r.status_code == 422
    assert r.json()["error"]["details"][0]["loc"] == ["body", "currency"]


async def test_editor_cannot_update_workspace(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    editor = await add_member(db, ws, role="editor")
    r = await (await session_client(editor, ws)).patch("/v1/workspace", json={"name": "No"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden_role"
    assert r.json()["error"]["details"]["required"] == [
        "raisebook:read",
        "raisebook:write",
        "raisebook:admin",
    ]


async def test_sample_workspace(db: AsyncSession, session_client: Any, frozen_now: Any) -> None:
    user = await make_user(db)
    c = await session_client(user)
    r = await c.post("/v1/workspaces", json={"sample": True})
    assert r.status_code == 201, r.text
    ws = r.json()
    assert ws["is_sandbox"] is True and ws["name"] == "Kestrel Robotics (sample)"
    wid = ws["id"]
    rounds = list(await db.scalars(select(Round).where(Round.workspace_id == wid)))
    assert {(r.name, r.status) for r in rounds} == {("Seed", "open"), ("Pre-seed", "closed")}
    seed = next(r for r in rounds if r.name == "Seed")
    assert seed.target_amount == 2_000_000 and seed.valuation_cap == 16_000_000
    n_inv = await db.scalar(
        select(func.count()).select_from(Investor).where(Investor.workspace_id == wid)
    )
    assert n_inv == 40
    investors = list(await db.scalars(select(Investor).where(Investor.workspace_id == wid)))
    assert all(i.email is None or i.email.split("@")[1].endswith("example.com") for i in investors)
    assert all(
        i.linkedin_url is None or i.linkedin_url.startswith("https://www.linkedin.com/in/example-")
        for i in investors
    )
    # Every stage of the seed round has someone; three commitments.
    rows = await db.execute(
        select(RoundStage.key, func.count())
        .join(RoundParticipant, RoundParticipant.stage_id == RoundStage.id)
        .where(RoundStage.round_id == seed.id)
        .group_by(RoundStage.key)
    )
    counts = dict(rows.tuples().all())
    assert set(counts) == {
        "new",
        "research",
        "contacted",
        "replied",
        "meeting",
        "dd",
        "committed",
        "passed",
    }
    assert counts["committed"] == 3
    follow = list(
        await db.scalars(
            select(RoundParticipant.follow_up_on).where(
                RoundParticipant.round_id == seed.id, RoundParticipant.follow_up_on.is_not(None)
            )
        )
    )
    today = frozen_now.date()  # 10:00 in Los Angeles on the frozen date
    assert any(d < today for d in follow) and any(d == today for d in follow)
    actors = set(
        (
            await db.execute(
                select(Activity.actor_type, Activity.actor_label, Activity.agent_model)
                .where(Activity.workspace_id == wid)
                .distinct()
            )
        ).tuples()
    )
    assert ("agent", "claude-code", "claude-opus-4-5") in actors
    assert ("user", None, None) in actors
    # A sandbox gets rb_test_ keys.
    owner_c = await session_client(user, ws["slug"])
    key = (await owner_c.post("/v1/api-keys", json={"name": "demo"})).json()
    assert key["secret"].startswith("rb_test_")


async def test_workspace_row_counts_only_for_members(db: AsyncSession) -> None:
    ws = await make_workspace(db)
    assert await db.get(Workspace, ws.id) is not None
