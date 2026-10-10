"""Rate limits (SPEC §7): 429 path, headers, buckets, backends."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from raisebook.core import clock, ratelimit
from raisebook.core.ratelimit import LIMITS, Limit, PostgresBackend, window_start
from tests.factories import make_api_key, make_user, make_workspace, owner_of


async def test_key_read_limit_returns_429_with_headers(
    db: AsyncSession, key_client: Any, monkeypatch: Any, frozen_now: Any
) -> None:
    monkeypatch.setitem(LIMITS, "key_read", Limit(2, 60))
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws)
    c = key_client(raw)
    first = await c.get("/v1/workspace")
    assert first.status_code == 200
    assert first.headers["ratelimit-limit"] == "2"
    assert first.headers["ratelimit-remaining"] == "1"
    assert int(first.headers["ratelimit-reset"]) <= 60
    assert (await c.get("/v1/members")).status_code == 200
    third = await c.get("/v1/workspace")
    assert third.status_code == 429
    err = third.json()["error"]
    assert err["code"] == "rate_limited" and err["details"]["retry_after_s"] >= 1
    assert third.headers["retry-after"] == str(err["details"]["retry_after_s"])
    assert third.headers["ratelimit-remaining"] == "0"
    # Writes have their own bucket.
    assert (await c.patch("/v1/workspace", json={})).status_code == 403  # scope, not limit
    # The next window resets the count.
    clock.freeze(frozen_now + timedelta(seconds=61))
    assert (await c.get("/v1/workspace")).status_code == 200


async def test_buckets_are_per_key(db: AsyncSession, key_client: Any, monkeypatch: Any) -> None:
    monkeypatch.setitem(LIMITS, "key_read", Limit(1, 60))
    ws = await make_workspace(db)
    _, a = await make_api_key(db, ws)
    _, b = await make_api_key(db, ws)
    assert (await key_client(a).get("/v1/workspace")).status_code == 200
    assert (await key_client(a).get("/v1/workspace")).status_code == 429
    assert (await key_client(b).get("/v1/workspace")).status_code == 200


async def test_session_bucket(db: AsyncSession, session_client: Any, monkeypatch: Any) -> None:
    monkeypatch.setitem(LIMITS, "session", Limit(2, 60))
    ws = await make_workspace(db)
    c = await session_client(await owner_of(db, ws), ws)
    assert (await c.get("/v1/workspace")).status_code == 200
    assert (await c.get("/v1/me")).status_code == 200
    assert (await c.get("/v1/workspace")).status_code == 429


async def test_anonymous_ip_bucket(client: Any, monkeypatch: Any) -> None:
    monkeypatch.setitem(LIMITS, "anon_ip", Limit(1, 60))
    r1 = await client.get("/v1/invites/lookup", params={"token": "x"})
    assert r1.status_code == 404
    r2 = await client.get("/v1/invites/lookup", params={"token": "x"})
    assert r2.status_code == 429


async def test_off_backend_never_limits(
    db: AsyncSession, key_client: Any, monkeypatch: Any
) -> None:
    monkeypatch.setitem(LIMITS, "key_read", Limit(1, 60))
    ratelimit.set_backend(ratelimit.OffBackend())
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws)
    for _ in range(3):
        assert (await key_client(raw).get("/v1/workspace")).status_code == 200


def test_window_start_alignment() -> None:
    t = datetime(2026, 10, 12, 17, 0, 42, tzinfo=UTC)
    assert window_start(t, 60) == datetime(2026, 10, 12, 17, 0, 0, tzinfo=UTC)
    assert window_start(t, 3600) == datetime(2026, 10, 12, 17, 0, 0, tzinfo=UTC)
    assert window_start(t, 900) == datetime(2026, 10, 12, 17, 0, 0, tzinfo=UTC)


async def test_postgres_backend_counts_across_calls(engine: AsyncEngine) -> None:
    backend = PostgresBackend()
    ratelimit.set_backend(backend)
    bucket_subject = f"pg-test-{datetime.now(UTC).timestamp()}"
    at = datetime(2026, 10, 12, 17, 0, 5, tzinfo=UTC)
    results = [await ratelimit.check("anon_ip", bucket_subject, now=at) for _ in range(3)]
    assert [r.remaining for r in results] == [119, 118, 117]
    later = at + timedelta(minutes=1)
    assert (await ratelimit.check("anon_ip", bucket_subject, now=later)).remaining == 119
    deleted = await ratelimit.delete_old_windows(datetime(2100, 1, 1, tzinfo=UTC))
    assert deleted >= 2


async def test_magic_link_email_bucket_uses_db(client: Any, db: AsyncSession) -> None:
    await make_user(db, email="bucket@example.com")
    for _ in range(6):
        r = await client.post("/v1/auth/magic-link", json={"email": "bucket@example.com"})
        assert r.status_code == 202
