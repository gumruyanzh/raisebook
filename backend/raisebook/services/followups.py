"""Follow-ups: derived state and the due list (SPEC §3.5, §5.6, MCP list_due_follow_ups).

``follow_up_state`` is relative to today in the workspace timezone: ``overdue`` (before
today), ``today``, ``soon`` (1 to 7 days ahead), ``later``, or ``None``. Owner: AM.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Literal
from uuid import UUID

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.models.investor import Investor
from raisebook.models.round import Round, RoundParticipant, RoundStage
from raisebook.schemas.participants import FollowUpCounts, FollowUpItem, FollowUpList, RoundRef

State = Literal["overdue", "today", "soon", "later"]
SOON_DAYS = 7


def priority(fit: int) -> Literal["hot", "warm", "maybe", "low"]:
    """fit 5 → hot, 4 → warm, 3 → maybe, else low (prototype labels)."""
    if fit >= 5:
        return "hot"
    if fit == 4:
        return "warm"
    if fit == 3:
        return "maybe"
    return "low"


def follow_up_state(on: date | None, today: date) -> State | None:
    if on is None:
        return None
    if on < today:
        return "overdue"
    if on == today:
        return "today"
    if on <= today + timedelta(days=SOON_DAYS):
        return "soon"
    return "later"


async def list_due(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    now: datetime,
    round_id: UUID | None = None,
    within_days: int = 0,
    include_overdue: bool = True,
    limit: int = 50,
    include_closed: bool = False,
) -> FollowUpList:
    """Due follow-ups: overdue first, then today, then the next ``within_days`` days.

    Without ``round_id`` it covers every open round. Lost-stage participants are skipped
    (a passed investor needs no follow-up).
    """
    from raisebook.services.investors import compact
    from raisebook.services.stages import stage_out

    today = ws.today(now)
    horizon = today + timedelta(days=max(0, within_days))
    lower = None if include_overdue else today
    conds = [
        RoundParticipant.workspace_id == ws.workspace_id,
        RoundParticipant.follow_up_on.is_not(None),
        RoundParticipant.follow_up_on <= horizon,
        RoundStage.kind != "lost",
    ]
    if lower is not None:
        conds.append(RoundParticipant.follow_up_on >= lower)
    if round_id is not None:
        conds.append(RoundParticipant.round_id == round_id)
    elif not include_closed:
        conds.append(Round.status == "open")
    base = (
        select(RoundParticipant, Investor, Round, RoundStage)
        .join(
            Investor,
            and_(
                Investor.id == RoundParticipant.investor_id,
                Investor.workspace_id == RoundParticipant.workspace_id,
            ),
        )
        .join(
            Round,
            and_(
                Round.id == RoundParticipant.round_id,
                Round.workspace_id == RoundParticipant.workspace_id,
            ),
        )
        .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
        .where(*conds)
    )
    counts_stmt = (
        select(
            func.count().filter(RoundParticipant.follow_up_on < today),
            func.count().filter(RoundParticipant.follow_up_on == today),
            func.count().filter(RoundParticipant.follow_up_on > today),
        )
        .select_from(RoundParticipant)
        .join(
            Round,
            and_(
                Round.id == RoundParticipant.round_id,
                Round.workspace_id == RoundParticipant.workspace_id,
            ),
        )
        .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
        .where(*conds)
    )
    overdue, today_n, upcoming = (await db.execute(counts_stmt)).one()
    rows = await db.execute(
        base.order_by(
            RoundParticipant.follow_up_on, RoundParticipant.fit.desc(), Investor.name
        ).limit(limit)
    )
    items: list[FollowUpItem] = []
    for p, inv, rnd, st in rows.tuples():
        assert p.follow_up_on is not None
        state = follow_up_state(p.follow_up_on, today) or "later"
        items.append(
            FollowUpItem(
                investor=compact(inv),
                round=RoundRef(id=rnd.id, slug=str(rnd.slug), name=rnd.name),
                stage=stage_out(st),
                follow_up_on=p.follow_up_on,
                follow_up_state=state,
                days_overdue=max(0, (today - p.follow_up_on).days),
                follow_up_note=p.follow_up_note,
                next_step=p.next_step,
                last_activity_at=p.last_activity_at,
            )
        )
    return FollowUpList(
        today=today,
        data=items,
        counts=FollowUpCounts(overdue=int(overdue), today=int(today_n), upcoming=int(upcoming)),
    )


async def upcoming_outlook(
    db: AsyncSession, ws: WorkspaceContext, *, now: datetime, round_id: UUID | None = None
) -> tuple[int, date | None]:
    """``(follow-ups in the next 7 days after today, the next future follow-up date)`` over
    the same participants as :func:`list_due` (open rounds, lost stages skipped)."""
    today = ws.today(now)
    conds = [
        RoundParticipant.workspace_id == ws.workspace_id,
        RoundParticipant.follow_up_on > today,
        RoundStage.kind != "lost",
    ]
    if round_id is not None:
        conds.append(RoundParticipant.round_id == round_id)
    else:
        conds.append(Round.status == "open")
    stmt = (
        select(
            func.count().filter(RoundParticipant.follow_up_on <= today + timedelta(days=7)),
            func.min(RoundParticipant.follow_up_on),
        )
        .select_from(RoundParticipant)
        .join(
            Round,
            and_(
                Round.id == RoundParticipant.round_id,
                Round.workspace_id == RoundParticipant.workspace_id,
            ),
        )
        .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
        .where(*conds)
    )
    n, first = (await db.execute(stmt)).one()
    return int(n or 0), first
