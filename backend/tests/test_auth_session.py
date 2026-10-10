"""Session cookie, CSRF, sign-out and workspace selection (SPEC §4.2, §4.3, §9.2.1)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.session import SESSION_COOKIE, create_user_session, encode_cookie
from raisebook.core import clock
from raisebook.models.user import UserSession
from tests.factories import add_member, make_api_key, make_user, make_workspace


async def test_session_endpoint_requires_sign_in(client: httpx.AsyncClient) -> None:
    r = await client.get("/v1/auth/session")
    assert r.status_code == 401 and r.json()["error"]["code"] == "session_invalid"


async def test_tampered_cookie_is_rejected(db: AsyncSession, app: Any, session_client: Any) -> None:
    user = await make_user(db)
    c = await session_client(user)
    ok = await c.get("/v1/auth/session")
    assert ok.status_code == 200
    good = c.cookies[SESSION_COOKIE]
    sid, secret, sig = good.split(".")
    for bad in (
        f"{sid}.{secret}.{sig[:-2]}xx",  # bad signature
        f"{sid}.{secret[:-2]}xx.{sig}",  # bad secret
        "garbage",
        f"{'0' * 32}.{secret}.{sig}",
    ):
        c.cookies.set(SESSION_COOKIE, bad)
        r = await c.get("/v1/auth/session")
        assert r.status_code == 401, bad
        assert r.json()["error"]["code"] == "session_invalid"


async def test_forged_cookie_with_valid_signature_but_wrong_secret(
    db: AsyncSession, client: httpx.AsyncClient
) -> None:
    user = await make_user(db)
    sess, _cookie = await create_user_session(db, user, now=clock.get_now())
    forged = encode_cookie(sess.id, "not-the-secret")
    client.cookies.set(SESSION_COOKIE, forged)
    r = await client.get("/v1/auth/session")
    assert r.status_code == 401


async def test_csrf_required_on_unsafe_methods(db: AsyncSession, session_client: Any) -> None:
    user = await make_user(db)
    no_csrf = await session_client(user, csrf=False)
    assert (await no_csrf.get("/v1/me")).status_code == 200  # safe method: no token needed
    r = await no_csrf.patch("/v1/me", json={"name": "Dana"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "csrf_failed"
    with_csrf = await session_client(user)
    r = await with_csrf.patch("/v1/me", json={"name": "Dana"})
    assert r.status_code == 200 and r.json()["name"] == "Dana"


async def test_wrong_csrf_token_and_foreign_origin(db: AsyncSession, session_client: Any) -> None:
    user = await make_user(db)
    c = await session_client(user)
    r = await c.patch("/v1/me", json={"name": "X"}, headers={"X-CSRF-Token": "wrong"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "csrf_failed"
    r = await c.patch("/v1/me", json={"name": "X"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "csrf_failed"
    r = await c.patch("/v1/me", json={"name": "X"}, headers={"Origin": "http://localhost:3000"})
    assert r.status_code == 200


async def test_csrf_token_of_another_session_fails(db: AsyncSession, session_client: Any) -> None:
    user = await make_user(db)
    a = await session_client(user)
    b = await session_client(user)
    r = await a.patch(
        "/v1/me", json={"name": "X"}, headers={"X-CSRF-Token": b.headers["X-CSRF-Token"]}
    )
    assert r.status_code == 403


async def test_signout_revokes_session(db: AsyncSession, session_client: Any) -> None:
    user = await make_user(db)
    c = await session_client(user)
    r = await c.post("/v1/auth/signout")
    assert r.status_code == 204
    assert any(h.startswith("rb_session=") for h in r.headers.get_list("set-cookie"))
    row = await db.get(UserSession, c.session_id)
    assert row is not None and row.revoked_at is not None
    assert (await c.get("/v1/auth/session")).status_code == 401


async def test_signout_requires_csrf(db: AsyncSession, session_client: Any) -> None:
    user = await make_user(db)
    c = await session_client(user, csrf=False)
    assert (await c.post("/v1/auth/signout")).status_code == 403


async def test_signout_without_session_is_fine(client: httpx.AsyncClient) -> None:
    assert (await client.post("/v1/auth/signout")).status_code == 204


async def test_expired_session(db: AsyncSession, session_client: Any, frozen_now: Any) -> None:
    user = await make_user(db)
    c = await session_client(user)
    clock.freeze(frozen_now + timedelta(days=31))
    assert (await c.get("/v1/auth/session")).status_code == 401


async def test_session_expiry_slides(
    db: AsyncSession, session_client: Any, frozen_now: Any
) -> None:
    user = await make_user(db)
    c = await session_client(user)
    clock.freeze(frozen_now + timedelta(days=20))
    r = await c.get("/v1/me")  # touch extends to day 50 and refreshes the cookies
    assert r.status_code == 200
    refreshed = [h for h in r.headers.get_list("set-cookie") if h.startswith("rb_session=")]
    assert refreshed and "01 Dec 2026" in refreshed[0]  # day 20 + 30 days
    again = await c.get("/v1/me")  # within 5 minutes: no touch, no cookie
    assert not [h for h in again.headers.get_list("set-cookie") if h.startswith("rb_session=")]
    clock.freeze(frozen_now + timedelta(days=45))
    assert (await c.get("/v1/me")).status_code == 200
    row = await db.scalar(select(UserSession).where(UserSession.id == c.session_id))
    assert row is not None and row.expires_at > frozen_now + timedelta(days=60)


async def test_workspace_selection(db: AsyncSession, session_client: Any) -> None:
    user = await make_user(db)
    ws1 = await make_workspace(db, owner=user, name="Qenzo")
    # Exactly one workspace: no header needed.
    c = await session_client(user)
    r = await c.get("/v1/workspace")
    assert r.status_code == 200 and r.json()["id"] == str(ws1.id)
    # Two workspaces: the header is required.
    ws2 = await make_workspace(db, owner=user, name="Second Co")
    r = await c.get("/v1/workspace")
    assert r.status_code == 400 and r.json()["error"]["code"] == "workspace_required"
    by_slug = await c.get("/v1/workspace", headers={"X-Workspace": ws2.slug})
    assert by_slug.json()["id"] == str(ws2.id)
    by_id = await c.get("/v1/workspace", headers={"X-Workspace": str(ws1.id)})
    assert by_id.json()["id"] == str(ws1.id)
    upper = await c.get("/v1/workspace", headers={"X-Workspace": ws1.slug.upper()})
    assert upper.json()["id"] == str(ws1.id)


async def test_workspace_header_for_non_member_is_404(
    db: AsyncSession, session_client: Any
) -> None:
    user = await make_user(db)
    await make_workspace(db, owner=user)
    other = await make_workspace(db)
    c = await session_client(user, other)
    r = await c.get("/v1/workspace")
    assert r.status_code == 404 and r.json()["error"]["code"] == "workspace_not_found"
    r = await c.get("/v1/workspace", headers={"X-Workspace": str(other.id)})
    assert r.status_code == 404
    r = await c.get("/v1/workspace", headers={"X-Workspace": "no-such-slug-x1y2"})
    assert r.status_code == 404


async def test_user_without_workspace_gets_workspace_required(
    db: AsyncSession, session_client: Any
) -> None:
    user = await make_user(db)
    c = await session_client(user)
    r = await c.get("/v1/members")
    assert r.status_code == 400 and r.json()["error"]["code"] == "workspace_required"
    assert "POST /v1/workspaces" in r.json()["error"]["message"]


async def test_api_key_wins_over_cookie(db: AsyncSession, session_client: Any) -> None:
    """A request with an API key is never cookie-authenticated (and needs no CSRF)."""
    user = await make_user(db)
    mine = await make_workspace(db, owner=user)
    other = await make_workspace(db)
    _, raw = await make_api_key(db, other, scopes="read,write,admin")
    c = await session_client(user, mine, csrf=False)
    r = await c.get("/v1/workspace", headers={"Authorization": f"Bearer {raw}"})
    assert r.json()["id"] == str(other.id)
    assert r.json()["you"]["type"] == "agent"
    r = await c.patch(
        "/v1/workspace", json={"name": "Renamed"}, headers={"Authorization": f"Bearer {raw}"}
    )
    assert r.status_code == 200 and r.json()["id"] == str(other.id)


async def test_org_less_endpoints_refuse_api_keys(db: AsyncSession, key_client: Any) -> None:
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws)
    c = key_client(raw)
    for path in ("/v1/me", "/v1/workspaces", "/v1/auth/session"):
        r = await c.get(path)
        assert r.status_code == 401, path


async def test_no_credentials(client: httpx.AsyncClient) -> None:
    r = await client.get("/v1/workspace")
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorized"
    assert r.json()["error"]["request_id"] == r.headers["x-request-id"]


async def test_session_lists_workspaces_with_roles(db: AsyncSession, session_client: Any) -> None:
    user = await make_user(db)
    own = await make_workspace(db, owner=user)
    other = await make_workspace(db)
    await add_member(db, other, user=user, role="viewer")
    c = await session_client(user)
    body = (await c.get("/v1/auth/session")).json()
    roles = {w["slug"]: w["role"] for w in body["workspaces"]}
    assert roles == {own.slug: "owner", other.slug: "viewer"}
