"""CSV and JSON exports (SPEC §8.3). Owner: Import-Export+Ops (IE).

Read-only. Every query filters by the caller's ``ws.workspace_id`` (never an id from input),
so an export can only ever contain the caller's own workspace.

- :func:`export_round`: a round as CSV (round-trips through import) or JSON
  (``raisebook.round``), optionally with each investor's timeline.
- :func:`export_investors_csv`: every contact, with a ``rounds`` summary column.
- :func:`export_workspace_json`: everything (``raisebook.export``). API keys, sessions and
  tokens are never exported.

CSV cells are formula-guarded (``services.csv_io.write_csv``).
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.config import get_settings
from raisebook.core.errors import not_found
from raisebook.models.activity import Activity
from raisebook.models.enums import LOGGABLE_ACTIVITY_KINDS
from raisebook.models.imports import ImportRun
from raisebook.models.investor import Investor
from raisebook.models.meeting import Meeting, MeetingGuest
from raisebook.models.research import (
    Dossier,
    DossierFacts,
    FieldSuggestion,
    InvestorIdentity,
    ResearchSource,
)
from raisebook.models.round import Round, RoundParticipant, RoundStage
from raisebook.models.user import User
from raisebook.models.workspace import Membership, Workspace
from raisebook.services import ai_settings, company_profile
from raisebook.services.csv_io import write_csv
from raisebook.services.users import FORMER_MEMBER, display_names

ROUND_CSV_COLUMNS: tuple[str, ...] = (
    "investor_id",
    "name",
    "firm",
    "title",
    "type",
    "email",
    "linkedin_url",
    "website_url",
    "x_url",
    "location",
    "check_min",
    "check_max",
    "check_note",
    "stage_focus",
    "industries",
    "tags",
    "source",
    "warm_intro_by",
    "stage",
    "stage_label",
    "fit",
    "priority",
    "probability",
    "amount_soft",
    "amount_committed",
    "committed_on",
    "follow_up_on",
    "follow_up_note",
    "next_step",
    "owner_email",
    "last_activity_at",
    "notes",
)
CONTACT_COLUMNS: tuple[str, ...] = (
    "name",
    "firm",
    "title",
    "type",
    "email",
    "linkedin_url",
    "website_url",
    "x_url",
    "location",
    "check_min",
    "check_max",
    "check_note",
    "stage_focus",
    "industries",
    "tags",
    "source",
    "warm_intro_by",
)
INVESTORS_CSV_COLUMNS: tuple[str, ...] = (
    "investor_id",
    *CONTACT_COLUMNS,
    "rounds",
    "notes",
    "created_at",
    "updated_at",
)
INVESTOR_FIELDS: tuple[str, ...] = (*CONTACT_COLUMNS, "notes")


@dataclass(frozen=True)
class ExportFile:
    filename: str
    media_type: str
    content: str
    row_count: int

    @property
    def size(self) -> int:
        return len(self.content.encode("utf-8"))


# --- small helpers -----------------------------------------------------------------------


def _ts(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _d(value: date | None) -> str | None:
    return value.isoformat() if value is not None else None


def priority_of(fit: int) -> str:
    return {5: "hot", 4: "warm", 3: "maybe"}.get(fit, "low")


def _stamp(ws: WorkspaceContext, now: datetime) -> str:
    return ws.today(now).strftime("%Y%m%d")


def _stage_dict(st: RoundStage, count: int | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "key": st.key,
        "label": st.label,
        "color": st.color,
        "kind": st.kind,
        "position": st.position,
    }
    if count is not None:
        out["count"] = count
    return out


def _investor_dict(inv: Investor) -> dict[str, Any]:
    out: dict[str, Any] = {"id": str(inv.id)}
    for f in INVESTOR_FIELDS:
        v = getattr(inv, f)
        out[f] = list(v) if isinstance(v, list) else (str(v) if f == "email" and v else v)
    out["created_at"] = _ts(inv.created_at)
    out["updated_at"] = _ts(inv.updated_at)
    return out


async def _stages_by_round(
    db: AsyncSession, ws: WorkspaceContext, round_ids: list[UUID] | None = None
) -> dict[UUID, list[RoundStage]]:
    stmt = select(RoundStage).where(RoundStage.workspace_id == ws.workspace_id)
    if round_ids is not None:
        stmt = stmt.where(RoundStage.round_id.in_(round_ids))
    out: dict[UUID, list[RoundStage]] = defaultdict(list)
    for st in await db.scalars(stmt.order_by(RoundStage.round_id, RoundStage.position)):
        out[st.round_id].append(st)
    return out


async def _round_dicts(
    db: AsyncSession, ws: WorkspaceContext, rounds: list[Round]
) -> list[dict[str, Any]]:
    if not rounds:
        return []
    ids = [r.id for r in rounds]
    stages = await _stages_by_round(db, ws, ids)
    counts: dict[UUID, int] = {}
    for stage_id, n in (
        await db.execute(
            select(RoundParticipant.stage_id, func.count())
            .where(
                RoundParticipant.workspace_id == ws.workspace_id,
                RoundParticipant.round_id.in_(ids),
            )
            .group_by(RoundParticipant.stage_id)
        )
    ).tuples():
        counts[stage_id] = int(n)
    committed: dict[UUID, int] = {}
    for round_id, total in (
        await db.execute(
            select(
                RoundParticipant.round_id,
                func.coalesce(func.sum(RoundParticipant.amount_committed), 0),
            )
            .join(
                RoundStage,
                (RoundStage.id == RoundParticipant.stage_id)
                & (RoundStage.round_id == RoundParticipant.round_id),
            )
            .where(
                RoundParticipant.workspace_id == ws.workspace_id,
                RoundParticipant.round_id.in_(ids),
                RoundStage.kind == "won",
            )
            .group_by(RoundParticipant.round_id)
        )
    ).tuples():
        committed[round_id] = int(total or 0)
    out = []
    for r in rounds:
        sts = stages.get(r.id, [])
        out.append(
            {
                "id": str(r.id),
                "slug": str(r.slug),
                "name": r.name,
                "status": r.status,
                "instrument": r.instrument,
                "currency": r.currency,
                "target_amount": r.target_amount,
                "valuation_cap": r.valuation_cap,
                "pre_money_valuation": r.pre_money_valuation,
                "target_close_on": _d(r.target_close_on),
                "closed_on": _d(r.closed_on),
                "notes": r.notes,
                "stages": [_stage_dict(s, counts.get(s.id, 0)) for s in sts],
                "committed_amount": committed.get(r.id, 0),
                "participant_count": sum(counts.get(s.id, 0) for s in sts),
                "created_at": _ts(r.created_at),
                "updated_at": _ts(r.updated_at),
            }
        )
    return out


async def _member_emails(db: AsyncSession, ws: WorkspaceContext) -> dict[UUID, str]:
    rows = await db.execute(
        select(User.id, User.email)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.workspace_id == ws.workspace_id)
    )
    return {uid: str(email) for uid, email in rows.tuples()}


async def _activity_dicts(
    db: AsyncSession, ws: WorkspaceContext, activities: list[Activity]
) -> list[dict[str, Any]]:
    if not activities:
        return []
    names = await display_names(db, (a.actor_user_id for a in activities))
    inv_ids = {a.investor_id for a in activities}
    inv_names = {
        i: n
        for i, n in (
            await db.execute(
                select(Investor.id, Investor.name).where(
                    Investor.workspace_id == ws.workspace_id, Investor.id.in_(inv_ids)
                )
            )
        ).tuples()
    }
    round_ids = {a.round_id for a in activities if a.round_id is not None}
    slugs: dict[UUID, str] = {}
    if round_ids:
        slugs = {
            i: str(s)
            for i, s in (
                await db.execute(
                    select(Round.id, Round.slug).where(
                        Round.workspace_id == ws.workspace_id, Round.id.in_(round_ids)
                    )
                )
            ).tuples()
        }
    loggable = {k.value for k in LOGGABLE_ACTIVITY_KINDS}
    out = []
    for a in activities:
        if a.actor_type == "user":
            label = names.get(a.actor_user_id, FORMER_MEMBER) if a.actor_user_id else FORMER_MEMBER
        elif a.actor_type == "system":
            label = "Raisebook"
        else:
            label = a.actor_label or "agent"
        actor: dict[str, Any] = {"type": a.actor_type, "label": label, "via": a.via}
        if a.actor_user_id:
            actor["user_id"] = str(a.actor_user_id)
        if a.api_key_id:
            actor["api_key_id"] = str(a.api_key_id)
        if a.agent_model:
            actor["agent_model"] = a.agent_model
        out.append(
            {
                "id": str(a.id),
                "investor_id": str(a.investor_id),
                "investor_name": inv_names.get(a.investor_id, ""),
                "round_id": str(a.round_id) if a.round_id else None,
                "round_slug": slugs.get(a.round_id) if a.round_id else None,
                "kind": a.kind,
                "occurred_at": _ts(a.occurred_at),
                "body": a.body,
                "data": a.data,
                "actor": actor,
                "created_at": _ts(a.created_at),
                "deletable": a.kind in loggable,
            }
        )
    return out


async def get_round(db: AsyncSession, ws: WorkspaceContext, round_id: UUID) -> Round:
    rnd = await db.scalar(
        select(Round).where(Round.workspace_id == ws.workspace_id, Round.id == round_id)
    )
    if rnd is None:
        raise not_found("Round")
    return rnd


# --- round export ------------------------------------------------------------------------


@dataclass(frozen=True)
class _RoundRow:
    part: RoundParticipant
    inv: Investor
    stage: RoundStage


async def _round_rows(db: AsyncSession, ws: WorkspaceContext, rnd: Round) -> list[_RoundRow]:
    rows = await db.execute(
        select(RoundParticipant, Investor, RoundStage)
        .join(
            Investor,
            (Investor.id == RoundParticipant.investor_id)
            & (Investor.workspace_id == RoundParticipant.workspace_id),
        )
        .join(
            RoundStage,
            (RoundStage.id == RoundParticipant.stage_id)
            & (RoundStage.round_id == RoundParticipant.round_id),
        )
        .where(
            RoundParticipant.workspace_id == ws.workspace_id, RoundParticipant.round_id == rnd.id
        )
        .order_by(RoundStage.position, RoundParticipant.fit.desc(), Investor.name, Investor.id)
    )
    return [_RoundRow(p, i, s) for p, i, s in rows.tuples()]


async def export_round(
    db: AsyncSession,
    ws: WorkspaceContext,
    rnd: Round,
    *,
    fmt: str,
    now: datetime,
    include_activities: bool = False,
) -> ExportFile:
    """``GET /v1/rounds/{round}/export`` and MCP ``export_round``. ``rnd`` must already be
    resolved within ``ws`` (``core.refs.resolve_round``)."""
    if rnd.workspace_id != ws.workspace_id:  # defense in depth; resolve_round already checks
        raise not_found("Round")
    rows = await _round_rows(db, ws, rnd)
    emails = await _member_emails(db, ws)
    base = f"raisebook-{ws.slug}-{rnd.slug}-{_stamp(ws, now)}"
    if fmt == "csv":
        content = write_csv(
            ROUND_CSV_COLUMNS,
            (
                [
                    r.inv.id,
                    r.inv.name,
                    r.inv.firm,
                    r.inv.title,
                    r.inv.type,
                    r.inv.email,
                    r.inv.linkedin_url,
                    r.inv.website_url,
                    r.inv.x_url,
                    r.inv.location,
                    r.inv.check_min,
                    r.inv.check_max,
                    r.inv.check_note,
                    r.inv.stage_focus,
                    r.inv.industries,
                    r.inv.tags,
                    r.inv.source,
                    r.inv.warm_intro_by,
                    r.stage.key,
                    r.stage.label,
                    r.part.fit,
                    priority_of(r.part.fit),
                    r.part.probability,
                    r.part.amount_soft,
                    r.part.amount_committed,
                    _d(r.part.committed_on),
                    _d(r.part.follow_up_on),
                    r.part.follow_up_note,
                    r.part.next_step,
                    emails.get(r.part.owner_user_id) if r.part.owner_user_id else None,
                    _ts(r.part.last_activity_at),
                    r.inv.notes,
                ]
                for r in rows
            ),
        )
        return ExportFile(f"{base}.csv", "text/csv; charset=utf-8", content, len(rows))

    timelines: dict[UUID, list[dict[str, Any]]] = defaultdict(list)
    if include_activities and rows:
        acts = list(
            await db.scalars(
                select(Activity)
                .where(
                    Activity.workspace_id == ws.workspace_id,
                    Activity.investor_id.in_([r.inv.id for r in rows]),
                )
                .order_by(Activity.occurred_at.desc(), Activity.id)
            )
        )
        for a in await _activity_dicts(db, ws, acts):
            timelines[UUID(a["investor_id"])].append(a)
    round_dict = (await _round_dicts(db, ws, [rnd]))[0]
    participants = []
    for r in rows:
        item: dict[str, Any] = {
            "investor": _investor_dict(r.inv),
            "stage": _stage_dict(r.stage),
            "fit": r.part.fit,
            "priority": priority_of(r.part.fit),
            "probability": r.part.probability,
            "amount_soft": r.part.amount_soft,
            "amount_committed": r.part.amount_committed,
            "committed_on": _d(r.part.committed_on),
            "follow_up_on": _d(r.part.follow_up_on),
            "follow_up_note": r.part.follow_up_note,
            "next_step": r.part.next_step,
            "owner_email": emails.get(r.part.owner_user_id) if r.part.owner_user_id else None,
            "stage_changed_at": _ts(r.part.stage_changed_at),
            "last_activity_at": _ts(r.part.last_activity_at),
            "created_at": _ts(r.part.created_at),
            "updated_at": _ts(r.part.updated_at),
        }
        if include_activities:
            item["timeline"] = timelines.get(r.inv.id, [])
        participants.append(item)
    doc = {
        "format": "raisebook.round",
        "version": 1,
        "exported_at": _ts(now),
        "round": round_dict,
        "participants": participants,
    }
    return ExportFile(f"{base}.json", "application/json", _json(doc), len(rows))


def _json(doc: dict[str, Any]) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=2, default=str) + "\n"


# --- investors CSV -----------------------------------------------------------------------


async def export_investors_csv(
    db: AsyncSession, ws: WorkspaceContext, *, now: datetime, ids: list[UUID] | None = None
) -> ExportFile:
    """Every contact (or only ``ids``, for the directory's bulk "Export CSV"), with a
    ``rounds`` column such as ``Seed: Meeting; Pre-seed 2025: Passed``."""
    stmt = select(Investor).where(Investor.workspace_id == ws.workspace_id)
    if ids is not None:
        stmt = stmt.where(Investor.id.in_(ids))
    investors = list(await db.scalars(stmt.order_by(Investor.name, Investor.id)))
    rounds_of: dict[UUID, list[str]] = defaultdict(list)
    rows = await db.execute(
        select(RoundParticipant.investor_id, Round.name, RoundStage.label)
        .join(
            Round,
            (Round.id == RoundParticipant.round_id) & (Round.workspace_id == ws.workspace_id),
        )
        .join(
            RoundStage,
            (RoundStage.id == RoundParticipant.stage_id)
            & (RoundStage.round_id == RoundParticipant.round_id),
        )
        .where(RoundParticipant.workspace_id == ws.workspace_id)
        .order_by(Round.created_at, Round.name)
    )
    for inv_id, round_name, stage_label in rows.tuples():
        rounds_of[inv_id].append(f"{round_name}: {stage_label}")
    content = write_csv(
        INVESTORS_CSV_COLUMNS,
        (
            [
                inv.id,
                *(getattr(inv, c) for c in CONTACT_COLUMNS),
                rounds_of.get(inv.id, []),
                inv.notes,
                _ts(inv.created_at),
                _ts(inv.updated_at),
            ]
            for inv in investors
        ),
    )
    name = f"raisebook-{ws.slug}-investors-{_stamp(ws, now)}.csv"
    return ExportFile(name, "text/csv; charset=utf-8", content, len(investors))


# --- workspace JSON ----------------------------------------------------------------------


async def export_workspace_json(
    db: AsyncSession, ws: WorkspaceContext, *, now: datetime
) -> ExportFile:
    """``GET /v1/export?format=json``: the whole workspace, never keys, sessions or tokens."""
    wid = ws.workspace_id
    workspace = await db.scalar(select(Workspace).where(Workspace.id == wid))
    if workspace is None:
        raise not_found("Workspace")
    members = [
        {"email": str(email), "name": name, "role": role}
        for email, name, role in (
            await db.execute(
                select(User.email, User.name, Membership.role)
                .join(Membership, Membership.user_id == User.id)
                .where(Membership.workspace_id == wid)
                .order_by(Membership.created_at, User.email)
            )
        ).tuples()
    ]
    rounds = list(
        await db.scalars(
            select(Round).where(Round.workspace_id == wid).order_by(Round.created_at, Round.id)
        )
    )
    stage_keys = {st.id: st.key for sts in (await _stages_by_round(db, ws)).values() for st in sts}
    investors = list(
        await db.scalars(
            select(Investor)
            .where(Investor.workspace_id == wid)
            .order_by(Investor.created_at, Investor.id)
        )
    )
    emails = await _member_emails(db, ws)
    participants = [
        {
            "round_id": str(p.round_id),
            "investor_id": str(p.investor_id),
            "stage_key": stage_keys.get(p.stage_id),
            "fit": p.fit,
            "probability": p.probability,
            "amount_soft": p.amount_soft,
            "amount_committed": p.amount_committed,
            "committed_on": _d(p.committed_on),
            "follow_up_on": _d(p.follow_up_on),
            "follow_up_note": p.follow_up_note,
            "next_step": p.next_step,
            "owner_email": emails.get(p.owner_user_id) if p.owner_user_id else None,
            "stage_changed_at": _ts(p.stage_changed_at),
            "created_at": _ts(p.created_at),
        }
        for p in await db.scalars(
            select(RoundParticipant)
            .where(RoundParticipant.workspace_id == wid)
            .order_by(RoundParticipant.created_at, RoundParticipant.id)
        )
    ]
    activities = list(
        await db.scalars(
            select(Activity)
            .where(Activity.workspace_id == wid)
            .order_by(Activity.occurred_at, Activity.id)
        )
    )
    runs = list(
        await db.scalars(
            select(ImportRun).where(ImportRun.workspace_id == wid).order_by(ImportRun.created_at)
        )
    )
    meetings = await _meeting_dicts(db, ws)
    doc = {
        "format": "raisebook.export",
        "version": 1,
        "exported_at": _ts(now),
        "workspace": {
            "id": str(workspace.id),
            "slug": str(workspace.slug),
            "name": workspace.name,
            "is_sandbox": workspace.is_sandbox,
            "default_currency": workspace.default_currency,
            "timezone": workspace.timezone,
            "created_at": _ts(workspace.created_at),
        },
        "members": members,
        "rounds": await _round_dicts(db, ws, rounds),
        "investors": [_investor_dict(i) for i in investors],
        "participants": participants,
        "activities": await _activity_dicts(db, ws, activities),
        "meetings": meetings,
        "import_runs": [
            {
                "id": str(r.id),
                "format": r.format,
                "filename": r.filename,
                "round_id": str(r.round_id) if r.round_id else None,
                "actor_type": r.actor_type,
                "actor_label": r.actor_label,
                "options": r.options,
                "counts": r.counts,
                "created_at": _ts(r.created_at),
            }
            for r in runs
        ],
    }
    if get_settings().research_enabled:
        doc["research"] = await _research_dict(db, ws)
    name = f"raisebook-{ws.slug}-{_stamp(ws, now)}.json"
    return ExportFile(name, "application/json", _json(doc), len(investors))


async def _meeting_dicts(db: AsyncSession, ws: WorkspaceContext) -> list[dict[str, Any]]:
    """Every meeting (all statuses) with its guests and who scheduled it."""
    rows = list(
        await db.scalars(
            select(Meeting)
            .where(Meeting.workspace_id == ws.workspace_id)
            .order_by(Meeting.starts_at, Meeting.id)
        )
    )
    if not rows:
        return []
    guests: dict[UUID, list[str]] = defaultdict(list)
    for mid, iid in (
        await db.execute(
            select(MeetingGuest.meeting_id, MeetingGuest.investor_id).where(
                MeetingGuest.workspace_id == ws.workspace_id
            )
        )
    ).tuples():
        guests[mid].append(str(iid))
    names = await display_names(db, (m.actor_user_id for m in rows))
    out: list[dict[str, Any]] = []
    for m in rows:
        if m.actor_type == "user":
            by = names.get(m.actor_user_id, FORMER_MEMBER) if m.actor_user_id else FORMER_MEMBER
        else:
            by = m.actor_label or "raisebook"
        out.append(
            {
                "id": str(m.id),
                "investor_id": str(m.investor_id),
                "guest_ids": guests.get(m.id, []),
                "round_id": str(m.round_id) if m.round_id else None,
                "title": m.title,
                "starts_at": _ts(m.starts_at),
                "ends_at": _ts(m.ends_at),
                "timezone": m.timezone,
                "location": m.location,
                "video_url": m.video_url,
                "agenda": m.agenda,
                "status": m.status,
                "outcome": m.outcome,
                "outcome_activity_id": str(m.outcome_activity_id)
                if m.outcome_activity_id
                else None,
                "source": m.source,
                "created_by": {"type": m.actor_type, "label": by, "via": m.via},
                "completed_at": _ts(m.completed_at),
                "cancelled_at": _ts(m.cancelled_at),
                "created_at": _ts(m.created_at),
                "updated_at": _ts(m.updated_at),
            }
        )
    return out


async def _research_dict(db: AsyncSession, ws: WorkspaceContext) -> dict[str, Any]:
    """Research settings, the company profile, identities and each investor's latest dossier
    with its facts, cited sources and suggestions. Never key material, not even its last 4."""
    settings = await ai_settings.get_row(db, ws.workspace_id)
    identities = list(
        await db.scalars(
            select(InvestorIdentity)
            .where(InvestorIdentity.workspace_id == ws.workspace_id)
            .order_by(InvestorIdentity.investor_id)
        )
    )
    latest = list(
        await db.scalars(
            select(Dossier)
            .where(Dossier.workspace_id == ws.workspace_id)
            .distinct(Dossier.investor_id)
            .order_by(Dossier.investor_id, Dossier.version.desc())
        )
    )
    facts = (
        {
            f.dossier_id: f
            for f in await db.scalars(
                select(DossierFacts).where(
                    DossierFacts.workspace_id == ws.workspace_id,
                    DossierFacts.dossier_id.in_([d.id for d in latest]),
                )
            )
        }
        if latest
        else {}
    )
    cited = {
        UUID(s) for f in facts.values() for fact in f.facts for s in fact.get("source_ids", [])
    }
    sources = (
        list(
            await db.scalars(
                select(ResearchSource).where(
                    ResearchSource.workspace_id == ws.workspace_id, ResearchSource.id.in_(cited)
                )
            )
        )
        if cited
        else []
    )
    suggestions = list(
        await db.scalars(
            select(FieldSuggestion)
            .where(FieldSuggestion.workspace_id == ws.workspace_id)
            .order_by(FieldSuggestion.created_at)
        )
    )
    dossiers_out = []
    for d in latest:
        f = facts.get(d.id)
        dossiers_out.append(
            {
                "id": str(d.id),
                "investor_id": str(d.investor_id),
                "version": d.version,
                "verdict": d.verdict,
                "author": {"kind": d.author_kind, "label": d.author_label},
                "created_at": _ts(d.created_at),
                "analysis": d.analysis,
                "unverified": d.unverified,
                "facts": [
                    {k: v for k, v in fact.items() if k not in ("fid", "loose", "notes")}
                    for fact in (f.facts if f else [])
                ],
            }
        )
    research_rows = {
        "identities": [
            {
                "investor_id": str(i.investor_id),
                "status": i.status,
                "source": i.source,
                "linkedin_url": i.linkedin_url,
                "firm": i.firm,
                "firm_website": i.firm_website,
                "title": i.title,
                "confidence": float(i.confidence) if i.confidence is not None else None,
            }
            for i in identities
        ],
        "dossiers": dossiers_out,
        "sources": [
            {
                "id": str(s.id),
                "investor_id": str(s.investor_id),
                "url": s.url,
                "title": s.title,
                "published_at": s.published_at.isoformat() if s.published_at else None,
            }
            for s in sources
        ],
        "suggestions": [
            {
                "investor_id": str(s.investor_id),
                "field": s.field,
                "current_value": s.current_value,
                "suggested_value": s.suggested_value,
                "status": s.status,
            }
            for s in suggestions
        ],
    }
    return {
        **research_rows,
        "company_profile": company_profile.export_dict(await company_profile.get_profile(db, ws)),
        "ai_settings": None
        if settings is None
        else {
            "preset": settings.preset,
            "identity_model": settings.identity_model,
            "search_model": settings.search_model,
            "writer_model": settings.writer_model,
            "monthly_cap_usd": settings.monthly_cap_micros / 1_000_000,
            "use_notes_in_research": bool(settings.use_notes_in_research),
        },
    }
