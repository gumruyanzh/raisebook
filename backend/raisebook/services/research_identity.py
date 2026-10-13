"""Identity first (R3; RESEARCH-PLAN §4.5): who is this investor, probably?

The identity call (cheap search model) returns up to three candidates as a JSON block. Their
confidence is **recomputed here** from evidence, the model's own number being one small input:

| signal | points |
|---|---|
| a ``linkedin.com/in/…`` profile URL **that the search cited** | +0.25 |
| the name matches exactly (after normalization) / by initial or nickname | +0.35 / +0.2 |
| the firm matches, or the firm site's domain equals the investor's website | +0.25 |
| two or more independent citing domains | +0.1 |
| the model's confidence | x 0.15 |

The model's ``linkedin_url`` and ``firm_website`` are free text (a page it read can inject
them), so they are checked against the call's citations: a LinkedIn profile nobody cited earns
nothing, and a firm website whose domain no citation is on is dropped from the candidate.

Above :data:`IDENTITY_AUTO_THRESHOLD` (0.80) **and** at least 0.15 ahead of the runner-up
**and** citing evidence → ``matched`` (research proceeds and empty fields are filled; contact
fields only when :func:`trust_of` trusts them, else they become suggestions). Otherwise
``needs_pick`` with the top 2-3 candidates ("Is this them?"); nothing scores 0.3 →
``not_found``. A person's pick is ``confirmed`` (source ``user``); "None of these" is
``rejected`` until they enter a LinkedIn URL. An investor whose LinkedIn URL a person
already entered is ``confirmed`` (source ``existing``) without any model call.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.errors import ValidationFailed, not_found
from raisebook.models.enums import IdentitySource, IdentityStatus
from raisebook.models.investor import Investor
from raisebook.models.research import InvestorIdentity, InvestorIdentityCandidate
from raisebook.services import activities
from raisebook.services.normalize import clean_url, linkedin_key, norm, norm_firm
from raisebook.services.openrouter import WebSource
from raisebook.services.research_validate import Anchor, Trust, domain_of, domain_resembles_firm
from raisebook.services.research_writeback import WritebackResult, apply_investor_fields

IDENTITY_AUTO_THRESHOLD = 0.80
IDENTITY_MARGIN = 0.15
IDENTITY_MIN_SCORE = 0.30
ANCHORED = (IdentityStatus.MATCHED.value, IdentityStatus.CONFIRMED.value)
BLOCKING = (
    IdentityStatus.NEEDS_PICK.value,
    IdentityStatus.NOT_FOUND.value,
    IdentityStatus.REJECTED.value,
)

NICKNAMES: dict[str, set[str]] = {
    "alexander": {"alex", "sasha"},
    "andrew": {"andy", "drew"},
    "benjamin": {"ben"},
    "catherine": {"cat", "kate", "katie"},
    "christopher": {"chris"},
    "daniel": {"dan", "danny"},
    "elizabeth": {"liz", "beth", "eliza"},
    "james": {"jim", "jamie"},
    "jennifer": {"jen", "jenny"},
    "jonathan": {"jon", "jonny"},
    "joseph": {"joe"},
    "katherine": {"kate", "katie", "kat"},
    "margaret": {"maggie", "meg"},
    "matthew": {"matt"},
    "michael": {"mike", "mick"},
    "nicholas": {"nick"},
    "patricia": {"pat", "trish"},
    "robert": {"rob", "bob", "bobby"},
    "samuel": {"sam"},
    "stephen": {"steve"},
    "steven": {"steve"},
    "thomas": {"tom", "tommy"},
    "william": {"will", "bill", "billy"},
}


@dataclass
class Candidate:
    name: str
    title: str | None = None
    firm: str | None = None
    linkedin_url: str | None = None
    firm_website: str | None = None
    model_confidence: float = 0.0
    evidence: list[int] = field(default_factory=list)  # 1-based citation numbers
    score: float = 0.0


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def _opt(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or text.lower() in ("null", "none", "n/a", "unknown"):
        return None
    return text[:limit]


def _url(value: Any) -> str | None:
    text = _opt(value, 500)
    if text is None:
        return None
    try:
        return clean_url(text, "url")
    except ValidationFailed:
        return None


def parse_candidates(content: str) -> list[Candidate]:
    """The model's fenced JSON (or bare JSON), read leniently; junk entries are skipped."""
    raw: Any = None
    blocks = _FENCE.findall(content or "")
    for text in [*blocks, content or ""]:
        text = text.strip()
        start = min((i for i in (text.find("["), text.find("{")) if i >= 0), default=-1)
        if start < 0:
            continue
        try:
            raw = json.loads(text[start:])
            break
        except ValueError:
            end = max(text.rfind("]"), text.rfind("}"))
            try:
                raw = json.loads(text[start : end + 1])
                break
            except ValueError:
                continue
    if isinstance(raw, dict):
        raw = raw.get("candidates", [raw])
    out: list[Candidate] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        name = _opt(item.get("name"), 200)
        if name is None:
            continue
        conf = item.get("confidence")
        evidence = item.get("evidence") or []
        out.append(
            Candidate(
                name=name,
                title=_opt(item.get("title"), 200),
                firm=_opt(item.get("firm"), 200),
                linkedin_url=_url(item.get("linkedin_url")),
                firm_website=_url(item.get("firm_website")),
                model_confidence=max(0.0, min(1.0, float(conf)))
                if isinstance(conf, int | float) and not isinstance(conf, bool)
                else 0.0,
                evidence=[
                    int(e) for e in evidence if isinstance(e, int) and not isinstance(e, bool)
                ][:20],
            )
        )
        if len(out) == 3:
            break
    return out


def name_points(candidate: str, investor: str) -> float:
    a, b = norm(candidate).split(), norm(investor).split()
    if not a or not b:
        return 0.0
    if a == b:
        return 0.35
    if a[-1] != b[-1]:
        return 0.0
    fa, fb = a[0], b[0]
    if fa == fb:
        return 0.2  # middle names differ
    if (len(fa) == 1 and fb.startswith(fa)) or (len(fb) == 1 and fa.startswith(fb)):
        return 0.2  # an initial
    for full, nicks in NICKNAMES.items():
        if {fa, fb} <= {full, *nicks}:
            return 0.2
    if len(fa) >= 3 and len(fb) >= 3 and (fa.startswith(fb) or fb.startswith(fa)):
        return 0.2
    return 0.0


def _cited_linkedin(c: Candidate, sources: list[WebSource]) -> bool:
    key = linkedin_key(c.linkedin_url)
    return bool(key) and any(linkedin_key(s.url) == key for s in sources)


def verify_against_sources(c: Candidate, investor: Investor, sources: list[WebSource]) -> None:
    """Drop a firm website no citation backs (a page the model read may have injected it)."""
    site = domain_of(c.firm_website)
    if site is None:
        return
    own = domain_of(investor.website_url)
    cited = {domain_of(s.url) for s in sources}
    if site != own and not any(d and (d == site or d.endswith("." + site)) for d in cited):
        c.firm_website = None


def score(c: Candidate, investor: Investor, sources: list[WebSource]) -> float:
    points = 0.0
    if _cited_linkedin(c, sources):
        points += 0.25
    points += name_points(c.name, investor.name)
    firm_ok = bool(investor.firm and c.firm and norm_firm(investor.firm) == norm_firm(c.firm))
    if not firm_ok and investor.website_url and c.firm_website:
        firm_ok = domain_of(investor.website_url) == domain_of(c.firm_website)
    if firm_ok:
        points += 0.25
    domains = {
        domain_of(sources[i - 1].url)
        for i in c.evidence
        if 1 <= i <= len(sources) and domain_of(sources[i - 1].url)
    }
    if len(domains) >= 2:
        points += 0.1
    points += c.model_confidence * 0.15
    return round(min(1.0, points), 3)


@dataclass
class Decision:
    status: IdentityStatus
    candidates: list[Candidate]  # ranked (best first), only those worth showing
    best: Candidate | None = None


def decide(candidates: list[Candidate], investor: Investor, sources: list[WebSource]) -> Decision:
    for c in candidates:
        verify_against_sources(c, investor, sources)
        c.score = score(c, investor, sources)
    ranked = sorted(candidates, key=lambda c: c.score, reverse=True)
    shown = [c for c in ranked if c.score >= IDENTITY_MIN_SCORE][:3]
    if not shown:
        return Decision(IdentityStatus.NOT_FOUND, [])
    top = shown[0]
    second = shown[1].score if len(shown) > 1 else 0.0
    evidenced = any(1 <= i <= len(sources) for i in top.evidence) and _cited_linkedin(top, sources)
    if evidenced and top.score >= IDENTITY_AUTO_THRESHOLD and top.score - second >= IDENTITY_MARGIN:
        return Decision(IdentityStatus.MATCHED, shown, top)
    return Decision(IdentityStatus.NEEDS_PICK, shown)


def trust_of(identity: InvestorIdentity | None, investor: Investor) -> Trust:
    """Which identity fields research may write into the investor without a person's click.

    A person's pick or LinkedIn (sources ``user`` / ``existing``) is trusted. An automatic
    match is trusted for its LinkedIn (it must be cited to match) and for a firm domain that
    looks like the firm's name; an agent's identity only for that firm domain. Anything else
    becomes a suggestion to accept, even into an empty field."""
    if identity is None or identity.status not in ANCHORED:
        return Trust()
    if identity.source in (IdentitySource.USER.value, IdentitySource.EXISTING.value):
        return Trust(linkedin=True, domain=True)
    firm = identity.firm or investor.firm
    domain_ok = domain_resembles_firm(identity.firm_domain, firm)
    if identity.source == IdentitySource.AUTO.value:
        return Trust(linkedin=True, domain=domain_ok)
    return Trust(linkedin=False, domain=domain_ok)


# --- storage -------------------------------------------------------------------------------------


async def get_identity(
    db: AsyncSession, ws: WorkspaceContext, investor_id: UUID, *, lock: bool = False
) -> InvestorIdentity | None:
    stmt = select(InvestorIdentity).where(
        InvestorIdentity.workspace_id == ws.workspace_id,
        InvestorIdentity.investor_id == investor_id,
    )
    if lock:
        stmt = stmt.with_for_update()
    row: InvestorIdentity | None = await db.scalar(stmt)
    return row


async def ensure_identity(
    db: AsyncSession, ws: WorkspaceContext, investor_id: UUID, now: datetime
) -> InvestorIdentity:
    row = await get_identity(db, ws, investor_id, lock=True)
    if row is None:
        row = InvestorIdentity(
            workspace_id=ws.workspace_id,
            investor_id=investor_id,
            status=IdentityStatus.NONE.value,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        await db.flush()
    return row


def anchor_of(identity: InvestorIdentity | None, investor: Investor) -> Anchor:
    """The anchor research uses: the confirmed identity, else the investor's own fields."""
    if identity is not None and identity.status in ANCHORED:
        return Anchor.of(
            name=investor.name,
            firm=identity.firm or investor.firm,
            firm_website=identity.firm_website or investor.website_url,
            firm_domain=identity.firm_domain,
            linkedin_url=identity.linkedin_url or investor.linkedin_url,
            title=identity.title or investor.title,
        )
    return Anchor.of(
        name=investor.name,
        firm=investor.firm,
        firm_website=investor.website_url,
        linkedin_url=investor.linkedin_url,
        title=investor.title,
    )


def _set_anchor(
    row: InvestorIdentity,
    *,
    status: IdentityStatus,
    source: IdentitySource,
    linkedin_url: str | None,
    firm: str | None,
    firm_website: str | None,
    title: str | None,
    confidence: float | None,
    run_id: UUID | None,
    ws: WorkspaceContext | None,
    now: datetime,
) -> None:
    row.status = status.value
    row.source = source.value
    row.linkedin_url = linkedin_url
    row.linkedin_key = linkedin_key(linkedin_url)
    row.firm = firm
    row.firm_website = firm_website
    row.firm_domain = domain_of(firm_website)
    row.title = title
    row.confidence = Decimal(str(confidence)) if confidence is not None else None
    row.run_id = run_id
    row.updated_at = now
    if status == IdentityStatus.CONFIRMED and ws is not None:
        for k, v in ws.actor.activity_fields().items():
            setattr(row, k, v)
        row.confirmed_at = now
    elif status == IdentityStatus.MATCHED:
        row.confirmed_at = now


async def write_back_identity(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor: Investor,
    row: InvestorIdentity,
    *,
    now: datetime,
    run_id: UUID | None,
    log_activity: bool = True,
) -> WritebackResult:
    """Fill the investor's empty LinkedIn / website / title / firm from the anchor (R3, R7)
    and log one ``research`` activity ("Identity confirmed: <title>, <firm>"). A LinkedIn or
    website :func:`trust_of` does not trust becomes a suggestion instead."""
    trust = trust_of(row, investor)
    review = {
        *(() if trust.linkedin else ("linkedin_url",)),
        *(() if trust.domain else ("website_url",)),
    }
    result = await apply_investor_fields(
        db,
        ws,
        investor,
        {
            "linkedin_url": row.linkedin_url,
            "website_url": row.firm_website,
            "title": row.title,
            "firm": row.firm,
        },
        now=now,
        run_id=run_id,
        review=review,
    )
    if log_activity:
        what = ", ".join(p for p in (row.title, row.firm) if p) or "identity confirmed"
        verb = (
            "Identity matched"
            if row.status == IdentityStatus.MATCHED.value
            else "Identity confirmed"
        )
        await activities.log(
            db,
            ws,
            investor_id=investor.id,
            kind="research",
            now=now,
            body=f"{verb}: {what}"[:500],
            data={
                "event": "identity",
                "status": row.status,
                "source": row.source,
                "run_id": run_id,
                "filled": result.applied,
                "suggested": result.suggested,
            },
        )
    return result


async def record_decision(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor: Investor,
    decision: Decision,
    *,
    run_id: UUID,
    source_ids: list[UUID],
    now: datetime,
) -> InvestorIdentity:
    """Store the identity step's outcome (candidates replace the previous run's)."""
    row = await ensure_identity(db, ws, investor.id, now)
    if row.status == IdentityStatus.CONFIRMED.value:
        return row  # a person decided meanwhile: never overwrite their pick
    await db.execute(
        delete(InvestorIdentityCandidate).where(
            InvestorIdentityCandidate.workspace_id == ws.workspace_id,
            InvestorIdentityCandidate.investor_id == investor.id,
        )
    )
    for rank, c in enumerate(decision.candidates, start=1):
        evidence = [source_ids[i - 1] for i in c.evidence if 1 <= i <= len(source_ids)]
        db.add(
            InvestorIdentityCandidate(
                workspace_id=ws.workspace_id,
                investor_id=investor.id,
                run_id=run_id,
                rank=rank,
                name=c.name,
                title=c.title,
                firm=c.firm,
                linkedin_url=c.linkedin_url,
                firm_website=c.firm_website,
                confidence=Decimal(str(c.score)),
                evidence_source_ids=list(dict.fromkeys(evidence)),
                created_at=now,
            )
        )
    if decision.status == IdentityStatus.MATCHED and decision.best is not None:
        b = decision.best
        _set_anchor(
            row,
            status=IdentityStatus.MATCHED,
            source=IdentitySource.AUTO,
            linkedin_url=b.linkedin_url,
            firm=b.firm,
            firm_website=b.firm_website,
            title=b.title,
            confidence=b.score,
            run_id=run_id,
            ws=None,
            now=now,
        )
        await db.flush()
        await write_back_identity(db, ws, investor, row, now=now, run_id=run_id)
    else:
        row.status = decision.status.value
        row.run_id = run_id
        row.confidence = Decimal(str(decision.candidates[0].score)) if decision.candidates else None
        row.updated_at = now
    await db.flush()
    return row


async def confirm_existing(
    db: AsyncSession, ws: WorkspaceContext, investor: Investor, *, now: datetime
) -> InvestorIdentity | None:
    """A LinkedIn URL a person entered is the anchor: confirmed without a model call."""
    if not investor.linkedin_url:
        return None
    row = await ensure_identity(db, ws, investor.id, now)
    if row.status in ANCHORED:
        return row
    _set_anchor(
        row,
        status=IdentityStatus.CONFIRMED,
        source=IdentitySource.EXISTING,
        linkedin_url=investor.linkedin_url,
        firm=investor.firm,
        firm_website=investor.website_url,
        title=investor.title,
        confidence=1.0,
        run_id=None,
        ws=ws,
        now=now,
    )
    await db.flush()
    return row


async def candidates_of(
    db: AsyncSession, ws: WorkspaceContext, investor_id: UUID
) -> list[InvestorIdentityCandidate]:
    rows = await db.scalars(
        select(InvestorIdentityCandidate)
        .where(
            InvestorIdentityCandidate.workspace_id == ws.workspace_id,
            InvestorIdentityCandidate.investor_id == investor_id,
        )
        .order_by(InvestorIdentityCandidate.rank)
    )
    return list(rows)


async def pick(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor: Investor,
    *,
    now: datetime,
    candidate_id: UUID | None = None,
    rank: int | None = None,
    none: bool = False,
    linkedin_url: str | None = None,
    firm_website: str | None = None,
    title: str | None = None,
) -> InvestorIdentity:
    """A person (or agent) decides: a candidate, "none of these", or a LinkedIn URL. Someone
    who asked not to be researched (R13) cannot be picked (409 ``research_suppressed``)."""
    from raisebook.services import research_removal as removal_svc

    row = await ensure_identity(db, ws, investor.id, now)
    if none:
        row.status = IdentityStatus.REJECTED.value
        row.source = IdentitySource.USER.value if ws.actor.is_user else IdentitySource.AGENT.value
        row.updated_at = now
        for c in await candidates_of(db, ws, investor.id):
            c.picked = False
        await db.flush()
        return row
    source = IdentitySource.USER if ws.actor.is_user else IdentitySource.AGENT
    if linkedin_url is not None:
        url = clean_url(linkedin_url, "linkedin_url")
        if linkedin_key(url) is None:
            raise ValidationFailed(
                "linkedin_url", "Use a LinkedIn profile URL like https://www.linkedin.com/in/…"
            )
        site = clean_url(firm_website, "firm_website") if firm_website else None
        await removal_svc.require_not_suppressed(db, investor, extra_linkedin=[url])
        _set_anchor(
            row,
            status=IdentityStatus.CONFIRMED,
            source=source,
            linkedin_url=url,
            firm=investor.firm,
            firm_website=site or investor.website_url,
            title=(title or "").strip()[:200] or investor.title,
            confidence=1.0,
            run_id=None,
            ws=ws,
            now=now,
        )
    else:
        cands = await candidates_of(db, ws, investor.id)
        chosen = next(
            (
                c
                for c in cands
                if (candidate_id is not None and c.id == candidate_id)
                or (rank is not None and c.rank == rank)
            ),
            None,
        )
        if chosen is None:
            raise not_found("Identity candidate")
        await removal_svc.require_not_suppressed(
            db,
            investor,
            extra_linkedin=[chosen.linkedin_url],
            extra_names=[(chosen.name, chosen.firm)],
        )
        for c in cands:
            c.picked = c.id == chosen.id
        _set_anchor(
            row,
            status=IdentityStatus.CONFIRMED,
            source=source,
            linkedin_url=chosen.linkedin_url,
            firm=chosen.firm,
            firm_website=chosen.firm_website,
            title=chosen.title,
            confidence=float(chosen.confidence),
            run_id=chosen.run_id,
            ws=ws,
            now=now,
        )
    await db.flush()
    await write_back_identity(db, ws, investor, row, now=now, run_id=row.run_id)
    return row


def identity_dict(row: InvestorIdentity | None) -> dict[str, Any]:
    if row is None:
        return {"status": IdentityStatus.NONE.value}
    return {
        "status": row.status,
        "source": row.source,
        "linkedin_url": row.linkedin_url,
        "firm": row.firm,
        "firm_website": row.firm_website,
        "title": row.title,
        "confidence": float(row.confidence) if row.confidence is not None else None,
        "confirmed_at": row.confirmed_at,
        "updated_at": row.updated_at,
    }
