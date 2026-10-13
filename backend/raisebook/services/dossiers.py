"""Saved dossiers: storage, the refresh diff, freshness and presentation (RESEARCH-PLAN §1.10,
§4.7, §4.8; R5, R7, R8, R10, R11).

A dossier is two rows: ``dossiers`` (private analysis: verdict, Brief, Fit, Ways in, Talking
points, unverified claims) and ``dossier_facts`` (the public layer: the anchor used and the
cited facts). Facts cite ``research_sources`` rows by id. History keeps the last
:data:`KEEP_VERSIONS` versions per investor.

**Refresh diff** (R10): a fact is "new since <previous date>" when neither its identity key
(section, kind, normalized text, first cited URL) nor its loose key (kind + first cited URL,
so a reworded fact about the same page still matches) appeared in the previous version.

**Freshness** is computed, never stored: "may be stale" after 90 days; a dossier older than
30 days on an investor in a Meeting stage gets the "Refresh before your meeting?" offer.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.errors import NoDossier
from raisebook.core.refs import how
from raisebook.models.enums import SuggestionStatus
from raisebook.models.investor import Investor
from raisebook.models.research import (
    Dossier,
    DossierFacts,
    FieldSuggestion,
    ResearchRun,
    ResearchSource,
)
from raisebook.models.round import Round, RoundParticipant, RoundStage
from raisebook.services import activities
from raisebook.services.activities import _jsonable as jsonable
from raisebook.services.normalize import norm
from raisebook.services.research_validate import Outcome
from raisebook.services.research_writeback import (
    WritebackResult,
    apply_fit,
    apply_investor_fields,
    suggestion_dict,
)

KEEP_VERSIONS = 5
STALE_DAYS = 90
MEETING_REFRESH_DAYS = 30
MEETING_STAGE_KEY = "meeting"
VERDICT_LABELS = {
    "strong": "Strong fit",
    "possible": "Possible fit",
    "poor": "Poor fit",
    "unrated": "no fit verdict yet (no company profile)",
}


def fact_ids(fact: Mapping[str, Any], first_url_key: str) -> tuple[str, str]:
    """(identity key, loose key) for the refresh diff."""
    text = norm(str(fact.get("text", "")))[:120]
    raw = f"{fact.get('section')}|{fact.get('kind')}|{text}|{first_url_key}"
    strict = hashlib.sha1(raw.encode(), usedforsecurity=False).hexdigest()[:16]
    loose = f"{fact.get('kind')}|{first_url_key}"
    return strict, loose


def is_stale(created_at: datetime, now: datetime) -> bool:
    return (now - created_at).days > STALE_DAYS


def meeting_refresh_offer(
    stage_key: str | None, created_at: datetime | None, now: datetime
) -> bool:
    """The R10 rule shared with the web: Meeting stage and a dossier older than 30 days."""
    return (
        stage_key == MEETING_STAGE_KEY
        and created_at is not None
        and (now - created_at).days > MEETING_REFRESH_DAYS
    )


async def latest(
    db: AsyncSession, ws: WorkspaceContext, investor_id: UUID, *, version: int | None = None
) -> Dossier | None:
    stmt = select(Dossier).where(
        Dossier.workspace_id == ws.workspace_id, Dossier.investor_id == investor_id
    )
    if version is not None:
        stmt = stmt.where(Dossier.version == version)
    row: Dossier | None = await db.scalar(stmt.order_by(Dossier.version.desc()).limit(1))
    return row


async def facts_of(db: AsyncSession, dossier: Dossier) -> DossierFacts | None:
    row: DossierFacts | None = await db.scalar(
        select(DossierFacts).where(
            DossierFacts.workspace_id == dossier.workspace_id,
            DossierFacts.dossier_id == dossier.id,
        )
    )
    return row


@dataclass
class Stored:
    dossier: Dossier
    facts: list[dict[str, Any]]
    writeback: WritebackResult = field(default_factory=WritebackResult)
    new_fact_keys: list[str] = field(default_factory=list)


async def store(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor: Investor,
    outcome: Outcome,
    *,
    sources: Mapping[str, ResearchSource],
    identity: Mapping[str, Any],
    author_kind: str,
    author_label: str,
    now: datetime,
    run_id: UUID | None = None,
    round_id: UUID | None = None,
    anchor_fields: Mapping[str, Any] | None = None,
) -> Stored:
    """Save a validated dossier (model or agent), write back, and log one ``research``
    activity. ``sources`` maps the document's local source ids to stored rows."""
    previous = await latest(db, ws, investor.id)
    prev_strict: set[str] = set()
    prev_loose: set[str] = set()
    if previous is not None:
        prev_facts = await facts_of(db, previous)
        for f in prev_facts.facts if prev_facts else []:
            prev_strict.add(str(f.get("fid", "")))
            prev_loose.add(str(f.get("loose", "")))
    facts: list[dict[str, Any]] = []
    new_keys: list[str] = []
    for f in outcome.facts:
        rows = [sources[s] for s in f["source_ids"] if s in sources]
        if not rows:
            continue
        strict, loose = fact_ids(f, rows[0].url_key)
        facts.append({**f, "source_ids": [str(r.id) for r in rows], "fid": strict, "loose": loose})
        if previous is not None and strict not in prev_strict and loose not in prev_loose:
            new_keys.append(f["key"])
    version = (
        int(
            await db.scalar(
                select(func.coalesce(func.max(Dossier.version), 0)).where(
                    Dossier.workspace_id == ws.workspace_id, Dossier.investor_id == investor.id
                )
            )
            or 0
        )
        + 1
    )
    dossier = Dossier(
        workspace_id=ws.workspace_id,
        investor_id=investor.id,
        round_id=round_id,
        run_id=run_id,
        version=version,
        schema_version=1,
        author_kind=author_kind,
        author_label=author_label[:200] or "agent",
        verdict=outcome.verdict,
        analysis=jsonable(outcome.analysis),
        unverified=jsonable(outcome.unverified),
        previous_id=previous.id if previous else None,
        new_fact_keys=new_keys[:100],
        created_at=now,
        **ws.actor.activity_fields(),
    )
    db.add(dossier)
    await db.flush()
    db.add(
        DossierFacts(
            dossier_id=dossier.id,
            workspace_id=ws.workspace_id,
            investor_id=investor.id,
            identity=jsonable(dict(identity)),
            facts=facts,
            as_of=ws.today(now),
            created_at=now,
        )
    )
    await db.flush()
    if version > KEEP_VERSIONS:
        await db.execute(
            delete(Dossier).where(
                Dossier.workspace_id == ws.workspace_id,
                Dossier.investor_id == investor.id,
                Dossier.version <= version - KEEP_VERSIONS,
            )
        )
    proposed: dict[str, Any] = dict(anchor_fields or {})
    for name, sug in outcome.suggestions.items():
        proposed[name] = sug["value"]
    wb = await apply_investor_fields(
        db, ws, investor, proposed, now=now, dossier_id=dossier.id, review=outcome.review
    )
    fit = await apply_fit(
        db, ws, investor, outcome.verdict, round_id=round_id, dossier_id=dossier.id, now=now
    )
    wb.applied += fit.applied
    wb.suggested += fit.suggested
    await activities.log(
        db,
        ws,
        investor_id=investor.id,
        kind="research",
        now=now,
        round_id=round_id,
        body=f"Researched: {VERDICT_LABELS.get(outcome.verdict, outcome.verdict)}",
        data={
            "event": "dossier",
            "dossier_id": dossier.id,
            "run_id": run_id,
            "verdict": outcome.verdict,
            "version": version,
            "author": {"kind": author_kind, "label": dossier.author_label},
            "filled": wb.applied,
            "suggested": wb.suggested,
            "new_facts": len(new_keys),
        },
    )
    return Stored(dossier, facts, wb, new_keys)


# --- presentation --------------------------------------------------------------------------------


async def _stage_keys(db: AsyncSession, ws: WorkspaceContext, investor_id: UUID) -> list[str]:
    rows = await db.scalars(
        select(RoundStage.key)
        .join(RoundParticipant, RoundParticipant.stage_id == RoundStage.id)
        .join(Round, Round.id == RoundParticipant.round_id)
        .where(
            RoundParticipant.workspace_id == ws.workspace_id,
            RoundParticipant.investor_id == investor_id,
            Round.status == "open",
        )
    )
    return list(rows)


def _usd(micros: int | None) -> float | None:
    return None if micros is None else round(micros / 1_000_000, 6)


def author_of(d: Dossier) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": d.author_kind, "label": d.author_label}
    if d.author_kind == "agent":
        out["by"] = f"by {d.author_label}"
    return out


async def view(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor: Investor,
    *,
    now: datetime,
    version: int | None = None,
) -> dict[str, Any]:
    """``GET /v1/investors/{id}/dossier``: the dossier with its facts and cited sources."""
    d = await latest(db, ws, investor.id, version=version)
    if d is None:
        raise NoDossier(
            f"{investor.name} has no dossier yet. Run research with "
            + how(ws, "research_investor", f"POST /v1/investors/{investor.id}/research")
            + ", or let an agent submit one with "
            + how(ws, "save_dossier", f"POST /v1/investors/{investor.id}/dossier")
            + ".",
            details={"investor_id": str(investor.id)},
        )
    df = await facts_of(db, d)
    facts = list(df.facts) if df else []
    cited = {s for f in facts for s in f.get("source_ids", [])}
    src_rows = (
        list(
            await db.scalars(
                select(ResearchSource).where(
                    ResearchSource.workspace_id == ws.workspace_id,
                    ResearchSource.id.in_([UUID(s) for s in cited]),
                )
            )
        )
        if cited
        else []
    )
    previous = (
        await db.scalar(
            select(Dossier.created_at).where(
                Dossier.workspace_id == ws.workspace_id, Dossier.id == d.previous_id
            )
        )
        if d.previous_id
        else None
    )
    pending = await db.scalars(
        select(FieldSuggestion)
        .where(
            FieldSuggestion.workspace_id == ws.workspace_id,
            FieldSuggestion.investor_id == investor.id,
            FieldSuggestion.status == SuggestionStatus.PENDING.value,
        )
        .order_by(FieldSuggestion.created_at)
    )
    run_cost = None
    if d.run_id is not None:
        run_cost = await db.scalar(
            select(ResearchRun.cost_micros).where(
                ResearchRun.workspace_id == ws.workspace_id, ResearchRun.id == d.run_id
            )
        )
    age_days = (now - d.created_at).days
    stage_keys = await _stage_keys(db, ws, investor.id)
    return {
        "dossier": {
            "id": d.id,
            "investor_id": d.investor_id,
            "version": d.version,
            "schema_version": d.schema_version,
            "verdict": d.verdict,
            "analysis": d.analysis,
            "unverified": d.unverified,
            "new_fact_keys": list(d.new_fact_keys or []),
            "round_id": d.round_id,
            "run_id": d.run_id,
            "created_at": d.created_at,
            "as_of": df.as_of if df else None,
            "identity": df.identity if df else {},
            "cost_usd": _usd(run_cost),
        },
        "facts": [{k: v for k, v in f.items() if k not in ("fid", "loose")} for f in facts],
        "sources": [
            {
                "id": s.id,
                "url": s.url,
                "domain": s.domain,
                "title": s.title,
                "published_at": s.published_at,
                "matched_anchor": s.matched_anchor,
            }
            for s in sorted(src_rows, key=lambda s: (s.created_at, str(s.id)))
        ],
        "author": author_of(d),
        "new_since": previous,
        "stale": is_stale(d.created_at, now),
        "age_days": age_days,
        "refresh_offer": any(meeting_refresh_offer(k, d.created_at, now) for k in stage_keys),
        "suggestions": [suggestion_dict(s) for s in pending],
    }


async def versions(
    db: AsyncSession, ws: WorkspaceContext, investor_id: UUID
) -> list[dict[str, Any]]:
    rows = await db.scalars(
        select(Dossier)
        .where(Dossier.workspace_id == ws.workspace_id, Dossier.investor_id == investor_id)
        .order_by(Dossier.version.desc())
    )
    return [
        {
            "id": d.id,
            "version": d.version,
            "verdict": d.verdict,
            "created_at": d.created_at,
            "author": author_of(d),
        }
        for d in rows
    ]


def sections(view_: Mapping[str, Any], wanted: str = "all") -> dict[str, Any]:
    """The fixed layout (R5) with ``[s3]``-style source refs, for MCP ``get_dossier``."""
    facts = view_["facts"]
    src_index = {str(s["id"]): i for i, s in enumerate(view_["sources"], start=1)}
    by_key = {f["key"]: f for f in facts}

    def ref(ids: Sequence[str]) -> str:
        nums = [f"[s{src_index[s]}]" for s in ids if s in src_index]
        return " ".join(nums)

    def fact_line(f: Mapping[str, Any]) -> str:
        date = f" ({f['date']})" if f.get("date") else ""
        return f"{f['text']}{date} {ref(f['source_ids'])}".strip()

    def claim_line(c: Mapping[str, Any]) -> str:
        ids = [s for k in c.get("fact_keys", []) if k in by_key for s in by_key[k]["source_ids"]]
        return f"{c['text']} {ref(list(dict.fromkeys(ids)))}".strip()

    analysis = view_["dossier"]["analysis"]
    fit = analysis.get("fit", {})
    out: dict[str, Any] = {
        "brief": analysis.get("brief"),
        "fit": [claim_line(fit[k]) for k in ("stage", "sector", "check", "deploying") if fit.get(k)]
        + [claim_line(c) for c in fit.get("conflicts", [])]
        + [fact_line(f) for f in facts if f["section"] in ("fit", "profile")],
        "activity": [fact_line(f) for f in facts if f["section"] == "activity"],
        "thesis": [fact_line(f) for f in facts if f["section"] == "thesis"],
        "ways_in": [claim_line(c) for c in analysis.get("ways_in", [])],
        "talking_points": [claim_line(c) for c in analysis.get("talking_points", [])],
        "red_flags": [fact_line(f) for f in facts if f["section"] == "red_flags"],
    }
    if wanted != "all":
        return (
            {"brief": out["brief"], wanted: out[wanted]}
            if wanted != "brief"
            else {"brief": out["brief"]}
        )
    return out
