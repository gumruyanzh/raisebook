"""The service contracts imports (IE) build on: investors.find_match/create/update,
participants.upsert and activities.log, with an import actor and run id (SPEC §8.1)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import Principal, WorkspaceContext, WorkspaceInfo
from raisebook.auth.scopes import ROLE_SCOPES
from raisebook.core.actor import user_actor
from raisebook.core.errors import Duplicate, LimitReached
from raisebook.core.refs import resolve_stage
from raisebook.models.enums import ActorType, Role, Via
from raisebook.models.imports import ImportRun
from raisebook.services import activities, investors, participants
from raisebook.services.stages import stages_for
from tests.api.helpers import activities_of, participant
from tests.factories import make_round, make_workspace, owner_of


async def ctx_for(db: AsyncSession, **kw: Any) -> tuple[Any, WorkspaceContext]:
    ws = await make_workspace(db, **kw)
    owner = await owner_of(db, ws)
    principal = Principal(
        type=ActorType.USER,
        workspace=WorkspaceInfo.of(ws),
        scopes=ROLE_SCOPES[Role.OWNER],
        user_id=owner.id,
        role=Role.OWNER,
    )
    return ws, WorkspaceContext.build(principal, user_actor(owner.id))


async def test_import_style_writes(db: AsyncSession, frozen_now: Any) -> None:
    ws, ctx = await ctx_for(db)
    rnd = await make_round(db, ws, name="Seed", slug="seed")
    actor = ctx.actor.with_via(Via.IMPORT)
    run = ImportRun(
        workspace_id=ws.id,
        format="csv",
        actor_type="user",
        actor_user_id=ctx.actor.user_id,
        counts={},
        created_at=frozen_now,
    )
    db.add(run)
    await db.flush()

    fields = {"name": "Dana Whitfield", "firm": "Harbor Light Ventures", "email": "d@example.com"}
    assert await investors.find_match(db, ctx, fields) is None
    inv = await investors.create(db, ctx, fields, now=frozen_now, actor=actor, import_run_id=run.id)
    m = await investors.find_match(db, ctx, {"name": "dana whitfield", "firm": "Harbor Light"})
    assert m is not None and m.matched_on == "name_firm" and m.investor.id == inv.id
    assert (
        await investors.find_match(
            db, ctx, {"name": "dana whitfield", "firm": "Harbor Light"}, include_name_firm=False
        )
        is None
    )
    with pytest.raises(Duplicate):
        await investors.create(db, ctx, {"name": "Other", "email": "D@example.com"}, now=frozen_now)

    res = await investors.update(
        db,
        ctx,
        inv,
        {"tags": ["AI"], "notes": "From the sheet"},
        now=frozen_now,
        actor=actor,
        import_run_id=run.id,
    )
    assert sorted(res.changed_fields) == ["notes", "tags"]
    up = await participants.upsert(
        db,
        ctx,
        rnd,
        inv,
        {"stage": "Meeting", "fit": 4, "follow_up_on": frozen_now.date(), "amount_committed": 0},
        now=frozen_now,
        actor=actor,
        import_run_id=run.id,
    )
    assert up.created and up.participant.fit == 4
    acts = await activities_of(db, inv)
    assert [a.kind for a in acts] == [
        "investor_created",
        "investor_updated",
        "added_to_round",
        "follow_up_set",
    ]
    for a in acts:
        assert a.via == "import" and a.import_run_id == run.id and a.actor_type == "user"
    # Imports by a user do log notes changes (only the web notes field is silent).
    assert acts[1].data["changes"]["notes"] == {"changed": True}
    assert acts[1].data["import_run_id"] == str(run.id)

    # import_add / import_update wrappers.
    stages = await stages_for(db, ctx, rnd.id)
    changed = await participants.import_update(
        db,
        ctx,
        round=rnd,
        investor=inv,
        stage=resolve_stage(stages, "dd"),
        changes={"probability": 30},
        now=frozen_now,
        actor=actor,
        import_run_id=run.id,
    )
    assert changed == ["stage", "probability"]


async def test_last_activity_bump(db: AsyncSession, frozen_now: Any) -> None:
    ws, ctx = await ctx_for(db)
    r1 = await make_round(db, ws, name="Seed", slug="seed")
    r2 = await make_round(db, ws, name="Bridge", slug="bridge")
    inv = await investors.create(db, ctx, {"name": "Grace Montoya"}, now=frozen_now)
    await participants.upsert(db, ctx, r1, inv, now=frozen_now - timedelta(days=30))
    await participants.upsert(db, ctx, r2, inv, now=frozen_now - timedelta(days=30))
    later = frozen_now - timedelta(days=1)
    await activities.log(db, ctx, investor_id=inv.id, round_id=r1.id, kind="note", now=later)
    p1, p2 = await participant(db, r1, inv), await participant(db, r2, inv)
    assert p1 is not None and p2 is not None
    assert p1.last_activity_at == later and p2.last_activity_at == frozen_now - timedelta(days=30)
    # Without a round: every participation of the investor.
    await activities.log(db, ctx, investor_id=inv.id, kind="note", now=frozen_now)
    p1, p2 = await participant(db, r1, inv), await participant(db, r2, inv)
    assert p1 is not None and p2 is not None
    assert p1.last_activity_at == frozen_now == p2.last_activity_at
    # A future meeting does not move last activity past now.
    future = frozen_now + timedelta(days=3)
    await activities.log_manual(
        db,
        ctx,
        investor=inv,
        kind="meeting",
        body="Partner meeting",
        now=frozen_now,
        occurred_at=future,
    )
    p1 = await participant(db, r1, inv)
    assert p1 is not None and p1.last_activity_at == frozen_now


async def test_investor_limit(db: AsyncSession, frozen_now: Any, monkeypatch: Any) -> None:
    from raisebook.services import workspaces

    _, ctx = await ctx_for(db)
    monkeypatch.setitem(workspaces.LIMITS, "investors", 1)
    await investors.create(db, ctx, {"name": "One"}, now=frozen_now)
    with pytest.raises(LimitReached):
        await investors.create(db, ctx, {"name": "Two"}, now=frozen_now)
