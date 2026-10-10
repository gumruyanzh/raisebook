"""API keys (SPEC §4.4, §9.2.1): create, use, revoke, expire, wrong mode, scopes, limits."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.api_keys import hash_api_key
from raisebook.core import clock
from raisebook.models.workspace import ApiKey
from tests.factories import add_member, make_api_key, make_workspace, owner_of


async def owner_client(db: AsyncSession, session_client: Any, **ws_kw: Any) -> tuple[Any, Any]:
    ws = await make_workspace(db, **ws_kw)
    return ws, await session_client(await owner_of(db, ws), ws)


async def test_owner_creates_key_secret_shown_once(db: AsyncSession, session_client: Any) -> None:
    _ws, c = await owner_client(db, session_client)
    r = await c.post(
        "/v1/api-keys",
        json={"name": "Claude Code laptop", "agent_name": "claude-code", "scopes": ["write"]},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    secret = body["secret"]
    assert secret.startswith("rb_live_") and len(secret) == len("rb_live_") + 32
    key = body["api_key"]
    assert key["key_prefix"] == secret[:12]
    assert key["scopes"] == ["raisebook:read", "raisebook:write"]  # read always included
    assert key["mode"] == "live" and key["agent_name"] == "claude-code"
    assert key["created_by"]  # display name of the owner
    row = await db.get(ApiKey, key["id"])
    assert row is not None and bytes(row.key_hash) == hash_api_key(secret)
    assert secret not in str(row.__dict__)
    listed = (await c.get("/v1/api-keys")).json()["data"]
    assert [k["id"] for k in listed] == [key["id"]]
    assert "secret" not in listed[0]


async def test_key_authenticates_both_headers(db: AsyncSession, client: httpx.AsyncClient) -> None:
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws)
    r = await client.get("/v1/workspace", headers={"Authorization": f"Bearer {raw}"})
    assert r.status_code == 200 and r.json()["id"] == str(ws.id)
    r = await client.get("/v1/workspace", headers={"X-API-Key": raw})
    assert r.status_code == 200
    you = r.json()["you"]
    assert you["type"] == "agent" and you["key_prefix"] == raw[:12]
    assert you["scopes"] == ["raisebook:read", "raisebook:write"]


async def test_sandbox_workspace_gets_test_keys(db: AsyncSession, session_client: Any) -> None:
    _ws, c = await owner_client(db, session_client, sandbox=True)
    r = await c.post("/v1/api-keys", json={"name": "demo"})
    assert r.json()["secret"].startswith("rb_test_") and r.json()["api_key"]["mode"] == "test"


async def test_revoked_key_is_rejected(
    db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    ws, c = await owner_client(db, session_client)
    key, raw = await make_api_key(db, ws)
    agent = key_client(raw)
    assert (await agent.get("/v1/workspace")).status_code == 200
    r = await c.delete(f"/v1/api-keys/{key.id}")
    assert r.status_code == 204
    r = await agent.get("/v1/workspace")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_api_key"
    assert r.headers["www-authenticate"] == 'Bearer realm="raisebook"'
    listed = (await c.get("/v1/api-keys")).json()["data"]
    assert listed[0]["revoked_at"] is not None
    # Revoking twice is fine.
    assert (await c.delete(f"/v1/api-keys/{key.id}")).status_code == 204


async def test_expired_key_is_rejected(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws, expires_at=frozen_now + timedelta(hours=1))
    c = key_client(raw)
    assert (await c.get("/v1/workspace")).status_code == 200
    clock.freeze(frozen_now + timedelta(hours=1, seconds=1))
    r = await c.get("/v1/workspace")
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_api_key"


async def test_wrong_mode_prefix_and_malformed_keys(
    db: AsyncSession, client: httpx.AsyncClient
) -> None:
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws)
    swapped = "rb_test_" + raw[len("rb_live_") :]
    for bad in (swapped, raw[:-1], raw + "x", "rb_live_short", "sk_live_" + "a" * 32, raw.upper()):
        r = await client.get("/v1/workspace", headers={"Authorization": f"Bearer {bad}"})
        assert r.status_code == 401, bad
        assert r.json()["error"]["code"] == "invalid_api_key"
    r = await client.get("/v1/workspace", headers={"Authorization": "Basic abc"})
    assert r.status_code == 401


async def test_key_mode_must_match_workspace(db: AsyncSession, client: httpx.AsyncClient) -> None:
    """A live key whose workspace became a sandbox (or vice versa) never authenticates."""
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws)
    ws.is_sandbox = True
    await db.flush()
    r = await client.get("/v1/workspace", headers={"Authorization": f"Bearer {raw}"})
    assert r.status_code == 401


async def test_last_used_at_is_touched(db: AsyncSession, key_client: Any, frozen_now: Any) -> None:
    ws = await make_workspace(db)
    key, raw = await make_api_key(db, ws)
    assert key.last_used_at is None
    await key_client(raw).get("/v1/workspace")
    await db.refresh(key)
    assert key.last_used_at == frozen_now


async def test_scope_rules(db: AsyncSession, session_client: Any) -> None:
    _ws, c = await owner_client(db, session_client)
    r = await c.post("/v1/api-keys", json={"name": "x", "scopes": ["raisebook:admin"]})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
    assert r.json()["error"]["details"][0]["loc"] == ["body", "scopes"]
    r = await c.post("/v1/api-keys", json={"name": "x", "scopes": ["raisebook:delete"]})
    assert r.status_code == 422
    r = await c.post("/v1/api-keys", json={"name": "x", "scopes": ["read"]})
    assert r.json()["api_key"]["scopes"] == ["raisebook:read"]
    r = await c.post("/v1/api-keys", json={"name": "x", "scopes": ["admin", "write"]})
    assert r.json()["api_key"]["scopes"] == [
        "raisebook:read",
        "raisebook:write",
        "raisebook:admin",
    ]


async def test_validation_of_name_and_agent_name(db: AsyncSession, session_client: Any) -> None:
    _ws, c = await owner_client(db, session_client)
    assert (await c.post("/v1/api-keys", json={"name": "  "})).status_code == 422
    r = await c.post("/v1/api-keys", json={"name": "ok", "agent_name": "-bad name!"})
    assert r.status_code == 422
    assert r.json()["error"]["details"][0]["loc"] == ["body", "agent_name"]
    r = await c.post("/v1/api-keys", json={"name": "ok", "unknown": 1})
    assert r.status_code == 422  # unknown keys are rejected


async def test_keys_cannot_manage_keys(db: AsyncSession, key_client: Any) -> None:
    """An agent can never mint or widen its own access, even with admin."""
    ws = await make_workspace(db)
    key, raw = await make_api_key(db, ws, scopes="read,write,admin")
    c = key_client(raw)
    r = await c.post("/v1/api-keys", json={"name": "escalate", "scopes": ["admin", "write"]})
    assert r.status_code == 403 and r.json()["error"]["code"] == "insufficient_scope"
    assert r.json()["error"]["details"]["required"] == ["owner_session"]
    r = await c.delete(f"/v1/api-keys/{key.id}")
    assert r.status_code == 403
    # Admin keys may list keys.
    assert (await c.get("/v1/api-keys")).status_code == 200


async def test_editor_cannot_manage_keys(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    editor = await add_member(db, ws, role="editor")
    c = await session_client(editor, ws)
    r = await c.post("/v1/api-keys", json={"name": "nope"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden_role"
    r = await c.get("/v1/api-keys")
    assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden_role"


async def test_active_key_limit(db: AsyncSession, session_client: Any) -> None:
    ws, c = await owner_client(db, session_client)
    for _ in range(19):
        await make_api_key(db, ws)
    await make_api_key(db, ws, revoked=True)  # revoked keys do not count
    assert (await c.post("/v1/api-keys", json={"name": "20th"})).status_code == 201
    r = await c.post("/v1/api-keys", json={"name": "21st"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "limit_reached"


async def test_revoke_other_workspace_key_is_404(db: AsyncSession, session_client: Any) -> None:
    _ws, c = await owner_client(db, session_client)
    other = await make_workspace(db)
    key, _ = await make_api_key(db, other)
    r = await c.delete(f"/v1/api-keys/{key.id}")
    assert r.status_code == 404
    await db.refresh(key)
    assert key.revoked_at is None


async def test_expires_at_must_be_future(
    db: AsyncSession, session_client: Any, frozen_now: Any
) -> None:
    _ws, c = await owner_client(db, session_client)
    past = (frozen_now - timedelta(days=1)).isoformat()
    r = await c.post("/v1/api-keys", json={"name": "x", "expires_at": past})
    assert r.status_code == 422
    future = (frozen_now + timedelta(days=30)).isoformat()
    r = await c.post("/v1/api-keys", json={"name": "x", "expires_at": future})
    assert r.status_code == 201
    assert r.json()["api_key"]["expires_at"] == "2026-11-11T17:00:00Z"


async def test_deleted_creator_is_cleared(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    co = await add_member(db, ws, role="owner")
    c = await session_client(co, ws)
    created = (await c.post("/v1/api-keys", json={"name": "by co"})).json()["api_key"]
    await db.delete(co)
    await db.flush()
    oc = await session_client(owner, ws)
    listed = {k["id"]: k for k in (await oc.get("/v1/api-keys")).json()["data"]}
    assert listed[created["id"]]["created_by"] is None  # ON DELETE SET NULL; key survives
