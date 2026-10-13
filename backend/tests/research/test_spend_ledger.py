"""The spend ledger and its race-safe monthly cap (services/spend.py; RESEARCH-PLAN §5.3, R4)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

import pytest
import pytest_asyncio
from sqlalchemy import delete, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from raisebook.models.workspace import Workspace
from raisebook.services import spend
from tests.factories import make_investor, make_workspace, owner_of

OCT = date(2026, 10, 1)


def test_month_follows_the_workspace_timezone() -> None:
    late = datetime(2026, 10, 31, 23, 30, tzinfo=UTC)
    assert spend.month_of(late, "UTC") == date(2026, 10, 1)
    assert spend.month_of(late, "Asia/Tokyo") == date(2026, 11, 1)
    assert spend.month_of(datetime(2026, 11, 1, 3, 0, tzinfo=UTC), "America/Los_Angeles") == OCT


async def test_reserve_settle_release(db: AsyncSession, frozen_now: Any) -> None:
    ws = await make_workspace(db)
    kw = {"workspace_id": ws.id, "month": OCT, "now": frozen_now}
    assert await spend.usage(db, ws.id, OCT) == spend.Usage(OCT, 0, 0, 0)
    assert await spend.reserve(db, amount_micros=600, cap_micros=1_000, **kw)
    assert not await spend.reserve(db, amount_micros=500, cap_micros=1_000, **kw)  # 1100 > cap
    assert await spend.reserve(db, amount_micros=400, cap_micros=1_000, **kw)  # exactly the cap
    u = await spend.usage(db, ws.id, OCT)
    assert (u.spent_micros, u.reserved_micros, u.remaining(1_000)) == (0, 1_000, 0)
    await spend.settle(db, reserved_micros=600, actual_micros=250, **kw)
    u = await spend.usage(db, ws.id, OCT)
    assert (u.spent_micros, u.reserved_micros, u.calls) == (250, 400, 1)
    await spend.release(db, amount_micros=400, **kw)
    u = await spend.usage(db, ws.id, OCT)
    assert (u.spent_micros, u.reserved_micros, u.remaining(1_000)) == (250, 0, 750)
    # A real cost above the reservation is still recorded in full.
    assert await spend.reserve(db, amount_micros=100, cap_micros=1_000, **kw)
    await spend.settle(db, reserved_micros=100, actual_micros=900, **kw)
    u = await spend.usage(db, ws.id, OCT)
    assert (u.spent_micros, u.reserved_micros) == (1_150, 0)
    assert not await spend.reserve(db, amount_micros=1, cap_micros=1_000, **kw)  # over: stop
    assert await spend.reserve(db, amount_micros=0, cap_micros=10_000, **kw)  # raised cap
    with pytest.raises(ValueError):
        await spend.reserve(db, amount_micros=-1, cap_micros=1_000, **kw)


async def test_months_and_workspaces_are_separate(db: AsyncSession, frozen_now: Any) -> None:
    a = await make_workspace(db)
    b = await make_workspace(db)
    assert await spend.reserve(
        db, workspace_id=a.id, month=OCT, amount_micros=900, cap_micros=1_000, now=frozen_now
    )
    assert await spend.reserve(
        db, workspace_id=b.id, month=OCT, amount_micros=900, cap_micros=1_000, now=frozen_now
    )
    nov = date(2026, 11, 1)
    assert await spend.reserve(
        db, workspace_id=a.id, month=nov, amount_micros=900, cap_micros=1_000, now=frozen_now
    )


async def new_run(db: AsyncSession, ws: Any) -> UUID:
    inv = await make_investor(db, ws)
    owner = await owner_of(db, ws)
    run_id: UUID = (
        await db.execute(
            text(
                "INSERT INTO research_runs (workspace_id, investor_id, kind, status, actor_type,"
                " actor_user_id, via) VALUES (:ws, :inv, 'dossier', 'running', 'user', :u, 'web')"
                " RETURNING id"
            ),
            {"ws": ws.id, "inv": inv.id, "u": owner.id},
        )
    ).scalar_one()
    return run_id


async def run_money(db: AsyncSession, run_id: UUID) -> tuple[int, int, Any]:
    r = (
        await db.execute(
            text(
                "SELECT cost_micros, reserved_micros, reserved_month FROM research_runs"
                " WHERE id = :id"
            ),
            {"id": run_id},
        )
    ).one()
    return int(r[0]), int(r[1]), r[2]


async def test_run_level_bookkeeping(db: AsyncSession, frozen_now: Any) -> None:
    ws = await make_workspace(db)
    run_id = await new_run(db, ws)
    kw = {"run_id": run_id, "now": frozen_now}
    assert await spend.reserve_for_run(
        db, workspace_id=ws.id, month=OCT, amount_micros=3_000, cap_micros=25_000_000, **kw
    )
    assert await run_money(db, run_id) == (0, 3_000, OCT)
    await spend.settle_for_run(db, actual_micros=1_234, **kw)
    assert await run_money(db, run_id) == (1_234, 0, None)
    # A second reservation releases any open one first (no double holds after a lost lease).
    for _ in range(2):
        assert await spend.reserve_for_run(
            db, workspace_id=ws.id, month=OCT, amount_micros=5_000, cap_micros=25_000_000, **kw
        )
    u = await spend.usage(db, ws.id, OCT)
    assert (u.spent_micros, u.reserved_micros, u.calls) == (1_234, 5_000, 1)
    # Recovery / cancel / shutdown give back what the run still holds.
    assert await spend.release_for_run(db, **kw) == 5_000
    assert await spend.release_for_run(db, **kw) == 0
    assert await run_money(db, run_id) == (1_234, 0, None)
    assert (await spend.usage(db, ws.id, OCT)).reserved_micros == 0
    # Capped: nothing is held and the run records nothing.
    assert not await spend.reserve_for_run(
        db, workspace_id=ws.id, month=OCT, amount_micros=5_000, cap_micros=2_000, **kw
    )
    assert await run_money(db, run_id) == (1_234, 0, None)
    with pytest.raises(ValueError):
        await spend.settle_for_run(db, actual_micros=1, **kw)


async def test_reserved_month_check(db: AsyncSession) -> None:
    from sqlalchemy.exc import IntegrityError

    ws = await make_workspace(db)
    run_id = await new_run(db, ws)
    async with db.begin_nested() as sp:
        with pytest.raises(IntegrityError):
            await db.execute(
                text("UPDATE research_runs SET reserved_micros = 5 WHERE id = :id"), {"id": run_id}
            )
        await sp.rollback()


@pytest_asyncio.fixture(loop_scope="session")
async def committed_ws(
    committing_sessionmaker: async_sessionmaker[AsyncSession],
) -> AsyncIterator[UUID]:
    async with committing_sessionmaker() as s:
        ws = await make_workspace(s, name="Ledger Race Co")
        ws_id: UUID = ws.id
        await s.commit()
    yield ws_id
    async with committing_sessionmaker() as s:
        await s.execute(delete(Workspace).where(Workspace.id == ws_id))  # cascades the ledger
        await s.commit()


async def test_concurrent_reservations_never_exceed_the_cap(
    committing_sessionmaker: async_sessionmaker[AsyncSession], committed_ws: UUID, now: Any
) -> None:
    cap = 10_000

    async def one(i: int) -> bool:
        async with committing_sessionmaker() as s:
            ok = await spend.reserve(
                s,
                workspace_id=committed_ws,
                month=OCT,
                amount_micros=1_000,
                cap_micros=cap,
                now=now,
            )
            await asyncio.sleep(0.01 * (i % 3))  # hold the row lock a little, out of order
            await s.commit()
            return ok

    results = await asyncio.gather(*(one(i) for i in range(20)))
    assert sum(results) == 10
    async with committing_sessionmaker() as s:
        u = await spend.usage(s, committed_ws, OCT)
    assert u.reserved_micros == 10_000 and u.reserved_micros + u.spent_micros <= cap
