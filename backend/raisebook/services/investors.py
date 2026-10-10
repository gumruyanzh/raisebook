"""Investor contacts: dedupe, create, update, delete, presentation (SPEC §3.4, §5.7). Owner: AM.

Contract for imports (IE) and every other writer:

- :func:`find_match` → :class:`Match` (dedupe order email → LinkedIn → name+firm).
- :func:`create` / :func:`update` write the row *and* its activity in one flush; the
  caller commits. Both accept raw or already-normalized fields (normalization is
  idempotent) and an optional ``actor`` / ``import_run_id`` (imports pass
  ``ws.actor.with_via(Via.IMPORT)``).
- :func:`add` is ``add_investor`` / ``POST /v1/investors`` (dedupe + ``on_duplicate``).

Investors never cross workspaces: every query filters by ``ws.workspace_id``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.actor import Actor
from raisebook.core.errors import Duplicate, LimitReached, ValidationFailed, not_found
from raisebook.models.enums import Via
from raisebook.models.investor import Investor
from raisebook.models.round import Round, RoundParticipant, RoundStage
from raisebook.schemas.investors import InvestorCompact, InvestorOut, ParticipationBrief
from raisebook.services import activities
from raisebook.services.normalize import (
    ARRAY_LIMITS,
    INVESTOR_FIELDS,
    TEXT_LIMITS,
    MatchedOn,
    clean_list,
    clean_text,
    dedupe_keys,
    derived_fields,
    linkedin_key,
    merge_lists,
    normalize_investor_input,
)
from raisebook.services.stages import stage_out
from raisebook.services.workspaces import LIMITS

OnDuplicate = Literal["return_existing", "fill_empty", "create_anyway"]
LIST_FIELDS = frozenset(ARRAY_LIMITS)


@dataclass(frozen=True)
class Match:
    investor: Investor
    matched_on: MatchedOn


@dataclass
class UpdateResult:
    investor: Investor
    changed_fields: list[str] = field(default_factory=list)


@dataclass
class AddResult:
    investor: Investor
    created: bool
    matched_on: MatchedOn | None = None
    filled_fields: list[str] | None = None


def _state(inv: Investor) -> dict[str, Any]:
    return {f: getattr(inv, f) for f in INVESTOR_FIELDS}


def _empty(value: Any) -> bool:
    return value is None or value == [] or value == ""


async def get(db: AsyncSession, ws: WorkspaceContext, investor_id: UUID) -> Investor:
    row = await db.scalar(
        select(Investor).where(Investor.workspace_id == ws.workspace_id, Investor.id == investor_id)
    )
    if row is None:
        raise not_found("Investor")
    return row


async def get_many(
    db: AsyncSession, ws: WorkspaceContext, ids: Iterable[UUID]
) -> dict[UUID, Investor]:
    wanted = set(ids)
    if not wanted:
        return {}
    rows = await db.scalars(
        select(Investor).where(Investor.workspace_id == ws.workspace_id, Investor.id.in_(wanted))
    )
    return {r.id: r for r in rows}


async def find_match(
    db: AsyncSession,
    ws: WorkspaceContext,
    fields: Mapping[str, Any],
    *,
    include_name_firm: bool = True,
    exclude_id: UUID | None = None,
) -> Match | None:
    """The existing investor that ``fields`` (normalized) duplicates, in SPEC order:
    same email → ``"email"``, same LinkedIn profile → ``"linkedin"``, same name+firm →
    ``"name_firm"`` (advisory; skipped with ``include_name_firm=False``)."""
    keys = dedupe_keys(fields)
    base = select(Investor).where(Investor.workspace_id == ws.workspace_id)
    if exclude_id is not None:
        base = base.where(Investor.id != exclude_id)
    for matched_on, value in keys.ordered():
        if matched_on == "email":
            stmt = base.where(Investor.email == value)
        elif matched_on == "linkedin":
            stmt = base.where(Investor.linkedin_key == value)
        else:
            if not include_name_firm:
                continue
            stmt = base.where(Investor.name_key == value)
        row = await db.scalar(stmt.order_by(Investor.created_at, Investor.id).limit(1))
        if row is not None:
            return Match(row, matched_on)
    return None


async def _check_unique(
    db: AsyncSession, ws: WorkspaceContext, state: Mapping[str, Any], exclude_id: UUID | None
) -> None:
    """Email and LinkedIn duplicates are never created (409 ``duplicate``)."""
    match = await find_match(db, ws, state, include_name_firm=False, exclude_id=exclude_id)
    if match is None:
        return
    what = "email" if match.matched_on == "email" else "LinkedIn profile"
    out = await present(db, ws, [match.investor], with_rounds=False)
    raise Duplicate(
        f"{match.investor.name} already has this {what} (id {match.investor.id}). "
        "Update that investor instead.",
        details={"matched_on": match.matched_on, "existing": out[0].model_dump(mode="json")},
    )


async def count(db: AsyncSession, ws: WorkspaceContext) -> int:
    n = await db.scalar(
        select(func.count()).select_from(Investor).where(Investor.workspace_id == ws.workspace_id)
    )
    return int(n or 0)


async def create(
    db: AsyncSession,
    ws: WorkspaceContext,
    fields: Mapping[str, Any],
    *,
    now: datetime,
    actor: Actor | None = None,
    import_run_id: UUID | None = None,
) -> Investor:
    """Insert an investor and its ``investor_created`` activity. Email/LinkedIn duplicates
    raise 409 ``duplicate`` (check :func:`find_match` first to dedupe instead)."""
    clean = normalize_investor_input(fields, partial=False)
    if await count(db, ws) >= LIMITS["investors"]:
        raise LimitReached(
            f"This workspace has reached the limit of {LIMITS['investors']:,} investors."
        )
    state = {f: clean.get(f) for f in INVESTOR_FIELDS}
    for f in LIST_FIELDS:
        state[f] = state[f] or []
    state["type"] = state["type"] or "other"
    await _check_unique(db, ws, state, None)
    inv = Investor(
        workspace_id=ws.workspace_id,
        **state,
        **derived_fields(state),
        created_at=now,
        updated_at=now,
    )
    db.add(inv)
    await db.flush()
    await activities.log(
        db,
        ws,
        investor_id=inv.id,
        kind="investor_created",
        now=now,
        data={"import_run_id": str(import_run_id)} if import_run_id else {},
        actor=actor,
        import_run_id=import_run_id,
    )
    return inv


def _notes_line(text: str, now: datetime, ws: WorkspaceContext, actor: Actor) -> str:
    day = ws.today(now).isoformat()
    who = actor.label if not actor.is_user and actor.label else None
    return f"[{day}, {who}] {text}" if who else f"[{day}] {text}"


async def update(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor: Investor,
    changes: Mapping[str, Any],
    *,
    now: datetime,
    actor: Actor | None = None,
    import_run_id: UUID | None = None,
    add_tags: Sequence[str] | None = None,
    remove_tags: Sequence[str] | None = None,
    add_industries: Sequence[str] | None = None,
    append_notes: str | None = None,
    fill_empty: bool = False,
) -> UpdateResult:
    """Apply contact-field changes (absent = unchanged, ``None`` = clear) and write one
    ``investor_updated`` activity listing the changed fields. A no-op writes nothing.

    ``fill_empty=True`` only fills fields that are empty and unions list fields (tags,
    industries, stage focus). Notes changes record ``{"appended": true}`` or
    ``{"changed": true}``, never the text; a signed-in user's notes edits write no
    activity (the web notes field autosaves).
    """
    act = actor or ws.actor
    clean = normalize_investor_input(changes, partial=True)
    before = _state(investor)
    after = dict(before)
    for f, value in clean.items():
        if fill_empty:
            if f in LIST_FIELDS:
                merged = merge_lists(before[f] or [], value or [])
                if len(merged) > ARRAY_LIMITS[f]:
                    merged = merged[: ARRAY_LIMITS[f]]
                after[f] = merged
            elif _empty(before[f]) and not _empty(value):
                after[f] = value
            elif f == "type" and before[f] == "other" and value not in (None, "other"):
                after[f] = value
        else:
            after[f] = [] if (f in LIST_FIELDS and value is None) else value
    if add_tags:
        after["tags"] = merge_lists(
            after["tags"] or [], clean_list(add_tags, "add_tags", max_items=30)
        )
    if remove_tags:
        drop = {t.casefold() for t in clean_list(remove_tags, "remove_tags", max_items=30)}
        after["tags"] = [t for t in after["tags"] or [] if t.casefold() not in drop]
    if add_industries:
        after["industries"] = merge_lists(
            after["industries"] or [], clean_list(add_industries, "add_industries", max_items=30)
        )
    for f in LIST_FIELDS:
        if len(after[f] or []) > ARRAY_LIMITS[f]:
            raise ValidationFailed(f, f"{f} can have at most {ARRAY_LIMITS[f]} items.")
    appended = False
    extra = clean_text(append_notes, "append_notes", max_len=TEXT_LIMITS["notes"], multiline=True)
    if extra:
        line = _notes_line(extra, now, ws, act)
        after["notes"] = f"{after['notes']}\n\n{line}" if after["notes"] else line
        appended = True
        if len(after["notes"]) > TEXT_LIMITS["notes"]:
            raise ValidationFailed("append_notes", "notes would exceed 20000 characters.")
    lo, hi = after.get("check_min"), after.get("check_max")
    if lo is not None and hi is not None and lo > hi:
        raise ValidationFailed("check_min", "check_min must not be greater than check_max.")

    changed = [f for f in INVESTOR_FIELDS if after[f] != before[f]]
    if not changed:
        return UpdateResult(investor, [])
    if "email" in changed or "linkedin_url" in changed:
        probe = {
            "email": after["email"] if "email" in changed else None,
            "linkedin_url": after["linkedin_url"]
            if linkedin_key(after["linkedin_url"]) != linkedin_key(before["linkedin_url"])
            else None,
        }
        await _check_unique(db, ws, probe, investor.id)
    for f in changed:
        setattr(investor, f, after[f])
    for k, v in derived_fields(after).items():
        setattr(investor, k, v)
    investor.updated_at = now
    await db.flush()

    web_user = act.is_user and act.via == Via.WEB  # the autosaving notes field
    log_fields = [f for f in changed if not (f == "notes" and web_user)]
    if log_fields:
        diff: dict[str, Any] = {}
        for f in log_fields:
            if f == "notes":
                diff[f] = {"appended": True} if appended else {"changed": True}
            else:
                diff[f] = {"from": before[f], "to": after[f]}
        data: dict[str, Any] = {"fields": log_fields, "changes": diff}
        if import_run_id:
            data["import_run_id"] = str(import_run_id)
        await activities.log(
            db,
            ws,
            investor_id=investor.id,
            kind="investor_updated",
            now=now,
            data=data,
            actor=act,
            import_run_id=import_run_id,
        )
    return UpdateResult(investor, changed)


async def add(
    db: AsyncSession,
    ws: WorkspaceContext,
    fields: Mapping[str, Any],
    *,
    on_duplicate: OnDuplicate = "return_existing",
    now: datetime,
    actor: Actor | None = None,
) -> AddResult:
    """``add_investor`` / ``POST /v1/investors``: create, or return the duplicate.

    ``return_existing`` changes nothing; ``fill_empty`` fills empty fields and merges
    lists; ``create_anyway`` ignores a name+firm match (email/LinkedIn duplicates are
    never created).
    """
    clean = normalize_investor_input(fields, partial=False)
    match = await find_match(db, ws, clean, include_name_firm=on_duplicate != "create_anyway")
    if match is None:
        inv = await create(db, ws, clean, now=now, actor=actor)
        return AddResult(inv, True)
    if on_duplicate == "fill_empty":
        res = await update(db, ws, match.investor, clean, now=now, actor=actor, fill_empty=True)
        return AddResult(match.investor, False, match.matched_on, res.changed_fields)
    return AddResult(match.investor, False, match.matched_on)


async def delete_investor(db: AsyncSession, ws: WorkspaceContext, investor: Investor) -> None:
    """Hard delete (cascades participants and activities)."""
    await db.execute(
        delete(Investor).where(Investor.workspace_id == ws.workspace_id, Investor.id == investor.id)
    )
    await db.flush()


# --- presentation ------------------------------------------------------------------------


def compact(inv: Investor) -> InvestorCompact:
    return InvestorCompact(
        id=inv.id,
        name=inv.name,
        firm=inv.firm,
        title=inv.title,
        type=inv.type,
        email=str(inv.email) if inv.email else None,
        linkedin_url=inv.linkedin_url,
        tags=list(inv.tags or []),
    )


async def participations(
    db: AsyncSession, ws: WorkspaceContext, investor_ids: Iterable[UUID]
) -> dict[UUID, list[ParticipationBrief]]:
    ids = set(investor_ids)
    out: dict[UUID, list[ParticipationBrief]] = {i: [] for i in ids}
    if not ids:
        return out
    rows = await db.execute(
        select(RoundParticipant, Round, RoundStage)
        .join(
            Round,
            (Round.id == RoundParticipant.round_id)
            & (Round.workspace_id == RoundParticipant.workspace_id),
        )
        .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
        .where(
            RoundParticipant.workspace_id == ws.workspace_id,
            RoundParticipant.investor_id.in_(ids),
        )
        .order_by(Round.status.desc(), Round.created_at.desc())
    )
    for p, r, st in rows.tuples():
        out[p.investor_id].append(
            ParticipationBrief(
                round_id=r.id,
                round_slug=str(r.slug),
                round_name=r.name,
                stage=stage_out(st),
                fit=p.fit,
                follow_up_on=p.follow_up_on,
                amount_committed=p.amount_committed,
            )
        )
    return out


async def present(
    db: AsyncSession,
    ws: WorkspaceContext,
    investors: Sequence[Investor],
    *,
    with_rounds: bool = True,
) -> list[InvestorOut]:
    parts = await participations(db, ws, [i.id for i in investors]) if with_rounds else {}
    out = []
    for inv in investors:
        base = compact(inv).model_dump()
        out.append(
            InvestorOut(
                **base,
                website_url=inv.website_url,
                x_url=inv.x_url,
                location=inv.location,
                check_min=inv.check_min,
                check_max=inv.check_max,
                check_note=inv.check_note,
                stage_focus=list(inv.stage_focus or []),
                industries=list(inv.industries or []),
                notes=inv.notes,
                source=inv.source,
                warm_intro_by=inv.warm_intro_by,
                rounds=parts.get(inv.id, []),
                created_at=inv.created_at,
                updated_at=inv.updated_at,
            )
        )
    return out


async def present_one(db: AsyncSession, ws: WorkspaceContext, inv: Investor) -> InvestorOut:
    return (await present(db, ws, [inv]))[0]
