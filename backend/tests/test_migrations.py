"""Schema guarantees from migration 0001 (SPEC §3, §9.2.7): the append-only trigger,
composite foreign keys that refuse cross-workspace links, and key CHECKs."""

from __future__ import annotations

import pytest
from sqlalchemy import delete, text, update
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core.actor import Actor, user_actor
from raisebook.models.activity import Activity
from raisebook.models.enums import ActorType, Via
from raisebook.models.imports import ImportRun
from raisebook.models.round import RoundParticipant, RoundStage
from raisebook.models.workspace import ApiKey
from tests.factories import (
    add_member,
    make_activity,
    make_api_key,
    make_investor,
    make_participant,
    make_round,
    make_user,
    make_workspace,
    stages_of,
)


async def expect_db_error(db: AsyncSession, stmt: object) -> None:
    async with db.begin_nested() as sp:
        with pytest.raises((IntegrityError, DBAPIError)):
            await db.execute(stmt)  # type: ignore[call-overload]
        await sp.rollback()


async def test_activities_are_append_only(db: AsyncSession) -> None:
    ws = await make_workspace(db)
    inv = await make_investor(db, ws)
    act = await make_activity(db, inv, body="original")
    for values in ({"body": "edited"}, {"kind": "call"}, {"data": {"x": 1}}, {"via": "api"}):
        async with db.begin_nested() as sp:
            with pytest.raises(DBAPIError, match="append-only"):
                await db.execute(update(Activity).where(Activity.id == act.id).values(**values))
            await sp.rollback()


async def test_trigger_blocks_setting_refs_to_new_values(db: AsyncSession) -> None:
    ws = await make_workspace(db)
    inv = await make_investor(db, ws)
    other = await make_user(db)
    act = await make_activity(db, inv)
    await expect_db_error(
        db, update(Activity).where(Activity.id == act.id).values(actor_user_id=other.id)
    )


async def test_fk_set_null_cascades_pass_the_trigger(db: AsyncSession) -> None:
    ws = await make_workspace(db)
    user = await add_member(db, ws)
    key, _ = await make_api_key(db, ws)
    run = ImportRun(workspace_id=ws.id, format="csv", actor_type="user", counts={})
    db.add(run)
    await db.flush()
    inv = await make_investor(db, ws)
    by_user = await make_activity(db, inv, actor=user_actor(user.id), import_run_id=run.id)
    by_key = await make_activity(
        db, inv, actor=Actor(ActorType.AGENT, Via.API, api_key_id=key.id, label="claude-code")
    )
    await db.execute(delete(ImportRun).where(ImportRun.id == run.id))
    await db.execute(delete(ApiKey).where(ApiKey.id == key.id))
    await db.delete(user)
    await db.flush()
    await db.refresh(by_user)
    await db.refresh(by_key)
    assert by_user.actor_user_id is None and by_user.import_run_id is None
    assert by_user.body == "Called and talked about the pilot."
    assert by_key.api_key_id is None and by_key.actor_label == "claude-code"


async def test_activities_can_be_deleted(db: AsyncSession) -> None:
    ws = await make_workspace(db)
    inv = await make_investor(db, ws)
    act = await make_activity(db, inv)
    await db.execute(delete(Activity).where(Activity.id == act.id))
    assert await db.get(Activity, act.id) is None


async def test_participant_cannot_link_across_workspaces(db: AsyncSession) -> None:
    a = await make_workspace(db)
    b = await make_workspace(db)
    rnd_a = await make_round(db, a)
    inv_b = await make_investor(db, b)
    stage = (await stages_of(db, rnd_a))["new"]
    for ws_id in (a.id, b.id):
        async with db.begin_nested() as sp:
            db.add(
                RoundParticipant(
                    workspace_id=ws_id, round_id=rnd_a.id, investor_id=inv_b.id, stage_id=stage.id
                )
            )
            with pytest.raises(IntegrityError):
                await db.flush()
            await sp.rollback()


async def test_participant_stage_must_belong_to_round(db: AsyncSession) -> None:
    ws = await make_workspace(db)
    r1 = await make_round(db, ws)
    r2 = await make_round(db, ws)
    inv = await make_investor(db, ws)
    other_stage = (await stages_of(db, r2))["new"]
    async with db.begin_nested() as sp:
        db.add(
            RoundParticipant(
                workspace_id=ws.id, round_id=r1.id, investor_id=inv.id, stage_id=other_stage.id
            )
        )
        with pytest.raises(IntegrityError):
            await db.flush()
        await sp.rollback()


async def test_participant_owner_must_be_member(db: AsyncSession) -> None:
    ws = await make_workspace(db)
    outsider = await make_user(db)
    rnd = await make_round(db, ws)
    inv = await make_investor(db, ws)
    async with db.begin_nested() as sp:
        with pytest.raises(IntegrityError):
            await make_participant(db, rnd, inv, owner_user_id=outsider.id)
        await sp.rollback()


async def test_activity_cannot_reference_other_workspace(db: AsyncSession) -> None:
    a = await make_workspace(db)
    b = await make_workspace(db)
    inv_b = await make_investor(db, b)
    rnd_a = await make_round(db, a)
    async with db.begin_nested() as sp:
        db.add(
            Activity(
                workspace_id=a.id,
                investor_id=inv_b.id,
                kind="note",
                actor_type="system",
                actor_label="raisebook",
                via="system",
            )
        )
        with pytest.raises(IntegrityError):
            await db.flush()
        await sp.rollback()
    inv_a = await make_investor(db, a)
    rnd_b = await make_round(db, b)
    async with db.begin_nested() as sp:
        with pytest.raises(IntegrityError):
            await make_activity(db, inv_a, rnd=rnd_b)
        await sp.rollback()
    assert rnd_a.workspace_id == a.id


async def test_one_won_and_one_lost_stage_per_round(db: AsyncSession) -> None:
    ws = await make_workspace(db)
    rnd = await make_round(db, ws)
    for kind in ("won", "lost"):
        async with db.begin_nested() as sp:
            db.add(
                RoundStage(
                    workspace_id=ws.id,
                    round_id=rnd.id,
                    key=f"extra_{kind}",
                    label="Extra",
                    color="sky",
                    kind=kind,
                    position=20,
                )
            )
            with pytest.raises(IntegrityError):
                await db.flush()
            await sp.rollback()


async def test_stage_positions_are_deferrable(db: AsyncSession) -> None:
    """Reordering swaps positions inside one transaction (unique check at commit)."""
    ws = await make_workspace(db)
    rnd = await make_round(db, ws)
    st = await stages_of(db, rnd)
    async with db.begin_nested():
        await db.execute(update(RoundStage).where(RoundStage.id == st["new"].id).values(position=1))
        await db.execute(
            update(RoundStage).where(RoundStage.id == st["research"].id).values(position=0)
        )
        await db.execute(text("SET CONSTRAINTS uq_round_stages_position IMMEDIATE"))
    await db.execute(text("SET CONSTRAINTS uq_round_stages_position DEFERRED"))
    async with db.begin_nested() as sp:
        await db.execute(update(RoundStage).where(RoundStage.id == st["dd"].id).values(position=0))
        with pytest.raises(IntegrityError):
            await db.execute(text("SET CONSTRAINTS uq_round_stages_position IMMEDIATE"))
        await sp.rollback()


async def test_api_key_scope_check(db: AsyncSession) -> None:
    ws = await make_workspace(db)
    key, _ = await make_api_key(db, ws)
    for scopes in ([], ["raisebook:write"], ["raisebook:read", "raisebook:root"]):
        await expect_db_error(db, update(ApiKey).where(ApiKey.id == key.id).values(scopes=scopes))


async def test_investor_unique_email_and_linkedin_per_workspace(db: AsyncSession) -> None:
    a = await make_workspace(db)
    b = await make_workspace(db)
    await make_investor(db, a, email="dup@example.com")
    await make_investor(db, b, email="dup@example.com")  # other workspace: fine
    async with db.begin_nested() as sp:
        with pytest.raises(IntegrityError):
            await make_investor(db, a, email="DUP@example.com")
        await sp.rollback()


async def test_extensions_present(db: AsyncSession) -> None:
    names = set((await db.execute(text("SELECT extname FROM pg_extension"))).scalars())
    assert {"citext", "pg_trgm"} <= names
