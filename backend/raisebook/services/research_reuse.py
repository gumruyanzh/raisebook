"""Reuse research across one owner's workspaces (owner decision 2026-10-14; RESEARCH-SPEC #14).

**The single named cross-workspace read.** Everything else in Raisebook reads one workspace
(``ws.workspace_id``); the operator's removal (``services/research_removal``) deletes across
workspaces but never reads content back. This module is the only code that *reads* rows of a
workspace other than the caller's, and only under all of these conditions:

- **Same owner.** The person starting the run is an ``owner`` of this workspace (a signed-in
  owner, or for an API key the owner who created it) **and** an ``owner`` of the other
  workspace. A member who is not an owner on both sides, or two workspaces of different
  owners, never reuse (``tests/research/test_research_reuse.py``). Sample workspaces never
  give.
- **Same person.** The other workspace's confirmed identity (``matched``/``confirmed``) has the
  same LinkedIn profile (``linkedin_key``), or, when either side has none, the exact normalized
  name and the same firm domain.
- **Fresh.** A successful dossier, refresh or agent run that finished within
  :data:`FRESH_DAYS`, with accepted sources.
- **Not suppressed.** A person who asked not to be researched (R13) is never reused; removal
  deletes the rows this would read anyway.

**Only the public layer.** It reads ``investor_identities`` (the anchor), accepted
``research_sources`` and ``dossier_facts`` (public cited facts), plus the giving workspace's
name for the "Reused research from …" line. It never reads ``dossiers`` (verdict, Brief, Ways
in, talking points), notes, suggestions, activities, contacts or anything else private: the
writer runs again for this workspace's company and round. This is the public-facts layer
spec #8 anticipated, opened only between workspaces of the same owner.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import and_, exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.models.enums import ResearchKind, Role, RunStatus
from raisebook.models.investor import Investor
from raisebook.models.research import DossierFacts, InvestorIdentity, ResearchRun, ResearchSource
from raisebook.models.workspace import ApiKey, Membership, Workspace
from raisebook.services import research_removal as removal_svc
from raisebook.services.normalize import linkedin_key, norm
from raisebook.services.research_validate import domain_of

FRESH_DAYS = 30
MAX_SOURCES = 40
MAX_CANDIDATES = 5000
ANCHORED = ("matched", "confirmed")
GIVING_KINDS = (ResearchKind.DOSSIER.value, ResearchKind.REFRESH.value, ResearchKind.AGENT.value)


@dataclass(frozen=True)
class PersonKey:
    linkedin_key: str | None
    name: str
    firm_domain: str | None

    @property
    def usable(self) -> bool:
        return bool(self.linkedin_key or (self.name and self.firm_domain))


def person_key(identity: InvestorIdentity | None, investor: Investor) -> PersonKey:
    """Who this investor is, for matching across workspaces: the confirmed identity's LinkedIn
    and firm domain, else what a person entered on the investor."""
    anchored = identity is not None and identity.status in ANCHORED
    lk = (identity.linkedin_key if anchored and identity else None) or linkedin_key(
        investor.linkedin_url
    )
    domain = (identity.firm_domain if anchored and identity else None) or domain_of(
        investor.website_url
    )
    return PersonKey(lk, norm(investor.name), domain)


@dataclass
class Donor:
    """Fresh research on the same person in another workspace of the same owner."""

    workspace_id: UUID
    workspace_name: str
    run_id: UUID
    investor_id: UUID
    finished_at: datetime
    dossier_id: UUID | None
    identity: dict[str, Any] = field(default_factory=dict)

    def as_result(self) -> dict[str, Any]:
        """What the run records (``research_runs.result.reuse``); ids stay internal."""
        return {
            "workspace_id": str(self.workspace_id),
            "workspace_name": self.workspace_name,
            "run_id": str(self.run_id),
            "date": self.finished_at.date().isoformat(),
        }


async def reuse_owner(db: AsyncSession, ws: WorkspaceContext) -> UUID | None:
    """The owner whose other workspaces may give: a signed-in owner of this workspace, or, for
    an API key, the owner of this workspace who created it. Anyone else: None (no reuse)."""
    p = ws.principal
    if p.is_session:
        return p.user_id if p.role == Role.OWNER else None
    if p.api_key_id is None:
        return None
    creator = await db.scalar(
        select(ApiKey.created_by_user_id).where(
            ApiKey.id == p.api_key_id, ApiKey.workspace_id == ws.workspace_id
        )
    )
    if creator is None:
        return None
    role = await db.scalar(
        select(Membership.role).where(
            Membership.workspace_id == ws.workspace_id, Membership.user_id == creator
        )
    )
    return creator if role == Role.OWNER.value else None


async def _owned_elsewhere(db: AsyncSession, ws: WorkspaceContext, owner: UUID) -> dict[UUID, str]:
    rows = await db.execute(
        select(Workspace.id, Workspace.name)
        .join(Membership, Membership.workspace_id == Workspace.id)
        .where(
            Membership.user_id == owner,
            Membership.role == Role.OWNER.value,
            Workspace.id != ws.workspace_id,
            Workspace.is_sandbox.is_(False),
        )
    )
    return {wid: name for wid, name in rows.tuples()}


@dataclass
class _Cand:
    workspace_id: UUID
    run_id: UUID
    investor_id: UUID
    finished_at: datetime
    dossier_id: UUID | None
    name: str
    identity: InvestorIdentity


async def _candidates(
    db: AsyncSession, ws: WorkspaceContext, *, now: datetime
) -> tuple[dict[UUID, str], list[_Cand]]:
    owner = await reuse_owner(db, ws)
    if owner is None:
        return {}, []
    owned = await _owned_elsewhere(db, ws, owner)
    if not owned:
        return {}, []
    since = now - timedelta(days=FRESH_DAYS)
    accepted = exists().where(
        ResearchSource.workspace_id == ResearchRun.workspace_id,
        ResearchSource.run_id == ResearchRun.id,
        ResearchSource.accepted.is_(True),
    )
    rows = await db.execute(
        select(ResearchRun, InvestorIdentity, Investor.name)
        .join(
            InvestorIdentity,
            and_(
                InvestorIdentity.workspace_id == ResearchRun.workspace_id,
                InvestorIdentity.investor_id == ResearchRun.investor_id,
            ),
        )
        .join(
            Investor,
            and_(
                Investor.workspace_id == ResearchRun.workspace_id,
                Investor.id == ResearchRun.investor_id,
            ),
        )
        .where(
            ResearchRun.workspace_id.in_(list(owned)),
            ResearchRun.status == RunStatus.SUCCEEDED.value,
            ResearchRun.kind.in_(GIVING_KINDS),
            ResearchRun.finished_at >= since,
            InvestorIdentity.status.in_(ANCHORED),
            accepted,
        )
        .order_by(ResearchRun.finished_at.desc(), ResearchRun.id)
        .limit(MAX_CANDIDATES)
    )
    out = [
        _Cand(
            workspace_id=run.workspace_id,
            run_id=run.id,
            investor_id=run.investor_id,
            finished_at=run.finished_at,
            dossier_id=run.dossier_id,
            name=name,
            identity=ident,
        )
        for run, ident, name in rows.tuples()
        if run.investor_id is not None and run.finished_at is not None
    ]
    return owned, out


def _same_person(key: PersonKey, c: _Cand) -> bool:
    if key.linkedin_key and c.identity.linkedin_key:
        return key.linkedin_key == c.identity.linkedin_key
    return bool(
        key.name
        and key.firm_domain
        and norm(c.name) == key.name
        and c.identity.firm_domain == key.firm_domain
    )


async def _pick(
    db: AsyncSession, owned: dict[UUID, str], cands: Sequence[_Cand], key: PersonKey
) -> Donor | None:
    if not key.usable:
        return None
    for c in cands:  # newest first
        if not _same_person(key, c):
            continue
        hidden = await removal_svc.suppressed_people(
            db, [(c.identity.linkedin_url, c.name, c.identity.firm)]
        )
        if hidden:
            continue
        i = c.identity
        return Donor(
            workspace_id=c.workspace_id,
            workspace_name=owned.get(c.workspace_id, "another workspace"),
            run_id=c.run_id,
            investor_id=c.investor_id,
            finished_at=c.finished_at,
            dossier_id=c.dossier_id,
            identity={
                "status": i.status,
                "source": i.source,
                "linkedin_url": i.linkedin_url,
                "firm": i.firm,
                "firm_website": i.firm_website,
                "title": i.title,
                "confidence": float(i.confidence) if i.confidence is not None else None,
            },
        )
    return None


async def find_donor(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor: Investor,
    identity: InvestorIdentity | None,
    *,
    now: datetime,
) -> Donor | None:
    """Fresh research on this same person in another workspace of the same owner, or None."""
    key = person_key(identity, investor)
    if not key.usable:
        return None
    owned, cands = await _candidates(db, ws, now=now)
    return await _pick(db, owned, cands, key) if cands else None


async def donors_for(
    db: AsyncSession,
    ws: WorkspaceContext,
    investors: Sequence[Investor],
    identities: dict[UUID, InvestorIdentity],
    *,
    now: datetime,
) -> dict[UUID, Donor]:
    """:func:`find_donor` for a selection (one candidate query)."""
    if not investors:
        return {}
    owned, cands = await _candidates(db, ws, now=now)
    if not cands:
        return {}
    out: dict[UUID, Donor] = {}
    for inv in investors:
        donor = await _pick(db, owned, cands, person_key(identities.get(inv.id), inv))
        if donor is not None:
            out[inv.id] = donor
    return out


async def donor_sources(db: AsyncSession, donor: Donor) -> list[ResearchSource]:
    """The giving run's accepted sources (public layer only)."""
    rows = await db.scalars(
        select(ResearchSource)
        .where(
            ResearchSource.workspace_id == donor.workspace_id,
            ResearchSource.run_id == donor.run_id,
            ResearchSource.accepted.is_(True),
        )
        .order_by(ResearchSource.created_at, ResearchSource.id)
        .limit(MAX_SOURCES)
    )
    return list(rows)


async def donor_facts(
    db: AsyncSession, donor: Donor, sources: Sequence[ResearchSource]
) -> list[dict[str, Any]]:
    """The giving dossier's public cited facts (``dossier_facts``, never ``dossiers``), each
    pointing at its sources by normalized URL so this run can cite its own copies."""
    if donor.dossier_id is None:
        return []
    row = await db.scalar(
        select(DossierFacts).where(
            DossierFacts.workspace_id == donor.workspace_id,
            DossierFacts.dossier_id == donor.dossier_id,
        )
    )
    if row is None:
        return []
    url_of = {str(s.id): s.url_key for s in sources}
    out: list[dict[str, Any]] = []
    for f in row.facts or []:
        if f.get("notes"):
            continue  # worded with the giving workspace's private notes: stays there
        keys = [url_of[s] for s in f.get("source_ids", []) if s in url_of]
        if not keys or not f.get("text"):
            continue
        out.append(
            {
                "section": f.get("section"),
                "kind": f.get("kind"),
                "text": f.get("text"),
                "date": f.get("date"),
                "url_keys": keys,
            }
        )
    return out
