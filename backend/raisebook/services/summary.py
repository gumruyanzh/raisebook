"""The round summary: money, funnel, follow-ups, stale conversations (SPEC §5.3). Owner: AM.

Math (by stage kind):
- ``committed`` = sum of ``amount_committed`` in the ``won`` stage.
- ``soft_circled`` = sum of ``amount_soft`` over ``open`` and ``active`` participants.
- ``weighted_pipeline`` = sum of ``amount_soft * coalesce(probability, 0) / 100`` over
  ``active`` participants.
- ``pct_of_target`` = committed / target * 100, one decimal (0 when the target is 0).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.models.investor import Investor
from raisebook.models.round import Round, RoundParticipant
from raisebook.schemas.participants import (
    FollowUpBlock,
    FunnelStage,
    KindCounts,
    MeetingsBlock,
    MoneyOut,
    RoundSummaryOut,
    RoundWithClose,
    StaleItem,
)
from raisebook.services import activities, followups, meetings, rounds
from raisebook.services.investors import compact
from raisebook.services.stages import stage_out, stages_for

STALE_DAYS = 14
TOP = 10


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


async def round_summary(
    db: AsyncSession, ws: WorkspaceContext, rnd: Round, *, now: datetime
) -> RoundSummaryOut:
    today = ws.today(now)
    stages = await stages_for(db, ws, rnd.id)
    rows = list(
        (
            await db.execute(
                select(RoundParticipant, Investor)
                .join(
                    Investor,
                    and_(
                        Investor.id == RoundParticipant.investor_id,
                        Investor.workspace_id == RoundParticipant.workspace_id,
                    ),
                )
                .where(
                    RoundParticipant.workspace_id == ws.workspace_id,
                    RoundParticipant.round_id == rnd.id,
                )
            )
        ).tuples()
    )
    by_stage = {s.id: s for s in stages}
    funnel = {s.id: {"count": 0, "amount_soft": 0, "amount_committed": 0} for s in stages}
    kinds = {"total": 0, "open": 0, "active": 0, "won": 0, "lost": 0}
    committed = soft = committed_count = 0
    weighted = 0.0
    won_without_amount = 0
    stale: list[tuple[int, StaleItem]] = []
    for p, inv in rows:
        st = by_stage[p.stage_id]
        f = funnel[st.id]
        f["count"] += 1
        f["amount_soft"] += p.amount_soft or 0
        f["amount_committed"] += p.amount_committed or 0
        kinds["total"] += 1
        kinds[st.kind] += 1
        if st.kind == "won":
            if p.amount_committed:
                committed += p.amount_committed
                committed_count += 1
            else:
                won_without_amount += 1
        if st.kind in ("open", "active"):
            soft += p.amount_soft or 0
        if st.kind == "active":
            weighted += (p.amount_soft or 0) * (p.probability or 0) / 100
            last = p.last_activity_at or p.stage_changed_at
            days = (now - last).days
            if days >= STALE_DAYS:
                stale.append(
                    (
                        days,
                        StaleItem(
                            investor=compact(inv), stage=stage_out(st), days_since_activity=days
                        ),
                    )
                )
    stale.sort(key=lambda t: -t[0])
    target = rnd.target_amount or 0
    pct = round(committed / target * 100, 1) if target else 0.0

    due = await followups.list_due(
        db, ws, now=now, round_id=rnd.id, within_days=7, include_overdue=True, limit=TOP
    )
    recent_rows, _ = await activities.list_activities(db, ws, limit=TOP, round_id=rnd.id)
    recent = await activities.present(db, ws, recent_rows)
    base = await rounds.present_one(db, ws, rnd, counts=True)
    days_to_close = (rnd.target_close_on - today).days if rnd.target_close_on else None

    warnings: list[str] = []
    won_label = next((s.label for s in stages if s.kind == "won"), "Committed")
    if won_without_amount:
        verb = "is" if won_without_amount == 1 else "are"
        warnings.append(
            f"{_plural(won_without_amount, 'investor', 'investors')} {verb} in {won_label} "
            "without an amount."
        )
    is_open = rnd.status == "open"
    if is_open and due.counts.overdue:
        warnings.append(f"{_plural(due.counts.overdue, 'follow-up is', 'follow-ups are')} overdue.")
    if is_open and stale:
        warnings.append(
            f"{_plural(len(stale), 'conversation has', 'conversations have')} had no activity "
            f"for {STALE_DAYS}+ days."
        )
    if rnd.status == "open" and days_to_close is not None and days_to_close < 0:
        warnings.append(f"The target close date passed {-days_to_close} days ago.")
    # Oversubscription is good news, not a warning: money.pct_of_target already says it.

    return RoundSummaryOut(
        round=RoundWithClose(**base.model_dump(), days_to_close=days_to_close),
        money=MoneyOut(
            currency=rnd.currency,
            target=target,
            committed=committed,
            pct_of_target=pct,
            soft_circled=soft,
            weighted_pipeline=round(weighted),
            committed_count=committed_count,
        ),
        funnel=[
            FunnelStage(**stage_out(s).model_dump(exclude={"count"}), **funnel[s.id])
            for s in stages
        ],
        counts=KindCounts(**kinds),
        follow_ups=FollowUpBlock(
            overdue=due.counts.overdue,
            today=due.counts.today,
            next_7_days=due.counts.upcoming,
            top=due.data[:TOP],
        ),
        stale=[s for _, s in stale[:TOP]],
        recent_activity=recent,
        warnings=warnings,
        meetings=MeetingsBlock(**await meetings.round_block(db, ws, rnd.id, now=now)),
    )
