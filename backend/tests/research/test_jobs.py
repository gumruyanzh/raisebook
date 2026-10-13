"""The Postgres job queue (services/jobs.py; RESEARCH-PLAN §3.1).

Single-session rules run inside the test transaction. Claim races use real commits
(``committing_sessionmaker``) with a kind unique to the test, and clean up after themselves.
"""

from __future__ import annotations

import asyncio
import secrets as pysecrets
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any
from uuid import UUID

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from raisebook.services import jobs as jobs_svc
from tests.factories import make_workspace

LEASE = 120


def kind() -> str:
    return f"test.k{pysecrets.token_hex(4)}"


async def job_row(db: AsyncSession, job_id: UUID) -> dict[str, Any]:
    row = (
        await db.execute(
            text(
                "SELECT status, attempts, locked_by, locked_until, run_after, last_error,"
                " finished_at FROM jobs WHERE id = :id"
            ),
            {"id": job_id},
        )
    ).one()
    return dict(row._mapping)


async def test_enqueue_dedupes_while_active(db: AsyncSession, frozen_now: Any) -> None:
    k = kind()
    ws = await make_workspace(db)
    first, created = await jobs_svc.enqueue(
        db, kind=k, now=frozen_now, workspace_id=ws.id, payload={"run_id": "x"}, dedupe_key="d1"
    )
    assert created
    again, created_again = await jobs_svc.enqueue(db, kind=k, now=frozen_now, dedupe_key="d1")
    assert (again, created_again) == (first, False)
    claimed = await jobs_svc.claim(db, worker_id="w1", now=frozen_now, lease_s=LEASE, kinds=[k])
    assert claimed is not None and claimed.id == first and claimed.payload == {"run_id": "x"}
    again, created_again = await jobs_svc.enqueue(db, kind=k, now=frozen_now, dedupe_key="d1")
    assert again == first and not created_again  # running counts as active too
    await jobs_svc.finish(db, job_id=first, worker_id="w1", status="succeeded", now=frozen_now)
    fresh, created_fresh = await jobs_svc.enqueue(db, kind=k, now=frozen_now, dedupe_key="d1")
    assert created_fresh and fresh != first
    # No dedupe key: always a new job.
    a, _ = await jobs_svc.enqueue(db, kind=k, now=frozen_now)
    b, _ = await jobs_svc.enqueue(db, kind=k, now=frozen_now)
    assert a != b


async def test_claim_order_due_time_and_kinds(db: AsyncSession, frozen_now: Any) -> None:
    k, other = kind(), kind()
    later, _ = await jobs_svc.enqueue(
        db, kind=k, now=frozen_now, run_after=frozen_now + timedelta(minutes=5)
    )
    bulk, _ = await jobs_svc.enqueue(db, kind=k, now=frozen_now, priority=jobs_svc.PRIORITY_BULK)
    single, _ = await jobs_svc.enqueue(
        db, kind=k, now=frozen_now, priority=jobs_svc.PRIORITY_SINGLE
    )
    await jobs_svc.enqueue(db, kind=other, now=frozen_now, priority=1)
    got = [
        await jobs_svc.claim(db, worker_id="w", now=frozen_now, lease_s=LEASE, kinds=[k])
        for _ in range(3)
    ]
    assert [j.id if j else None for j in got] == [single, bulk, None]  # `later` is not due
    assert got[0] is not None and got[0].attempts == 1
    assert got[0].locked_until == frozen_now + timedelta(seconds=LEASE)
    row = await job_row(db, single)
    assert row["status"] == "running" and row["locked_by"] == "w"
    due = await jobs_svc.claim(
        db, worker_id="w", now=frozen_now + timedelta(minutes=6), lease_s=LEASE, kinds=[k]
    )
    assert due is not None and due.id == later


async def test_heartbeat_and_finish_need_the_lease(db: AsyncSession, frozen_now: Any) -> None:
    k = kind()
    job_id, _ = await jobs_svc.enqueue(db, kind=k, now=frozen_now)
    await jobs_svc.claim(db, worker_id="w1", now=frozen_now, lease_s=LEASE, kinds=[k])
    later = frozen_now + timedelta(seconds=30)
    assert await jobs_svc.heartbeat(db, job_id=job_id, worker_id="w1", now=later, lease_s=LEASE)
    assert (await job_row(db, job_id))["locked_until"] == later + timedelta(seconds=LEASE)
    # Another worker (or this one after losing the lease) changes nothing.
    assert not await jobs_svc.heartbeat(db, job_id=job_id, worker_id="w2", now=later, lease_s=9)
    assert not await jobs_svc.finish(
        db, job_id=job_id, worker_id="w2", status="succeeded", now=later
    )
    assert await jobs_svc.retry(db, job_id=job_id, worker_id="w2", now=later, error="x") is None
    assert not await jobs_svc.release(db, job_id=job_id, worker_id="w2", now=later)
    assert (await job_row(db, job_id))["status"] == "running"
    assert await jobs_svc.finish(db, job_id=job_id, worker_id="w1", status="succeeded", now=later)
    row = await job_row(db, job_id)
    assert row["status"] == "succeeded" and row["locked_by"] is None
    assert row["finished_at"] == later
    with pytest.raises(ValueError):
        await jobs_svc.finish(db, job_id=job_id, worker_id="w1", status="queued", now=later)


def test_backoff_schedule() -> None:
    assert jobs_svc.backoff_s(1, rand=0.5) == 10.0
    assert jobs_svc.backoff_s(2, rand=0.5) == 20.0
    assert jobs_svc.backoff_s(4, rand=0.0) == pytest.approx(80 * 0.8)
    assert jobs_svc.backoff_s(4, rand=1.0) == pytest.approx(80 * 1.2)
    assert jobs_svc.backoff_s(20, rand=0.5) == 900.0  # capped at 15 minutes
    assert jobs_svc.backoff_s(1, retry_after_s=120, rand=0.5) == 120.0  # Retry-After wins
    assert jobs_svc.backoff_s(1, retry_after_s=99999, rand=0.5) == 900.0
    assert jobs_svc.backoff_s(5, retry_after_s=1, rand=0.5) == 160.0


async def test_retry_backs_off_then_fails(db: AsyncSession, frozen_now: Any) -> None:
    k = kind()
    job_id, _ = await jobs_svc.enqueue(db, kind=k, now=frozen_now, max_attempts=3)
    now = frozen_now
    statuses = []
    for _ in range(3):
        claimed = await jobs_svc.claim(db, worker_id="w", now=now, lease_s=LEASE, kinds=[k])
        assert claimed is not None and claimed.id == job_id
        status = await jobs_svc.retry(
            db, job_id=job_id, worker_id="w", now=now, error="openrouter_unavailable", rand=0.5
        )
        statuses.append(status)
        row = await job_row(db, job_id)
        if status == "queued":
            assert row["run_after"] == now + timedelta(seconds=5 * 2**claimed.attempts)
            assert row["locked_by"] is None and row["last_error"] == "openrouter_unavailable"
            # not due yet
            assert (
                await jobs_svc.claim(db, worker_id="w", now=now, lease_s=LEASE, kinds=[k]) is None
            )
            now = row["run_after"]
    assert statuses == ["queued", "queued", "failed"]
    row = await job_row(db, job_id)
    assert row["status"] == "failed" and row["attempts"] == 3 and row["finished_at"] is not None


async def test_recover_stuck_requeues_then_fails_poison_jobs(
    db: AsyncSession, frozen_now: Any
) -> None:
    k = kind()
    job_id, _ = await jobs_svc.enqueue(db, kind=k, now=frozen_now, max_attempts=2)
    await jobs_svc.claim(db, worker_id="dead", now=frozen_now, lease_s=60, kinds=[k])
    # Lease still valid: nothing to recover.
    assert await jobs_svc.recover_stuck(db, now=frozen_now + timedelta(seconds=59), kinds=[k]) == []
    t1 = frozen_now + timedelta(seconds=61)
    rec = await jobs_svc.recover_stuck(db, now=t1, kinds=[k])
    assert [(r.id, r.failed) for r in rec] == [(job_id, False)]
    row = await job_row(db, job_id)
    assert row["status"] == "queued" and row["attempts"] == 1 and row["locked_by"] is None
    assert (row["last_error"] or "").startswith("lease_expired")
    await jobs_svc.claim(db, worker_id="dead2", now=t1, lease_s=60, kinds=[k])
    rec = await jobs_svc.recover_stuck(db, now=t1 + timedelta(seconds=61), kinds=[k])
    assert [(r.id, r.failed) for r in rec] == [(job_id, True)]
    assert (await job_row(db, job_id))["status"] == "failed"


async def test_release_hands_back_without_counting(db: AsyncSession, frozen_now: Any) -> None:
    k = kind()
    job_id, _ = await jobs_svc.enqueue(db, kind=k, now=frozen_now)
    await jobs_svc.claim(db, worker_id="w", now=frozen_now, lease_s=LEASE, kinds=[k])
    assert await jobs_svc.release(db, job_id=job_id, worker_id="w", now=frozen_now)
    row = await job_row(db, job_id)
    assert (row["status"], row["attempts"], row["locked_by"]) == ("queued", 0, None)


async def test_cancel_queued_and_purge(db: AsyncSession, frozen_now: Any) -> None:
    k = kind()
    ws = await make_workspace(db)
    queued, _ = await jobs_svc.enqueue(db, kind=k, now=frozen_now, workspace_id=ws.id)
    other_kind, _ = await jobs_svc.enqueue(db, kind=kind(), now=frozen_now, workspace_id=ws.id)
    n = await jobs_svc.cancel_queued(db, workspace_id=ws.id, now=frozen_now, kinds=[k])
    assert n == 1
    assert (await job_row(db, queued))["status"] == "cancelled"
    assert (await job_row(db, other_kind))["status"] == "queued"
    purged = await jobs_svc.purge_finished(db, older_than=frozen_now + timedelta(seconds=1))
    assert purged >= 1
    assert (
        await db.execute(text("SELECT count(*) FROM jobs WHERE id = :id"), {"id": queued})
    ).scalar_one() == 0


async def test_payload_and_kind_checks(db: AsyncSession, frozen_now: Any) -> None:
    from sqlalchemy.exc import DBAPIError

    for bad_kind in ("Research.Run", "x", "has space"):
        async with db.begin_nested() as sp:
            with pytest.raises(DBAPIError):
                await jobs_svc.enqueue(db, kind=bad_kind, now=frozen_now)
            await sp.rollback()


# --- real concurrency (committed rows) ----------------------------------------------------


@pytest_asyncio.fixture(loop_scope="session")
async def committed_kind(
    committing_sessionmaker: async_sessionmaker[AsyncSession],
) -> AsyncIterator[str]:
    k = kind()
    yield k
    async with committing_sessionmaker() as s:
        await s.execute(text("DELETE FROM jobs WHERE kind = :k"), {"k": k})
        await s.commit()


async def test_two_workers_never_claim_the_same_job(
    committing_sessionmaker: async_sessionmaker[AsyncSession], committed_kind: str, now: Any
) -> None:
    k = committed_kind
    async with committing_sessionmaker() as s:
        job_id, _ = await jobs_svc.enqueue(s, kind=k, now=now)
        await s.commit()
    async with committing_sessionmaker() as a, committing_sessionmaker() as b:
        got_a = await jobs_svc.claim(a, worker_id="a", now=now, lease_s=LEASE, kinds=[k])
        # A holds the row lock (uncommitted): B skips it instead of waiting or double-claiming.
        got_b = await jobs_svc.claim(b, worker_id="b", now=now, lease_s=LEASE, kinds=[k])
        assert got_a is not None and got_a.id == job_id
        assert got_b is None
        await a.commit()
        await b.commit()


async def test_parallel_claimers_get_distinct_jobs(
    committing_sessionmaker: async_sessionmaker[AsyncSession], committed_kind: str, now: Any
) -> None:
    k = committed_kind
    async with committing_sessionmaker() as s:
        ids = {(await jobs_svc.enqueue(s, kind=k, now=now))[0] for _ in range(3)}
        await s.commit()

    async def claimer(i: int) -> UUID | None:
        async with committing_sessionmaker() as s:
            job = await jobs_svc.claim(s, worker_id=f"w{i}", now=now, lease_s=LEASE, kinds=[k])
            await s.commit()
            return job.id if job else None

    results = await asyncio.gather(*(claimer(i) for i in range(8)))
    claimed = [r for r in results if r is not None]
    assert sorted(map(str, claimed)) == sorted(map(str, ids))  # each exactly once


async def test_enqueue_notifies_on_commit(
    committing_sessionmaker: async_sessionmaker[AsyncSession], committed_kind: str, now: Any
) -> None:
    got: list[str] = []
    async with committing_sessionmaker() as listener:
        conn = await listener.connection()
        raw = await conn.get_raw_connection()
        driver: Any = raw.driver_connection
        woke = asyncio.Event()

        def on_notify(*args: Any) -> None:
            got.append(args[-1])
            woke.set()

        await driver.add_listener(jobs_svc.NOTIFY_CHANNEL, on_notify)
        try:
            async with committing_sessionmaker() as s:
                await jobs_svc.enqueue(s, kind=committed_kind, now=now)
                await asyncio.sleep(0.05)
                assert got == []  # not before commit
                await s.commit()
            await asyncio.wait_for(woke.wait(), timeout=5)
        finally:
            await driver.remove_listener(jobs_svc.NOTIFY_CHANNEL, on_notify)
    assert got == [committed_kind]
