"""The Postgres job queue (RESEARCH-PLAN §3.1). The worker is ``raisebook/worker.py``.

- :func:`enqueue` inserts a job in the caller's transaction (next to the row it is about,
  e.g. a research run). A ``dedupe_key`` makes it idempotent: while a job with that key is
  queued or running, enqueueing again returns the existing job. ``NOTIFY raisebook_jobs``
  fires on commit and wakes idle workers.
- :func:`claim` takes the next due job with ``FOR UPDATE SKIP LOCKED`` and marks it running
  under a lease (``locked_by`` + ``locked_until``) in one statement, so two workers never
  claim one job. Callers commit right after (a short transaction of its own).
- :func:`heartbeat` extends the lease only while ``locked_by`` is still this worker: a worker
  that lost its lease (recovered as stuck) gets False and must stop without writing results.
  :func:`finish`, :func:`retry` and :func:`release` carry the same guard.
- :func:`retry` backs off exponentially (``min(2^attempts x 5 s, 15 min)`` x jitter 0.8 to
  1.2, at least ``Retry-After``) and fails the job once ``attempts`` reaches ``max_attempts``.
- :func:`recover_stuck` requeues running jobs whose lease ran out (a crashed worker). The
  attempt was already counted, so a job that keeps killing workers still ends ``failed``.
- :func:`release` (graceful shutdown) hands a job back without counting the attempt.

Every timestamp comparison takes ``now`` as a bound parameter (the injectable clock), never
SQL ``now()``. Handlers must be idempotent per step: a job can run twice after a lost lease.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

NOTIFY_CHANNEL = "raisebook_jobs"
BACKOFF_BASE_S = 5.0
BACKOFF_MAX_S = 15 * 60.0
MAX_ERROR_LEN = 500

# Job kinds (one handler each, registered by the worker).
KIND_RESEARCH_RUN = "research.run"
KIND_COMPANY_PREFILL = "company.prefill"
KIND_RESEARCH_REMOVAL = "research.removal"

PRIORITY_SINGLE = 50
PRIORITY_BULK = 100


class TransientJobError(Exception):
    """Retry later (network trouble, 429/5xx, serialization failure)."""

    def __init__(self, code: str, message: str = "", *, retry_after_s: float | None = None):
        super().__init__(message or code)
        self.code = code
        self.retry_after_s = retry_after_s


class PermanentJobError(Exception):
    """Do not retry (bad key, out of credits, cap reached, invalid input). The job fails."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


@dataclass(frozen=True)
class ClaimedJob:
    id: UUID
    kind: str
    workspace_id: UUID | None
    payload: dict[str, Any]
    attempts: int
    max_attempts: int
    locked_by: str
    locked_until: datetime


@dataclass(frozen=True)
class RecoveredJob:
    id: UUID
    kind: str
    workspace_id: UUID | None
    payload: dict[str, Any]
    failed: bool  # attempts exhausted: failed instead of requeued


def _payload(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        loaded = json.loads(raw)
        return loaded if isinstance(loaded, dict) else {}
    return {}


def safe_error(code: str, message: str | None = None) -> str:
    """``code: message`` cut to the column limit (never payloads or response bodies)."""
    out = code if not message or message == code else f"{code}: {message}"
    return out[:MAX_ERROR_LEN]


async def enqueue(
    db: AsyncSession,
    *,
    kind: str,
    now: datetime,
    payload: dict[str, Any] | None = None,
    workspace_id: UUID | None = None,
    dedupe_key: str | None = None,
    priority: int = PRIORITY_BULK,
    max_attempts: int = 5,
    run_after: datetime | None = None,
) -> tuple[UUID, bool]:
    """Insert a queued job; ``(job_id, created)``. Not committed: the caller commits."""
    params = {
        "ws": workspace_id,
        "kind": kind,
        "payload": json.dumps(payload or {}),
        "priority": priority,
        "max_attempts": max_attempts,
        "run_after": run_after or now,
        "dedupe": dedupe_key,
        "now": now,
    }
    row = (
        await db.execute(
            text(
                "INSERT INTO jobs (workspace_id, kind, payload, status, priority, max_attempts,"
                " run_after, dedupe_key, created_at, updated_at)"
                " VALUES (:ws, :kind, CAST(:payload AS jsonb), 'queued', :priority,"
                " :max_attempts, :run_after, :dedupe, :now, :now)"
                " ON CONFLICT (dedupe_key)"
                " WHERE status IN ('queued', 'running') AND dedupe_key IS NOT NULL"
                " DO NOTHING RETURNING id"
            ),
            params,
        )
    ).one_or_none()
    if row is not None:
        await db.execute(text("SELECT pg_notify(:ch, :kind)"), {"ch": NOTIFY_CHANNEL, "kind": kind})
        return row[0], True
    existing = (
        await db.execute(
            text(
                "SELECT id FROM jobs WHERE dedupe_key = :dedupe AND status IN ('queued', 'running')"
            ),
            {"dedupe": dedupe_key},
        )
    ).one_or_none()
    if existing is None:  # the other job finished between the insert and this select
        return await enqueue(
            db,
            kind=kind,
            now=now,
            payload=payload,
            workspace_id=workspace_id,
            dedupe_key=dedupe_key,
            priority=priority,
            max_attempts=max_attempts,
            run_after=run_after,
        )
    return existing[0], False


async def claim(
    db: AsyncSession,
    *,
    worker_id: str,
    now: datetime,
    lease_s: int,
    kinds: list[str] | None = None,
) -> ClaimedJob | None:
    """Claim the next due job (of ``kinds`` when given). The caller commits right away."""
    params: dict[str, Any] = {
        "w": worker_id,
        "now": now,
        "until": now + timedelta(seconds=lease_s),
        "kinds": kinds,
    }
    row = (
        await db.execute(
            text(
                "UPDATE jobs SET status = 'running', locked_by = :w, locked_until = :until,"
                " attempts = attempts + 1, updated_at = :now"
                " WHERE id = (SELECT id FROM jobs WHERE status = 'queued'"
                " AND run_after <= :now"
                " AND (CAST(:kinds AS text[]) IS NULL OR kind = ANY(CAST(:kinds AS text[])))"
                " ORDER BY priority, run_after, created_at"
                " FOR UPDATE SKIP LOCKED LIMIT 1)"
                " RETURNING id, kind, workspace_id, payload, attempts, max_attempts,"
                " locked_by, locked_until"
            ),
            params,
        )
    ).one_or_none()
    if row is None:
        return None
    return ClaimedJob(
        id=row[0],
        kind=row[1],
        workspace_id=row[2],
        payload=_payload(row[3]),
        attempts=int(row[4]),
        max_attempts=int(row[5]),
        locked_by=row[6],
        locked_until=row[7],
    )


async def heartbeat(
    db: AsyncSession, *, job_id: UUID, worker_id: str, now: datetime, lease_s: int
) -> bool:
    """Extend the lease. False when this worker no longer holds the job."""
    row = (
        await db.execute(
            text(
                "UPDATE jobs SET locked_until = :until, updated_at = :now"
                " WHERE id = :id AND locked_by = :w AND status = 'running' RETURNING id"
            ),
            {"until": now + timedelta(seconds=lease_s), "now": now, "id": job_id, "w": worker_id},
        )
    ).one_or_none()
    return row is not None


async def finish(
    db: AsyncSession,
    *,
    job_id: UUID,
    worker_id: str,
    status: str,
    now: datetime,
    error: str | None = None,
) -> bool:
    """End a running job (``succeeded``, ``failed`` or ``cancelled``)."""
    if status not in ("succeeded", "failed", "cancelled"):
        raise ValueError(f"finish() takes a terminal status, not {status!r}")
    row = (
        await db.execute(
            text(
                "UPDATE jobs SET status = :status, locked_by = NULL, locked_until = NULL,"
                " last_error = :err, finished_at = :now, updated_at = :now"
                " WHERE id = :id AND locked_by = :w AND status = 'running' RETURNING id"
            ),
            {
                "status": status,
                "err": error[:MAX_ERROR_LEN] if error else None,
                "now": now,
                "id": job_id,
                "w": worker_id,
            },
        )
    ).one_or_none()
    return row is not None


def backoff_s(
    attempts: int, *, retry_after_s: float | None = None, rand: float | None = None
) -> float:
    """Delay before the next attempt: ``min(2^attempts x 5 s, 15 min)`` x jitter(0.8..1.2)."""
    base = min(BACKOFF_BASE_S * (2 ** max(0, attempts)), BACKOFF_MAX_S)
    jitter = 0.8 + 0.4 * (random.random() if rand is None else rand)  # noqa: S311 (not crypto)
    delay: float = base * jitter
    if retry_after_s is not None:
        delay = max(delay, min(retry_after_s, BACKOFF_MAX_S))
    return delay


async def retry(
    db: AsyncSession,
    *,
    job_id: UUID,
    worker_id: str,
    now: datetime,
    error: str,
    retry_after_s: float | None = None,
    rand: float | None = None,
) -> str | None:
    """Requeue with backoff, or fail when attempts are used up. Returns the new status
    (``queued`` / ``failed``), or None when this worker no longer holds the job."""
    row = (
        await db.execute(
            text(
                "SELECT attempts, max_attempts FROM jobs"
                " WHERE id = :id AND locked_by = :w AND status = 'running' FOR UPDATE"
            ),
            {"id": job_id, "w": worker_id},
        )
    ).one_or_none()
    if row is None:
        return None
    attempts, max_attempts = int(row[0]), int(row[1])
    if attempts >= max_attempts:
        await finish(db, job_id=job_id, worker_id=worker_id, status="failed", now=now, error=error)
        return "failed"
    delay = backoff_s(attempts, retry_after_s=retry_after_s, rand=rand)
    await db.execute(
        text(
            "UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL,"
            " run_after = :after, last_error = :err, updated_at = :now WHERE id = :id"
        ),
        {
            "after": now + timedelta(seconds=delay),
            "err": error[:MAX_ERROR_LEN],
            "now": now,
            "id": job_id,
        },
    )
    return "queued"


async def release(db: AsyncSession, *, job_id: UUID, worker_id: str, now: datetime) -> bool:
    """Hand a job back on shutdown: queued again now, the attempt not counted."""
    row = (
        await db.execute(
            text(
                "UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL,"
                " attempts = greatest(0, attempts - 1), run_after = :now, updated_at = :now"
                " WHERE id = :id AND locked_by = :w AND status = 'running' RETURNING id"
            ),
            {"now": now, "id": job_id, "w": worker_id},
        )
    ).one_or_none()
    return row is not None


async def recover_stuck(
    db: AsyncSession, *, now: datetime, kinds: list[str] | None = None
) -> list[RecoveredJob]:
    """Requeue (or fail, when attempts are used up) running jobs whose lease expired."""
    params: dict[str, Any] = {"now": now, "kinds": kinds}
    rows = (
        await db.execute(
            text(
                "UPDATE jobs SET"
                " status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,"
                " finished_at = CASE WHEN attempts >= max_attempts THEN :now ELSE NULL END,"
                " last_error = 'lease_expired: the worker stopped answering',"
                " locked_by = NULL, locked_until = NULL, run_after = :now, updated_at = :now"
                " WHERE id IN (SELECT id FROM jobs WHERE status = 'running'"
                " AND locked_until < :now"
                " AND (CAST(:kinds AS text[]) IS NULL OR kind = ANY(CAST(:kinds AS text[])))"
                " FOR UPDATE SKIP LOCKED)"
                " RETURNING id, kind, workspace_id, payload, status"
            ),
            params,
        )
    ).all()
    return [
        RecoveredJob(
            id=r[0],
            kind=r[1],
            workspace_id=r[2],
            payload=_payload(r[3]),
            failed=r[4] == "failed",
        )
        for r in rows
    ]


async def cancel_queued(
    db: AsyncSession,
    *,
    workspace_id: UUID,
    now: datetime,
    kinds: list[str] | None = None,
    reason: str = "cancelled",
) -> int:
    """Cancel a workspace's queued jobs (running ones end on their own)."""
    params: dict[str, Any] = {
        "ws": workspace_id,
        "now": now,
        "err": reason[:MAX_ERROR_LEN],
        "kinds": kinds,
    }
    result = await db.execute(
        text(
            "UPDATE jobs SET status = 'cancelled', last_error = :err, finished_at = :now,"
            " updated_at = :now WHERE workspace_id = :ws AND status = 'queued'"
            " AND (CAST(:kinds AS text[]) IS NULL OR kind = ANY(CAST(:kinds AS text[])))"
        ),
        params,
    )
    return int(getattr(result, "rowcount", 0) or 0)


async def purge_finished(db: AsyncSession, *, older_than: datetime) -> int:
    """Housekeeping: drop finished jobs older than ``older_than``."""
    result = await db.execute(
        text(
            "DELETE FROM jobs WHERE status IN ('succeeded', 'failed', 'cancelled')"
            " AND finished_at < :t"
        ),
        {"t": older_than},
    )
    return int(getattr(result, "rowcount", 0) or 0)
