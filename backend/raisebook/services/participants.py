"""Round participation: an investor in a round (SPEC §3.5, §5.6, §8.1). Owner: AM.

Every change writes its activity in the same flush (the caller commits), and a no-op
writes nothing. Activity kinds per change:

- stage → ``stage_change`` ``{from, to, reason?}`` (``body`` = note)
- amount_committed / committed_on → ``commitment`` ``{amount, previous_amount, currency,
  committed_on}``
- follow_up_on / follow_up_note → ``follow_up_set`` ``{from, to, note}``
- fit, probability, amount_soft, owner, next_step → ``participant_updated`` ``{changes}``

Contract for imports (IE): :func:`upsert` (add to a round, or apply fields to an
existing participant) with ``actor`` / ``import_run_id``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import Select, and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.actor import Actor
from raisebook.core.errors import NotFound, NotInRound, ValidationFailed
from raisebook.core.refs import how, resolve_stage
from raisebook.models.investor import Investor
from raisebook.models.round import Round, RoundParticipant, RoundStage
from raisebook.models.user import User
from raisebook.models.workspace import Membership
from raisebook.schemas.common import decode_cursor, encode_cursor
from raisebook.schemas.participants import OwnerOut, ParticipantOut
from raisebook.services import activities
from raisebook.services.followups import follow_up_state, priority
from raisebook.services.investors import compact
from raisebook.services.normalize import clean_text
from raisebook.services.stages import first_stage, stage_of_kind, stage_out, stage_ref, stages_for

PARTICIPANT_FIELDS: tuple[str, ...] = (
    "stage",
    "fit",
    "probability",
    "amount_soft",
    "amount_committed",
    "committed_on",
    "follow_up_on",
    "follow_up_note",
    "next_step",
    "owner_user_id",
)
UPDATED_FIELDS = ("fit", "probability", "amount_soft", "owner_user_id", "next_step")


@dataclass
class UpsertResult:
    participant: RoundParticipant
    created: bool
    changed: list[str] = field(default_factory=list)


@dataclass
class MoveResult:
    participant: RoundParticipant
    changed: bool
    from_stage: RoundStage
    to_stage: RoundStage


@dataclass
class CommitResult:
    participant: RoundParticipant
    previous_amount: int | None
    moved_stage: bool
    round_committed_total: int


async def get_participant(
    db: AsyncSession, ws: WorkspaceContext, round_id: UUID, investor_id: UUID
) -> RoundParticipant | None:
    row: RoundParticipant | None = await db.scalar(
        select(RoundParticipant).where(
            RoundParticipant.workspace_id == ws.workspace_id,
            RoundParticipant.round_id == round_id,
            RoundParticipant.investor_id == investor_id,
        )
    )
    return row


async def require_participant(
    db: AsyncSession, ws: WorkspaceContext, rnd: Round, inv: Investor
) -> RoundParticipant:
    row = await get_participant(db, ws, rnd.id, inv.id)
    if row is None:
        raise NotInRound(
            f"{inv.name} is not in round {rnd.name}. Add them with "
            + how(ws, "add_to_round", f"POST /v1/rounds/{rnd.slug}/participants")
            + ".",
            details={"investor_id": str(inv.id), "round": str(rnd.slug)},
        )
    return row


# --- validation --------------------------------------------------------------------------


def _int_in(value: Any, f: str, lo: int, hi: int | None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        try:
            value = int(str(value).strip())
        except (TypeError, ValueError):
            raise ValidationFailed(f, f"{f} must be a whole number.") from None
    if value < lo or (hi is not None and value > hi):
        rng = f"{lo} to {hi}" if hi is not None else f"at least {lo}"
        raise ValidationFailed(f, f"{f} must be {rng}.")
    return int(value)


def _date(value: Any, f: str) -> date | None:
    if value is None or isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError:
        raise ValidationFailed(f, f"{f} must be a date YYYY-MM-DD.") from None


async def owner_from_email(db: AsyncSession, ws: WorkspaceContext, email: str) -> UUID:
    """A member's user id by email (``owner_email`` inputs)."""
    uid = await db.scalar(
        select(User.id)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.workspace_id == ws.workspace_id, User.email == email.strip().lower())
    )
    if uid is None:
        raise ValidationFailed(
            "owner_email",
            f"{email!r} is not a member of this workspace "
            + how(ws, "(use a member's sign-in email).", "(GET /v1/members)."),
        )
    return uid


async def _check_owner(db: AsyncSession, ws: WorkspaceContext, user_id: UUID) -> None:
    ok = await db.scalar(
        select(Membership.user_id).where(
            Membership.workspace_id == ws.workspace_id, Membership.user_id == user_id
        )
    )
    if ok is None:
        raise ValidationFailed(
            "owner_user_id", "owner_user_id must be a member of this workspace (GET /v1/members)."
        )


async def _clean(
    db: AsyncSession,
    ws: WorkspaceContext,
    stages: Sequence[RoundStage],
    raw: Mapping[str, Any],
    *,
    known_owners: set[UUID] | None = None,
) -> dict[str, Any]:
    """Validate the participant fields present in ``raw``. ``known_owners`` (bulk writes)
    caches the member check so a 1,000-row change asks the database once per owner."""
    out: dict[str, Any] = {}
    for f in PARTICIPANT_FIELDS:
        if f not in raw:
            continue
        v = raw[f]
        if f == "stage":
            if v is None:
                continue
            out[f] = v if isinstance(v, RoundStage) else resolve_stage(list(stages), str(v))
        elif f == "fit":
            out[f] = 0 if v is None else _int_in(v, f, 0, 5)
        elif f == "probability":
            out[f] = None if v is None else _int_in(v, f, 0, 100)
        elif f == "amount_soft":
            out[f] = None if v is None else _int_in(v, f, 0, 10**15)
        elif f == "amount_committed":
            amount = None if v is None else _int_in(v, f, 0, 10**15)
            out[f] = amount or None  # 0 clears
        elif f in ("committed_on", "follow_up_on"):
            out[f] = _date(v, f)
        elif f in ("follow_up_note", "next_step"):
            out[f] = clean_text(v, f, max_len=500)
        elif f == "owner_user_id":
            if v is not None:
                uid = v if isinstance(v, UUID) else UUID(str(v))
                if known_owners is None or uid not in known_owners:
                    await _check_owner(db, ws, uid)
                    if known_owners is not None:
                        known_owners.add(uid)
                out[f] = uid
            else:
                out[f] = None
    return out


async def _owner_label(db: AsyncSession, user_id: UUID | None) -> str | None:
    if user_id is None:
        return None
    from raisebook.services.users import display_names

    return (await display_names(db, [user_id])).get(user_id, "Former member")


# --- writes ------------------------------------------------------------------------------


async def apply_changes(
    db: AsyncSession,
    ws: WorkspaceContext,
    rnd: Round,
    part: RoundParticipant,
    stages: Sequence[RoundStage],
    raw: Mapping[str, Any],
    *,
    now: datetime,
    actor: Actor | None = None,
    note: str | None = None,
    reason: str | None = None,
    import_run_id: UUID | None = None,
    bulk_id: UUID | None = None,
    known_owners: set[UUID] | None = None,
    undo: bool = False,
) -> list[str]:
    """Apply participant field changes and log one activity per change type. ``bulk_id``
    goes into every activity's ``data`` so the feed can group a bulk change; ``undo`` marks
    them ``data.undo = true`` (an Undo putting values back, so a timeline can drop the pair)."""
    act = actor or ws.actor
    clean = await _clean(db, ws, stages, raw, known_owners=known_owners)
    by_id = {s.id: s for s in stages}
    extra: dict[str, Any] = {"import_run_id": str(import_run_id)} if import_run_id else {}
    if bulk_id:
        extra["bulk_id"] = str(bulk_id)
    if undo:
        extra["undo"] = True
    changed: list[str] = []
    body = clean_text(note, "note", max_len=2000, multiline=True)

    async def _log(kind: str, data: dict[str, Any], body: str | None = None) -> None:
        await activities.log(
            db,
            ws,
            investor_id=part.investor_id,
            round_id=rnd.id,
            kind=kind,
            now=now,
            body=body,
            data={**data, **extra},
            actor=act,
            import_run_id=import_run_id,
        )

    # Stage.
    if "stage" in clean and clean["stage"].id != part.stage_id:
        old, new = by_id[part.stage_id], clean["stage"]
        part.stage_id = new.id
        part.stage_changed_at = now
        changed.append("stage")
        data: dict[str, Any] = {"from": stage_ref(old), "to": stage_ref(new)}
        if reason:
            data["reason"] = reason
        await _log("stage_change", data, body)
        body = None  # the note travels on the first activity only
    # Commitment.
    prev_amount, prev_on = part.amount_committed, part.committed_on
    new_amount = clean.get("amount_committed", prev_amount)
    new_on = clean.get("committed_on", prev_on)
    if "amount_committed" in clean and new_amount is not None and new_on is None:
        new_on = ws.today(now)
    if new_amount is None and "amount_committed" in clean:
        new_on = None if "committed_on" not in clean else new_on
    if new_amount != prev_amount or new_on != prev_on:
        part.amount_committed, part.committed_on = new_amount, new_on
        if new_amount != prev_amount:
            changed.append("amount_committed")
        if new_on != prev_on:
            changed.append("committed_on")
        cdata: dict[str, Any] = {
            "amount": new_amount or 0,
            "currency": rnd.currency,
            "committed_on": new_on.isoformat() if new_on else None,
        }
        if prev_amount is not None:
            cdata["previous_amount"] = prev_amount
        await _log("commitment", cdata, body)
        body = None
    # Follow-up.
    prev_fu, prev_note = part.follow_up_on, part.follow_up_note
    new_fu = clean.get("follow_up_on", prev_fu)
    new_note = clean.get("follow_up_note", prev_note)
    if new_fu is None and "follow_up_on" in clean and "follow_up_note" not in clean:
        new_note = None  # clearing the date clears its note
    if new_fu != prev_fu or new_note != prev_note:
        part.follow_up_on, part.follow_up_note = new_fu, new_note
        if new_fu != prev_fu:
            changed.append("follow_up_on")
        if new_note != prev_note:
            changed.append("follow_up_note")
        fdata: dict[str, Any] = {
            "from": prev_fu.isoformat() if prev_fu else None,
            "to": new_fu.isoformat() if new_fu else None,
        }
        if new_note:
            fdata["note"] = new_note
        await _log("follow_up_set", fdata)
    # Other fields.
    diffs: dict[str, Any] = {}
    for f in UPDATED_FIELDS:
        if f in clean and clean[f] != getattr(part, f):
            before = getattr(part, f)
            setattr(part, f, clean[f])
            changed.append(f)
            if f == "owner_user_id":
                diffs["owner"] = {
                    "from": await _owner_label(db, before),
                    "to": await _owner_label(db, clean[f]),
                }
            else:
                diffs[f] = {"from": before, "to": clean[f]}
    if diffs:
        await _log("participant_updated", {"changes": diffs})
    if changed:
        part.updated_at = now
        await db.flush()
    return changed


async def upsert(
    db: AsyncSession,
    ws: WorkspaceContext,
    rnd: Round,
    investor: Investor,
    changes: Mapping[str, Any] | None = None,
    *,
    now: datetime,
    actor: Actor | None = None,
    import_run_id: UUID | None = None,
    stages: Sequence[RoundStage] | None = None,
    note: str | None = None,
    bulk_id: UUID | None = None,
    known_owners: set[UUID] | None = None,
    undo: bool = False,
) -> UpsertResult:
    """Put ``investor`` on ``rnd`` (first stage unless ``changes["stage"]``), or apply
    ``changes`` to the existing participant (a different stage is a stage change).

    ``changes`` keys: stage (key, label or RoundStage), fit, probability, amount_soft,
    amount_committed, committed_on, follow_up_on, follow_up_note, next_step,
    owner_user_id. Safe to repeat.
    """
    changes = dict(changes or {})
    stage_list = list(stages) if stages is not None else await stages_for(db, ws, rnd.id)
    act = actor or ws.actor
    existing = await get_participant(db, ws, rnd.id, investor.id)
    if existing is not None:
        changed = await apply_changes(
            db,
            ws,
            rnd,
            existing,
            stage_list,
            changes,
            now=now,
            actor=act,
            note=note,
            import_run_id=import_run_id,
            bulk_id=bulk_id,
            known_owners=known_owners,
            undo=undo,
        )
        return UpsertResult(existing, False, changed)

    clean = await _clean(db, ws, stage_list, changes, known_owners=known_owners)
    stage = clean.pop("stage", None) or first_stage(stage_list)
    part = RoundParticipant(
        workspace_id=ws.workspace_id,
        round_id=rnd.id,
        investor_id=investor.id,
        stage_id=stage.id,
        fit=0,
        stage_changed_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(part)
    await db.flush()
    extra: dict[str, Any] = {"import_run_id": str(import_run_id)} if import_run_id else {}
    if bulk_id:
        extra["bulk_id"] = str(bulk_id)
    await activities.log(
        db,
        ws,
        investor_id=investor.id,
        round_id=rnd.id,
        kind="added_to_round",
        now=now,
        data={"stage": stage_ref(stage), **extra},
        body=clean_text(note, "note", max_len=2000, multiline=True),
        actor=act,
        import_run_id=import_run_id,
    )
    # Initial values: plain fields silently, money/follow-up with their own activities.
    for f in ("fit", "probability", "amount_soft", "next_step", "owner_user_id"):
        if f in clean and clean[f] is not None:
            setattr(part, f, clean[f])
    rest = {
        k: v
        for k, v in clean.items()
        if k in ("amount_committed", "committed_on", "follow_up_on", "follow_up_note")
    }
    if rest:
        await apply_changes(
            db,
            ws,
            rnd,
            part,
            stage_list,
            rest,
            now=now,
            actor=act,
            import_run_id=import_run_id,
            bulk_id=bulk_id,
        )
    await db.flush()
    changed = ["stage", *[k for k, v in clean.items() if v is not None and k != "stage"]]
    return UpsertResult(part, True, list(dict.fromkeys(changed)))


async def import_add(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    round: Round,
    investor: Investor,
    stage: RoundStage | str | None,
    values: Mapping[str, Any] | None,
    now: datetime,
    actor: Actor | None = None,
    import_run_id: UUID | None = None,
) -> RoundParticipant:
    """Imports: add ``investor`` to ``round`` (``stage`` or the first stage) with ``values``
    (participant fields). Thin wrapper over :func:`upsert`."""
    changes = dict(values or {})
    if stage is not None:
        changes["stage"] = stage
    res = await upsert(
        db, ws, round, investor, changes, now=now, actor=actor, import_run_id=import_run_id
    )
    return res.participant


async def import_update(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    round: Round,
    investor: Investor,
    stage: RoundStage | str | None,
    changes: Mapping[str, Any] | None,
    now: datetime,
    actor: Actor | None = None,
    import_run_id: UUID | None = None,
) -> list[str]:
    """Imports: apply ``changes`` (and a stage move) to an existing participant (adds them
    when missing). Returns the changed field names. Thin wrapper over :func:`upsert`."""
    data = dict(changes or {})
    if stage is not None:
        data["stage"] = stage
    res = await upsert(
        db, ws, round, investor, data, now=now, actor=actor, import_run_id=import_run_id
    )
    return res.changed


async def move_stage(
    db: AsyncSession,
    ws: WorkspaceContext,
    rnd: Round,
    inv: Investor,
    stage_ref_: str | RoundStage,
    *,
    note: str | None,
    now: datetime,
) -> MoveResult:
    """Move to another stage; the current stage is a no-op (``changed=False``)."""
    stages = await stages_for(db, ws, rnd.id)
    part = await require_participant(db, ws, rnd, inv)
    target = (
        stage_ref_ if isinstance(stage_ref_, RoundStage) else resolve_stage(stages, str(stage_ref_))
    )
    current = next(s for s in stages if s.id == part.stage_id)
    if target.id == current.id:
        return MoveResult(part, False, current, current)
    await apply_changes(db, ws, rnd, part, stages, {"stage": target}, now=now, note=note)
    return MoveResult(part, True, current, target)


async def set_follow_up(
    db: AsyncSession,
    ws: WorkspaceContext,
    rnd: Round,
    inv: Investor,
    *,
    on: date | None = None,
    in_days: int | None = None,
    clear: bool | None = None,
    note: str | None = None,
    now: datetime,
) -> tuple[RoundParticipant, bool]:
    """Set (``on`` or ``in_days`` from today) or ``clear`` the follow-up date."""
    given = [x for x in (on is not None, in_days is not None, bool(clear)) if x]
    if len(given) != 1:
        raise ValidationFailed(
            "on", "Give exactly one of `on` (YYYY-MM-DD), `in_days` or `clear: true`."
        )
    part = await require_participant(db, ws, rnd, inv)
    stages = await stages_for(db, ws, rnd.id)
    if clear:
        changes: dict[str, Any] = {"follow_up_on": None, "follow_up_note": None}
    else:
        if in_days is not None:
            if not 0 <= in_days <= 365:
                raise ValidationFailed("in_days", "in_days must be 0 to 365.")
            on = ws.today(now) + timedelta(days=in_days)
        changes = {"follow_up_on": on}
        if note is not None:
            changes["follow_up_note"] = note
    changed = await apply_changes(db, ws, rnd, part, stages, changes, now=now)
    return part, bool(changed)


async def committed_total(db: AsyncSession, ws: WorkspaceContext, round_id: UUID) -> int:
    total = await db.scalar(
        select(func.coalesce(func.sum(RoundParticipant.amount_committed), 0))
        .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
        .where(
            RoundParticipant.workspace_id == ws.workspace_id,
            RoundParticipant.round_id == round_id,
            RoundStage.kind == "won",
        )
    )
    return int(total or 0)


async def record_commitment(
    db: AsyncSession,
    ws: WorkspaceContext,
    rnd: Round,
    inv: Investor,
    *,
    amount: int,
    committed_on: date | None = None,
    note: str | None = None,
    move_to_won: bool = True,
    now: datetime,
) -> CommitResult:
    """Set the total committed amount (replaces, never adds; 0 clears). By default also
    adds the investor to the round if needed and moves them to the won stage."""
    amount = _int_in(amount, "amount", 0, 10**15)
    stages = await stages_for(db, ws, rnd.id)
    won = stage_of_kind(stages, "won")
    move = move_to_won and amount > 0
    part = await get_participant(db, ws, rnd.id, inv.id)
    moved = False
    if part is None:
        res = await upsert(db, ws, rnd, inv, {"stage": won} if move else {}, now=now, stages=stages)
        part = res.participant
        moved = move
    previous = part.amount_committed
    changes: dict[str, Any] = {"amount_committed": amount}
    if move and part.stage_id != won.id:
        changes["stage"] = won
        moved = True
    if committed_on is not None:
        changes["committed_on"] = committed_on
    await apply_changes(db, ws, rnd, part, stages, changes, now=now, note=note, reason="commitment")
    total = await committed_total(db, ws, rnd.id)
    return CommitResult(part, previous, moved, total)


async def remove(
    db: AsyncSession,
    ws: WorkspaceContext,
    rnd: Round,
    inv: Investor,
    *,
    now: datetime,
    part: RoundParticipant | None = None,
    stage: RoundStage | None = None,
    bulk_id: UUID | None = None,
) -> None:
    """Remove from the round (logs ``removed_from_round``; the investor stays)."""
    part = part or await require_participant(db, ws, rnd, inv)
    stage = stage or await db.get(RoundStage, part.stage_id)
    data: dict[str, Any] = {"stage": stage_ref(stage)} if stage else {}
    if bulk_id:
        data["bulk_id"] = str(bulk_id)
    await db.execute(
        delete(RoundParticipant).where(
            RoundParticipant.workspace_id == ws.workspace_id, RoundParticipant.id == part.id
        )
    )
    await activities.log(
        db,
        ws,
        investor_id=inv.id,
        round_id=rnd.id,
        kind="removed_from_round",
        now=now,
        data=data,
    )


async def bulk_add(
    db: AsyncSession,
    ws: WorkspaceContext,
    rnd: Round,
    investor_ids: Sequence[UUID],
    *,
    stage: str | None,
    now: datetime,
) -> tuple[int, int]:
    """Add many investors (404 if any id is not in this workspace). ``(added, already)``."""
    from raisebook.services.investors import get_many

    ids = list(dict.fromkeys(investor_ids))
    found = await get_many(db, ws, ids)
    missing = [str(i) for i in ids if i not in found]
    if missing:
        raise NotFound(
            f"{len(missing)} investor id(s) are not in this workspace.",
            details={"missing": missing[:20]},
        )
    stages = await stages_for(db, ws, rnd.id)
    target = resolve_stage(stages, stage) if stage else first_stage(stages)
    existing = set(
        await db.scalars(
            select(RoundParticipant.investor_id).where(
                RoundParticipant.workspace_id == ws.workspace_id,
                RoundParticipant.round_id == rnd.id,
                RoundParticipant.investor_id.in_(ids),
            )
        )
    )
    added = 0
    for iid in ids:
        if iid in existing:
            continue
        await upsert(db, ws, rnd, found[iid], {"stage": target}, now=now, stages=stages)
        added += 1
    return added, len(ids) - added


@dataclass
class BulkResult:
    bulk_id: UUID
    changed: list[UUID]
    unchanged: list[UUID]
    #: Participants still in the round, in the order the ids were given.
    participants: list[RoundParticipant]
    removed: list[UUID]


BULK_FIELD = {"stage": "stage", "follow_up": "follow_up_on", "owner": "owner_user_id", "fit": "fit"}


async def bulk_update(
    db: AsyncSession,
    ws: WorkspaceContext,
    rnd: Round,
    *,
    op: str,
    investor_ids: Sequence[UUID] = (),
    value: Any = None,
    items: Sequence[Mapping[str, Any]] | None = None,
    now: datetime,
) -> BulkResult:
    """One change for many investors of ``rnd`` in one transaction (the caller commits).

    ``op`` is ``stage`` / ``follow_up`` / ``owner`` / ``fit`` (``value`` is the new value,
    ``None`` clears a follow-up or an owner), ``add_tag`` / ``remove_tag`` (``value`` is
    the tag; tags live on the investor), ``remove``, or ``restore`` (``items``: one mapping
    per investor with ``investor_id`` and the participant fields to put back; investors no
    longer in the round are added back). Every activity carries the same ``data.bulk_id``;
    ``restore`` activities also carry ``data.undo = true`` (timelines drop an undone pair).

    All or nothing: an id outside this workspace is 404 for the whole request, and for
    every op but ``restore`` an investor who is not in the round is 409 ``not_in_round``.
    Nothing is written in either case.
    """
    from uuid import uuid4

    from raisebook.services.investors import get_many
    from raisebook.services.normalize import (
        ARRAY_LIMITS,
        INVESTOR_FIELDS,
        clean_list,
        derived_fields,
        merge_lists,
    )

    if op == "restore":
        rows = list(items or [])
        ids = list(dict.fromkeys(UUID(str(r["investor_id"])) for r in rows))
        per_id = {UUID(str(r["investor_id"])): r for r in rows}
    else:
        ids = list(dict.fromkeys(investor_ids))
        per_id = {}
    if not ids:
        raise ValidationFailed(
            "investor_ids", "Give at least one investor id (or `items` for restore)."
        )
    if len(ids) > 1000:
        raise ValidationFailed("investor_ids", "At most 1,000 investors per bulk change.")

    found = await get_many(db, ws, ids)
    missing = [str(i) for i in ids if i not in found]
    if missing:
        raise NotFound(
            f"{len(missing)} investor id(s) are not in this workspace. Nothing was changed.",
            details={"missing": missing[:20]},
        )
    stages = await stages_for(db, ws, rnd.id)
    by_stage_id = {s.id: s for s in stages}
    parts = {
        p.investor_id: p
        for p in await db.scalars(
            select(RoundParticipant).where(
                RoundParticipant.workspace_id == ws.workspace_id,
                RoundParticipant.round_id == rnd.id,
                RoundParticipant.investor_id.in_(ids),
            )
        )
    }
    if op != "restore":
        outside = [i for i in ids if i not in parts]
        if outside:
            names = ", ".join(found[i].name for i in outside[:3])
            more = f" and {len(outside) - 3} more" if len(outside) > 3 else ""
            raise NotInRound(
                f"{names}{more} {'is' if len(outside) == 1 else 'are'} not in round "
                f"{rnd.name}. Nothing was changed.",
                details={"not_in_round": [str(i) for i in outside[:20]]},
            )

    bulk_id = uuid4()
    owners: set[UUID] = set()
    changed: list[UUID] = []
    removed: list[UUID] = []

    if op in BULK_FIELD:
        raw = {BULK_FIELD[op]: value}
        if op == "stage":
            if value is None:
                raise ValidationFailed("stage", "Give the stage to move them to.")
            raw = {"stage": resolve_stage(list(stages), str(value))}
        elif op == "fit" and value is None:
            raise ValidationFailed("fit", "Give a fit from 0 to 5.")
        for iid in ids:
            if await apply_changes(
                db,
                ws,
                rnd,
                parts[iid],
                stages,
                raw,
                now=now,
                bulk_id=bulk_id,
                known_owners=owners,
            ):
                changed.append(iid)
    elif op in ("add_tag", "remove_tag"):
        tags = clean_list([value] if isinstance(value, str) else value, "tag", max_items=1)
        if not tags:
            raise ValidationFailed("tag", "Give the tag to add or remove.")
        tag = tags[0]
        for iid in ids:
            inv = found[iid]
            before = list(inv.tags or [])
            if op == "add_tag":
                after = merge_lists(before, [tag])
                if len(after) > ARRAY_LIMITS["tags"]:
                    raise ValidationFailed(
                        "tag", f"{inv.name} already has {ARRAY_LIMITS['tags']} tags."
                    )
            else:
                after = [t for t in before if t.casefold() != tag.casefold()]
            if after == before:
                continue
            inv.tags = after
            state = {f: getattr(inv, f) for f in INVESTOR_FIELDS}
            for k, v in derived_fields(state).items():
                setattr(inv, k, v)
            inv.updated_at = now
            await activities.log(
                db,
                ws,
                investor_id=inv.id,
                kind="investor_updated",
                now=now,
                data={
                    "fields": ["tags"],
                    "changes": {"tags": {"from": before, "to": after}},
                    "bulk_id": str(bulk_id),
                },
            )
            changed.append(iid)
        await db.flush()
    elif op == "remove":
        for iid in ids:
            part = parts.pop(iid)
            await remove(
                db,
                ws,
                rnd,
                found[iid],
                now=now,
                part=part,
                stage=by_stage_id.get(part.stage_id),
                bulk_id=bulk_id,
            )
            removed.append(iid)
            changed.append(iid)
    elif op == "restore":
        for iid in ids:
            fields = {k: v for k, v in per_id[iid].items() if k != "investor_id"}
            res = await upsert(
                db,
                ws,
                rnd,
                found[iid],
                fields,
                now=now,
                stages=stages,
                bulk_id=bulk_id,
                known_owners=owners,
                undo=True,
            )
            parts[iid] = res.participant
            if res.created or res.changed:
                changed.append(iid)
    else:
        raise ValidationFailed("op", f"Unknown bulk op {op!r}.")

    done = set(changed)
    return BulkResult(
        bulk_id=bulk_id,
        changed=changed,
        unchanged=[i for i in ids if i not in done],
        participants=[parts[i] for i in ids if i in parts],
        removed=removed,
    )


# --- reads -------------------------------------------------------------------------------


SORTS = ("fit", "name", "firm", "stage", "follow_up", "updated", "amount", "recent")


def list_query(
    ws: WorkspaceContext,
    rnd: Round,
    *,
    now: datetime,
    q: str | None = None,
    stages: Sequence[RoundStage] | None = None,
    fit_min: int | None = None,
    type_: str | None = None,
    tags: Sequence[str] | None = None,
    industries: Sequence[str] | None = None,
    follow_up: str | None = None,
    owner: str | None = None,
    sort: str = "fit",
    order: str | None = None,
) -> Select[tuple[RoundParticipant, Investor, RoundStage]]:
    from raisebook.services.search import array_has_ci as _array_has_ci
    from raisebook.services.search import word_conditions

    stmt = (
        select(RoundParticipant, Investor, RoundStage)
        .join(
            Investor,
            and_(
                Investor.id == RoundParticipant.investor_id,
                Investor.workspace_id == RoundParticipant.workspace_id,
            ),
        )
        .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
        .where(
            RoundParticipant.workspace_id == ws.workspace_id,
            RoundParticipant.round_id == rnd.id,
        )
    )
    if q:
        stmt = stmt.where(*word_conditions(q))
    if stages:
        stmt = stmt.where(RoundParticipant.stage_id.in_([s.id for s in stages]))
    if fit_min is not None:
        stmt = stmt.where(RoundParticipant.fit >= fit_min)
    if type_:
        stmt = stmt.where(Investor.type == type_)
    for t in tags or []:
        stmt = stmt.where(_array_has_ci(Investor.tags, t))
    if industries:
        stmt = stmt.where(or_(*[_array_has_ci(Investor.industries, i) for i in industries]))
    today = ws.today(now)
    if follow_up == "due":
        stmt = stmt.where(RoundParticipant.follow_up_on <= today)
    elif follow_up == "week":
        stmt = stmt.where(RoundParticipant.follow_up_on <= today + timedelta(days=7))
    elif follow_up == "none":
        stmt = stmt.where(RoundParticipant.follow_up_on.is_(None))
    if owner:
        if owner == "none":
            stmt = stmt.where(RoundParticipant.owner_user_id.is_(None))
        else:
            try:
                stmt = stmt.where(RoundParticipant.owner_user_id == UUID(owner))
            except ValueError:
                raise ValidationFailed(
                    ["query", "owner"], "owner must be a user id or 'none'."
                ) from None
    desc = (
        order or ("desc" if sort in ("fit", "updated", "amount", "recent") else "asc")
    ) == "desc"

    def o(col: Any) -> Any:
        return col.desc().nulls_last() if desc else col.asc().nulls_last()

    keys: list[Any]
    if sort == "name":
        keys = [o(func.lower(Investor.name))]
    elif sort == "firm":
        keys = [o(func.lower(Investor.firm)), func.lower(Investor.name)]
    elif sort == "stage":
        keys = [o(RoundStage.position), RoundParticipant.fit.desc(), func.lower(Investor.name)]
    elif sort == "follow_up":
        keys = [o(RoundParticipant.follow_up_on), func.lower(Investor.name)]
    elif sort in ("updated", "recent"):
        keys = [o(func.coalesce(RoundParticipant.last_activity_at, RoundParticipant.updated_at))]
    elif sort == "amount":
        keys = [o(func.coalesce(RoundParticipant.amount_committed, RoundParticipant.amount_soft))]
    else:
        keys = [o(RoundParticipant.fit), RoundStage.position.desc(), func.lower(Investor.name)]
    return stmt.order_by(*keys, RoundParticipant.id)


async def list_participants(
    db: AsyncSession,
    ws: WorkspaceContext,
    rnd: Round,
    *,
    now: datetime,
    limit: int = 50,
    cursor: str | None = None,
    **filters: Any,
) -> tuple[list[RoundParticipant], str | None, int]:
    stmt = list_query(ws, rnd, now=now, **filters)
    total = int(
        await db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
    )
    offset = int((decode_cursor(cursor) or {}).get("o", 0))
    rows = list((await db.execute(stmt.offset(offset).limit(limit + 1))).tuples())
    more = len(rows) > limit
    parts = [p for p, _i, _s in rows[:limit]]
    return parts, encode_cursor({"o": offset + limit}) if more else None, total


async def present(
    db: AsyncSession,
    ws: WorkspaceContext,
    parts: Sequence[RoundParticipant],
    *,
    now: datetime,
) -> list[ParticipantOut]:
    if not parts:
        return []
    from raisebook.services.investors import get_many

    invs = await get_many(db, ws, [p.investor_id for p in parts])
    stage_rows = await db.scalars(
        select(RoundStage).where(
            RoundStage.workspace_id == ws.workspace_id,
            RoundStage.id.in_({p.stage_id for p in parts}),
        )
    )
    stages = {s.id: s for s in stage_rows}
    rounds = {
        rid: str(slug)
        for rid, slug in (
            await db.execute(
                select(Round.id, Round.slug).where(
                    Round.workspace_id == ws.workspace_id,
                    Round.id.in_({p.round_id for p in parts}),
                )
            )
        ).tuples()
    }
    owner_ids = {p.owner_user_id for p in parts if p.owner_user_id}
    owners: dict[UUID, OwnerOut] = {}
    if owner_ids:
        for u in await db.scalars(select(User).where(User.id.in_(owner_ids))):
            owners[u.id] = OwnerOut(user_id=u.id, name=u.name, email=str(u.email))
    today = ws.today(now)
    return [
        ParticipantOut(
            round_id=p.round_id,
            round_slug=rounds.get(p.round_id, ""),
            investor=compact(invs[p.investor_id]),
            stage=stage_out(stages[p.stage_id]),
            fit=p.fit,
            priority=priority(p.fit),
            probability=p.probability,
            amount_soft=p.amount_soft,
            amount_committed=p.amount_committed,
            committed_on=p.committed_on,
            follow_up_on=p.follow_up_on,
            follow_up_note=p.follow_up_note,
            follow_up_state=follow_up_state(p.follow_up_on, today),
            next_step=p.next_step,
            owner=owners.get(p.owner_user_id) if p.owner_user_id else None,
            stage_changed_at=p.stage_changed_at,
            last_activity_at=p.last_activity_at,
            created_at=p.created_at,
            updated_at=p.updated_at,
        )
        for p in parts
    ]


async def reload(
    db: AsyncSession, ws: WorkspaceContext, parts: Sequence[RoundParticipant]
) -> list[RoundParticipant]:
    """Re-read rows in one query (``last_activity_at`` is bumped in SQL by
    ``activities.log``), keeping the given order."""
    if not parts:
        return []
    rows = {
        p.id: p
        for p in await db.scalars(
            select(RoundParticipant)
            .where(
                RoundParticipant.workspace_id == ws.workspace_id,
                RoundParticipant.id.in_([p.id for p in parts]),
            )
            .execution_options(populate_existing=True)
        )
    }
    return [rows[p.id] for p in parts if p.id in rows]


async def present_one(
    db: AsyncSession, ws: WorkspaceContext, part: RoundParticipant, *, now: datetime
) -> ParticipantOut:
    await db.refresh(part)
    return (await present(db, ws, [part], now=now))[0]


async def for_investor(
    db: AsyncSession, ws: WorkspaceContext, investor_id: UUID, round_id: UUID | None = None
) -> list[RoundParticipant]:
    stmt = select(RoundParticipant).where(
        RoundParticipant.workspace_id == ws.workspace_id,
        RoundParticipant.investor_id == investor_id,
    )
    if round_id is not None:
        stmt = stmt.where(RoundParticipant.round_id == round_id)
    return list(await db.scalars(stmt.order_by(RoundParticipant.created_at)))
