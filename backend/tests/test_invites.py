"""Invites (SPEC §5.4): create, replace, limits, lookup, accept, revoke."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core import clock
from raisebook.core.ratelimit import LIMITS, Limit
from raisebook.models.workspace import Invite, Membership
from tests.factories import (
    add_member,
    make_api_key,
    make_invite,
    make_user,
    make_workspace,
    owner_of,
)


async def owner_client(db: AsyncSession, session_client: Any) -> tuple[Any, Any, Any]:
    ws = await make_workspace(db, name="Qenzo")
    owner = await owner_of(db, ws)
    return ws, owner, await session_client(owner, ws)


async def test_owner_invites_and_email_is_sent(
    db: AsyncSession, session_client: Any, outbox: list[Any]
) -> None:
    _ws, owner, c = await owner_client(db, session_client)
    r = await c.post("/v1/invites", json={"email": "Cofounder@Example.com", "role": "editor"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] == "cofounder@example.com" and body["status"] == "pending"
    assert body["invited_by"] == owner.name
    assert body["dev_link"].startswith("http://localhost:3000/invite/")
    assert len(outbox) == 1 and outbox[0].to == "cofounder@example.com"
    assert outbox[0].subject == "You're invited to a workspace on Raisebook"
    assert '"Qenzo"' in outbox[0].text and body["dev_link"] in outbox[0].text
    listed = (await c.get("/v1/invites")).json()["data"]
    assert [i["id"] for i in listed] == [body["id"]] and "dev_link" not in listed[0]


async def test_new_invite_replaces_pending(db: AsyncSession, session_client: Any) -> None:
    _ws, _owner, c = await owner_client(db, session_client)
    first = (await c.post("/v1/invites", json={"email": "a@example.com"})).json()
    second = (await c.post("/v1/invites", json={"email": "a@example.com", "role": "viewer"})).json()
    statuses = {i["id"]: i["status"] for i in (await c.get("/v1/invites")).json()["data"]}
    assert statuses == {first["id"]: "revoked", second["id"]: "pending"}


async def test_already_member(db: AsyncSession, session_client: Any) -> None:
    ws, _owner, c = await owner_client(db, session_client)
    member = await add_member(db, ws, role="viewer")
    r = await c.post("/v1/invites", json={"email": member.email})
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_member"


async def test_member_limit_counts_pending_invites(db: AsyncSession, session_client: Any) -> None:
    ws, _owner, c = await owner_client(db, session_client)
    for _ in range(9):
        await add_member(db, ws)
    for _ in range(10):
        await make_invite(db, ws)
    r = await c.post("/v1/invites", json={"email": "twentyfirst@example.com"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "limit_reached"


async def test_invite_rate_limit(db: AsyncSession, session_client: Any, monkeypatch: Any) -> None:
    monkeypatch.setitem(LIMITS, "invite", Limit(2, 86400))
    _ws, _owner, c = await owner_client(db, session_client)
    for i in range(2):
        assert (await c.post("/v1/invites", json={"email": f"r{i}@example.com"})).status_code == 201
    r = await c.post("/v1/invites", json={"email": "r3@example.com"})
    assert r.status_code == 429 and "retry-after" in r.headers


async def test_only_owner_session_invites(
    db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    ws = await make_workspace(db)
    editor = await add_member(db, ws)
    r = await (await session_client(editor, ws)).post(
        "/v1/invites", json={"email": "x@example.com"}
    )
    assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden_role"
    _, raw = await make_api_key(db, ws, scopes="read,write,admin")
    r = await key_client(raw).post("/v1/invites", json={"email": "x@example.com"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "insufficient_scope"
    assert (await key_client(raw).get("/v1/invites")).status_code == 200  # admin may list


async def test_lookup(db: AsyncSession, client: httpx.AsyncClient, frozen_now: Any) -> None:
    ws = await make_workspace(db, name="Qenzo")
    owner = await owner_of(db, ws)
    _, raw = await make_invite(db, ws, email="dana@example.com", invited_by=owner, role="viewer")
    r = await client.get("/v1/invites/lookup", params={"token": raw})
    assert r.status_code == 200
    assert r.json() == {
        "workspace_name": "Qenzo",
        "inviter_name": owner.name,
        "email_hint": "d***@example.com",
        "role": "viewer",
        "expired": False,
    }
    clock.freeze(frozen_now + timedelta(days=8))
    assert (await client.get("/v1/invites/lookup", params={"token": raw})).json()["expired"]
    assert (await client.get("/v1/invites/lookup", params={"token": "nope"})).status_code == 404


async def test_accept(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    inv, raw = await make_invite(db, ws, email="joiner@example.com", role="editor")
    joiner = await make_user(db, email="joiner@example.com")
    c = await session_client(joiner)
    r = await c.post("/v1/invites/accept", json={"token": raw})
    assert r.status_code == 200 and r.json()["id"] == str(ws.id) and r.json()["role"] == "editor"
    m = await db.get(Membership, (ws.id, joiner.id))
    assert m is not None and m.role == "editor"
    await db.refresh(inv)
    assert inv.accepted_at is not None and inv.accepted_by_user_id == joiner.id
    again = await c.post("/v1/invites/accept", json={"token": raw})
    assert again.status_code == 400 and again.json()["error"]["code"] == "invalid_token"


async def test_accept_with_other_email_is_mismatch(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    _, raw = await make_invite(db, ws, email="right@example.com")
    wrong = await make_user(db, email="wrong@example.com")
    r = await (await session_client(wrong)).post("/v1/invites/accept", json={"token": raw})
    assert r.status_code == 409 and r.json()["error"]["code"] == "invite_mismatch"
    assert r.json()["error"]["details"]["email_hint"] == "r***@example.com"
    assert await db.get(Membership, (ws.id, wrong.id)) is None


async def test_accept_expired_or_revoked(
    db: AsyncSession, session_client: Any, frozen_now: Any
) -> None:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    _inv, raw = await make_invite(db, ws, email="late@example.com")
    late = await make_user(db, email="late@example.com")
    clock.freeze(frozen_now + timedelta(days=7, seconds=1))
    r = await (await session_client(late)).post("/v1/invites/accept", json={"token": raw})
    assert r.status_code == 400
    clock.freeze(frozen_now)
    inv2, raw2 = await make_invite(db, ws, email="late2@example.com")
    oc = await session_client(owner, ws)
    assert (await oc.delete(f"/v1/invites/{inv2.id}")).status_code == 204
    late2 = await make_user(db, email="late2@example.com")
    r = await (await session_client(late2)).post("/v1/invites/accept", json={"token": raw2})
    assert r.status_code == 400


async def test_revoke_other_workspace_invite_is_404(db: AsyncSession, session_client: Any) -> None:
    _ws, _owner, c = await owner_client(db, session_client)
    other = await make_workspace(db)
    inv, _ = await make_invite(db, other)
    assert (await c.delete(f"/v1/invites/{inv.id}")).status_code == 404
    row = await db.scalar(select(Invite).where(Invite.id == inv.id))
    assert row is not None and row.revoked_at is None


async def test_accept_requires_session(db: AsyncSession, client: httpx.AsyncClient) -> None:
    ws = await make_workspace(db)
    _, raw = await make_invite(db, ws)
    r = await client.post("/v1/invites/accept", json={"token": raw})
    assert r.status_code == 401
