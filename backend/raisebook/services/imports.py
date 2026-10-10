"""CSV and prototype-JSON import: mapping, preview, dedupe, commit (SPEC §5.8, §8.2).

Owner: Import-Export+Ops (IE).

Flow: :func:`build` turns the request into records (CSV rows through the column mapping,
or prototype JSON documents), :func:`plan` normalizes each record with
``services.normalize``, matches it against the workspace and against earlier rows of the
same file (email → LinkedIn → name+firm), and decides the row action (``create``,
``update``, ``skip``, ``error``) and the round participation. :func:`preview` returns that
plan without writing. :func:`commit` replays it in one transaction through the feature
services (``services.investors``, ``services.participants``, ``services.activities``),
never raw writes, with one ``import_runs`` row and ``via=import`` on every activity.

All reads filter by ``ws.workspace_id``; matching never looks outside the caller's
workspace.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, time
from typing import Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core import refs
from raisebook.core.errors import APIError, ImportInvalid, LimitReached, ValidationFailed
from raisebook.models.enums import Via
from raisebook.models.imports import ImportRun
from raisebook.models.investor import Investor
from raisebook.models.round import DEFAULT_STAGES, Round, RoundParticipant, RoundStage
from raisebook.models.user import User
from raisebook.models.workspace import Membership
from raisebook.schemas.data import (
    ImportPreview,
    ImportRequest,
    ImportResult,
    ImportRow,
    ImportRunOut,
    PreviewCounts,
    ResultCounts,
    ResultError,
    RowError,
    RowMatch,
    RowParticipant,
)
from raisebook.services import csv_io
from raisebook.services.normalize import (
    ARRAY_LIMITS,
    INVESTOR_FIELDS,
    TEXT_LIMITS,
    clean_text,
    dedupe_keys,
    linkedin_key,
    merge_lists,
    norm,
    normalize_investor_input,
    parse_date_loose,
    parse_investor_type,
    parse_money,
)
from raisebook.services.users import FORMER_MEMBER, display_names
from raisebook.services.workspaces import LIMITS

PREVIEW_ROWS = 200
MAX_RECORDS = csv_io.MAX_ROWS
LIST_FIELDS = frozenset(ARRAY_LIMITS)
PARTICIPANT_FIELDS: tuple[str, ...] = (
    "fit",
    "probability",
    "amount_soft",
    "amount_committed",
    "follow_up_on",
    "follow_up_note",
    "next_step",
    "owner_user_id",
)
Mode = Literal["skip", "fill_empty", "update"]


# --- records ------------------------------------------------------------------------------


@dataclass
class NoteIn:
    body: str
    on: date | None  # prototype log date (12:00 local); None = now


@dataclass
class ParticipationIn:
    round: Round
    cells: dict[str, Any]  # round field → raw value (CSV text or prototype value)
    notes: list[NoteIn] = field(default_factory=list)


@dataclass
class RecordIn:
    row: int
    contact: dict[str, Any]  # investor field → raw value (empty cells are absent)
    participations: list[ParticipationIn] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    errors: list[RowError] = field(default_factory=list)


@dataclass
class Built:
    format: str
    columns: list[str]
    mapping: dict[str, str | None]
    samples: dict[str, list[str]]
    records: list[RecordIn]
    rounds: list[Round]
    warnings: list[str]
    default_stage: str | None


# --- context ------------------------------------------------------------------------------


@dataclass
class Ctx:
    stages: dict[UUID, list[RoundStage]]
    members: dict[str, UUID]  # lowercased email → user id

    def stage(self, rnd: Round, ref: str | None) -> RoundStage | None:
        if ref is None:
            return None
        key = norm(str(ref))
        compact = key.replace(" ", "")
        for st in self.stages.get(rnd.id, []):
            if key in (norm(st.key), norm(st.label)) or compact == norm(st.key).replace(" ", ""):
                return st
        return None

    def first_stage(self, rnd: Round) -> RoundStage:
        return self.stages[rnd.id][0]


async def _load_ctx(db: AsyncSession, ws: WorkspaceContext, rounds: Sequence[Round]) -> Ctx:
    stages: dict[UUID, list[RoundStage]] = defaultdict(list)
    if rounds:
        rows = await db.scalars(
            select(RoundStage)
            .where(
                RoundStage.workspace_id == ws.workspace_id,
                RoundStage.round_id.in_([r.id for r in rounds]),
            )
            .order_by(RoundStage.round_id, RoundStage.position)
        )
        for st in rows:
            stages[st.round_id].append(st)
    members = {
        str(email).lower(): uid
        for uid, email in (
            await db.execute(
                select(User.id, User.email)
                .join(Membership, Membership.user_id == User.id)
                .where(Membership.workspace_id == ws.workspace_id)
            )
        ).tuples()
    }
    return Ctx(stages=dict(stages), members=members)


# --- building records ---------------------------------------------------------------------


async def build(db: AsyncSession, ws: WorkspaceContext, req: ImportRequest) -> Built:
    if req.format == "prototype_json":
        return await _build_prototype(db, ws, req)
    return await _build_csv(db, ws, req)


async def _build_csv(db: AsyncSession, ws: WorkspaceContext, req: ImportRequest) -> Built:
    parsed = csv_io.parse_csv(req.content)
    rnd = await refs.resolve_round(db, ws, req.round, required=False)
    warnings: list[str] = []
    if req.round_map:
        warnings.append("round_map applies to prototype JSON only and was ignored.")
    if rnd is not None:
        stage_rows = await db.scalars(
            select(RoundStage).where(
                RoundStage.workspace_id == ws.workspace_id, RoundStage.round_id == rnd.id
            )
        )
        names = [n for st in stage_rows for n in (st.key, st.label)]
    else:
        names = [n for st in DEFAULT_STAGES for n in (st.key, st.label)]
    if req.mapping is not None:
        mapping = csv_io.validate_mapping(parsed.columns, req.mapping)
    else:
        mapping = csv_io.auto_map(parsed.columns, parsed.rows, stage_names=names)
    mapped = {f for f in mapping.values() if f}
    if "name" not in mapped and not ({"first_name", "last_name"} & mapped):
        warnings.append(
            "No column is mapped to Name, so every row will fail. Map the column that holds "
            "the investor's name."
        )
    round_cols = [c for c, f in mapping.items() if f in csv_io.ROUND_FIELDS]
    if rnd is None and round_cols:
        warnings.append(
            f"Round columns ({', '.join(round_cols)}) are ignored because no round was chosen. "
            "Pick a round to import stages, fit, follow-ups and amounts."
        )
    samples: dict[str, list[str]] = {}
    for idx, col in enumerate(parsed.columns):
        vals = [r[idx].strip() for r in parsed.rows if r[idx].strip()][:3]
        samples[col] = [v[:120] for v in vals]

    records: list[RecordIn] = []
    for cells, line in zip(parsed.rows, parsed.line_numbers, strict=True):
        contact: dict[str, Any] = {}
        round_cells: dict[str, Any] = {}
        first = last = ""
        for col, value in zip(parsed.columns, cells, strict=True):
            fld = mapping.get(col)
            text = csv_io.unguard_cell(value).strip()
            if not fld or not text:
                continue  # empty cells never clear existing data
            if fld == "first_name":
                first = text
            elif fld == "last_name":
                last = text
            elif fld in csv_io.ROUND_FIELDS:
                round_cells[fld] = text
            else:
                contact[fld] = text
        if "name" not in contact and (first or last):
            contact["name"] = f"{first} {last}".strip()
        rec = RecordIn(row=line, contact=contact)
        if rnd is not None:
            rec.participations.append(ParticipationIn(round=rnd, cells=round_cells))
        records.append(rec)
    return Built(
        format="csv",
        columns=parsed.columns,
        mapping=dict(mapping),
        samples=samples,
        records=records,
        rounds=[rnd] if rnd is not None else [],
        warnings=warnings,
        default_stage=req.default_stage,
    )


def _proto_docs(content: str) -> list[Any]:
    try:
        data = json.loads(content.lstrip("\ufeff"))
    except json.JSONDecodeError as exc:
        raise ImportInvalid(
            f"The file is not valid JSON ({exc.msg} at line {exc.lineno})."
        ) from None
    if isinstance(data, dict) and isinstance(data.get("investors"), list):
        docs: list[Any] = data["investors"]
    elif isinstance(data, list):
        docs = data
    else:
        raise ImportInvalid(
            "Prototype JSON must be an array of investors or an object with an 'investors' array."
        )
    if len(docs) > MAX_RECORDS:
        raise ImportInvalid(
            f"The file has more than {MAX_RECORDS:,} investors. Split it and import the parts "
            "one after another.",
            details={"limit_rows": MAX_RECORDS},
        )
    return docs


def _s(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return ", ".join(_s(v) for v in value if v is not None)
    return str(value).strip()


def proto_source_keys(docs: Iterable[Any]) -> list[str]:
    """The round keys used under ``p`` across the documents, most frequent first."""
    seen: dict[str, int] = defaultdict(int)
    for doc in docs:
        p = doc.get("p") if isinstance(doc, dict) else None
        if isinstance(p, dict):
            for k, v in p.items():
                if isinstance(v, dict):
                    seen[str(k)] += 1
    return sorted(seen, key=lambda k: (-seen[k], k))


async def _build_prototype(db: AsyncSession, ws: WorkspaceContext, req: ImportRequest) -> Built:
    docs = _proto_docs(req.content)
    warnings: list[str] = []
    if req.mapping:
        warnings.append("mapping applies to CSV only and was ignored.")
    keys_found = proto_source_keys(docs)
    entries = list(req.round_map or [])
    if not entries and req.round is not None:
        if len(keys_found) == 1:
            from raisebook.schemas.data import RoundMapEntry

            entries = [RoundMapEntry(source_key=keys_found[0], round=req.round)]
        elif keys_found:
            raise ImportInvalid(
                "This file tracks several rounds under 'p' ("
                + ", ".join(keys_found)
                + "). Pass round_map to say which one goes to which Raisebook round.",
                details={"source_keys": keys_found},
            )
    if keys_found and not entries:
        warnings.append(
            "The file has round data under 'p' ("
            + ", ".join(keys_found)
            + "). Choose a round (round_map) to import stages, follow-ups and amounts; "
            "without one only the contacts are imported."
        )
    mapped_rounds: list[tuple[str, Round, str | None]] = []
    for e in entries:
        rnd = await refs.resolve_round(db, ws, e.round, required=True)
        assert rnd is not None
        mapped_rounds.append((e.source_key, rnd, e.fit_field))
        if e.source_key not in keys_found:
            warnings.append(f"No investor has round data under p.{e.source_key}.")

    records: list[RecordIn] = []
    for i, doc in enumerate(docs):
        rec = RecordIn(row=i + 1, contact={})
        records.append(rec)
        if not isinstance(doc, dict):
            rec.errors.append(RowError(field="row", message="Each investor must be a JSON object."))
            continue
        _proto_contact(doc, rec)
        pdata: dict[str, Any] = doc["p"] if isinstance(doc.get("p"), dict) else {}
        for source_key, rnd, fit_field in mapped_rounds:
            pr = pdata.get(source_key)
            if not isinstance(pr, dict):
                continue
            cells: dict[str, Any] = {}
            if _s(pr.get("stage")):
                cells["stage"] = _s(pr.get("stage"))
            if _s(pr.get("followUp")):
                cells["follow_up_on"] = _s(pr.get("followUp"))
            if pr.get("amount") not in (None, "", 0, "0"):
                cells["amount"] = pr.get("amount")
            if fit_field and doc.get(fit_field) not in (None, ""):
                cells["fit"] = _s(doc.get(fit_field))
            notes: list[NoteIn] = []
            if _s(pr.get("notes")):
                notes.append(NoteIn(_s(pr.get("notes")), None))
            log = pr.get("log")
            if isinstance(log, list):
                for item in log:
                    if not isinstance(item, dict) or not _s(item.get("t")):
                        continue
                    d, _amb = parse_date_loose(_s(item.get("d")))
                    notes.append(NoteIn(_s(item.get("t")), d))
            rec.participations.append(ParticipationIn(round=rnd, cells=cells, notes=notes))
    return Built(
        format="prototype_json",
        columns=[],
        mapping={},
        samples={},
        records=records,
        rounds=[r for _, r, _ in mapped_rounds],
        warnings=warnings,
        default_stage=req.default_stage,
    )


def _proto_contact(doc: Mapping[str, Any], rec: RecordIn) -> None:
    c = rec.contact
    for src, dst in (
        ("name", "name"),
        ("firm", "firm"),
        ("title", "title"),
        ("location", "location"),
        ("email", "email"),
        ("website", "website_url"),
        ("x", "x_url"),
        ("check", "check_note"),
    ):
        if _s(doc.get(src)):
            c[dst] = _s(doc.get(src))
    raw_type = _s(doc.get("type"))
    if raw_type:
        try:
            c["type"] = parse_investor_type(raw_type)
        except ValidationFailed:
            c["type"] = "other"
            rec.warnings.append(f"Unknown investor type {raw_type!r}; imported as Other.")
    if _s(doc.get("industry")):
        c["industries"] = [_s(doc.get("industry"))]
    tags = doc.get("tags")
    if isinstance(tags, list):
        c["tags"] = [_s(t) for t in tags if _s(t)]
    elif _s(tags):
        c["tags"] = [t.strip() for t in _s(tags).split(",") if t.strip()]
    focus = doc.get("stageFocus")
    if isinstance(focus, list):
        c["stage_focus"] = [_s(t) for t in focus if _s(t)]
    elif _s(focus):
        c["stage_focus"] = _s(focus)
    li = _s(doc.get("linkedin"))
    if li:
        if "/search/" in li.lower():
            rec.warnings.append("The LinkedIn link is a search URL, not a profile; it was dropped.")
        else:
            c["linkedin_url"] = li
    paragraphs: list[str] = []
    for label, key in (("Summary", "summary"), ("Bio", "bio"), ("Research", "notes")):
        if _s(doc.get(key)):
            paragraphs.append(f"{label}: {_s(doc.get(key))}")
    if _s(doc.get("ig")):
        paragraphs.append(f"Instagram: {_s(doc.get('ig'))}")
    events, nxt, url = _s(doc.get("events")), _s(doc.get("nextEvent")), _s(doc.get("nextEventUrl"))
    if events or nxt:
        parts = []
        if events and events != "0":
            parts.append(events)
        if nxt:
            parts.append(f"next: {nxt}" + (f" ({url})" if url else ""))
        if parts:
            paragraphs.append("Events together: " + "; ".join(parts))
    if paragraphs:
        c["notes"] = "\n\n".join(paragraphs)


# --- planning -----------------------------------------------------------------------------


@dataclass
class Target:
    """An investor a row resolves to: an existing one, or one created by an earlier row."""

    fields: dict[str, Any]
    investor_id: UUID | None = None
    row: int | None = None
    # round id → participant field snapshot (stage_id + PARTICIPANT_FIELDS)
    rounds: dict[UUID, dict[str, Any]] = field(default_factory=dict)

    @property
    def name(self) -> str:
        return str(self.fields.get("name") or "")


@dataclass
class PlannedParticipation:
    round: Round
    add: bool
    stage: RoundStage | None  # stage for a new participant, or the stage to move to
    values: dict[str, Any]  # new participant: initial values; existing: changes
    notes: list[NoteIn]
    preview: RowParticipant


@dataclass
class PlannedRow:
    rec: RecordIn
    action: str
    clean: dict[str, Any]
    changes: dict[str, Any] = field(default_factory=dict)
    target: Target | None = None
    match: RowMatch | None = None
    participations: list[PlannedParticipation] = field(default_factory=list)


@dataclass
class Plan:
    built: Built
    rows: list[PlannedRow]
    mode: Mode
    source: str | None

    def counts(self) -> PreviewCounts:
        c = PreviewCounts()
        for r in self.rows:
            setattr(c, r.action, getattr(c, r.action) + 1)
            if r.action != "error":
                c.add_to_round += sum(1 for p in r.participations if p.add)
        return c


def _empty(value: Any) -> bool:
    return value is None or value == "" or value == []


def _field_of(exc: ValidationFailed, default: str) -> str:
    try:
        loc = exc.details[0]["loc"]
        return str(loc[-1])
    except (TypeError, KeyError, IndexError):
        return default


def _normalize_contact(rec: RecordIn, source: str | None) -> dict[str, Any] | None:
    raw = dict(rec.contact)
    if source and not raw.get("source"):
        raw["source"] = source
    if not str(raw.get("name") or "").strip():
        rec.errors.append(RowError(field="name", message="The row has no name."))
        return None
    try:
        return normalize_investor_input(raw, partial=False)
    except ValidationFailed:
        pass
    good: dict[str, Any] = {}
    for f in INVESTOR_FIELDS:
        if f not in raw:
            continue
        try:
            normalize_investor_input({f: raw[f]}, partial=True)
            good[f] = raw[f]
        except ValidationFailed as exc:
            rec.errors.append(RowError(field=_field_of(exc, f), message=exc.message))
    if not rec.errors:  # a cross-field problem (check_min > check_max)
        try:
            return normalize_investor_input(good, partial=False)
        except ValidationFailed as exc:
            rec.errors.append(RowError(field=_field_of(exc, "row"), message=exc.message))
    return None


def _parse_participation(
    p: ParticipationIn, rec: RecordIn, ctx: Ctx, default_stage: str | None, ws_currency: str
) -> tuple[RoundStage | None, dict[str, Any], RowParticipant]:
    """Round cells → (stage or None, field values, preview). Errors go on ``rec``."""
    rnd = p.round
    cells = p.cells
    values: dict[str, Any] = {}
    pv = RowParticipant(round=str(rnd.slug))
    stage: RoundStage | None = None
    raw_stage = cells.get("stage")
    if raw_stage:
        stage = ctx.stage(rnd, str(raw_stage))
        if stage is None:
            fallback = ctx.stage(rnd, default_stage) or ctx.first_stage(rnd)
            rec.warnings.append(
                f"Stage {raw_stage!r} is not a stage of {rnd.name}; using {fallback.label}."
            )
            stage = fallback
        pv.stage = stage.key
    if "fit" in cells:
        try:
            values["fit"] = csv_io.parse_fit(str(cells["fit"]))
            pv.fit = values["fit"]
        except ValueError as exc:
            rec.errors.append(RowError(field="fit", message=str(exc)))
    if "probability" in cells:
        try:
            values["probability"] = csv_io.parse_probability(str(cells["probability"]))
            pv.probability = values["probability"]
        except ValueError as exc:
            rec.errors.append(RowError(field="probability", message=str(exc)))
    if "follow_up_on" in cells:
        d, ambiguous = parse_date_loose(cells["follow_up_on"])
        if d is None:
            rec.errors.append(
                RowError(
                    field="follow_up_on",
                    message=f"{cells['follow_up_on']!r} is not a date (use YYYY-MM-DD).",
                )
            )
        else:
            values["follow_up_on"] = d
            pv.follow_up_on = d.isoformat()
            if ambiguous:
                rec.warnings.append(
                    f"Follow-up date {cells['follow_up_on']!r} was read as month/day "
                    f"({d.isoformat()})."
                )
    for fld in ("amount_soft", "amount_committed", "amount"):
        if fld not in cells:
            continue
        raw = cells[fld]
        amount = parse_money(raw)
        if amount is None:
            rec.errors.append(
                RowError(
                    field=fld if fld != "amount" else "amount",
                    message=f"{raw!r} is not an amount (use 250000 or 250k).",
                )
            )
            continue
        cur = csv_io.currency_symbol_of(str(raw))
        if cur and cur != rnd.currency:
            rec.warnings.append(
                f"{raw} looks like {cur}; it was imported as {rnd.currency} {amount:,}."
            )
        if fld == "amount":  # prototype: committed if the stage is the won stage
            eff = stage or ctx.stage(rnd, default_stage) or ctx.first_stage(rnd)
            fld = "amount_committed" if eff.kind == "won" else "amount_soft"
        if fld == "amount_committed" and amount == 0:
            continue
        values[fld] = amount
        setattr(pv, fld, amount)
    for fld, limit in (("follow_up_note", 500), ("next_step", 500)):
        if fld in cells:
            try:
                values[fld] = clean_text(cells[fld], fld, max_len=limit)
                setattr(pv, fld, values[fld])
            except ValidationFailed as exc:
                rec.errors.append(RowError(field=fld, message=exc.message))
    if "owner_email" in cells:
        email = str(cells["owner_email"]).strip().lower()
        uid = ctx.members.get(email)
        if uid is None:
            rec.warnings.append(
                f"Owner {cells['owner_email']} is not a member of this workspace; owner left empty."
            )
        else:
            values["owner_user_id"] = uid
            pv.owner_email = email
    _ = ws_currency
    return stage, values, pv


def _fill_empty_state(before: Mapping[str, Any], clean: Mapping[str, Any]) -> dict[str, Any]:
    """The state after ``investors.update(..., fill_empty=True)`` (kept in step with it)."""
    after = dict(before)
    for f, value in clean.items():
        if f in LIST_FIELDS:
            after[f] = merge_lists(before.get(f) or [], value or [])[: ARRAY_LIMITS[f]]
        elif _empty(before.get(f)) and not _empty(value):
            after[f] = value
        elif f == "type" and before.get(f) == "other" and value not in (None, "other"):
            after[f] = value
    return after


def _changes(before: Mapping[str, Any], after: Mapping[str, Any]) -> dict[str, Any]:
    return {f: after[f] for f in INVESTOR_FIELDS if f in after and after[f] != before.get(f)}


async def _existing_matches(
    db: AsyncSession, ws: WorkspaceContext, cleans: Iterable[dict[str, Any]]
) -> list[Investor]:
    emails: set[str] = set()
    lkeys: set[str] = set()
    nkeys: set[str] = set()
    for c in cleans:
        k = dedupe_keys(c)
        if k.email:
            emails.add(k.email)
        if k.linkedin_key:
            lkeys.add(k.linkedin_key)
        if k.name_key:
            nkeys.add(k.name_key)
    conds = []
    if emails:
        conds.append(func.lower(Investor.email).in_(sorted(emails)))
    if lkeys:
        conds.append(Investor.linkedin_key.in_(sorted(lkeys)))
    if nkeys:
        conds.append(Investor.name_key.in_(sorted(nkeys)))
    if not conds:
        return []
    rows = await db.scalars(
        select(Investor)
        .where(Investor.workspace_id == ws.workspace_id, or_(*conds))
        .order_by(Investor.created_at, Investor.id)
    )
    return list(rows)


def _state_of(inv: Investor) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in INVESTOR_FIELDS:
        v = getattr(inv, f)
        out[f] = list(v) if isinstance(v, list) else (str(v) if f == "email" and v else v)
    return out


class _Index:
    """Dedupe keys → targets, across existing investors and rows planned so far."""

    def __init__(self) -> None:
        self.email: dict[str, Target] = {}
        self.linkedin: dict[str, Target] = {}
        self.name: dict[str, list[Target]] = defaultdict(list)

    def add(self, t: Target) -> None:
        k = dedupe_keys(t.fields)
        if k.email:
            self.email.setdefault(k.email, t)
        if k.linkedin_key:
            self.linkedin.setdefault(k.linkedin_key, t)
        if k.name_key and t not in self.name[k.name_key]:
            self.name[k.name_key].append(t)

    def find(self, clean: Mapping[str, Any]) -> tuple[Target, str] | None:
        k = dedupe_keys(clean)
        if k.email and k.email in self.email:
            return self.email[k.email], "email"
        if k.linkedin_key and k.linkedin_key in self.linkedin:
            return self.linkedin[k.linkedin_key], "linkedin"
        if k.name_key:
            has_firm = bool(clean.get("firm"))
            for t in self.name.get(k.name_key, []):
                if bool(t.fields.get("firm")) == has_firm:
                    return t, "name_firm"
        return None

    def owner_of(self, fld: str, value: Any) -> Target | None:
        if fld == "email" and value:
            return self.email.get(str(value).lower())
        if fld == "linkedin_url" and value:
            key = linkedin_key(str(value))
            return self.linkedin.get(key) if key else None
        return None


async def plan(
    db: AsyncSession, ws: WorkspaceContext, req: ImportRequest, *, built: Built | None = None
) -> Plan:
    """Decide every row's action. Reads only; writes nothing."""
    b = built or await build(db, ws, req)
    ctx = await _load_ctx(db, ws, b.rounds)
    for rnd in b.rounds:
        if not ctx.stages.get(rnd.id):
            raise ImportInvalid(f"Round {rnd.name} has no stages.")
        if b.default_stage and ctx.stage(rnd, b.default_stage) is None:
            raise ImportInvalid(
                f"default_stage {b.default_stage!r} is not a stage of {rnd.name}.",
                details={"valid": [s.key for s in ctx.stages[rnd.id]]},
            )
    mode: Mode = req.on_duplicate
    source = clean_text(req.source, "source", max_len=TEXT_LIMITS["source"]) if req.source else None

    cleans: list[dict[str, Any] | None] = [_normalize_contact(r, source) for r in b.records]
    existing = await _existing_matches(db, ws, (c for c in cleans if c is not None))
    index = _Index()
    targets: dict[UUID, Target] = {}
    for inv in existing:
        t = Target(fields=_state_of(inv), investor_id=inv.id)
        targets[inv.id] = t
        index.add(t)
    if targets and b.rounds:
        parts = await db.scalars(
            select(RoundParticipant).where(
                RoundParticipant.workspace_id == ws.workspace_id,
                RoundParticipant.round_id.in_([r.id for r in b.rounds]),
                RoundParticipant.investor_id.in_(list(targets)),
            )
        )
        for p in parts:
            snap = {f: getattr(p, f) for f in PARTICIPANT_FIELDS}
            snap["stage_id"] = p.stage_id
            targets[p.investor_id].rounds[p.round_id] = snap

    rows: list[PlannedRow] = []
    for rec, clean in zip(b.records, cleans, strict=True):
        parsed = [
            (p, *_parse_participation(p, rec, ctx, b.default_stage, ws.currency))
            for p in rec.participations
        ]
        if clean is None or rec.errors:
            rows.append(
                PlannedRow(
                    rec=rec,
                    action="error",
                    clean=clean or _display_fields(rec.contact),
                    participations=[
                        PlannedParticipation(p.round, False, None, {}, [], pv)
                        for p, _s1, _v, pv in parsed
                    ],
                )
            )
            continue
        pr = PlannedRow(rec=rec, action="create", clean=clean)
        found = index.find(clean)
        if found is None:
            t = Target(fields={f: clean.get(f) for f in INVESTOR_FIELDS}, row=rec.row)
            for f in LIST_FIELDS:
                t.fields[f] = t.fields[f] or []
            t.fields["type"] = t.fields["type"] or "other"
            index.add(t)
            pr.target = t
        else:
            t, matched_on = found
            pr.target = t
            pr.match = RowMatch(
                investor_id=t.investor_id,
                row=t.row if t.investor_id is None else None,
                name=t.name,
                matched_on=matched_on,
            )
            pr.action = "skip"
            if mode != "skip":
                before = dict(t.fields)
                if mode == "fill_empty":
                    after = _fill_empty_state(before, clean)
                else:
                    after = dict(before)
                    after.update({f: v for f, v in clean.items() if not _empty(v)})
                changes = _changes(before, after)
                for fld in ("email", "linkedin_url"):
                    if fld in changes:
                        owner = index.owner_of(fld, changes[fld])
                        if owner is not None and owner is not t:
                            rec.warnings.append(
                                f"{fld} {changes[fld]} already belongs to {owner.name}; "
                                "it was not changed."
                            )
                            changes.pop(fld)
                if changes:
                    pr.changes = changes
                    t.fields.update(changes)
                    index.add(t)
        for pin, stage, values, pv in parsed:
            pr.participations.append(_plan_participation(pin, stage, values, pv, pr, ctx, b, mode))
        if pr.action == "skip" and (
            pr.changes or any(not pp.add and (pp.values or pp.stage) for pp in pr.participations)
        ):
            pr.action = "update"
        rows.append(pr)
    return Plan(built=b, rows=rows, mode=mode, source=source)


def _display_fields(contact: Mapping[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in contact.items() if k in INVESTOR_FIELDS}


def _plan_participation(
    p: ParticipationIn,
    stage: RoundStage | None,
    values: dict[str, Any],
    pv: RowParticipant,
    pr: PlannedRow,
    ctx: Ctx,
    b: Built,
    mode: Mode,
) -> PlannedParticipation:
    t = pr.target
    assert t is not None
    rnd = p.round
    snap = t.rounds.get(rnd.id)
    if snap is None:
        st = stage or ctx.stage(rnd, b.default_stage) or ctx.first_stage(rnd)
        initial = dict(values)
        snap = {f: initial.get(f) for f in PARTICIPANT_FIELDS}
        snap["fit"] = snap["fit"] or 0
        snap["stage_id"] = st.id
        t.rounds[rnd.id] = snap
        pv.stage = st.key
        return PlannedParticipation(rnd, True, st, initial, p.notes, pv)
    # Already in the round (in the workspace, or added by an earlier row of this file).
    if mode == "skip":
        return PlannedParticipation(rnd, False, None, {}, [], _unchanged(rnd))
    changes: dict[str, Any] = {}
    for f, v in values.items():
        cur = snap.get(f)
        if mode == "fill_empty":
            if (cur is None or (f == "fit" and cur == 0)) and v is not None and v != cur:
                changes[f] = v
        elif v is not None and v != cur:
            changes[f] = v
    move: RoundStage | None = None
    if mode == "update" and stage is not None and stage.id != snap.get("stage_id"):
        move = stage
        snap["stage_id"] = stage.id
    snap.update(changes)
    if not changes and move is None:
        return PlannedParticipation(rnd, False, None, {}, [], _unchanged(rnd))
    return PlannedParticipation(rnd, False, move, changes, p.notes, pv)


def _unchanged(rnd: Round) -> RowParticipant:
    """Preview for a participant that stays as it is (only the round is shown)."""
    return RowParticipant(round=str(rnd.slug))


# --- preview ------------------------------------------------------------------------------


def _jsonable(value: Any) -> Any:
    if isinstance(value, date):
        return value.isoformat()
    return value


def _row_out(r: PlannedRow) -> ImportRow:
    part = r.participations[0].preview if r.participations else None
    return ImportRow(
        row=r.rec.row,
        action=r.action,
        investor={k: _jsonable(v) for k, v in r.clean.items() if not _empty(v)},
        participant=part,
        match=r.match,
        errors=r.rec.errors,
        warnings=r.rec.warnings,
    )


async def preview(
    db: AsyncSession, ws: WorkspaceContext, req: ImportRequest, *, max_rows: int = PREVIEW_ROWS
) -> ImportPreview:
    """``POST /v1/imports/preview`` and the MCP dry run. Writes nothing."""
    p = await plan(db, ws, req)
    warnings = list(p.built.warnings)
    counts = p.counts()
    _limit_warning(warnings, counts.create, await _investor_count(db, ws))
    return ImportPreview(
        format=p.built.format,
        columns=p.built.columns,
        mapping=p.built.mapping,
        row_count=len(p.rows),
        rows=[_row_out(r) for r in p.rows[:max_rows]],
        counts=counts,
        warnings=warnings,
        samples=p.built.samples,
    )


async def _investor_count(db: AsyncSession, ws: WorkspaceContext) -> int:
    n = await db.scalar(
        select(func.count()).select_from(Investor).where(Investor.workspace_id == ws.workspace_id)
    )
    return int(n or 0)


def _limit_warning(warnings: list[str], creating: int, have: int) -> None:
    cap = LIMITS["investors"]
    if have + creating > cap:
        warnings.append(
            f"This import would create {creating:,} investors, but the workspace can hold "
            f"{cap - have:,} more (limit {cap:,})."
        )


# --- commit -------------------------------------------------------------------------------


async def commit(
    db: AsyncSession, ws: WorkspaceContext, req: ImportRequest, *, now: datetime
) -> ImportResult:
    """``POST /v1/imports``: apply the plan in the caller's transaction (the caller commits).

    Error rows are skipped and reported. Every write goes through the feature services
    (``investors.create/update``, ``participants.upsert``, ``activities.log``) with
    ``via=import`` and this run's ``import_run_id``. Each row runs in a savepoint, so a row
    that fails at write time is reported and the rest of the import still lands.
    """
    from raisebook.services import activities, investors, participants

    p = await plan(db, ws, req)
    counts = p.counts()
    have = await _investor_count(db, ws)
    if have + counts.create > LIMITS["investors"]:
        raise LimitReached(
            f"This import would create {counts.create:,} investors, but the workspace can hold "
            f"{LIMITS['investors'] - have:,} more (limit {LIMITS['investors']:,}).",
            details={"limit": LIMITS["investors"], "have": have, "create": counts.create},
        )
    actor = ws.actor.with_via(Via.IMPORT)
    ctx = await _load_ctx(db, ws, p.built.rounds)
    run = ImportRun(
        workspace_id=ws.workspace_id,
        format=p.built.format,
        filename=req.filename[:255] if req.filename else None,
        round_id=p.built.rounds[0].id if p.built.rounds else None,
        options={
            "on_duplicate": p.mode,
            "round": req.round,
            "default_stage": req.default_stage,
            "source": p.source,
            "mapping": p.built.mapping or None,
            "round_map": [e.model_dump() for e in req.round_map] if req.round_map else None,
        },
        counts={},
        created_at=now,
        actor_type=actor.type.value,
        actor_user_id=actor.user_id,
        api_key_id=actor.api_key_id,
        actor_label=actor.label,
    )
    db.add(run)
    await db.flush()

    result = ResultCounts(rows=len(p.rows))
    errors: list[ResultError] = []
    created_ids: dict[int, UUID] = {}  # id(Target) → investor created by an earlier row
    for r in p.rows:
        if r.action == "error":
            result.errors += 1
            errors.extend(
                ResultError(row=r.rec.row, field=e.field, message=e.message) for e in r.rec.errors
            )
            continue
        t = r.target
        assert t is not None
        added = 0
        new_id: UUID | None = None
        try:
            async with db.begin_nested():
                if r.action == "create":
                    inv = await investors.create(
                        db, ws, r.clean, now=now, actor=actor, import_run_id=run.id
                    )
                    new_id = inv.id
                else:
                    inv_id = t.investor_id or created_ids[id(t)]
                    inv = await investors.get(db, ws, inv_id)
                    if r.changes:
                        await investors.update(
                            db, ws, inv, r.changes, now=now, actor=actor, import_run_id=run.id
                        )
                for pp in r.participations:
                    if pp.add or pp.values or pp.stage is not None:
                        changes: dict[str, Any] = dict(pp.values)
                        if pp.stage is not None:
                            changes["stage"] = pp.stage
                        await participants.upsert(
                            db,
                            ws,
                            pp.round,
                            inv,
                            changes,
                            now=now,
                            actor=actor,
                            import_run_id=run.id,
                            stages=ctx.stages[pp.round.id],
                        )
                        added += 1 if pp.add else 0
                    for note in pp.notes:
                        await _log_note(db, ws, activities, inv, pp.round, note, now, actor, run.id)
        except APIError as exc:
            result.errors += 1
            fld = _field_of(exc, "row") if isinstance(exc, ValidationFailed) else "row"
            errors.append(ResultError(row=r.rec.row, field=fld, message=exc.message))
            continue
        if new_id is not None:
            created_ids[id(t)] = new_id
            result.created += 1
        elif r.action == "update":
            result.updated += 1
        else:
            result.skipped += 1
        result.added_to_round += added
    run.counts = result.model_dump()
    await db.flush()
    rnd = p.built.rounds[0] if p.built.rounds else None
    return ImportResult(
        import_run_id=run.id,
        counts=result,
        errors=errors,
        round={"id": str(rnd.id), "slug": str(rnd.slug), "name": rnd.name} if rnd else None,
    )


async def _log_note(
    db: AsyncSession,
    ws: WorkspaceContext,
    activities: Any,
    inv: Investor,
    rnd: Round,
    note: NoteIn,
    now: datetime,
    actor: Any,
    run_id: UUID,
) -> None:
    """A prototype ``p.notes`` / ``log[]`` entry as a round note. The idempotency key makes
    re-importing the same file add no duplicate notes."""
    from raisebook.models.activity import Activity

    raw = f"{rnd.id}|{inv.id}|{note.on}|{note.body}"
    key = "import:prototype:" + hashlib.sha256(raw.encode()).hexdigest()[:40]
    seen = await db.scalar(
        select(Activity.id).where(
            Activity.workspace_id == ws.workspace_id, Activity.idempotency_key == key
        )
    )
    if seen is not None:
        return
    at = datetime.combine(note.on, time(12, 0), tzinfo=ZoneInfo(ws.timezone)) if note.on else None
    await activities.log(
        db,
        ws,
        investor_id=inv.id,
        kind="note",
        now=now,
        round_id=rnd.id,
        body=note.body[:20000],
        data={"imported_from": "prototype"},
        occurred_at=min(at, now) if at else None,
        actor=actor,
        import_run_id=run_id,
        idempotency_key=key,
    )


# --- runs ---------------------------------------------------------------------------------


async def list_runs(
    db: AsyncSession, ws: WorkspaceContext, *, limit: int = 50
) -> list[ImportRunOut]:
    rows = list(
        await db.execute(
            select(ImportRun, Round.name)
            .outerjoin(
                Round,
                (Round.id == ImportRun.round_id) & (Round.workspace_id == ImportRun.workspace_id),
            )
            .where(ImportRun.workspace_id == ws.workspace_id)
            .order_by(ImportRun.created_at.desc(), ImportRun.id.desc())
            .limit(limit)
        )
    )
    names = await display_names(db, (run.actor_user_id for run, _ in rows))
    out = []
    for run, round_name in rows:
        if run.actor_type == "user":
            label = (
                names.get(run.actor_user_id, FORMER_MEMBER) if run.actor_user_id else FORMER_MEMBER
            )
        elif run.actor_type == "system":
            label = "Raisebook"
        else:
            label = run.actor_label or "agent"
        out.append(
            ImportRunOut(
                id=run.id,
                format=run.format,
                filename=run.filename,
                round_id=run.round_id,
                round_name=round_name,
                actor_type=run.actor_type,
                actor_label=label,
                counts={k: int(v) for k, v in (run.counts or {}).items()},
                options=run.options or {},
                created_at=run.created_at,
            )
        )
    return out
