"""Magic-link sign-in (SPEC §4.1, §9.2.1): request, verify, single use, expiry, limits."""

from __future__ import annotations

from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core import clock
from raisebook.core.ratelimit import LIMITS, Limit
from raisebook.models.user import LoginToken, User
from raisebook.models.workspace import Membership
from tests.factories import make_invite, make_user, make_workspace


def token_of(link: str) -> str:
    return parse_qs(urlsplit(link).query)["token"][0]


async def request_link(client: httpx.AsyncClient, email: str, **extra: Any) -> httpx.Response:
    return await client.post("/v1/auth/magic-link", json={"email": email, **extra})


async def test_request_always_202_and_emails_link(
    client: httpx.AsyncClient, outbox: list[Any], db: AsyncSession
) -> None:
    r = await request_link(client, "New.Founder@Example.com")
    assert r.status_code == 202
    body = r.json()
    assert body["sent"] is True
    assert body["dev_link"].startswith("http://localhost:3000/auth/verify?token=")
    assert len(outbox) == 1 and outbox[0].to == "new.founder@example.com"
    assert body["dev_link"] in outbox[0].text
    # The user row is created on verify, not on request.
    assert await db.scalar(select(User).where(User.email == "new.founder@example.com")) is None
    stored = await db.scalar(
        select(LoginToken).where(LoginToken.email == "new.founder@example.com")
    )
    assert stored is not None and token_of(body["dev_link"]).encode() not in bytes(
        stored.token_hash
    )


async def test_request_rejects_malformed_email(client: httpx.AsyncClient) -> None:
    r = await request_link(client, "not-an-email")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


async def test_verify_creates_user_session_and_cookies(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    link = (await request_link(client, "dana@example.com", redirect_path="/w/x")).json()["dev_link"]
    r = await client.post("/v1/auth/verify", json={"token": token_of(link)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user"]["email"] == "dana@example.com"
    assert body["redirect_path"] == "/w/x"
    assert body["workspaces"] == []
    assert body["csrf_token"]
    assert r.headers["cache-control"] == "no-store"
    set_cookie = r.headers.get_list("set-cookie")
    session_cookie = next(c for c in set_cookie if c.startswith("rb_session="))
    csrf_cookie = next(c for c in set_cookie if c.startswith("rb_csrf="))
    assert "HttpOnly" in session_cookie and "SameSite=lax" in session_cookie
    assert "HttpOnly" not in csrf_cookie
    user = await db.scalar(select(User).where(User.email == "dana@example.com"))
    assert user is not None and user.last_signin_at is not None
    # The cookie works.
    s = await client.get("/v1/auth/session")
    assert s.status_code == 200 and s.json()["user"]["email"] == "dana@example.com"
    assert s.json()["csrf_token"] == body["csrf_token"]


async def test_open_redirects_are_dropped(client: httpx.AsyncClient) -> None:
    for bad in ("//evil.example.com", "https://evil.example.com", "/\\evil"):
        link = (await request_link(client, "redir@example.com", redirect_path=bad)).json()[
            "dev_link"
        ]
        r = await client.post("/v1/auth/verify", json={"token": token_of(link)})
        assert r.json()["redirect_path"] is None


async def test_token_is_single_use(client: httpx.AsyncClient) -> None:
    link = (await request_link(client, "once@example.com")).json()["dev_link"]
    first = await client.post("/v1/auth/verify", json={"token": token_of(link)})
    assert first.status_code == 200
    second = await client.post("/v1/auth/verify", json={"token": token_of(link)})
    assert second.status_code == 400
    assert second.json()["error"]["code"] == "invalid_token"


async def test_unknown_token_is_invalid(client: httpx.AsyncClient) -> None:
    r = await client.post("/v1/auth/verify", json={"token": "nope"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_token"


async def test_token_expires_after_15_minutes(client: httpx.AsyncClient, frozen_now: Any) -> None:
    link = (await request_link(client, "late@example.com")).json()["dev_link"]
    clock.freeze(frozen_now + timedelta(minutes=15, seconds=1))
    r = await client.post("/v1/auth/verify", json={"token": token_of(link)})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_token"


async def test_token_valid_just_before_expiry(client: httpx.AsyncClient, frozen_now: Any) -> None:
    link = (await request_link(client, "ontime@example.com")).json()["dev_link"]
    clock.freeze(frozen_now + timedelta(minutes=14, seconds=59))
    r = await client.post("/v1/auth/verify", json={"token": token_of(link)})
    assert r.status_code == 200


async def test_email_rate_limit_still_202_but_no_email(
    client: httpx.AsyncClient, outbox: list[Any], db: AsyncSession, frozen_now: Any
) -> None:
    for _ in range(5):
        assert (await request_link(client, "spam@example.com")).status_code == 202
    sixth = await request_link(client, "spam@example.com")
    assert sixth.status_code == 202 and sixth.json() == {"sent": True}  # no dev_link
    assert len(outbox) == 5
    count = await db.scalar(
        select(func.count()).select_from(LoginToken).where(LoginToken.email == "spam@example.com")
    )
    assert count == 5
    # The window slides: 15 minutes later a new link is sent again.
    clock.freeze(frozen_now + timedelta(minutes=16))
    later = await request_link(client, "spam@example.com")
    assert "dev_link" in later.json() and len(outbox) == 6


async def test_ip_rate_limit_still_202(
    client: httpx.AsyncClient, outbox: list[Any], monkeypatch: Any
) -> None:
    monkeypatch.setitem(LIMITS, "magic_ip", Limit(2, 3600))
    for i in range(2):
        await request_link(client, f"ip{i}@example.com")
    third = await request_link(client, "ip3@example.com")
    assert third.status_code == 202 and "dev_link" not in third.json()
    assert len(outbox) == 2


async def test_no_dev_link_outside_local_dev(
    client: httpx.AsyncClient, monkeypatch: Any, outbox: list[Any]
) -> None:
    from raisebook.config import reset_settings_cache

    monkeypatch.setenv("RAISEBOOK_PUBLIC_BASE_URL", "https://api.raisebook.org")
    reset_settings_cache()
    try:
        r = await request_link(client, "prod@example.com")
        assert r.status_code == 202 and r.json() == {"sent": True}
        assert len(outbox) == 1
    finally:
        monkeypatch.undo()
        reset_settings_cache()


async def test_verify_accepts_attached_invite(client: httpx.AsyncClient, db: AsyncSession) -> None:
    ws = await make_workspace(db, name="Qenzo")
    inv, raw = await make_invite(db, ws, email="cofounder@example.com", role="editor")
    link = (await request_link(client, "cofounder@example.com", invite_token=raw)).json()[
        "dev_link"
    ]
    r = await client.post("/v1/auth/verify", json={"token": token_of(link)})
    assert r.status_code == 200
    body = r.json()
    assert [w["slug"] for w in body["workspaces"]] == [ws.slug]
    assert body["workspaces"][0]["role"] == "editor"
    assert body["redirect_path"] == f"/w/{ws.slug}"
    await db.refresh(inv)
    assert inv.accepted_at is not None


async def test_invite_for_other_email_is_not_attached(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    ws = await make_workspace(db)
    _, raw = await make_invite(db, ws, email="someone@example.com")
    link = (await request_link(client, "intruder@example.com", invite_token=raw)).json()["dev_link"]
    r = await client.post("/v1/auth/verify", json={"token": token_of(link)})
    assert r.status_code == 200 and r.json()["workspaces"] == []
    user = await db.scalar(select(User).where(User.email == "intruder@example.com"))
    assert user is not None
    assert await db.get(Membership, (ws.id, user.id)) is None


async def test_existing_user_signs_in_and_sees_workspaces(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, email="known@example.com")
    ws = await make_workspace(db, owner=user)
    link = (await request_link(client, "KNOWN@example.com")).json()["dev_link"]
    r = await client.post("/v1/auth/verify", json={"token": token_of(link)})
    assert r.json()["user"]["id"] == str(user.id)
    assert r.json()["workspaces"][0]["role"] == "owner"
    assert r.json()["workspaces"][0]["id"] == str(ws.id)
