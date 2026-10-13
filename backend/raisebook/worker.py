"""The background worker (``rbctl worker``; RESEARCH-PLAN §3.2).

One asyncio process with ``RAISEBOOK_WORKER_CONCURRENCY`` slots. Each slot claims a due job
(``services/jobs.claim``, ``FOR UPDATE SKIP LOCKED``), runs its handler and records the
outcome. Idle slots wake on ``NOTIFY raisebook_jobs`` (a dedicated ``LISTEN`` connection)
or every ``RAISEBOOK_WORKER_POLL_S`` seconds.

- **Leases.** A running job is heartbeated every ``lease / 3``. A worker that loses its
  lease (the job was recovered as stuck) sets ``JobContext.lease_lost``; handlers check it
  between steps and stop. Every write that ends a job is guarded by ``locked_by``.
- **Outcomes.** Handler returns → ``succeeded``. :class:`PermanentJobError` → ``failed``,
  no retry. :class:`TransientJobError` → retry with backoff (honouring ``Retry-After``).
  Anything else → retry, logged with frame names only (``safe_traceback``).
- **Stuck jobs.** Every tick requeues running jobs whose lease expired, and runs the kind's
  recovery hook (e.g. release a dead run's spend reservation).
- **Graceful shutdown.** SIGTERM/SIGINT: stop claiming, wait up to ``GRACE_S`` for running
  jobs, then cancel them and release their leases (queued again, attempt not counted) so
  another worker resumes at once. Exit 0.

The worker has its own small engine (never the API's pool). Logs carry job id, kind,
workspace id, status, attempt and duration, never payloads.
"""

from __future__ import annotations

import asyncio
import importlib
import os
import signal
import socket
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import datetime
from itertools import count
from typing import Any

import structlog
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from raisebook.config import Settings, get_settings
from raisebook.core.clock import get_now
from raisebook.core.database import build_engine
from raisebook.core.logging import safe_traceback
from raisebook.services import jobs as jobs_svc
from raisebook.services.jobs import ClaimedJob, PermanentJobError, RecoveredJob, TransientJobError

log = structlog.get_logger("raisebook.worker")

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


@dataclass
class JobContext:
    """What a handler gets: the job, a way to open sessions, and the lease flag."""

    job: ClaimedJob
    session: SessionFactory
    lease_lost: asyncio.Event = field(default_factory=asyncio.Event)
    now: Callable[[], datetime] = get_now

    def check_lease(self) -> None:
        """Call between steps: stop (without writing results) once the lease is gone."""
        if self.lease_lost.is_set():
            raise LeaseLost()


class LeaseLost(Exception):
    """This worker no longer holds the job; another worker will resume it."""


Handler = Callable[[JobContext], Awaitable[None]]
RecoveryHook = Callable[[AsyncSession, RecoveredJob, datetime], Awaitable[None]]

# kind → handler. Feature modules register theirs (research runs, prefill, removal) by
# calling :func:`register` at import; ``HANDLER_MODULES`` lists them so ``rbctl worker``
# imports every one before it starts claiming.
HANDLERS: dict[str, Handler] = {}
RECOVERY_HOOKS: dict[str, RecoveryHook] = {}
HANDLER_MODULES: list[str] = []


def load_handlers() -> None:
    for name in HANDLER_MODULES:
        importlib.import_module(name)


def register(kind: str, handler: Handler, *, on_recover: RecoveryHook | None = None) -> None:
    HANDLERS[kind] = handler
    if on_recover is not None:
        RECOVERY_HOOKS[kind] = on_recover


def default_worker_id() -> str:
    return f"{socket.gethostname()[:40]}:{os.getpid()}"


def sessions_from(sm: async_sessionmaker[AsyncSession]) -> SessionFactory:
    @asynccontextmanager
    async def open_session() -> AsyncIterator[AsyncSession]:
        async with sm() as session:
            try:
                yield session
            except BaseException:
                await session.rollback()
                raise

    return open_session


class Worker:
    def __init__(
        self,
        session: SessionFactory,
        *,
        handlers: dict[str, Handler] | None = None,
        recovery_hooks: dict[str, RecoveryHook] | None = None,
        concurrency: int = 4,
        poll_s: float = 2.0,
        lease_s: int = 120,
        grace_s: float = 50.0,
        worker_id: str | None = None,
        now: Callable[[], datetime] = get_now,
        listen_engine: AsyncEngine | None = None,
    ) -> None:
        self.session = session
        self.handlers = HANDLERS if handlers is None else handlers
        self.recovery_hooks = RECOVERY_HOOKS if recovery_hooks is None else recovery_hooks
        self.concurrency = max(1, concurrency)
        self.poll_s = poll_s
        self.lease_s = lease_s
        self.grace_s = grace_s
        self.base_id = worker_id or default_worker_id()
        self.now = now
        self.listen_engine = listen_engine
        self.stopping = asyncio.Event()
        self._wake = asyncio.Event()
        self._slot_ids = count(1)
        self._running: dict[asyncio.Task[None], ClaimedJob] = {}
        self._heartbeat_every = max(1.0, lease_s / 3)

    @property
    def kinds(self) -> list[str]:
        return sorted(self.handlers)

    def request_stop(self) -> None:
        self.stopping.set()
        self._wake.set()

    # --- one job ------------------------------------------------------------------------

    async def _claim(self, slot_id: str) -> ClaimedJob | None:
        if not self.handlers:
            return None
        async with self.session() as s:
            job = await jobs_svc.claim(
                s, worker_id=slot_id, now=self.now(), lease_s=self.lease_s, kinds=self.kinds
            )
            await s.commit()
            return job

    async def _heartbeat(self, job: ClaimedJob, lost: asyncio.Event) -> None:
        while True:
            await asyncio.sleep(self._heartbeat_every)
            try:
                async with self.session() as s:
                    ok = await jobs_svc.heartbeat(
                        s,
                        job_id=job.id,
                        worker_id=job.locked_by,
                        now=self.now(),
                        lease_s=self.lease_s,
                    )
                    await s.commit()
            except Exception as exc:  # a DB blip: try again next beat
                log.warning("job_heartbeat_failed", job_id=str(job.id), error=type(exc).__name__)
                continue
            if not ok:
                lost.set()
                log.warning("job_lease_lost", job_id=str(job.id), kind=job.kind)
                return

    async def _record(self, job: ClaimedJob, outcome: str, error: str | None, **kw: Any) -> str:
        async with self.session() as s:
            now = self.now()
            if outcome == "retry":
                status = await jobs_svc.retry(
                    s,
                    job_id=job.id,
                    worker_id=job.locked_by,
                    now=now,
                    error=error or "error",
                    retry_after_s=kw.get("retry_after_s"),
                )
            elif outcome == "release":
                status = (
                    "queued"
                    if await jobs_svc.release(s, job_id=job.id, worker_id=job.locked_by, now=now)
                    else None
                )
            else:
                ok = await jobs_svc.finish(
                    s, job_id=job.id, worker_id=job.locked_by, status=outcome, now=now, error=error
                )
                status = outcome if ok else None
            await s.commit()
        return status or "lost"

    async def run_job(self, job: ClaimedJob) -> str:
        """Run one claimed job to an outcome; returns the job's new status (or ``lost``)."""
        handler = self.handlers.get(job.kind)
        started = time.monotonic()
        ctx = JobContext(job=job, session=self.session, now=self.now)
        beat = asyncio.create_task(self._heartbeat(job, ctx.lease_lost))
        status = "lost"
        try:
            if handler is None:
                status = await self._record(job, "failed", "unknown_kind")
            else:
                try:
                    await handler(ctx)
                except asyncio.CancelledError:
                    # Shutdown after the grace period: give the job back, attempt not counted.
                    status = await asyncio.shield(self._record(job, "release", None))
                    raise
                except LeaseLost:
                    status = "lost"
                except PermanentJobError as exc:
                    status = await self._record(job, "failed", jobs_svc.safe_error(exc.code))
                except TransientJobError as exc:
                    status = await self._record(
                        job, "retry", jobs_svc.safe_error(exc.code), retry_after_s=exc.retry_after_s
                    )
                except Exception as exc:
                    log.error(
                        "job_handler_error",
                        job_id=str(job.id),
                        kind=job.kind,
                        exc_type=type(exc).__name__,
                        traceback=safe_traceback(exc),
                    )
                    status = await self._record(job, "retry", f"unexpected: {type(exc).__name__}")
                else:
                    status = await self._record(job, "succeeded", None)
        finally:
            beat.cancel()
            with suppress(asyncio.CancelledError):
                await beat
            log.info(
                "job_done",
                job_id=str(job.id),
                kind=job.kind,
                workspace_id=str(job.workspace_id) if job.workspace_id else None,
                status=status,
                attempt=job.attempts,
                duration_ms=int((time.monotonic() - started) * 1000),
            )
        return status

    # --- maintenance --------------------------------------------------------------------

    async def recover(self) -> list[RecoveredJob]:
        """Requeue jobs whose lease expired and run their kinds' recovery hooks."""
        async with self.session() as s:
            now = self.now()
            recovered = await jobs_svc.recover_stuck(s, now=now, kinds=self.kinds or None)
            for rec in recovered:
                hook = self.recovery_hooks.get(rec.kind)
                if hook is not None:
                    await hook(s, rec, now)
                log.warning("job_recovered", job_id=str(rec.id), kind=rec.kind, failed=rec.failed)
            await s.commit()
        return recovered

    # --- modes --------------------------------------------------------------------------

    async def drain(self) -> int:
        """``rbctl worker --once``: run due jobs one after another until none is left."""
        await self.recover()
        done = 0
        slot_id = f"{self.base_id}:{next(self._slot_ids)}"
        while not self.stopping.is_set():
            job = await self._claim(slot_id)
            if job is None:
                break
            await self.run_job(job)
            done += 1
        return done

    async def _slot(self) -> None:
        slot_id = f"{self.base_id}:{next(self._slot_ids)}"
        while not self.stopping.is_set():
            try:
                job = await self._claim(slot_id)
            except Exception as exc:
                log.warning("job_claim_failed", error=type(exc).__name__)
                job = None
            if job is None:
                self._wake.clear()
                with suppress(TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), timeout=self.poll_s)
                continue
            task = asyncio.current_task()
            assert task is not None
            self._running[task] = job
            try:
                await self.run_job(job)
            finally:
                self._running.pop(task, None)

    async def _maintenance(self) -> None:
        while not self.stopping.is_set():
            try:
                await self.recover()
            except Exception as exc:
                log.warning("job_recover_failed", error=type(exc).__name__)
            with suppress(TimeoutError):
                await asyncio.wait_for(self.stopping.wait(), timeout=self.poll_s)

    async def _listen(self) -> None:
        """Wake idle slots on ``NOTIFY raisebook_jobs``; polling covers any failure here."""
        if self.listen_engine is None:
            return
        try:
            async with self.listen_engine.connect() as conn:
                raw = await conn.get_raw_connection()
                driver = raw.driver_connection
                if driver is None:
                    return

                def on_notify(*_: Any) -> None:
                    self._wake.set()

                await driver.add_listener(jobs_svc.NOTIFY_CHANNEL, on_notify)
                try:
                    await self.stopping.wait()
                finally:
                    with suppress(Exception):
                        await driver.remove_listener(jobs_svc.NOTIFY_CHANNEL, on_notify)
        except Exception as exc:
            log.warning("job_listen_failed", error=type(exc).__name__)

    async def run(self) -> None:
        """Run until :meth:`request_stop` (or a signal), then shut down gracefully."""
        log.info("worker_started", worker_id=self.base_id, kinds=self.kinds, slots=self.concurrency)
        slots = [asyncio.create_task(self._slot()) for _ in range(self.concurrency)]
        helpers = [asyncio.create_task(self._maintenance()), asyncio.create_task(self._listen())]
        await self.stopping.wait()
        log.info("worker_stopping", in_flight=len(self._running), grace_s=self.grace_s)
        # Idle slots exit at once; busy ones get the grace period to finish their job.
        _, pending = await asyncio.wait(slots, timeout=self.grace_s) if slots else (set(), set())
        for task in [*pending, *helpers]:
            task.cancel()  # a cancelled job releases its lease (see run_job)
        await asyncio.gather(*slots, *helpers, return_exceptions=True)
        log.info("worker_stopped", worker_id=self.base_id)


_SIGNALS = (signal.SIGTERM, signal.SIGINT)


def install_signal_handlers(worker: Worker) -> None:
    loop = asyncio.get_running_loop()
    for sig in _SIGNALS:
        with suppress(NotImplementedError):  # not on every platform
            loop.add_signal_handler(sig, worker.request_stop)


def remove_signal_handlers() -> None:
    loop = asyncio.get_running_loop()
    for sig in _SIGNALS:
        with suppress(NotImplementedError):
            loop.remove_signal_handler(sig)


async def main(*, once: bool = False, settings: Settings | None = None) -> int:
    """Entry point for ``rbctl worker``. Returns the number of jobs run in ``--once`` mode."""
    s = settings or get_settings()
    load_handlers()
    # Own pool: slots + heartbeats + maintenance, never the API's connections.
    engine = build_engine(s, pool_size=s.worker_concurrency + 2, max_overflow=s.worker_concurrency)
    listen_engine = None if once else build_engine(s, pool_size=1, max_overflow=0)
    try:
        worker = Worker(
            sessions_from(async_sessionmaker(engine, expire_on_commit=False)),
            concurrency=s.worker_concurrency,
            poll_s=s.worker_poll_s,
            lease_s=s.worker_lease_s,
            grace_s=s.worker_grace_s,
            listen_engine=listen_engine,
        )
        install_signal_handlers(worker)
        if once:
            return await worker.drain()
        await worker.run()
        return 0
    finally:
        remove_signal_handlers()
        await engine.dispose()
        if listen_engine is not None:
            await listen_engine.dispose()
