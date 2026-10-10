"""Hard deletes (SPEC §8.4, §9.2.7): workspace and account cascades."""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core.actor import user_actor
from raisebook.models.activity import Activity
from raisebook.models.imports import ImportRun
from raisebook.models.investor import Investor
from raisebook.models.round import Round, RoundParticipant, RoundStage
from raisebook.models.user import LoginToken, User, UserSession
from raisebook.models.workspace import ApiKey, Invite, Membership, Workspace
from tests.factories import (
    add_member,
    make_activity,
    make_api_key,
    make_investor,
    make_invite,
    make_participant,
    make_round,
    make_user,
    make_workspace,
    owner_of,
)


async def populate(db: AsyncSession, ws: Workspace, user: User) -> None:
    rnd = await make_round(db, ws)
    for _ in range(3):
        inv = await make_investor(db, ws)
        await make_participant(db, rnd, inv, stage="contacted", owner_user_id=user.id)
        await make_activity(db, inv, rnd=rnd, actor=user_actor(user.id))
    await make_api_key(db, ws)
    await make_invite(db, ws)
    db.add(
        ImportRun(
            workspace_id=ws.id,
            format="csv",
            round_id=rnd.id,
            actor_type="user",
            actor_user_id=user.id,
            counts={"rows": 3},
        )
    )
    await db.flush()


async def count(db: AsyncSession, model: Any, ws_id: Any) -> int:
    return int(
        await db.scalar(select(func.count()).select_from(model).where(model.workspace_id == ws_id))
        or 0
    )


WS_TABLES = (
    Round,
    RoundStage,
    RoundParticipant,
    Investor,
    Activity,
    ApiKey,
    Invite,
    ImportRun,
    Membership,
)


async def test_delete_workspace_cascades_everything(db: AsyncSession, session_client: Any) -> None:
    ws = await make_workspace(db)
    keep = await make_workspace(db)
    owner = await owner_of(db, ws)
    await populate(db, ws, owner)
    await populate(db, keep, await owner_of(db, keep))
    c = await session_client(owner, ws)
    r = await c.request("DELETE", "/v1/workspace", json={"confirm": "wrong"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "confirmation_required"
    assert r.json()["error"]["details"]["expected"] == ws.slug
    r = await c.request("DELETE", "/v1/workspace", json={"confirm": ws.slug})
    assert r.status_code == 204
    assert await db.get(Workspace, ws.id) is None
    for model in WS_TABLES:
        assert await count(db, model, ws.id) == 0, model.__tablename__
        assert await count(db, model, keep.id) > 0, model.__tablename__
    assert await db.get(User, owner.id) is not None  # the account stays


async def test_only_owner_session_deletes_workspace(
    db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    ws = await make_workspace(db)
    editor = await add_member(db, ws)
    r = await (await session_client(editor, ws)).request(
        "DELETE", "/v1/workspace", json={"confirm": ws.slug}
    )
    assert r.status_code == 403
    _, raw = await make_api_key(db, ws, scopes="read,write,admin")
    r = await key_client(raw).request("DELETE", "/v1/workspace", json={"confirm": ws.slug})
    assert r.status_code == 403 and r.json()["error"]["code"] == "insufficient_scope"
    assert await db.get(Workspace, ws.id) is not None


async def test_delete_account(db: AsyncSession, session_client: Any) -> None:
    user = await make_user(db, email="leaver@example.com")
    solo = await make_workspace(db, owner=user)  # only member: deleted
    await populate(db, solo, user)
    shared = await make_workspace(db)  # another owner: the user just leaves
    await add_member(db, shared, user=user, role="editor")
    rnd = await make_round(db, shared)
    inv = await make_investor(db, shared)
    await make_participant(db, rnd, inv, owner_user_id=user.id)
    act = await make_activity(db, inv, rnd=rnd, actor=user_actor(user.id))
    db.add(LoginToken(email=user.email, token_hash=b"x" * 32, expires_at=act.created_at))
    await db.flush()
    c = await session_client(user)
    r = await c.request("DELETE", "/v1/me", json={"confirm_email": "nope@example.com"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "confirmation_required"
    r = await c.request("DELETE", "/v1/me", json={"confirm_email": "Leaver@example.com"})
    assert r.status_code == 204, r.text
    assert await db.get(User, user.id) is None
    assert await db.get(Workspace, solo.id) is None
    assert await db.get(Workspace, shared.id) is not None
    assert await count(db, Investor, solo.id) == 0
    await db.refresh(act)
    assert act.actor_user_id is None and act.actor_type == "user"  # shown as "Former member"
    assert await db.scalar(select(LoginToken).where(LoginToken.email == user.email)) is None
    assert (
        await db.scalar(
            select(func.count()).select_from(UserSession).where(UserSession.user_id == user.id)
        )
        == 0
    )


async def test_sole_owner_of_shared_workspace_must_transfer(
    db: AsyncSession, session_client: Any
) -> None:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    await add_member(db, ws, role="editor")
    r = await (await session_client(owner)).request(
        "DELETE", "/v1/me", json={"confirm_email": owner.email}
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "transfer_ownership_first"
    assert r.json()["error"]["details"]["workspaces"][0]["slug"] == ws.slug
    assert await db.get(User, owner.id) is not None
