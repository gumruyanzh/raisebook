"""Round stages: defaults, validation and whole-list replacement (SPEC §3.3). Owner: AM.

Stage ``kind`` drives every computed number: ``open`` (on the list), ``active`` (in
conversation), ``won`` (exactly one: committed), ``lost`` (exactly one: passed).
Keys are immutable; labels, colors, kinds and order may change.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.errors import InvalidStageConfig, StageInUse
from raisebook.models.enums import StageColor, StageKind
from raisebook.models.round import DEFAULT_STAGES, Round, RoundParticipant, RoundStage
from raisebook.schemas.rounds import StageOut
from raisebook.services.normalize import collapse, stage_key_from_label

KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
MIN_STAGES = 3
MAX_STAGES = 16
COLORS = frozenset(c.value for c in StageColor)
KINDS = frozenset(k.value for k in StageKind)


@dataclass(frozen=True)
class StageSpec:
    key: str | None
    label: str
    color: str
    kind: str


def stage_out(st: RoundStage, count: int | None = None) -> StageOut:
    return StageOut(
        key=st.key,
        label=st.label,
        color=st.color,
        kind=st.kind,
        position=st.position,
        count=count,
    )


def stage_ref(st: RoundStage) -> dict[str, str]:
    """``{key, label}`` as stored in activity ``data``."""
    return {"key": st.key, "label": st.label}


async def stages_for(db: AsyncSession, ws: WorkspaceContext, round_id: UUID) -> list[RoundStage]:
    rows = await db.scalars(
        select(RoundStage)
        .where(RoundStage.workspace_id == ws.workspace_id, RoundStage.round_id == round_id)
        .order_by(RoundStage.position)
    )
    return list(rows)


async def stages_by_round(
    db: AsyncSession, ws: WorkspaceContext, round_ids: Iterable[UUID]
) -> dict[UUID, list[RoundStage]]:
    ids = set(round_ids)
    out: dict[UUID, list[RoundStage]] = {rid: [] for rid in ids}
    if not ids:
        return out
    rows = await db.scalars(
        select(RoundStage)
        .where(RoundStage.workspace_id == ws.workspace_id, RoundStage.round_id.in_(ids))
        .order_by(RoundStage.round_id, RoundStage.position)
    )
    for st in rows:
        out[st.round_id].append(st)
    return out


def stage_of_kind(stages: Sequence[RoundStage], kind: str) -> RoundStage:
    for st in stages:
        if st.kind == kind:
            return st
    raise InvalidStageConfig(f"This round has no {kind} stage.")


def first_stage(stages: Sequence[RoundStage]) -> RoundStage:
    return min(stages, key=lambda s: s.position)


def _spec(item: Any) -> StageSpec:
    get = item.get if isinstance(item, Mapping) else lambda k, d=None: getattr(item, k, d)
    return StageSpec(
        key=(get("key") or None),
        label=collapse(str(get("label") or "")),
        color=str(get("color") or ""),
        kind=str(get("kind") or ""),
    )


def validate_specs(items: Sequence[Any], existing_keys: Iterable[str] = ()) -> list[StageSpec]:
    """Validate an ordered stage list and give every new stage a unique key."""
    specs = [_spec(i) for i in items]
    problems: list[str] = []
    if not MIN_STAGES <= len(specs) <= MAX_STAGES:
        problems.append(f"A round needs {MIN_STAGES} to {MAX_STAGES} stages.")
    kinds = [s.kind for s in specs]
    for s in specs:
        if not 1 <= len(s.label) <= 40:
            problems.append("Every stage needs a label of 1 to 40 characters.")
        if s.color not in COLORS:
            problems.append(f"Stage color {s.color!r} is not one of {', '.join(sorted(COLORS))}.")
        if s.kind not in KINDS:
            problems.append(f"Stage kind {s.kind!r} is not one of open, active, won, lost.")
        if s.key is not None and not KEY_RE.match(s.key):
            problems.append(f"Stage key {s.key!r} must be lowercase letters, digits or _ (max 32).")
    if kinds.count("won") != 1:
        problems.append("Exactly one stage must have kind 'won' (the committed stage).")
    if kinds.count("lost") != 1:
        problems.append("Exactly one stage must have kind 'lost' (passed or dead).")
    if not any(k in ("open", "active") for k in kinds):
        problems.append("At least one stage must have kind 'open' or 'active'.")
    labels = [s.label.casefold() for s in specs]
    if len(set(labels)) != len(labels):
        problems.append("Stage labels must be unique.")
    given = [s.key for s in specs if s.key]
    if len(set(given)) != len(given):
        problems.append("Stage keys must be unique.")
    if problems:
        raise InvalidStageConfig(" ".join(dict.fromkeys(problems)), details={"problems": problems})
    taken = set(existing_keys) | set(given)
    out: list[StageSpec] = []
    for s in specs:
        key = s.key
        if key is None:
            base = stage_key_from_label(s.label)
            key, n = base, 2
            while key in taken:
                suffix = f"_{n}"
                key = base[: 32 - len(suffix)] + suffix
                n += 1
            taken.add(key)
        out.append(StageSpec(key, s.label, s.color, s.kind))
    return out


def default_specs() -> list[StageSpec]:
    return [StageSpec(d.key, d.label, str(d.color), str(d.kind)) for d in DEFAULT_STAGES]


async def create_stages(
    db: AsyncSession, ws: WorkspaceContext, rnd: Round, specs: Sequence[StageSpec]
) -> list[RoundStage]:
    rows = []
    for pos, s in enumerate(specs):
        assert s.key is not None
        row = RoundStage(
            workspace_id=ws.workspace_id,
            round_id=rnd.id,
            key=s.key,
            label=s.label,
            color=s.color,
            kind=s.kind,
            position=pos,
        )
        db.add(row)
        rows.append(row)
    await db.flush()
    return rows


async def stage_counts(db: AsyncSession, ws: WorkspaceContext, round_id: UUID) -> dict[UUID, int]:
    rows = await db.execute(
        select(RoundParticipant.stage_id, func.count())
        .where(
            RoundParticipant.workspace_id == ws.workspace_id,
            RoundParticipant.round_id == round_id,
        )
        .group_by(RoundParticipant.stage_id)
    )
    return {sid: int(n) for sid, n in rows.tuples()}


async def replace_stages(
    db: AsyncSession,
    ws: WorkspaceContext,
    rnd: Round,
    items: Sequence[Any],
    *,
    reassign: Mapping[str, str] | None,
    now: datetime,
) -> list[RoundStage]:
    """``PUT /v1/rounds/{round}/stages``: replace the ordered list in one transaction.

    Existing stages are matched by key. A removed stage that still has participants needs
    ``reassign[removed_key] = target_key`` (409 ``stage_in_use`` otherwise); each moved
    participant gets a ``stage_change`` activity with ``reason = "stage_removed"``.
    """
    from raisebook.services import activities

    current = await stages_for(db, ws, rnd.id)
    by_key = {s.key: s for s in current}
    specs = validate_specs(items, existing_keys=by_key)
    new_keys = {s.key for s in specs}
    removed = [s for s in current if s.key not in new_keys]
    counts = await stage_counts(db, ws, rnd.id)
    reassign = dict(reassign or {})
    in_use = {s.key: counts.get(s.id, 0) for s in removed if counts.get(s.id, 0)}
    missing = {k: n for k, n in in_use.items() if k not in reassign}
    if missing:
        raise StageInUse(
            "These stages still have investors: "
            + ", ".join(f"{k} ({n})" for k, n in missing.items())
            + '. Send reassign: {"<removed_key>": "<target_key>"} to move them.',
            details={"counts": missing},
        )
    for src, dst in reassign.items():
        if src not in in_use:
            continue
        if dst not in new_keys:
            raise InvalidStageConfig(
                f"reassign target {dst!r} is not one of the new stage keys.",
                details={"valid": sorted(new_keys)},
            )

    # 1) Neutralize kinds of kept stages so the one-won/one-lost indexes never collide.
    kept = [by_key[s.key] for s in specs if s.key in by_key]
    for st in kept:
        st.kind = StageKind.ACTIVE.value
    await db.flush()
    # 2) Apply the new list (positions are a deferred unique constraint).
    final: list[RoundStage] = []
    for pos, s in enumerate(specs):
        assert s.key is not None
        found = by_key.get(s.key)
        if found is None:
            st = RoundStage(
                workspace_id=ws.workspace_id,
                round_id=rnd.id,
                key=s.key,
                label=s.label,
                color=s.color,
                kind=s.kind,
                position=pos,
            )
            db.add(st)
        else:
            st = found
            st.label, st.color, st.kind, st.position = s.label, s.color, s.kind, pos
        final.append(st)
    await db.flush()
    # 3) Move participants off removed stages, then delete those stages.
    final_by_key = {s.key: s for s in final}
    for st in removed:
        if not counts.get(st.id):
            continue
        target = final_by_key[reassign[st.key]]
        parts = list(
            await db.scalars(
                select(RoundParticipant).where(
                    RoundParticipant.workspace_id == ws.workspace_id,
                    RoundParticipant.round_id == rnd.id,
                    RoundParticipant.stage_id == st.id,
                )
            )
        )
        for p in parts:
            p.stage_id = target.id
            p.stage_changed_at = now
            p.updated_at = now
            await activities.log(
                db,
                ws,
                investor_id=p.investor_id,
                round_id=rnd.id,
                kind="stage_change",
                now=now,
                data={"from": stage_ref(st), "to": stage_ref(target), "reason": "stage_removed"},
            )
    await db.flush()
    if removed:
        await db.execute(
            delete(RoundStage).where(
                RoundStage.workspace_id == ws.workspace_id,
                RoundStage.id.in_([s.id for s in removed]),
            )
        )
    rnd.updated_at = now
    await db.flush()
    return final
