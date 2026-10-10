"""Members (SPEC §5.4): list, change role, remove, leave, last owner."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.workspace import Membership
from tests.factories import (
    add_member,
    make_api_key,
    make_investor,
    make_participant,
    make_round,
    make_workspace,
    owner_of,
)


async def test_list_members(db: AsyncSession, session_client: Any, key_client: Any) -> None:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    viewer = await add_member(db, ws, role="viewer")
    body = (await (await session_client(viewer, ws)).get("/v1/members")).json()["data"]
    assert [(m["user_id"], m["role"], m["is_you"]) for m in body] == [
        (str(owner.id), "owner", False),
        (str(viewer.id), "viewer", True),
    ]
    assert body[0]["email"] == owner.email
    _, raw = await make_api_key(db, ws, scopes="read")
    by_key = (await key_client(raw).get("/v1/members")).json()["data"]
    assert len(by_key) == 2 and not any(m["is_you"] for m in by_key)


async def test_owner_changes_role(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    editor = await add_member(db, ws, role="editor")
    c = await session_client(owner, ws)
    r = await c.patch(f"/v1/members/{editor.id}", json={"role": "Viewer"})
    assert r.status_code == 200 and r.json()["role"] == "viewer"
    r = await c.patch(f"/v1/members/{editor.id}", json={"role": "god"})
    assert r.status_code == 422


async def test_last_owner_cannot_be_demoted_or_removed(
    db: AsyncSession, session_client: Any
) -> None:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    c = await session_client(owner, ws)
    r = await c.patch(f"/v1/members/{owner.id}", json={"role": "editor"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "last_owner"
    r = await c.delete(f"/v1/members/{owner.id}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "last_owner"
    # With a second owner, the first may step down.
    second = await add_member(db, ws, role="owner")
    assert (await c.patch(f"/v1/members/{owner.id}", json={"role": "editor"})).status_code == 200
    c2 = await session_client(second, ws)
    assert (await c2.delete(f"/v1/members/{second.id}")).status_code == 409


async def test_remove_member_clears_participant_owner(
    db: AsyncSession, session_client: Any
) -> None:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    editor = await add_member(db, ws, role="editor")
    rnd = await make_round(db, ws)
    inv = await make_investor(db, ws)
    part = await make_participant(db, rnd, inv, owner_user_id=editor.id)
    c = await session_client(owner, ws)
    assert (await c.delete(f"/v1/members/{editor.id}")).status_code == 204
    assert await db.get(Membership, (ws.id, editor.id)) is None
    await db.refresh(part)
    assert part.owner_user_id is None


async def test_member_can_leave(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    viewer = await add_member(db, ws, role="viewer")
    c = await session_client(viewer, ws)
    assert (await c.delete(f"/v1/members/{viewer.id}")).status_code == 204
    assert (await c.get("/v1/workspace")).status_code in (400, 404)


async def test_non_owner_cannot_remove_or_change_others(
    db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    editor = await add_member(db, ws, role="editor")
    c = await session_client(editor, ws)
    r = await c.delete(f"/v1/members/{owner.id}")
    assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden_role"
    r = await c.patch(f"/v1/members/{owner.id}", json={"role": "viewer"})
    assert r.status_code == 403
    _, raw = await make_api_key(db, ws, scopes="read,write,admin")
    r = await key_client(raw).delete(f"/v1/members/{editor.id}")
    assert r.status_code == 403 and r.json()["error"]["code"] == "insufficient_scope"


async def test_unknown_or_foreign_member_is_404(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    other = await make_workspace(db)
    stranger = await owner_of(db, other)
    c = await session_client(await owner_of(db, ws), ws)
    assert (await c.patch(f"/v1/members/{stranger.id}", json={"role": "viewer"})).status_code == 404
    assert (await c.delete(f"/v1/members/{stranger.id}")).status_code == 404
