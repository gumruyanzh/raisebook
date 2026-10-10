"""SPEC §4.6 permissions matrix: the Foundation-backend rows (workspace, members, invites,
API keys). AM and IE add their rows in their own files using ``tests/matrix.py``."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.matrix import ADMINS, ALL, OWNER_SESSION, PRINCIPALS, SESSIONS, Ctx, Row, run_row


def _self_path(ctx: Ctx, principal: str) -> str:
    user = ctx.users.get(principal) or ctx.target_member
    return f"/v1/members/{user.id}"


ROWS = [
    Row("view workspace", "GET", "/v1/workspace", ALL),
    Row("list members", "GET", "/v1/members", ALL),
    Row("update workspace", "PATCH", "/v1/workspace", ADMINS, body={"name": "Renamed"}),
    Row("list api keys", "GET", "/v1/api-keys", ADMINS),
    Row("list invites", "GET", "/v1/invites", ADMINS),
    Row(
        "create api key", "POST", "/v1/api-keys", OWNER_SESSION, body={"name": "new", "scopes": []}
    ),
    Row(
        "revoke api key",
        "DELETE",
        lambda c, _p: f"/v1/api-keys/{c.revocable_key.id}",
        OWNER_SESSION,
    ),
    Row(
        "invite member",
        "POST",
        "/v1/invites",
        OWNER_SESSION,
        body={"email": "new.person@example.com", "role": "viewer"},
    ),
    Row("revoke invite", "DELETE", lambda c, _p: f"/v1/invites/{c.invite.id}", OWNER_SESSION),
    Row(
        "change member role",
        "PATCH",
        lambda c, _p: f"/v1/members/{c.target_member.id}",
        OWNER_SESSION,
        body={"role": "viewer"},
    ),
    Row(
        "remove member",
        "DELETE",
        lambda c, _p: f"/v1/members/{c.target_member.id}",
        OWNER_SESSION,
    ),
    # Leave: every session may remove itself (the last owner gets 409, not 403); keys may not.
    Row("leave workspace", "DELETE", _self_path, SESSIONS),
    Row(
        "delete workspace",
        "DELETE",
        "/v1/workspace",
        OWNER_SESSION,
        body=lambda c, _p: {"confirm": c.ws.slug},
    ),
]


@pytest.mark.parametrize("principal", PRINCIPALS)
@pytest.mark.parametrize("row", ROWS, ids=lambda r: r.name)
async def test_matrix(
    row: Row, principal: str, db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    r = await run_row(row, principal, db, session_client, key_client)
    if row.name == "leave workspace" and principal == "owner":
        assert r.status_code == 409 and r.json()["error"]["code"] == "last_owner"
    elif principal in row.allowed:
        assert r.status_code < 300, (row.name, principal, r.text)
