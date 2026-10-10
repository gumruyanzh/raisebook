"""Workspace isolation for the Foundation routes (SPEC §8.4, §9.2.3).

The full suite that enumerates every /v1 route and MCP tool lives in ``tests/isolation/``
(API+MCP). This file covers workspace, members, invites and API keys: a principal of A
addressing B's ids gets 404 and B is unchanged; lists never return B's rows.
"""

from __future__ import annotations

from typing import Any

from fastapi.routing import APIRoute
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.workspace import ApiKey, Invite, Membership, Workspace
from tests.factories import add_member, make_api_key, make_invite, make_workspace, owner_of
from tests.test_permissions_matrix import ROWS

FB_MODULES = {
    "raisebook.api.health",
    "raisebook.api.auth",
    "raisebook.api.me",
    "raisebook.api.workspaces",
    "raisebook.api.members",
    "raisebook.api.invites",
    "raisebook.api.api_keys",
}
# Routes that are not workspace-scoped (anonymous or the caller's own account).
ORGLESS = {
    ("GET", "/healthz"),
    ("GET", "/healthz/ready"),
    ("POST", "/v1/auth/magic-link"),
    ("POST", "/v1/auth/verify"),
    ("GET", "/v1/auth/session"),
    ("POST", "/v1/auth/signout"),
    ("GET", "/v1/me"),
    ("PATCH", "/v1/me"),
    ("DELETE", "/v1/me"),
    ("GET", "/v1/workspaces"),
    ("POST", "/v1/workspaces"),
    ("GET", "/v1/invites/lookup"),
    ("POST", "/v1/invites/accept"),
}
MATRIX_PATHS = {
    ("GET", "/v1/workspace"),
    ("PATCH", "/v1/workspace"),
    ("DELETE", "/v1/workspace"),
    ("GET", "/v1/members"),
    ("PATCH", "/v1/members/{user_id}"),
    ("DELETE", "/v1/members/{user_id}"),
    ("GET", "/v1/invites"),
    ("POST", "/v1/invites"),
    ("DELETE", "/v1/invites/{invite_id}"),
    ("GET", "/v1/api-keys"),
    ("POST", "/v1/api-keys"),
    ("DELETE", "/v1/api-keys/{key_id}"),
}


def test_every_foundation_route_is_classified(app: Any) -> None:
    """A new Foundation route must be added to the matrix (or declared org-less)."""
    routes = {
        (m, r.path)
        for r in app.routes
        if isinstance(r, APIRoute) and r.endpoint.__module__ in FB_MODULES
        for m in r.methods
        if m != "HEAD"
    }
    unclassified = routes - ORGLESS - MATRIX_PATHS
    assert not unclassified, f"classify these routes: {sorted(unclassified)}"
    assert len(ROWS) >= len(MATRIX_PATHS)


async def two_workspaces(db: AsyncSession) -> dict[str, Any]:
    a = await make_workspace(db, name="Alpha")
    b = await make_workspace(db, name="Bravo")
    b_member = await add_member(db, b, role="editor")
    b_invite, _ = await make_invite(db, b)
    b_key, _ = await make_api_key(db, b)
    return {"a": a, "b": b, "b_member": b_member, "b_invite": b_invite, "b_key": b_key}


async def assert_b_unchanged(db: AsyncSession, w: dict[str, Any]) -> None:
    await db.refresh(w["b_invite"])
    await db.refresh(w["b_key"])
    assert w["b_invite"].revoked_at is None
    assert w["b_key"].revoked_at is None
    m = await db.get(Membership, (w["b"].id, w["b_member"].id))
    assert m is not None and m.role == "editor"
    b = await db.get(Workspace, w["b"].id)
    assert b is not None and b.name == "Bravo"


async def test_owner_of_a_cannot_touch_b(db: AsyncSession, session_client: Any) -> None:
    w = await two_workspaces(db)
    c = await session_client(await owner_of(db, w["a"]), w["a"])
    for method, path, body in (
        ("DELETE", f"/v1/api-keys/{w['b_key'].id}", None),
        ("DELETE", f"/v1/invites/{w['b_invite'].id}", None),
        ("PATCH", f"/v1/members/{w['b_member'].id}", {"role": "viewer"}),
        ("DELETE", f"/v1/members/{w['b_member'].id}", None),
    ):
        r = await c.request(method, path, json=body)
        assert r.status_code == 404, (method, path, r.text)
        assert r.json()["error"]["code"] == "not_found"
    # Selecting B with the header is refused as not found.
    r = await c.request(
        "DELETE",
        "/v1/workspace",
        json={"confirm": w["b"].slug},
        headers={"X-Workspace": w["b"].slug},
    )
    assert r.status_code == 404 and r.json()["error"]["code"] == "workspace_not_found"
    r = await c.patch(
        "/v1/workspace", json={"name": "Hacked"}, headers={"X-Workspace": str(w["b"].id)}
    )
    assert r.status_code == 404
    await assert_b_unchanged(db, w)


async def test_key_of_a_ignores_workspace_header(db: AsyncSession, key_client: Any) -> None:
    w = await two_workspaces(db)
    _, raw = await make_api_key(db, w["a"], scopes="read,write,admin")
    c = key_client(raw, headers={"X-Workspace": w["b"].slug})
    r = await c.get("/v1/workspace")
    assert r.json()["id"] == str(w["a"].id)
    r = await c.patch("/v1/workspace", json={"name": "Renamed A"})
    assert r.json()["id"] == str(w["a"].id)
    await assert_b_unchanged(db, w)


async def test_lists_never_include_other_workspaces(
    db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    w = await two_workspaces(db)
    a_owner = await owner_of(db, w["a"])
    a_invite, _ = await make_invite(db, w["a"])
    a_key, raw = await make_api_key(db, w["a"], scopes="read,write,admin")
    for c in (await session_client(a_owner, w["a"]), key_client(raw)):
        members = {m["user_id"] for m in (await c.get("/v1/members")).json()["data"]}
        assert members == {str(a_owner.id)}
        invites = {i["id"] for i in (await c.get("/v1/invites")).json()["data"]}
        assert invites == {str(a_invite.id)}
        keys = {k["id"] for k in (await c.get("/v1/api-keys")).json()["data"]}
        assert keys == {str(a_key.id)}
    # And B's owner sees only B.
    b_owner = await owner_of(db, w["b"])
    cb = await session_client(b_owner, w["b"])
    keys_b = {k["id"] for k in (await cb.get("/v1/api-keys")).json()["data"]}
    assert keys_b == {str(w["b_key"].id)}
    assert str(a_key.id) not in keys_b


async def test_workspaces_list_is_the_users_own(db: AsyncSession, session_client: Any) -> None:
    w = await two_workspaces(db)
    c = await session_client(await owner_of(db, w["a"]))
    slugs = {x["slug"] for x in (await c.get("/v1/workspaces")).json()["data"]}
    assert slugs == {w["a"].slug}
    assert await db.get(Invite, w["b_invite"].id) is not None
    assert await db.get(ApiKey, w["b_key"].id) is not None
