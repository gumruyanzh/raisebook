"""Agent-friendly reference resolution (SPEC §6.2). Owner: API+MCP (AM).

The only place that turns a user/agent reference into a row. Every lookup is filtered
by ``ws.workspace_id``: a reference to another workspace's row is simply not found.

- investor: UUID, email, LinkedIn URL, ``"Name"`` or ``"Name @ Firm"`` (exact after
  normalization); 0 matches → ``not_found`` with up to three suggestions (trigram
  similarity, same workspace), >1 → ``ambiguous_reference`` with candidates.
- round: UUID, slug or name (case-insensitive); when ``required`` and omitted, the single
  open round, else ``round_required`` listing the open rounds.
- stage: a stage key or label (case-insensitive), else ``stage_not_found`` with valid keys.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.errors import AmbiguousReference, NotFound, RoundRequired, StageNotFound
from raisebook.models.investor import Investor
from raisebook.models.round import Round, RoundStage
from raisebook.services.normalize import linkedin_key, name_key, norm, split_name_at_firm

MAX_CANDIDATES = 10


def as_uuid(value: str) -> UUID | None:
    try:
        return UUID(value.strip())
    except (ValueError, AttributeError):
        return None


async def open_rounds(db: AsyncSession, ws: WorkspaceContext) -> list[Round]:
    rows = await db.scalars(
        select(Round)
        .where(Round.workspace_id == ws.workspace_id, Round.status == "open")
        .order_by(Round.created_at, Round.id)
    )
    return list(rows)


def _round_brief(r: Round) -> dict[str, Any]:
    return {"id": str(r.id), "slug": str(r.slug), "name": r.name}


async def resolve_round(
    db: AsyncSession, ws: WorkspaceContext, ref: str | None, *, required: bool
) -> Round | None:
    """A round by id, slug or name; ``None`` only when ``ref`` is empty and not required."""
    text = (ref or "").strip()
    if not text:
        if not required:
            return None
        opened = await open_rounds(db, ws)
        if len(opened) == 1:
            return opened[0]
        if not opened:
            raise RoundRequired(
                "There is no open round. Create one (POST /v1/rounds) or pass `round` with the "
                "id, slug or name of a closed round.",
                details={"open_rounds": []},
            )
        raise RoundRequired(
            "This workspace has several open rounds; pass `round` with one of: "
            + ", ".join(f"{r.slug} ({r.name})" for r in opened)
            + ".",
            details={"open_rounds": [_round_brief(r) for r in opened]},
        )
    rid = as_uuid(text)
    cond = (
        Round.id == rid
        if rid is not None
        else or_(Round.slug == text.lower(), func.lower(Round.name) == text.lower())
    )
    rows = list(await db.scalars(select(Round).where(Round.workspace_id == ws.workspace_id, cond)))
    if len(rows) == 1:
        return rows[0]
    if len(rows) > 1:  # a slug of one round equal to another round's name
        exact = [r for r in rows if str(r.slug) == text.lower()]
        if len(exact) == 1:
            return exact[0]
        raise AmbiguousReference(
            f"Round {text!r} matches more than one round; use the id.",
            details={"candidates": [_round_brief(r) for r in rows]},
        )
    names = await db.scalars(
        select(Round).where(Round.workspace_id == ws.workspace_id).order_by(Round.created_at)
    )
    known = [f"{r.slug} ({r.name})" for r in names]
    raise NotFound(
        f"Round {text!r} not found in this workspace."
        + (f" Rounds: {', '.join(known)}." if known else " Create one with POST /v1/rounds."),
        details={"round": text},
    )


def _candidate(inv: Investor) -> dict[str, Any]:
    return {"id": str(inv.id), "name": inv.name, "firm": inv.firm}


async def suggestions(db: AsyncSession, ws: WorkspaceContext, text: str) -> list[dict[str, Any]]:
    """Up to three closest investor names in this workspace (trigram similarity)."""
    sim = func.similarity(Investor.name, text)
    rows = await db.scalars(
        select(Investor)
        .where(Investor.workspace_id == ws.workspace_id, sim > 0.1)
        .order_by(sim.desc(), Investor.name)
        .limit(3)
    )
    return [_candidate(r) for r in rows]


async def resolve_investor(db: AsyncSession, ws: WorkspaceContext, ref: str) -> Investor:
    """An investor by id, email, LinkedIn URL, ``"Name"`` or ``"Name @ Firm"``."""
    text = (ref or "").strip()
    if not text:
        raise NotFound("Pass `investor`: an id, email, LinkedIn URL or exact name.")
    base = select(Investor).where(Investor.workspace_id == ws.workspace_id)
    iid = as_uuid(text)
    if iid is not None:
        row = await db.scalar(base.where(Investor.id == iid))
        if row is None:
            raise NotFound(
                f"Investor {text} not found in this workspace.", details={"investor": text}
            )
        return row
    lkey = linkedin_key(text)
    if lkey is not None:
        stmt = base.where(Investor.linkedin_key == lkey)
        kind = "LinkedIn profile"
    elif "@" in text and " " not in text:
        stmt = base.where(Investor.email == text.lower().removeprefix("mailto:"))
        kind = "email"
    else:
        name, firm = split_name_at_firm(text)
        if firm is not None:
            stmt = base.where(Investor.name_key == name_key(name, firm))
        else:
            stmt = base.where(func.split_part(Investor.name_key, "|", 1) == norm(name))
        kind = "name"
    rows = list(await db.scalars(stmt.order_by(Investor.name, Investor.id).limit(MAX_CANDIDATES)))
    if len(rows) == 1:
        return rows[0]
    if len(rows) > 1:
        raise AmbiguousReference(
            f'{text!r} matches {len(rows)} investors. Use the id, email, or "Name @ Firm".',
            details={"candidates": [_candidate(r) for r in rows]},
        )
    probe = split_name_at_firm(text)[0] if kind == "name" else text
    sugg = await suggestions(db, ws, probe)
    hint = ""
    if sugg:
        hint = (
            " Did you mean: "
            + "; ".join(f"{s['name']}" + (f" @ {s['firm']}" if s["firm"] else "") for s in sugg)
            + "?"
        )
    raise NotFound(
        f"No investor with {kind} {text!r} in this workspace.{hint} "
        "Add them with add_investor (POST /v1/investors).",
        details={"investor": text, "suggestions": sugg},
    )


def resolve_stage(round: Round | Sequence[RoundStage] | Any, ref: str) -> RoundStage:
    """A stage by key or label (case-insensitive).

    ``round`` is the round's ordered stage list (``services.stages.stages_for``) or any
    object with a ``stages`` attribute holding that list.
    """
    stages: Sequence[RoundStage] = (
        round if isinstance(round, list | tuple) else getattr(round, "stages", None) or []
    )
    text = (ref or "").strip()
    low = text.lower()
    for st in stages:
        if st.key == low:
            return st
    for st in stages:
        if st.label.lower() == low:
            return st
    norm_ref = norm(text)
    for st in stages:
        if norm(st.label) == norm_ref or norm(st.key) == norm_ref:
            return st
    valid = [s.key for s in stages]
    raise StageNotFound(
        f"Unknown stage {text!r}. Valid stage keys: {', '.join(valid)}.",
        details={"valid": valid},
    )
