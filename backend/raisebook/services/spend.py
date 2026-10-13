"""The AI spend ledger and its race-safe monthly cap (RESEARCH-PLAN §5.3, R4).

``ai_usage_months`` has one row per workspace and month (the first day of the month in the
**workspace timezone**): ``spent_micros`` (settled real cost), ``reserved_micros`` (money held
for calls in flight) and ``calls``.

Before each OpenRouter call the caller reserves that call's upper-bound estimate with one
conditional UPDATE (:func:`reserve`). Postgres row locks serialize concurrent reservations on
the row, and the ``WHERE spent + reserved + amount <= cap`` re-check runs on the newest row
version, so parallel workers can never overspend. After the call, :func:`settle` moves the
reservation to spent (the real cost from OpenRouter's usage). :func:`release` returns a
reservation that will never be settled (a run that died, was cancelled or shut down).

The ``*_for_run`` helpers keep a run's own ``reserved_micros`` / ``reserved_month`` /
``cost_micros`` in step with the ledger inside the same transaction, so stuck-job recovery
and shutdown can release exactly what a run still holds, and a re-run job never reserves
twice.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


def month_of(now: datetime, timezone: str) -> date:
    """The ledger month for ``now``: the first day of the month in the workspace timezone."""
    local = now.astimezone(ZoneInfo(timezone)).date()
    return local.replace(day=1)


@dataclass(frozen=True)
class Usage:
    month: date
    spent_micros: int
    reserved_micros: int
    calls: int

    def remaining(self, cap_micros: int) -> int:
        return max(0, cap_micros - self.spent_micros - self.reserved_micros)


async def usage(db: AsyncSession, workspace_id: UUID, month: date) -> Usage:
    row = (
        await db.execute(
            text(
                "SELECT spent_micros, reserved_micros, calls FROM ai_usage_months"
                " WHERE workspace_id = :ws AND month = :m"
            ),
            {"ws": workspace_id, "m": month},
        )
    ).one_or_none()
    if row is None:
        return Usage(month, 0, 0, 0)
    return Usage(month, int(row[0]), int(row[1]), int(row[2]))


async def reserve(
    db: AsyncSession,
    *,
    workspace_id: UUID,
    month: date,
    amount_micros: int,
    cap_micros: int,
    now: datetime,
) -> bool:
    """Hold ``amount_micros`` if it fits under the cap. False (nothing held) when it does not."""
    if amount_micros < 0:
        raise ValueError("amount_micros must be >= 0")
    await db.execute(
        text(
            "INSERT INTO ai_usage_months (workspace_id, month, updated_at)"
            " VALUES (:ws, :m, :now) ON CONFLICT DO NOTHING"
        ),
        {"ws": workspace_id, "m": month, "now": now},
    )
    row = (
        await db.execute(
            text(
                "UPDATE ai_usage_months"
                " SET reserved_micros = reserved_micros + :r, updated_at = :now"
                " WHERE workspace_id = :ws AND month = :m"
                " AND spent_micros + reserved_micros + :r <= :cap"
                " RETURNING spent_micros"
            ),
            {"ws": workspace_id, "m": month, "r": amount_micros, "cap": cap_micros, "now": now},
        )
    ).one_or_none()
    return row is not None


async def settle(
    db: AsyncSession,
    *,
    workspace_id: UUID,
    month: date,
    reserved_micros: int,
    actual_micros: int,
    now: datetime,
    calls: int = 1,
) -> None:
    """Turn a reservation into real spend (``actual`` may exceed the reservation)."""
    await db.execute(
        text(
            "INSERT INTO ai_usage_months (workspace_id, month, updated_at)"
            " VALUES (:ws, :m, :now) ON CONFLICT DO NOTHING"
        ),
        {"ws": workspace_id, "m": month, "now": now},
    )
    await db.execute(
        text(
            "UPDATE ai_usage_months"
            " SET spent_micros = spent_micros + :a,"
            " reserved_micros = greatest(0, reserved_micros - :r),"
            " calls = calls + :c, updated_at = :now"
            " WHERE workspace_id = :ws AND month = :m"
        ),
        {
            "ws": workspace_id,
            "m": month,
            "a": max(0, actual_micros),
            "r": max(0, reserved_micros),
            "c": calls,
            "now": now,
        },
    )


async def release(
    db: AsyncSession, *, workspace_id: UUID, month: date, amount_micros: int, now: datetime
) -> None:
    """Give back a reservation that will never be settled."""
    if amount_micros <= 0:
        return
    await db.execute(
        text(
            "UPDATE ai_usage_months"
            " SET reserved_micros = greatest(0, reserved_micros - :r), updated_at = :now"
            " WHERE workspace_id = :ws AND month = :m"
        ),
        {"ws": workspace_id, "m": month, "r": amount_micros, "now": now},
    )


# --- run-level bookkeeping (same transaction as the ledger) ------------------------------


async def reserve_for_run(
    db: AsyncSession,
    *,
    run_id: UUID,
    workspace_id: UUID,
    month: date,
    amount_micros: int,
    cap_micros: int,
    now: datetime,
) -> bool:
    """Reserve for one call of ``run_id`` and record it on the run. False when capped.

    A run holds at most one open reservation: any earlier one is released first (a call
    that was reserved but never settled, e.g. after a lost lease).
    """
    await release_for_run(db, run_id=run_id, now=now)
    if not await reserve(
        db,
        workspace_id=workspace_id,
        month=month,
        amount_micros=amount_micros,
        cap_micros=cap_micros,
        now=now,
    ):
        return False
    await db.execute(
        text(
            "UPDATE research_runs SET reserved_micros = :r, reserved_month = :m, updated_at = :now"
            " WHERE id = :run AND workspace_id = :ws"
        ),
        {"r": amount_micros, "m": month, "now": now, "run": run_id, "ws": workspace_id},
    )
    return True


async def settle_for_run(
    db: AsyncSession, *, run_id: UUID, actual_micros: int, now: datetime
) -> None:
    """Settle the run's open reservation with the call's real cost."""
    row = (
        await db.execute(
            text(
                "SELECT workspace_id, reserved_micros, reserved_month FROM research_runs"
                " WHERE id = :run FOR UPDATE"
            ),
            {"run": run_id},
        )
    ).one_or_none()
    if row is None:
        return
    workspace_id, reserved, month = row[0], int(row[1]), row[2]
    if month is None:  # every call reserves first, so this is a programming error
        raise ValueError("settle_for_run needs an open reservation (reserve_for_run first)")
    await settle(
        db,
        workspace_id=workspace_id,
        month=month,
        reserved_micros=reserved,
        actual_micros=actual_micros,
        now=now,
    )
    await db.execute(
        text(
            "UPDATE research_runs SET cost_micros = cost_micros + :a, reserved_micros = 0,"
            " reserved_month = NULL, updated_at = :now WHERE id = :run"
        ),
        {"a": max(0, actual_micros), "now": now, "run": run_id},
    )


async def release_for_run(db: AsyncSession, *, run_id: UUID, now: datetime) -> int:
    """Release whatever the run still holds (recovery, cancel, shutdown). Returns the amount."""
    row = (
        await db.execute(
            text(
                "SELECT workspace_id, reserved_micros, reserved_month FROM research_runs"
                " WHERE id = :run FOR UPDATE"
            ),
            {"run": run_id},
        )
    ).one_or_none()
    if row is None or int(row[1]) <= 0 or row[2] is None:
        return 0
    amount = int(row[1])
    await release(db, workspace_id=row[0], month=row[2], amount_micros=amount, now=now)
    await db.execute(
        text(
            "UPDATE research_runs SET reserved_micros = 0, reserved_month = NULL,"
            " updated_at = :now WHERE id = :run"
        ),
        {"now": now, "run": run_id},
    )
    return amount
