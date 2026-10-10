"""The SPEC §4.6 permissions-matrix harness (shared: AM and IE add rows in their own files).

Usage in a test module::

    from tests.matrix import PRINCIPALS, Row, run_row

    ROWS = [
        Row("list rounds", "GET", "/v1/rounds", allowed=ALL),
        Row("create round", "POST", "/v1/rounds", allowed=WRITERS,
            body={"name": "Seed"}),
        Row("delete round", "DELETE", lambda c: f"/v1/rounds/{c.extra['round'].slug}",
            allowed=ADMINS_AND_OWNER, body=lambda c: {"confirm": c.extra["round"].name},
            setup=make_round_setup),
    ]

    @pytest.mark.parametrize("principal", PRINCIPALS)
    @pytest.mark.parametrize("row", ROWS, ids=lambda r: r.name)
    async def test_matrix(row, principal, db, session_client, key_client):
        await run_row(row, principal, db, session_client, key_client)

A principal in ``allowed`` must not get 401/403 (a 404/409/422 from the action itself is
fine); every other principal must get 403 with ``insufficient_scope`` (keys) or
``forbidden_role`` (sessions).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import add_member, make_api_key, make_invite, make_workspace, owner_of

PRINCIPALS: tuple[str, ...] = ("owner", "editor", "viewer", "key_read", "key_write", "key_admin")
SESSIONS = frozenset({"owner", "editor", "viewer"})
ALL = frozenset(PRINCIPALS)
READERS = ALL
WRITERS = frozenset({"owner", "editor", "key_write", "key_admin"})
ADMINS = frozenset({"owner", "key_admin"})
OWNER_SESSION = frozenset({"owner"})

KEY_SCOPES = {"key_read": "read", "key_write": "read,write", "key_admin": "read,write,admin"}


@dataclass
class Ctx:
    """A workspace with one owner, editor and viewer, three keys, and spare targets."""

    ws: Any
    users: dict[str, Any]  # role → user
    keys: dict[str, str]  # key_read/key_write/key_admin → plaintext
    target_member: Any  # a spare editor to change or remove
    invite: Any
    revocable_key: Any
    extra: dict[str, Any] = field(default_factory=dict)


Setup = Callable[[AsyncSession, Ctx], Awaitable[dict[str, Any]]]
PathSpec = str | Callable[[Ctx, str], str]
BodySpec = dict[str, Any] | Callable[[Ctx, str], dict[str, Any]] | None


@dataclass
class Row:
    name: str
    method: str
    path: PathSpec
    allowed: frozenset[str]
    body: BodySpec = None
    setup: Setup | None = None


async def build_ctx(db: AsyncSession) -> Ctx:
    ws = await make_workspace(db, name="Matrix Co")
    owner = await owner_of(db, ws)
    editor = await add_member(db, ws, role="editor")
    viewer = await add_member(db, ws, role="viewer")
    target = await add_member(db, ws, role="editor")
    invite, _ = await make_invite(db, ws, invited_by=owner)
    revocable, _ = await make_api_key(db, ws, name="revocable")
    keys = {}
    for name, scopes in KEY_SCOPES.items():
        _, raw = await make_api_key(db, ws, scopes=scopes, name=name)
        keys[name] = raw
    return Ctx(
        ws=ws,
        users={"owner": owner, "editor": editor, "viewer": viewer},
        keys=keys,
        target_member=target,
        invite=invite,
        revocable_key=revocable,
    )


async def client_for(
    ctx: Ctx, principal: str, session_client: Any, key_client: Any
) -> httpx.AsyncClient:
    if principal in SESSIONS:
        client: httpx.AsyncClient = await session_client(ctx.users[principal], ctx.ws)
        return client
    return key_client(ctx.keys[principal])  # type: ignore[no-any-return]


async def run_row(
    row: Row, principal: str, db: AsyncSession, session_client: Any, key_client: Any
) -> httpx.Response:
    ctx = await build_ctx(db)
    if row.setup is not None:
        ctx.extra.update(await row.setup(db, ctx))
    path = row.path(ctx, principal) if callable(row.path) else row.path
    body = row.body(ctx, principal) if callable(row.body) else row.body
    c = await client_for(ctx, principal, session_client, key_client)
    r = await c.request(row.method, path, json=body)
    if principal in row.allowed:
        assert r.status_code not in (401, 403), (row.name, principal, r.status_code, r.text)
    else:
        assert r.status_code == 403, (row.name, principal, r.status_code, r.text)
        expected = "forbidden_role" if principal in SESSIONS else "insufficient_scope"
        assert r.json()["error"]["code"] == expected, (row.name, principal, r.text)
        assert r.json()["error"]["details"]["required"], (row.name, principal)
    return r
