"""API keys end with their creator's access (review finding: keys outliving members).

Removing a member, an owner leaving, demoting an owner, or deleting an account
revokes every active key that person created in that workspace, so a secret seen
once cannot be used after access ends.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import add_member, make_api_key, make_user, make_workspace, owner_of

ADMIN = "read,write,admin"


async def test_removed_owner_key_stops_working(
    db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    ws = await make_workspace(db)
    first = await owner_of(db, ws)
    second = await add_member(db, ws, role="owner")
    _, raw = await make_api_key(db, ws, scopes=ADMIN, created_by=second)
    _, keep = await make_api_key(db, ws, scopes="read", created_by=first)
    assert (await key_client(raw).get("/v1/investors")).status_code == 200
    members = (await (await session_client(first, ws)).get("/v1/members")).json()["data"]
    assert {m["user_id"]: m["active_api_keys"] for m in members}[str(second.id)] == 1
    r = await (await session_client(first, ws)).delete(f"/v1/members/{second.id}")
    assert r.status_code == 204
    for path in ("/v1/investors", "/v1/export", "/v1/api-keys"):
        assert (await key_client(raw).get(path)).status_code == 401, path
    assert (await key_client(keep).get("/v1/investors")).status_code == 200


async def test_member_leaving_revokes_their_keys(
    db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    ws = await make_workspace(db)
    leaver = await add_member(db, ws, role="owner")
    _, raw = await make_api_key(db, ws, scopes="read,write", created_by=leaver)
    r = await (await session_client(leaver, ws)).delete(f"/v1/members/{leaver.id}")
    assert r.status_code == 204
    assert (await key_client(raw).get("/v1/investors")).status_code == 401


async def test_demoted_owner_keys_are_revoked(
    db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    ws = await make_workspace(db)
    first = await owner_of(db, ws)
    second = await add_member(db, ws, role="owner")
    _, raw = await make_api_key(db, ws, scopes=ADMIN, created_by=second)
    r = await (await session_client(first, ws)).patch(
        f"/v1/members/{second.id}", json={"role": "editor"}
    )
    assert r.status_code == 200
    assert (await key_client(raw).get("/v1/investors")).status_code == 401


async def test_role_change_between_non_owners_keeps_keys(
    db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    ws = await make_workspace(db)
    first = await owner_of(db, ws)
    _, raw = await make_api_key(db, ws, scopes="read", created_by=first)
    editor = await add_member(db, ws, role="editor")
    r = await (await session_client(first, ws)).patch(
        f"/v1/members/{editor.id}", json={"role": "viewer"}
    )
    assert r.status_code == 200
    assert (await key_client(raw).get("/v1/investors")).status_code == 200


async def test_account_deletion_revokes_keys_in_workspaces_left(
    db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    ws = await make_workspace(db)
    await owner_of(db, ws)
    leaver = await add_member(
        db, ws, user=await make_user(db, email="key.leaver@example.com"), role="owner"
    )
    _, raw = await make_api_key(db, ws, scopes=ADMIN, created_by=leaver)
    c = await session_client(leaver)
    r = await c.request("DELETE", "/v1/me", json={"confirm_email": leaver.email})
    assert r.status_code == 204, r.text
    assert (await key_client(raw).get("/v1/investors")).status_code == 401
