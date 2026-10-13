"""The worker runner (raisebook/worker.py; RESEARCH-PLAN §3.2). Real commits, test-only kinds."""

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

from raisebook import worker as worker_mod
from raisebook.core.clock import get_now
from raisebook.services import jobs as jobs_svc
from raisebook.services.jobs import PermanentJobError, RecoveredJob, TransientJobError
from raisebook.worker import JobContext, LeaseLost, Worker, sessions_from


@pytest_asyncio.fixture(loop_scope="session")
async def k(committing_sessionmaker: async_sessionmaker[AsyncSession]) -> AsyncIterator[str]:
    name = f"test.w{pysecrets.token_hex(4)}"
    yield name
    async with committing_sessionmaker() as s:
        await s.execute(text("DELETE FROM jobs WHERE kind = :k"), {"k": name})
        await s.commit()


async def enqueue(sm: async_sessionmaker[AsyncSession], kind: str, **kw: Any) -> UUID:
    async with sm() as s:
        job_id, _ = await jobs_svc.enqueue(s, kind=kind, now=get_now(), **kw)
        await s.commit()
    return job_id


async def row(sm: async_sessionmaker[AsyncSession], job_id: UUID) -> dict[str, Any]:
    async with sm() as s:
        r = (
            await s.execute(
                text(
                    "SELECT status, attempts, locked_by, last_error, run_after FROM jobs"
                    " WHERE id = :id"
                ),
                {"id": job_id},
            )
        ).one()
    return dict(r._mapping)


def make_worker(
    sm: async_sessionmaker[AsyncSession], handlers: dict[str, Any], **kw: Any
) -> Worker:
    kw.setdefault("poll_s", 0.05)
    kw.setdefault("lease_s", 30)
    kw.setdefault("grace_s", 1.0)
    return Worker(sessions_from(sm), handlers=handlers, recovery_hooks=kw.pop("hooks", {}), **kw)


async def test_drain_runs_jobs_and_records_outcomes(
    committing_sessionmaker: async_sessionmaker[AsyncSession], k: str
) -> None:
    sm = committing_sessionmaker
    seen: list[dict[str, Any]] = []

    async def handler(ctx: JobContext) -> None:
        seen.append(ctx.job.payload)
        async with ctx.session() as s:  # handlers open their own sessions
            await s.execute(text("SELECT 1"))
        what = ctx.job.payload["do"]
        if what == "permanent":
            raise PermanentJobError("openrouter_key_rejected", "secret details stay out")
        if what == "transient":
            raise TransientJobError("openrouter_unavailable", retry_after_s=60)
        if what == "crash":
            raise RuntimeError("boom with private text")

    ok = await enqueue(sm, k, payload={"do": "ok"})
    perm = await enqueue(sm, k, payload={"do": "permanent"})
    trans = await enqueue(sm, k, payload={"do": "transient"})
    crash = await enqueue(sm, k, payload={"do": "crash"})
    w = make_worker(sm, {k: handler})
    assert await w.drain() == 4
    assert len(seen) == 4
    assert (await row(sm, ok))["status"] == "succeeded"
    p = await row(sm, perm)
    assert p["status"] == "failed" and p["last_error"] == "openrouter_key_rejected"
    t = await row(sm, trans)
    assert t["status"] == "queued" and t["attempts"] == 1
    assert t["run_after"] >= get_now() + timedelta(seconds=59)  # honours Retry-After
    c = await row(sm, crash)
    assert c["status"] == "queued" and c["last_error"] == "unexpected: RuntimeError"
    assert "private" not in (c["last_error"] or "")


async def test_worker_without_a_handler_claims_nothing(
    committing_sessionmaker: async_sessionmaker[AsyncSession], k: str
) -> None:
    job_id = await enqueue(committing_sessionmaker, k)
    w = make_worker(committing_sessionmaker, {"other.kind": lambda ctx: None})
    assert await w.drain() == 0
    assert (await row(committing_sessionmaker, job_id))["status"] == "queued"


async def test_run_loop_picks_up_jobs_and_stops(
    committing_sessionmaker: async_sessionmaker[AsyncSession], k: str
) -> None:
    sm = committing_sessionmaker
    done = asyncio.Event()

    async def handler(ctx: JobContext) -> None:
        done.set()

    w = make_worker(sm, {k: handler}, concurrency=2)
    task = asyncio.create_task(w.run())
    job_id = await enqueue(sm, k)
    await asyncio.wait_for(done.wait(), timeout=5)
    w.request_stop()
    await asyncio.wait_for(task, timeout=5)
    for _ in range(50):
        if (await row(sm, job_id))["status"] == "succeeded":
            break
        await asyncio.sleep(0.02)
    assert (await row(sm, job_id))["status"] == "succeeded"


async def test_graceful_shutdown_releases_unfinished_jobs(
    committing_sessionmaker: async_sessionmaker[AsyncSession], k: str
) -> None:
    sm = committing_sessionmaker
    started = asyncio.Event()

    async def stuck(ctx: JobContext) -> None:
        started.set()
        await asyncio.Event().wait()  # never finishes on its own

    job_id = await enqueue(sm, k)
    w = make_worker(sm, {k: stuck}, concurrency=1, grace_s=0.2)
    task = asyncio.create_task(w.run())
    await asyncio.wait_for(started.wait(), timeout=5)
    running = await row(sm, job_id)
    assert running["status"] == "running" and running["attempts"] == 1
    w.request_stop()
    await asyncio.wait_for(task, timeout=5)
    after = await row(sm, job_id)
    assert (after["status"], after["attempts"], after["locked_by"]) == ("queued", 0, None)


async def test_graceful_shutdown_lets_short_jobs_finish(
    committing_sessionmaker: async_sessionmaker[AsyncSession], k: str
) -> None:
    sm = committing_sessionmaker
    started = asyncio.Event()

    async def short(ctx: JobContext) -> None:
        started.set()
        await asyncio.sleep(0.2)

    job_id = await enqueue(sm, k)
    w = make_worker(sm, {k: short}, concurrency=1, grace_s=5)
    task = asyncio.create_task(w.run())
    await asyncio.wait_for(started.wait(), timeout=5)
    w.request_stop()
    await asyncio.wait_for(task, timeout=5)
    assert (await row(sm, job_id))["status"] == "succeeded"


async def test_lost_lease_stops_the_handler_without_writing(
    committing_sessionmaker: async_sessionmaker[AsyncSession], k: str
) -> None:
    sm = committing_sessionmaker
    started = asyncio.Event()
    stopped: list[str] = []

    async def careful(ctx: JobContext) -> None:
        started.set()
        await asyncio.wait_for(ctx.lease_lost.wait(), timeout=10)
        try:
            ctx.check_lease()
        except LeaseLost:
            stopped.append("lease_lost")
            raise

    job_id = await enqueue(sm, k)
    w = make_worker(sm, {k: careful}, lease_s=3)  # heartbeat every second
    run = asyncio.create_task(w.drain())
    await asyncio.wait_for(started.wait(), timeout=5)
    async with sm() as s:  # another worker took it over (as stuck recovery would)
        await s.execute(
            text("UPDATE jobs SET locked_by = 'other:1' WHERE id = :id"), {"id": job_id}
        )
        await s.commit()
    await asyncio.wait_for(run, timeout=10)
    assert stopped == ["lease_lost"]
    after = await row(sm, job_id)
    assert (after["status"], after["locked_by"]) == ("running", "other:1")  # untouched


async def test_recover_runs_the_kind_hook(
    committing_sessionmaker: async_sessionmaker[AsyncSession], k: str
) -> None:
    sm = committing_sessionmaker
    job_id = await enqueue(sm, k, payload={"run_id": "r1"})
    async with sm() as s:
        await jobs_svc.claim(s, worker_id="dead:1", now=get_now(), lease_s=1, kinds=[k])
        await s.execute(
            text("UPDATE jobs SET locked_until = :t WHERE id = :id"),
            {"t": get_now() - timedelta(seconds=5), "id": job_id},
        )
        await s.commit()
    hooked: list[RecoveredJob] = []

    async def hook(s: AsyncSession, rec: RecoveredJob, now: Any) -> None:
        hooked.append(rec)

    async def handler(ctx: JobContext) -> None:
        return None

    w = make_worker(sm, {k: handler}, hooks={k: hook})
    recovered = await w.recover()
    assert [r.id for r in recovered] == [job_id]
    assert hooked and hooked[0].payload == {"run_id": "r1"} and not hooked[0].failed
    assert (await row(sm, job_id))["status"] == "queued"


async def test_rbctl_worker_once_drains(
    committing_sessionmaker: async_sessionmaker[AsyncSession],
    k: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ran: list[UUID] = []

    async def handler(ctx: JobContext) -> None:
        ran.append(ctx.job.id)

    monkeypatch.setitem(worker_mod.HANDLERS, k, handler)
    ids = [await enqueue(committing_sessionmaker, k) for _ in range(2)]
    assert await worker_mod.main(once=True) == 2
    assert sorted(map(str, ran)) == sorted(map(str, ids))
    for job_id in ids:
        assert (await row(committing_sessionmaker, job_id))["status"] == "succeeded"
