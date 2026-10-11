"""Sign-in hardening (review findings): verify needs a click, no silent account swap,
session list/revoke, absolute session lifetime, failed-key throttling on /v1 and /mcp."""

from __future__ import annotations

from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.session import SESSION_COOKIE
from raisebook.core import clock
from raisebook.core.ratelimit import LIMITS, Limit
from tests.factories import make_user, make_workspace, owner_of


def token_of(link: str) -> str:
    return parse_qs(urlsplit(link).query)["token"][0]


async def new_link(client: httpx.AsyncClient, email: str) -> str:
    r = await client.post("/v1/auth/magic-link", json={"email": email})
    return str(r.json()["dev_link"])


async def test_peek_does_not_spend_the_token(client: httpx.AsyncClient) -> None:
    token = token_of(await new_link(client, "peek.person@example.com"))
    for _ in range(2):
        r = await client.get("/v1/auth/verify/peek", params={"token": token})
        assert r.status_code == 200
        assert r.json() == {"valid": True, "email_hint": "p***@example.com"}
        assert r.headers["cache-control"] == "no-store"
    assert (await client.post("/v1/auth/verify", json={"token": token})).status_code == 200
    r = await client.get("/v1/auth/verify/peek", params={"token": token})
    assert r.json() == {"valid": False, "email_hint": None}


async def test_verify_refuses_silent_account_swap(
    db: AsyncSession, session_client: Any, client: httpx.AsyncClient
) -> None:
    victim = await make_user(db, email="victim.founder@example.com")
    c = await session_client(victim)
    token = token_of(await new_link(client, "attacker.person@example.com"))
    r = await c.post("/v1/auth/verify", json={"token": token})
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == "session_conflict"
    assert err["details"] == {"signed_in_as": "v***@example.com", "link_for": "a***@example.com"}
    assert "set-cookie" not in r.headers
    # Nothing was spent: the victim is still signed in and the token still works.
    assert (await c.get("/v1/me")).json()["email"] == victim.email
    peek = await client.get("/v1/auth/verify/peek", params={"token": token})
    assert peek.json()["valid"] is True
    # An explicit switch signs the old session out and starts the new one.
    old_cookie = c.cookies.get(SESSION_COOKIE)
    r = await c.post("/v1/auth/verify", json={"token": token, "switch_account": True})
    assert r.status_code == 200 and r.json()["user"]["email"] == "attacker.person@example.com"
    stale = httpx.AsyncClient(
        transport=c._transport, base_url="http://testserver", cookies={SESSION_COOKIE: old_cookie}
    )
    async with stale:
        assert (await stale.get("/v1/me")).status_code == 401


async def test_verify_same_user_signed_in_is_fine(
    db: AsyncSession, session_client: Any, client: httpx.AsyncClient
) -> None:
    me = await make_user(db, email="same.person@example.com")
    c = await session_client(me)
    token = token_of(await new_link(client, "same.person@example.com"))
    assert (await c.post("/v1/auth/verify", json={"token": token})).status_code == 200


async def test_list_and_end_sessions(db: AsyncSession, session_client: Any) -> None:
    me = await make_user(db)
    a = await session_client(me)
    b = await session_client(me)
    rows = (await a.get("/v1/me/sessions")).json()["data"]
    assert len(rows) == 2 and sum(r["current"] for r in rows) == 1
    other = next(r for r in rows if not r["current"])
    assert (await a.delete(f"/v1/me/sessions/{other['id']}")).status_code == 204
    assert (await b.get("/v1/me")).status_code == 401
    assert (await a.delete(f"/v1/me/sessions/{other['id']}")).status_code == 404
    # Someone else's session id is a 404, never a revoke.
    stranger = await make_user(db)
    s = await session_client(stranger)
    mine = (await a.get("/v1/me/sessions")).json()["data"][0]["id"]
    assert (await s.delete(f"/v1/me/sessions/{mine}")).status_code == 404
    assert (await a.get("/v1/me")).status_code == 200


async def test_sign_out_other_sessions(db: AsyncSession, session_client: Any) -> None:
    me = await make_user(db)
    a = await session_client(me)
    b = await session_client(me)
    c = await session_client(me)
    assert (await a.post("/v1/me/sessions/revoke-others")).status_code == 204
    assert (await a.get("/v1/me")).status_code == 200
    assert (await b.get("/v1/me")).status_code == 401
    assert (await c.get("/v1/me")).status_code == 401


async def test_session_has_absolute_lifetime(db: AsyncSession, session_client: Any) -> None:
    me = await make_user(db)
    c = await session_client(me)
    start = clock.get_now()
    try:
        # Used every 20 days: the sliding expiry alone would keep it alive forever.
        for day in (20, 40, 60, 80):
            clock.freeze(start + timedelta(days=day))
            assert (await c.get("/v1/me")).status_code == 200, day
        clock.freeze(start + timedelta(days=90, minutes=1))
        assert (await c.get("/v1/me")).status_code == 401
    finally:
        clock.freeze(None)


async def test_failed_keys_are_throttled_per_ip(
    client: httpx.AsyncClient, monkeypatch: Any
) -> None:
    monkeypatch.setitem(LIMITS, "auth_fail", Limit(3, 60))
    bad = {"Authorization": "Bearer rb_live_" + "x" * 32}
    codes = [(await client.get("/v1/investors", headers=bad)).status_code for _ in range(5)]
    assert codes == [401, 401, 401, 429, 429]


async def test_mcp_rejected_key_message_and_throttle(
    db: AsyncSession, client: httpx.AsyncClient, monkeypatch: Any
) -> None:
    ws = await make_workspace(db)
    await owner_of(db, ws)
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    hdrs = {"Accept": "application/json, text/event-stream"}
    r = await client.post("/mcp", json=payload, headers=hdrs)
    assert r.status_code == 401 and "No Raisebook API key" in r.json()["error_description"]
    bad = {**hdrs, "Authorization": "Bearer rb_live_" + "y" * 32}
    r = await client.post("/mcp", json=payload, headers=bad)
    assert r.status_code == 401
    assert r.json()["error_description"].startswith("Invalid or revoked Raisebook API key")
    assert "Invalid or revoked" in r.headers["www-authenticate"]
    monkeypatch.setitem(LIMITS, "auth_fail", Limit(1, 60))
    r = await client.post("/mcp", json=payload, headers=bad)
    assert r.status_code == 429


async def test_invites_are_capped_per_person_across_workspaces(
    db: AsyncSession, session_client: Any, monkeypatch: Any
) -> None:
    monkeypatch.setitem(LIMITS, "invite_user", Limit(2, 86400))
    owner = await make_user(db)
    a = await make_workspace(db, owner=owner)
    b = await make_workspace(db, owner=owner)
    ca, cb = await session_client(owner, a), await session_client(owner, b)
    assert (await ca.post("/v1/invites", json={"email": "x1@example.com"})).status_code == 201
    assert (await cb.post("/v1/invites", json={"email": "x2@example.com"})).status_code == 201
    r = await cb.post("/v1/invites", json={"email": "x3@example.com"})
    assert r.status_code == 429


async def test_new_accounts_get_a_tighter_invite_cap(
    db: AsyncSession, session_client: Any, monkeypatch: Any
) -> None:
    monkeypatch.setitem(LIMITS, "invite_user_new", Limit(1, 86400))
    owner = await make_user(db)  # created just now
    ws = await make_workspace(db, owner=owner)
    c = await session_client(owner, ws)
    assert (await c.post("/v1/invites", json={"email": "y1@example.com"})).status_code == 201
    assert (await c.post("/v1/invites", json={"email": "y2@example.com"})).status_code == 429


async def test_workspace_count_is_capped_per_owner(
    db: AsyncSession, session_client: Any, monkeypatch: Any
) -> None:
    from raisebook.services.workspaces import LIMITS as WS_LIMITS

    monkeypatch.setitem(WS_LIMITS, "workspaces_per_user", 2)
    me = await make_user(db)
    c = await session_client(me)
    for i in range(2):
        assert (await c.post("/v1/workspaces", json={"name": f"Co {i}"})).status_code == 201
    r = await c.post("/v1/workspaces", json={"name": "Co 3"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "limit_reached"


async def test_names_cannot_carry_links(db: AsyncSession, session_client: Any) -> None:
    me = await make_user(db)
    c = await session_client(me)
    r = await c.post("/v1/workspaces", json={"name": "Win at https://evil.example"})
    assert r.status_code == 422
    r = await c.patch("/v1/me", json={"name": "Visit www.evil.example"})
    assert r.status_code == 422
    assert (await c.patch("/v1/me", json={"name": "Ada Founder"})).status_code == 200
