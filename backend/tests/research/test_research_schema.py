"""Migration 0003 (RESEARCH-PLAN §1): round trip, the ``research`` activity kind, composite
foreign keys that keep research rows inside one workspace, and delete cascades."""

from __future__ import annotations

import asyncio
import os
import secrets as pysecrets
from datetime import date
from typing import Any

import asyncpg
import pytest
from alembic.config import Config
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from alembic import command
from raisebook.models.activity import Activity
from raisebook.models.investor import Investor
from raisebook.models.research import (
    Dossier,
    DossierFacts,
    FieldSuggestion,
    InvestorIdentity,
    ResearchRun,
    ResearchSource,
)
from tests.conftest import BACKEND_DIR, TEST_DB_URL
from tests.factories import make_investor, make_round, make_workspace, owner_of


def _alembic(schema: str, *args: str) -> None:
    cfg = Config(os.path.join(BACKEND_DIR, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(BACKEND_DIR, "alembic"))
    cfg.attributes["schema"] = schema
    cfg.attributes["configure_logger"] = False
    fn = getattr(command, args[0])
    fn(cfg, *args[1:])


async def test_0003_upgrade_downgrade_round_trip() -> None:
    schema = f"t_mig_{pysecrets.token_hex(4)}"
    dsn = TEST_DB_URL.replace("postgresql+asyncpg://", "postgresql://")
    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(f'CREATE SCHEMA "{schema}"')
        await asyncio.to_thread(_alembic, schema, "upgrade", "head")
        tables = {
            r["table_name"]
            for r in await conn.fetch(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = $1", schema
            )
        }
        assert {"jobs", "workspace_ai_settings", "dossiers", "dossier_facts"} <= tables
        await asyncio.to_thread(_alembic, schema, "downgrade", "0002")
        after = {
            r["table_name"]
            for r in await conn.fetch(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = $1", schema
            )
        }
        assert "jobs" not in after and "research_runs" not in after and "investors" in after
        await asyncio.to_thread(_alembic, schema, "upgrade", "head")
    finally:
        await conn.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        await conn.close()


async def test_activities_accept_the_research_kind(db: AsyncSession) -> None:
    ws = await make_workspace(db)
    inv = await make_investor(db, ws)
    db.add(
        Activity(
            workspace_id=ws.id,
            investor_id=inv.id,
            kind="research",
            body="Researched: Strong fit",
            actor_type="system",
            actor_label="raisebook",
            via="system",
        )
    )
    await db.flush()
    async with db.begin_nested() as sp:
        db.add(
            Activity(
                workspace_id=ws.id,
                investor_id=inv.id,
                kind="gossip",
                actor_type="system",
                actor_label="raisebook",
                via="system",
            )
        )
        with pytest.raises(IntegrityError):
            await db.flush()
        await sp.rollback()


def run_values(ws: Any, inv: Any, user: Any, **kw: Any) -> dict[str, Any]:
    return {
        "workspace_id": ws.id,
        "investor_id": inv.id,
        "kind": "dossier",
        "status": "succeeded",
        "actor_type": "user",
        "actor_user_id": user.id,
        "via": "web",
        **kw,
    }


async def test_research_rows_cannot_point_into_another_workspace(db: AsyncSession) -> None:
    a = await make_workspace(db)
    b = await make_workspace(db)
    owner_a = await owner_of(db, a)
    inv_b = await make_investor(db, b)
    rnd_b = await make_round(db, b)
    inv_a = await make_investor(db, a)
    for values in (
        run_values(a, inv_b, owner_a),
        run_values(a, inv_a, owner_a, round_id=rnd_b.id),
    ):
        async with db.begin_nested() as sp:
            db.add(ResearchRun(**values))
            with pytest.raises(IntegrityError):
                await db.flush()
            await sp.rollback()
    run_a = ResearchRun(**run_values(a, inv_a, owner_a))
    db.add(run_a)
    await db.flush()
    async with db.begin_nested() as sp:  # B's source on A's run
        db.add(
            ResearchSource(
                workspace_id=b.id,
                run_id=run_a.id,
                investor_id=inv_b.id,
                url="https://harborlight.example/team",
                url_key="harborlight.example/team",
                domain="harborlight.example",
                fetched_at=date(2026, 10, 1),
            )
        )
        with pytest.raises(IntegrityError):
            await db.flush()
        await sp.rollback()


async def test_deleting_an_investor_cascades_research(db: AsyncSession, frozen_now: Any) -> None:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    inv = await make_investor(db, ws, name="Dana Whitfield", firm="Harbor Light Ventures")
    run = ResearchRun(**run_values(ws, inv, owner))
    db.add(run)
    await db.flush()
    db.add(
        ResearchSource(
            workspace_id=ws.id,
            run_id=run.id,
            investor_id=inv.id,
            url="https://harborlight.example/team/dana",
            url_key="harborlight.example/team/dana",
            domain="harborlight.example",
            fetched_at=frozen_now,
            matched_anchor="firm_domain",
            accepted=True,
        )
    )
    db.add(InvestorIdentity(workspace_id=ws.id, investor_id=inv.id, status="confirmed"))
    dossier = Dossier(
        workspace_id=ws.id,
        investor_id=inv.id,
        run_id=run.id,
        version=1,
        author_kind="model",
        author_label="anthropic/claude-opus-5.5",
        verdict="strong",
        actor_type="user",
        actor_user_id=owner.id,
        via="web",
    )
    db.add(dossier)
    await db.flush()
    db.add(
        DossierFacts(
            dossier_id=dossier.id, workspace_id=ws.id, investor_id=inv.id, as_of=date(2026, 10, 12)
        )
    )
    db.add(
        FieldSuggestion(
            workspace_id=ws.id,
            investor_id=inv.id,
            dossier_id=dossier.id,
            field="title",
            suggested_value="General Partner",
        )
    )
    await db.flush()
    await db.execute(delete(Investor).where(Investor.id == inv.id))
    for model in (
        ResearchRun,
        ResearchSource,
        InvestorIdentity,
        Dossier,
        DossierFacts,
        FieldSuggestion,
    ):
        count = await db.scalar(
            select(func.count()).select_from(model).where(model.workspace_id == ws.id)
        )
        assert count == 0, model.__tablename__


async def test_one_pending_suggestion_per_field_and_fit_needs_a_round(db: AsyncSession) -> None:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    inv = await make_investor(db, ws)
    dossier = Dossier(
        workspace_id=ws.id,
        investor_id=inv.id,
        version=1,
        author_kind="agent",
        author_label="claude-code",
        verdict="possible",
        actor_type="user",
        actor_user_id=owner.id,
        via="web",
    )
    db.add(dossier)
    await db.flush()

    def suggestion(**kw: Any) -> FieldSuggestion:
        return FieldSuggestion(
            workspace_id=ws.id, investor_id=inv.id, dossier_id=dossier.id, suggested_value=1, **kw
        )

    db.add(suggestion(field="title"))
    await db.flush()
    for bad in (suggestion(field="title"), suggestion(field="fit")):
        async with db.begin_nested() as sp:
            db.add(bad)
            with pytest.raises(IntegrityError):
                await db.flush()
            await sp.rollback()
    db.add(suggestion(field="title", status="ignored"))  # decided ones may repeat
    await db.flush()
    await db.execute(text("SELECT 1"))
