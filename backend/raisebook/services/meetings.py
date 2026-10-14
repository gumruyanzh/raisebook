"""Meetings with investors: schedule, reschedule, cancel, no-show, done (docs/SPEC.md §3.9).

Rules:

- A meeting has one investor and may include up to 10 more people from the **same firm**
  (``guests``). It may be tied to a round; when the caller gives none, the investor's only
  open-round participation is used (else no round).
- Scheduling writes ``meeting_scheduled``; every later change writes one ``meeting_updated``
  (``data.change``: rescheduled, edited, cancelled, no_show, reopened, deleted) with the old and
  new start, so the timeline is the audit trail. Marking it done logs a ``meeting`` activity
  (the outcome) linked by ``data.meeting_id`` and ``meetings.outcome_activity_id``. A no-op
  writes nothing.
- Scheduling in a round moves the investor to the round's Meeting stage (key ``meeting``, or
  a stage labelled "Meeting") when they are earlier in the pipeline and still open or talking
  (``move_to_meeting_stage``, default on); an investor not yet in that round is added there.
- The same investor at the same start is the same meeting: scheduling it again returns it
  (``created: false``), so agents can retry.
- Times are stored as instants; a time without an offset is read in the workspace timezone,
  and the workspace timezone is kept on the row for calendars.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.errors import LimitReached, MeetingDone, ValidationFailed, not_found
from raisebook.models.activity import Activity
from raisebook.models.enums import ActorType, MeetingStatus
from raisebook.models.investor import Investor
from raisebook.models.meeting import Meeting, MeetingGuest
from raisebook.models.round import Round, RoundParticipant, RoundStage
from raisebook.schemas.activities import ActorOut
from raisebook.schemas.common import decode_cursor, encode_cursor
from raisebook.schemas.meetings import MeetingChange, MeetingOut, MeetingRound
from raisebook.schemas.participants import MeetingBrief
from raisebook.services import activities
from raisebook.services.investors import compact
from raisebook.services.normalize import clean_text, norm, norm_firm
from raisebook.services.stages import stages_for
from raisebook.services.users import FORMER_MEMBER, display_names

DEFAULT_MINUTES = 30
MAX_MINUTES = 24 * 60
MAX_GUESTS = 10
PAST_LIMIT = timedelta(days=366)
FUTURE_LIMIT = timedelta(days=731)
# Marking done before the start is refused; a few minutes early is fine.
DONE_GRACE = timedelta(minutes=30)
MEETING_STAGE_KEY = "meeting"
MAX_MEETINGS = 50_000
OPEN_STATUSES = (MeetingStatus.SCHEDULED.value,)


# --- parsing -----------------------------------------------------------------------------


def parse_when(value: str | datetime | None, ws: WorkspaceContext, field_: str) -> datetime | None:
    """RFC 3339, or a local ``YYYY-MM-DDTHH:MM`` in the workspace timezone. A bare date is
    refused (a meeting needs a time)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = value.strip()
        if not text:
            return None
        if len(text) == 10:
            raise ValidationFailed(
                field_,
                f"{field_} needs a time, for example {text}T11:00 (workspace time) or "
                f"{text}T11:00:00Z.",
            )
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00").replace(" ", "T"))
        except ValueError:
            raise ValidationFailed(
                field_,
                f"{field_} must be an RFC 3339 timestamp such as 2026-10-20T11:00:00-07:00, "
                "or a local time such as 2026-10-20T11:00 (workspace timezone).",
            ) from None
    if dt.tzinfo is None:
        tz = ZoneInfo(ws.timezone)
        local = dt.replace(tzinfo=tz)
        # A wall time skipped by a DST change (02:30 on a spring-forward night) does not
        # exist: refuse it instead of silently shifting it by an hour.
        if local.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != dt:
            raise ValidationFailed(
                field_,
                f"{dt.strftime('%Y-%m-%d %H:%M')} does not exist in {ws.timezone} (the clocks "
                "change that night). Pick another time.",
            )
        dt = local
    # Store and compute in UTC: arithmetic on a zoned datetime is wall-clock arithmetic, so a
    # 30-minute meeting across a DST change would otherwise last 30 minutes ± 1 hour.
    return dt.astimezone(UTC)


def clean_url(value: str | None) -> str | None:
    text = clean_text(value, "video_url", max_len=1000)
    if text is None:
        return None
    if " " in text:
        raise ValidationFailed("video_url", "video_url must be one link without spaces.")
    if not text.lower().startswith(("http://", "https://")):
        if "." not in text:
            raise ValidationFailed("video_url", "video_url must be a link (https://…).")
        text = "https://" + text
    return text


def default_title(inv: Investor) -> str:
    title = f"Meeting with {inv.name}"
    if inv.firm:
        title += f" ({inv.firm})"
    return title[:200]


def when_text(dt: datetime, tz: str) -> str:
    """``Wed, Oct 14 at 11:00`` in ``tz``."""
    local = dt.astimezone(ZoneInfo(tz))
    return f"{local.strftime('%a, %b')} {local.day} at {local.strftime('%H:%M')}"


def meeting_stage(stages: Sequence[RoundStage]) -> RoundStage | None:
    for st in stages:
        if st.key == MEETING_STAGE_KEY:
            return st
    for st in stages:
        if norm(st.label) in ("meeting", "meetings", "meeting scheduled", "meeting booked"):
            return st
    return None


def needs_outcome(m: Meeting, now: datetime) -> bool:
    return m.status == MeetingStatus.SCHEDULED.value and m.ends_at <= now


# --- reads -------------------------------------------------------------------------------


async def get(db: AsyncSession, ws: WorkspaceContext, meeting_id: UUID) -> Meeting:
    row = await db.scalar(
        select(Meeting).where(Meeting.workspace_id == ws.workspace_id, Meeting.id == meeting_id)
    )
    if row is None:
        raise not_found("Meeting")
    return row


async def guest_ids(
    db: AsyncSession, ws: WorkspaceContext, meeting_ids: Iterable[UUID]
) -> dict[UUID, list[UUID]]:
    ids = list(set(meeting_ids))
    out: dict[UUID, list[UUID]] = {i: [] for i in ids}
    if not ids:
        return out
    rows = await db.execute(
        select(MeetingGuest.meeting_id, MeetingGuest.investor_id).where(
            MeetingGuest.workspace_id == ws.workspace_id, MeetingGuest.meeting_id.in_(ids)
        )
    )
    for mid, iid in rows.tuples():
        out.setdefault(mid, []).append(iid)
    return out


def _with_investor(stmt: Any, ws: WorkspaceContext, investor_id: UUID) -> Any:
    as_guest = select(MeetingGuest.meeting_id).where(
        MeetingGuest.workspace_id == ws.workspace_id, MeetingGuest.investor_id == investor_id
    )
    return stmt.where(or_(Meeting.investor_id == investor_id, Meeting.id.in_(as_guest)))


async def list_meetings(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    now: datetime,
    investor_id: UUID | None = None,
    round_id: UUID | None = None,
    statuses: Sequence[str] | None = None,
    start_from: datetime | None = None,
    start_to: datetime | None = None,
    upcoming: bool | None = None,
    needs_outcome_only: bool = False,
    order: str = "asc",
    limit: int = 50,
    cursor: str | None = None,
) -> tuple[list[Meeting], str | None]:
    """Meetings by start time. ``upcoming``: scheduled and not ended yet; ``needs_outcome``:
    scheduled and ended. ``investor_id`` matches the investor or a guest."""
    stmt = select(Meeting).where(Meeting.workspace_id == ws.workspace_id)
    if investor_id is not None:
        stmt = _with_investor(stmt, ws, investor_id)
    if round_id is not None:
        stmt = stmt.where(Meeting.round_id == round_id)
    if statuses:
        stmt = stmt.where(Meeting.status.in_(list(statuses)))
    if start_from is not None:
        stmt = stmt.where(Meeting.starts_at >= start_from)
    if start_to is not None:
        stmt = stmt.where(Meeting.starts_at < start_to)
    if upcoming:
        stmt = stmt.where(Meeting.status == MeetingStatus.SCHEDULED.value, Meeting.ends_at > now)
    if needs_outcome_only:
        stmt = stmt.where(Meeting.status == MeetingStatus.SCHEDULED.value, Meeting.ends_at <= now)
    if order == "desc":
        stmt = stmt.order_by(Meeting.starts_at.desc(), Meeting.id.desc())
    else:
        stmt = stmt.order_by(Meeting.starts_at, Meeting.id)
    offset = int((decode_cursor(cursor) or {}).get("o", 0))
    rows = list(await db.scalars(stmt.offset(offset).limit(limit + 1)))
    more = len(rows) > limit
    return rows[:limit], encode_cursor({"o": offset + limit}) if more else None


def brief(m: Meeting, inv: Investor | None = None) -> MeetingBrief:
    return MeetingBrief(
        id=m.id,
        title=m.title,
        starts_at=m.starts_at,
        ends_at=m.ends_at,
        location=m.location,
        video_url=m.video_url,
        investor_id=inv.id if inv is not None else None,
        investor_name=inv.name if inv is not None else None,
    )


async def next_by_investor(
    db: AsyncSession,
    ws: WorkspaceContext,
    pairs: Iterable[tuple[UUID, UUID]],
    *,
    now: datetime,
) -> dict[tuple[UUID, UUID], MeetingBrief]:
    """The soonest scheduled, not-ended meeting for each ``(round_id, investor_id)``: a
    meeting in that round, or in no round, with the investor as host or guest."""
    wanted = set(pairs)
    if not wanted:
        return {}
    inv_ids = {i for _, i in wanted}
    guest_rows = select(MeetingGuest.meeting_id, MeetingGuest.investor_id).where(
        MeetingGuest.workspace_id == ws.workspace_id, MeetingGuest.investor_id.in_(inv_ids)
    )
    guests: dict[UUID, list[UUID]] = {}
    for mid, iid in (await db.execute(guest_rows)).tuples():
        guests.setdefault(mid, []).append(iid)
    stmt = (
        select(Meeting)
        .where(
            Meeting.workspace_id == ws.workspace_id,
            Meeting.status == MeetingStatus.SCHEDULED.value,
            Meeting.ends_at > now,
            or_(Meeting.investor_id.in_(inv_ids), Meeting.id.in_(list(guests) or [None])),
        )
        .order_by(Meeting.starts_at, Meeting.id)
    )
    out: dict[tuple[UUID, UUID], MeetingBrief] = {}
    for m in await db.scalars(stmt):
        people = [m.investor_id, *guests.get(m.id, [])]
        for iid in people:
            for rid, wanted_inv in wanted:
                if wanted_inv != iid or (rid, iid) in out:
                    continue
                if m.round_id is None or m.round_id == rid:
                    out[(rid, iid)] = brief(m)
    return out


async def round_block(
    db: AsyncSession, ws: WorkspaceContext, round_id: UUID, *, now: datetime
) -> dict[str, Any]:
    """Counts for a round summary: today, upcoming, needing an outcome, and the next five."""
    tz = ZoneInfo(ws.timezone)
    local = now.astimezone(tz)
    day_start = datetime.combine(local.date(), datetime.min.time(), tzinfo=tz)
    day_end = day_start + timedelta(days=1)
    base = [
        Meeting.workspace_id == ws.workspace_id,
        Meeting.round_id == round_id,
        Meeting.status == MeetingStatus.SCHEDULED.value,
    ]
    today_n, upcoming_n, needs_n = (
        await db.execute(
            select(
                func.count().filter(
                    and_(Meeting.starts_at >= day_start, Meeting.starts_at < day_end)
                ),
                func.count().filter(Meeting.ends_at > now),
                func.count().filter(Meeting.ends_at <= now),
            ).where(*base)
        )
    ).one()
    rows = list(
        (
            await db.execute(
                select(Meeting, Investor)
                .join(
                    Investor,
                    and_(
                        Investor.id == Meeting.investor_id,
                        Investor.workspace_id == Meeting.workspace_id,
                    ),
                )
                .where(*base, Meeting.ends_at > now)
                .order_by(Meeting.starts_at, Meeting.id)
                .limit(5)
            )
        ).tuples()
    )
    return {
        "today": int(today_n or 0),
        "upcoming": int(upcoming_n or 0),
        "needs_outcome": int(needs_n or 0),
        "next": [brief(m, inv) for m, inv in rows],
    }


async def history(
    db: AsyncSession, ws: WorkspaceContext, meeting_ids: Sequence[UUID]
) -> dict[UUID, list[MeetingChange]]:
    """Each meeting's changes, oldest first, from its timeline activities."""
    out: dict[UUID, list[MeetingChange]] = {m: [] for m in meeting_ids}
    if not meeting_ids:
        return out
    keys = [str(m) for m in meeting_ids]
    rows = list(
        await db.scalars(
            select(Activity)
            .where(
                Activity.workspace_id == ws.workspace_id,
                Activity.data.has_key("meeting_id"),
                Activity.data["meeting_id"].astext.in_(keys),
            )
            .order_by(Activity.created_at, Activity.id)
        )
    )
    rows.sort(key=lambda r: (r.created_at, _seq(r.data)))
    names = await display_names(db, [r.actor_user_id for r in rows])
    for r in rows:
        data = r.data or {}
        if r.kind == "meeting_scheduled":
            change = "scheduled"
        elif r.kind == "meeting":
            change = "done"
        else:
            change = str(data.get("change") or "edited")
        mid = UUID(str(data["meeting_id"]))
        out.setdefault(mid, []).append(
            MeetingChange(
                at=r.created_at,
                change=change,
                from_starts_at=_dt(data.get("from_starts_at")),
                to_starts_at=_dt(data.get("to_starts_at") or data.get("starts_at")),
                by=_actor_out(r, names),
            )
        )
    return out


def _seq(data: Any) -> int:
    value = data.get("seq") if isinstance(data, dict) else None
    return value if isinstance(value, int) else 0


def _dt(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _actor_out(r: Any, names: Mapping[UUID, str]) -> ActorOut:
    if r.actor_type == ActorType.USER.value:
        label = names.get(r.actor_user_id, FORMER_MEMBER) if r.actor_user_id else FORMER_MEMBER
    else:
        label = r.actor_label or "raisebook"
    return ActorOut(
        type=r.actor_type,
        label=label,
        user_id=r.actor_user_id,
        api_key_id=r.api_key_id,
        agent_model=r.agent_model,
        via=r.via,
    )


async def present(
    db: AsyncSession,
    ws: WorkspaceContext,
    rows: Sequence[Meeting],
    *,
    now: datetime,
    with_history: bool = False,
) -> list[MeetingOut]:
    if not rows:
        return []
    guests = await guest_ids(db, ws, [m.id for m in rows])
    inv_ids = {m.investor_id for m in rows} | {g for gs in guests.values() for g in gs}
    invs = {
        i.id: i
        for i in await db.scalars(
            select(Investor).where(
                Investor.workspace_id == ws.workspace_id, Investor.id.in_(inv_ids)
            )
        )
    }
    round_ids = {m.round_id for m in rows if m.round_id is not None}
    rounds: dict[UUID, Round] = {}
    if round_ids:
        rounds = {
            r.id: r
            for r in await db.scalars(
                select(Round).where(Round.workspace_id == ws.workspace_id, Round.id.in_(round_ids))
            )
        }
    names = await display_names(db, [m.actor_user_id for m in rows])
    hist = await history(db, ws, [m.id for m in rows]) if with_history else {}
    out: list[MeetingOut] = []
    for m in rows:
        rnd = rounds.get(m.round_id) if m.round_id else None
        out.append(
            MeetingOut(
                id=m.id,
                investor=compact(invs[m.investor_id]),
                guests=[compact(invs[g]) for g in guests.get(m.id, []) if g in invs],
                round=MeetingRound(id=rnd.id, slug=str(rnd.slug), name=rnd.name) if rnd else None,
                title=m.title,
                starts_at=m.starts_at,
                ends_at=m.ends_at,
                duration_minutes=int((m.ends_at - m.starts_at).total_seconds() // 60),
                timezone=m.timezone,
                location=m.location,
                video_url=m.video_url,
                agenda=m.agenda,
                status=m.status,
                needs_outcome=needs_outcome(m, now),
                outcome=m.outcome,
                outcome_activity_id=m.outcome_activity_id,
                source=m.source,
                created_by=_actor_out(m, names),
                created_at=m.created_at,
                updated_at=m.updated_at,
                completed_at=m.completed_at,
                cancelled_at=m.cancelled_at,
                history=hist.get(m.id, []),
            )
        )
    return out


async def present_one(
    db: AsyncSession, ws: WorkspaceContext, m: Meeting, *, now: datetime
) -> MeetingOut:
    await db.refresh(m)
    return (await present(db, ws, [m], now=now, with_history=True))[0]


# --- writes ------------------------------------------------------------------------------


@dataclass
class StageMoved:
    from_stage: RoundStage | None  # None: added to the round at the Meeting stage
    to_stage: RoundStage


@dataclass
class WriteResult:
    meeting: Meeting
    created: bool = False
    changed: bool = True
    moved: StageMoved | None = None
    participant: RoundParticipant | None = None
    activity: Activity | None = None
    warnings: list[str] = field(default_factory=list)


async def default_round(db: AsyncSession, ws: WorkspaceContext, inv: Investor) -> Round | None:
    """The investor's only open-round participation, else None."""
    rows = list(
        await db.scalars(
            select(Round)
            .join(
                RoundParticipant,
                and_(
                    RoundParticipant.round_id == Round.id,
                    RoundParticipant.workspace_id == Round.workspace_id,
                ),
            )
            .where(
                Round.workspace_id == ws.workspace_id,
                Round.status == "open",
                RoundParticipant.investor_id == inv.id,
            )
        )
    )
    return rows[0] if len(rows) == 1 else None


async def resolve_guests(
    db: AsyncSession, ws: WorkspaceContext, primary: Investor, ids: Sequence[UUID]
) -> list[Investor]:
    """Guests by id (404 for another workspace's id), deduplicated, without the primary,
    and only from the primary's firm."""
    wanted = [i for i in dict.fromkeys(ids) if i != primary.id]
    if not wanted:
        return []
    if len(wanted) > MAX_GUESTS:
        raise ValidationFailed("guest_ids", f"A meeting can have at most {MAX_GUESTS} guests.")
    rows = {
        i.id: i
        for i in await db.scalars(
            select(Investor).where(
                Investor.workspace_id == ws.workspace_id, Investor.id.in_(wanted)
            )
        )
    }
    if len(rows) != len(wanted):
        raise not_found("Investor")
    firm = norm_firm(primary.firm)
    for inv in rows.values():
        if not firm or norm_firm(inv.firm) != firm:
            where = f" ({primary.firm})" if primary.firm else ""
            raise ValidationFailed(
                "guest_ids",
                f"{inv.name} is not at {primary.name}'s firm{where}. A meeting's guests are "
                "people from the same firm; schedule a separate meeting for others.",
            )
    return [rows[i] for i in wanted]


def _check_window(starts_at: datetime, ends_at: datetime, now: datetime) -> None:
    if ends_at <= starts_at:
        raise ValidationFailed("ends_at", "ends_at must be after starts_at.")
    if ends_at - starts_at > timedelta(minutes=MAX_MINUTES):
        raise ValidationFailed("ends_at", "A meeting can last at most 24 hours.")
    if starts_at < now - PAST_LIMIT or starts_at > now + FUTURE_LIMIT:
        raise ValidationFailed(
            "starts_at", "starts_at must be within 1 year in the past and 2 years in the future."
        )


def _end(starts_at: datetime, ends_at: datetime | None, minutes: int | None) -> datetime:
    if ends_at is not None:
        return ends_at
    return starts_at + timedelta(minutes=minutes or DEFAULT_MINUTES)


async def _advance_stage(
    db: AsyncSession,
    ws: WorkspaceContext,
    rnd: Round,
    inv: Investor,
    starts_at: datetime,
    *,
    now: datetime,
) -> tuple[StageMoved | None, RoundParticipant | None, str | None]:
    from raisebook.services import participants as parts_svc

    part = await parts_svc.get_participant(db, ws, rnd.id, inv.id)
    if rnd.status != "open":
        # A closed round's pipeline is history: never add anyone to it or move them.
        return None, part, f"{rnd.name} is not open, so the stage was not changed."
    stages = await stages_for(db, ws, rnd.id)
    target = meeting_stage(stages)
    if target is None:
        return None, part, f"{rnd.name} has no Meeting stage, so the stage was not changed."
    note = f"Meeting scheduled for {when_text(starts_at, ws.timezone)}."
    if part is None:
        res = await parts_svc.upsert(db, ws, rnd, inv, {"stage": target}, now=now, note=note)
        return StageMoved(None, target), res.participant, None
    current = next(s for s in stages if s.id == part.stage_id)
    if current.kind in ("open", "active") and current.position < target.position:
        await parts_svc.move_stage(db, ws, rnd, inv, target, note=note, now=now)
        return StageMoved(current, target), part, None
    return None, part, None


async def schedule(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    investor: Investor,
    starts_at: datetime,
    now: datetime,
    ends_at: datetime | None = None,
    duration_minutes: int | None = None,
    round: Round | None = None,
    title: str | None = None,
    location: str | None = None,
    video_url: str | None = None,
    agenda: str | None = None,
    guests: Sequence[Investor] = (),
    source: str | None = None,
    move_to_meeting_stage: bool = True,
) -> WriteResult:
    end = _end(starts_at, ends_at, duration_minutes)
    _check_window(starts_at, end, now)
    existing = await db.scalar(
        select(Meeting).where(
            Meeting.workspace_id == ws.workspace_id,
            Meeting.investor_id == investor.id,
            Meeting.starts_at == starts_at,
            Meeting.status == MeetingStatus.SCHEDULED.value,
        )
    )
    if existing is not None:
        return WriteResult(existing, created=False, changed=False)
    n = await db.scalar(
        select(func.count()).select_from(Meeting).where(Meeting.workspace_id == ws.workspace_id)
    )
    if int(n or 0) >= MAX_MEETINGS:
        raise LimitReached(f"This workspace has reached the limit of {MAX_MEETINGS:,} meetings.")
    rnd = round if round is not None else await default_round(db, ws, investor)
    src = source or ("agent" if ws.actor.is_agent else "manual")
    m = Meeting(
        workspace_id=ws.workspace_id,
        investor_id=investor.id,
        round_id=rnd.id if rnd else None,
        title=clean_text(title, "title", max_len=200) or default_title(investor),
        starts_at=starts_at,
        ends_at=end,
        timezone=ws.timezone,
        location=clean_text(location, "location", max_len=500),
        video_url=clean_url(video_url),
        agenda=clean_text(agenda, "agenda", max_len=5000, multiline=True),
        status=MeetingStatus.SCHEDULED.value,
        source=src,
        sequence=0,
        created_at=now,
        updated_at=now,
        **ws.actor.activity_fields(),
    )
    db.add(m)
    await db.flush()
    for g in guests:
        db.add(MeetingGuest(meeting_id=m.id, investor_id=g.id, workspace_id=ws.workspace_id))
    await db.flush()
    await activities.check_activity_limit(db, ws)
    act = await activities.log(
        db,
        ws,
        investor_id=investor.id,
        round_id=m.round_id,
        kind="meeting_scheduled",
        now=now,
        data={
            "meeting_id": m.id,
            "title": m.title,
            "starts_at": starts_at,
            "ends_at": end,
            "location": m.location,
            "video_url": m.video_url,
            "guests": [g.name for g in guests] or None,
            "source": src,
            "seq": 0,
        },
    )
    result = WriteResult(m, created=True, activity=act)
    if rnd is not None and move_to_meeting_stage:
        moved, part, warning = await _advance_stage(db, ws, rnd, investor, starts_at, now=now)
        result.moved, result.participant = moved, part
        if warning:
            result.warnings.append(warning)
    elif rnd is not None:
        from raisebook.services import participants as parts_svc

        result.participant = await parts_svc.get_participant(db, ws, rnd.id, investor.id)
    if starts_at < now:
        result.warnings.append(
            f"starts_at {starts_at.isoformat()} is in the past; mark the meeting done with an "
            "outcome if it happened."
        )
    return result


_EDITABLE = ("title", "location", "video_url", "agenda")


async def update(
    db: AsyncSession,
    ws: WorkspaceContext,
    m: Meeting,
    changes: Mapping[str, Any],
    *,
    now: datetime,
    note: str | None = None,
) -> WriteResult:
    """Reschedule, edit, cancel, mark a no-show or reopen. ``changes`` keys: starts_at,
    ends_at, duration_minutes, round (Round or None), title, location, video_url, agenda,
    guests (list of Investor), status (scheduled, cancelled, no_show)."""
    fields: list[str] = []
    old_start, old_end = m.starts_at, m.ends_at
    start = changes.get("starts_at") or m.starts_at
    if changes.get("ends_at") is not None:
        end = changes["ends_at"]
    elif changes.get("duration_minutes") is not None:
        end = start + timedelta(minutes=int(changes["duration_minutes"]))
    else:
        end = start + (old_end - old_start)
    timed = start != old_start or end != old_end
    status = changes.get("status")
    if m.status == MeetingStatus.DONE.value and (timed or status not in (None, "done")):
        raise MeetingDone(
            "This meeting is done. Schedule a new meeting instead of changing this one.",
            details={"meeting_id": str(m.id)},
        )
    if timed:
        _check_window(start, end, now)
    values: dict[str, Any] = {}
    for f in _EDITABLE:
        if f not in changes:
            continue
        raw = changes[f]
        if f == "video_url":
            v = clean_url(raw)
        elif f == "title":
            v = clean_text(raw, "title", max_len=200) or m.title
        elif f == "agenda":
            v = clean_text(raw, "agenda", max_len=5000, multiline=True)
        else:
            v = clean_text(raw, f, max_len=500)
        if v != getattr(m, f):
            values[f] = v
            fields.append(f)
    if "round" in changes:
        rnd = changes["round"]
        rid = rnd.id if rnd is not None else None
        if rid != m.round_id:
            values["round_id"] = rid
            fields.append("round")
    new_guests: list[Investor] | None = None
    if changes.get("guests") is not None:
        current = (await guest_ids(db, ws, [m.id]))[m.id]
        new_guests = list(changes["guests"])
        if {g.id for g in new_guests} != set(current):
            fields.append("guests")
        else:
            new_guests = None
    new_status = m.status
    if status is not None and status != m.status:
        new_status = status
    elif timed and m.status in (MeetingStatus.CANCELLED.value, MeetingStatus.NO_SHOW.value):
        new_status = MeetingStatus.SCHEDULED.value  # rescheduling brings it back
    if not timed and not fields and new_status == m.status:
        return WriteResult(m, changed=False)

    if new_status != m.status and new_status == MeetingStatus.CANCELLED.value:
        change = "cancelled"
    elif new_status != m.status and new_status == MeetingStatus.NO_SHOW.value:
        change = "no_show"
    elif timed:
        change = "rescheduled"
    elif new_status != m.status:
        change = "reopened"
    else:
        change = "edited"
    for k, v in values.items():
        setattr(m, k, v)
    if timed:
        m.starts_at, m.ends_at = start, end
    if new_status != m.status:
        m.status = new_status
        m.cancelled_at = now if new_status == MeetingStatus.CANCELLED.value else None
    if new_guests is not None:
        await db.execute(
            delete(MeetingGuest).where(
                MeetingGuest.workspace_id == ws.workspace_id, MeetingGuest.meeting_id == m.id
            )
        )
        for g in new_guests:
            db.add(MeetingGuest(meeting_id=m.id, investor_id=g.id, workspace_id=ws.workspace_id))
    m.sequence += 1
    m.updated_at = now
    await db.flush()
    data: dict[str, Any] = {
        "meeting_id": m.id,
        "change": change,
        "title": m.title,
        "seq": m.sequence,
    }
    if fields:
        data["fields"] = fields
    if timed:
        data["from_starts_at"] = old_start
        data["to_starts_at"] = start
    else:
        data["starts_at"] = m.starts_at
    act = await activities.log(
        db,
        ws,
        investor_id=m.investor_id,
        round_id=m.round_id,
        kind="meeting_updated",
        now=now,
        body=clean_text(note, "note", max_len=2000, multiline=True),
        data=data,
    )
    result = WriteResult(m, changed=True, activity=act)
    if m.round_id is not None:
        from raisebook.services import participants as parts_svc

        # The board's chip reads the participant's next meeting: hand it back.
        result.participant = await parts_svc.get_participant(db, ws, m.round_id, m.investor_id)
    return result


async def complete(
    db: AsyncSession,
    ws: WorkspaceContext,
    m: Meeting,
    *,
    now: datetime,
    outcome: str | None = None,
    next_step: str | None = None,
    follow_up_on: Any = None,
    follow_up_in_days: int | None = None,
    follow_up_note: str | None = None,
) -> WriteResult:
    """Mark done: log the outcome as a ``meeting`` activity (linked to the meeting) and,
    when the investor is in the meeting's round, set the next step and the follow-up."""
    from raisebook.services import investors as investors_svc
    from raisebook.services import participants as parts_svc

    if m.status == MeetingStatus.DONE.value:
        act = None
        if m.outcome_activity_id:
            act = await db.scalar(select(Activity).where(Activity.id == m.outcome_activity_id))
        return WriteResult(m, changed=False, activity=act)
    if m.starts_at > now + DONE_GRACE:
        raise ValidationFailed(
            "status",
            f"This meeting starts {when_text(m.starts_at, ws.timezone)}; mark it done after it "
            "has happened, or reschedule it.",
        )
    if follow_up_on is not None and follow_up_in_days is not None:
        raise ValidationFailed("follow_up_on", "Give follow_up_on or follow_up_in_days, not both.")
    inv = await investors_svc.get(db, ws, m.investor_id)
    text = clean_text(outcome, "outcome", max_len=5000, multiline=True)
    await activities.check_activity_limit(db, ws)
    act = await activities.log(
        db,
        ws,
        investor_id=m.investor_id,
        round_id=m.round_id,
        kind="meeting",
        now=now,
        occurred_at=m.starts_at,
        body=text or f"Met {inv.name}.",
        data={"meeting_id": m.id, "title": m.title, "seq": m.sequence + 1},
    )
    m.status = MeetingStatus.DONE.value
    m.completed_at = now
    m.cancelled_at = None
    m.outcome = text
    m.outcome_activity_id = act.id
    m.sequence += 1
    m.updated_at = now
    await db.flush()
    result = WriteResult(m, changed=True, activity=act)
    if follow_up_in_days is not None:
        follow_up_on = ws.today(now) + timedelta(days=follow_up_in_days)
    wants = {
        k: v
        for k, v in (
            ("next_step", clean_text(next_step, "next_step", max_len=500)),
            ("follow_up_on", follow_up_on),
            ("follow_up_note", clean_text(follow_up_note, "follow_up_note", max_len=500)),
        )
        if v is not None
    }
    rnd: Round | None = None
    if m.round_id is not None:
        rnd = await db.scalar(
            select(Round).where(Round.workspace_id == ws.workspace_id, Round.id == m.round_id)
        )
    if rnd is None:
        rnd = await default_round(db, ws, inv)
    part = await parts_svc.get_participant(db, ws, rnd.id, inv.id) if rnd else None
    result.participant = part
    if wants:
        if rnd is None or part is None:
            result.warnings.append(
                f"{inv.name} is not in a round, so the next step and follow-up were not saved."
            )
        else:
            stages = await stages_for(db, ws, rnd.id)
            await parts_svc.apply_changes(db, ws, rnd, part, stages, wants, now=now)
    return result


async def delete_meeting(
    db: AsyncSession, ws: WorkspaceContext, m: Meeting, *, now: datetime
) -> None:
    """Hard delete (its timeline entries stay, with ``meeting_updated`` ``deleted``)."""
    await activities.log(
        db,
        ws,
        investor_id=m.investor_id,
        round_id=m.round_id,
        kind="meeting_updated",
        now=now,
        data={
            "meeting_id": m.id,
            "change": "deleted",
            "title": m.title,
            "starts_at": m.starts_at,
        },
    )
    await db.execute(
        delete(Meeting).where(Meeting.workspace_id == ws.workspace_id, Meeting.id == m.id)
    )
    await db.flush()
