"""Concurrent research runs on a real worker with real commits can never overshoot the
monthly cap (RESEARCH-PLAN §5.3; R4). OpenRouter is the scripted mock."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID

import pytest_asyncio
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from raisebook.auth.principal import worker_context
from raisebook.core.clock import get_now
from raisebook.models.enums import ResearchKind
from raisebook.models.research import ResearchRun
from raisebook.models.user import User
from raisebook.models.workspace import Workspace
from raisebook.services import jobs as jobs_svc
from raisebook.services import research as research_svc
from raisebook.worker import Worker, sessions_from
from tests.factories import make_investor, make_workspace, owner_of
from tests.research.helpers import set_key
from tests.research.pipeline_mock import Script

RESERVE = 10_500  # one identity call's reservation: ≈ $0.007 x 1.5
BILLED = 7_000


@pytest_asyncio.fixture(loop_scope="session")
async def race_ws(
    committing_sessionmaker: async_sessionmaker[AsyncSession],
) -> AsyncIterator[tuple[UUID, UUID]]:
    async with committing_sessionmaker() as s:
        ws = await make_workspace(s, name="Race Robotics")
        owner = await owner_of(s, ws)
        ids = (ws.id, owner.id)
        await s.commit()
    yield ids
    async with committing_sessionmaker() as s:
        await s.execute(delete(Workspace).where(Workspace.id == ids[0]))  # cascades everything
        await s.execute(delete(User).where(User.id == ids[1]))
        await s.commit()


async def test_parallel_runs_never_overshoot_the_cap(
    committing_sessionmaker: async_sessionmaker[AsyncSession],
    race_ws: tuple[UUID, UUID],
    openrouter_mock: Any,
) -> None:
    sm = committing_sessionmaker
    ws_id, owner_id = race_ws
    cap = 30_000  # room for two calls at a time, three at most in total
    Script(identity_cost=BILLED / 1_000_000).install(openrouter_mock)
    async with sm() as s:
        ws_row = await s.get(Workspace, ws_id)
        assert ws_row is not None
        await set_key(s, ws_row, cap_usd=cap / 1_000_000)
        ws = await worker_context(
            s,
            workspace_id=ws_id,
            actor_type="user",
            via="web",
            actor_user_id=owner_id,
            api_key_id=None,
            actor_label=None,
            agent_model=None,
            now=get_now(),
        )
        assert ws is not None
        for i in range(8):
            inv = await make_investor(s, ws_row, name=f"Race Person {i}", firm="Kelpline Ventures")
            await research_svc.start_run(
                s, ws, inv, kind=ResearchKind.IDENTITY, now=get_now(), check_cap=False
            )
        await s.commit()

    w = Worker(
        sessions_from(sm),
        handlers={jobs_svc.KIND_RESEARCH_RUN: research_svc.run_job},
        recovery_hooks={},
        concurrency=4,
        poll_s=0.02,
        lease_s=60,
        worker_id="race",
    )
    task = asyncio.create_task(w.run())
    try:
        for _ in range(500):
            async with sm() as s:
                active = await s.scalar(
                    text(
                        "SELECT count(*) FROM research_runs WHERE workspace_id = :ws"
                        " AND status IN ('queued', 'running')"
                    ),
                    {"ws": ws_id},
                )
            if not active:
                break
            await asyncio.sleep(0.02)
    finally:
        w.request_stop()
        await asyncio.wait_for(task, timeout=10)

    async with sm() as s:
        statuses = list(
            await s.scalars(select(ResearchRun.status).where(ResearchRun.workspace_id == ws_id))
        )
        spent, reserved, calls = (
            await s.execute(
                text(
                    "SELECT spent_micros, reserved_micros, calls FROM ai_usage_months"
                    " WHERE workspace_id = :ws"
                ),
                {"ws": ws_id},
            )
        ).one()
        costs = list(
            await s.scalars(
                select(ResearchRun.cost_micros).where(ResearchRun.workspace_id == ws_id)
            )
        )
    done = statuses.count("succeeded")
    assert done + statuses.count("capped") == 8, statuses
    assert 1 <= done <= cap // BILLED
    assert spent == done * BILLED <= cap and reserved == 0 and calls == done
    assert sum(costs) == spent
