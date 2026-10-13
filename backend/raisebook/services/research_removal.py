"""Removal requests and suppressions (R13; RESEARCH-PLAN §1.12, §6.5, §6.8).

Anyone can ask Raisebook to delete what research stored about them:

1. ``POST /v1/research-policy/removal-requests`` (anonymous, rate-limited, always 202 so it
   reveals nothing) stores the request ``unverified`` and emails a one-time link.
2. ``POST …/verify`` with the token marks it ``verified`` and tells the operator.
3. The operator runs ``rbctl research removals apply <id>``: a ``research.removal`` job
   deletes, **in every workspace**, research rows about that person (identities, candidates,
   dossiers and their facts, sources, suggestions, runs and ``research`` activities), resets
   auto-filled "from research" values that nobody changed since, and inserts a suppression so
   research (model or agent) refuses that person from then on (``research_suppressed``).

This module holds the only cross-workspace statements in the product (the SPEC §1.6
exception): they are DELETE/UPDATE only and return counts, never content. Founders' own
contact rows (what they typed or imported) are their address book and stay.
"""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

import structlog
from sqlalchemy import or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.config import get_settings
from raisebook.core.errors import Conflict, InvalidToken, NotFound, ResearchSuppressed
from raisebook.models.enums import RemovalStatus
from raisebook.models.investor import Investor
from raisebook.models.research import (
    InvestorIdentity,
    ResearchRemovalRequest,
    ResearchSuppression,
)
from raisebook.services import jobs as jobs_svc
from raisebook.services.email import EmailSender, OutboundEmail
from raisebook.services.normalize import clean_email, clean_url, linkedin_key, name_key

log = structlog.get_logger("raisebook.research.removal")

TOKEN_TTL = timedelta(days=7)
SUPPRESSED_MESSAGE = (
    "This person asked Raisebook not to research them, so research is turned off for this "
    "investor. Your own contact details for them are unchanged."
)


def email_hash(email: str | None) -> bytes | None:
    if not email:
        return None
    return hashlib.sha256(email.strip().lower().encode()).digest()


def _token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


# --- suppression checks (any workspace's research) ------------------------------------------


async def is_suppressed(
    db: AsyncSession,
    investor: Investor,
    *,
    extra_linkedin: Sequence[str | None] = (),
    extra_names: Sequence[tuple[str, str | None]] = (),
) -> bool:
    """Did this person ask not to be researched? Checked against the investor row, its
    identity (the anchor research found, which may differ from what the founder typed), and
    any LinkedIn / name+firm about to become the identity."""
    keys = {k for k in (investor.linkedin_key, *(linkedin_key(u) for u in extra_linkedin)) if k}
    ident = (
        await db.execute(
            select(InvestorIdentity.linkedin_key, InvestorIdentity.firm).where(
                InvestorIdentity.workspace_id == investor.workspace_id,
                InvestorIdentity.investor_id == investor.id,
            )
        )
    ).one_or_none()
    names = {investor.name_key, *(name_key(n, f) for n, f in extra_names if n and f)}
    if ident is not None:
        if ident[0]:
            keys.add(ident[0])
        if ident[1]:
            names.add(name_key(investor.name, ident[1]))
    conds: list[Any] = [ResearchSuppression.name_key.in_(sorted(n for n in names if n))]
    if keys:
        conds.append(ResearchSuppression.linkedin_key.in_(sorted(keys)))
    h = email_hash(str(investor.email) if investor.email else None)
    if h is not None:
        conds.append(ResearchSuppression.email_sha256 == h)
    hit = await db.scalar(select(ResearchSuppression.id).where(or_(*conds)).limit(1))
    return hit is not None


async def require_not_suppressed(
    db: AsyncSession,
    investor: Investor,
    *,
    extra_linkedin: Sequence[str | None] = (),
    extra_names: Sequence[tuple[str, str | None]] = (),
) -> None:
    if await is_suppressed(db, investor, extra_linkedin=extra_linkedin, extra_names=extra_names):
        raise ResearchSuppressed(SUPPRESSED_MESSAGE)


async def suppressed_people(
    db: AsyncSession, people: Sequence[tuple[str | None, str | None, str | None]]
) -> set[int]:
    """Indexes of ``(linkedin_url, name, firm)`` that match a suppression (identity
    candidates are dropped before anyone sees or picks them)."""
    keys = {linkedin_key(u) for u, _, _ in people} - {None}
    names = {name_key(n, f) for _, n, f in people if n and f}
    conds: list[Any] = []
    if keys:
        conds.append(ResearchSuppression.linkedin_key.in_(sorted(k for k in keys if k)))
    if names:
        conds.append(ResearchSuppression.name_key.in_(sorted(names)))
    if not conds:
        return set()
    rows = (
        await db.execute(
            select(ResearchSuppression.linkedin_key, ResearchSuppression.name_key).where(
                or_(*conds)
            )
        )
    ).all()
    hit_keys = {r[0] for r in rows if r[0]}
    hit_names = {r[1] for r in rows if r[1]}
    return {
        i
        for i, (u, n, f) in enumerate(people)
        if (linkedin_key(u) in hit_keys) or (n and f and name_key(n, f) in hit_names)
    }


async def suppressed_ids(db: AsyncSession, investors: Sequence[Investor]) -> set[UUID]:
    out: set[UUID] = set()
    for inv in investors:  # bulk estimates: a few hundred indexed lookups at most
        if await is_suppressed(db, inv):
            out.add(inv.id)
    return out


# --- requests ------------------------------------------------------------------------------------


def verification_email(to: str, link: str) -> OutboundEmail:
    return OutboundEmail(
        to=to,
        subject="Confirm your Raisebook research removal request",
        text=(
            "Someone (we hope you) asked Raisebook to delete research it stores about you and "
            "to stop researching you.\n\n"
            f"Confirm the request within 7 days:\n\n{link}\n\n"
            "If you did not ask for this, ignore this email; nothing happens without the "
            "confirmation.\n\nResearch Policy: https://raisebook.org/research-policy\n"
        ),
        link=link,
        tags=("research_removal",),
    )


def done_email(to: str) -> OutboundEmail:
    # No counts: they would tell the requester whether (and how much) anyone researched
    # the person named, which is exactly what a false requester would want to learn.
    return OutboundEmail(
        to=to,
        subject="Your Raisebook research removal is done",
        text=(
            "Any research Raisebook stored about you is deleted, and research about you is "
            "turned off.\n\n"
            "Founders' own address-book entries (what they typed or imported themselves) are "
            "theirs and were not changed.\n\nhttps://raisebook.org/research-policy\n"
        ),
        tags=("research_removal_done",),
    )


async def create_request(
    db: AsyncSession,
    *,
    name: str,
    email: str,
    linkedin_url: str | None,
    firm: str | None,
    message: str | None,
    now: datetime,
    sender: EmailSender | None,
) -> ResearchRemovalRequest:
    """Store an unverified request and email the confirmation link (the caller commits)."""
    clean = clean_email(email)
    assert clean is not None
    link_url = clean_url(linkedin_url, "linkedin_url") if linkedin_url else None
    token = secrets.token_urlsafe(32)
    row = ResearchRemovalRequest(
        name=name.strip()[:200],
        email=clean,
        linkedin_url=link_url,
        firm=(firm or "").strip()[:200] or None,
        message=(message or "").strip()[:2000] or None,
        token_hash=_token_hash(token),
        status=RemovalStatus.UNVERIFIED.value,
        created_at=now,
    )
    db.add(row)
    await db.flush()
    if sender is not None:
        link = f"{get_settings().app_url.rstrip('/')}/research-policy/verify?token={token}"
        await sender.send(verification_email(clean, link))
    return row


async def verify_request(
    db: AsyncSession, token: str, *, now: datetime, sender: EmailSender | None
) -> ResearchRemovalRequest:
    row = await db.scalar(
        select(ResearchRemovalRequest)
        .where(ResearchRemovalRequest.token_hash == _token_hash((token or "").strip()))
        .with_for_update()
    )
    if row is None or row.created_at + TOKEN_TTL < now:
        raise InvalidToken("This confirmation link is invalid or expired. Send the request again.")
    if row.status == RemovalStatus.UNVERIFIED.value:
        row.status = RemovalStatus.VERIFIED.value
        row.verified_at = now
        await db.flush()
        log.warning("research_removal_verified", request_id=str(row.id))
        operator = get_settings().operator_email
        if operator and sender is not None:
            await sender.send(
                OutboundEmail(
                    to=operator,
                    subject="Raisebook: a research removal request was confirmed",
                    text=(
                        f"Request {row.id} was confirmed. Review it with "
                        "`rbctl research removals list --status verified`, then apply it with "
                        f"`rbctl research removals apply {row.id}`.\n"
                    ),
                    tags=("research_removal_operator",),
                )
            )
    return row


async def list_requests(
    db: AsyncSession, *, status: str | None = None, limit: int = 100
) -> list[ResearchRemovalRequest]:
    stmt = select(ResearchRemovalRequest).order_by(ResearchRemovalRequest.created_at.desc())
    if status:
        stmt = stmt.where(ResearchRemovalRequest.status == status)
    return list(await db.scalars(stmt.limit(limit)))


async def _get(db: AsyncSession, request_id: UUID) -> ResearchRemovalRequest:
    row = await db.get(ResearchRemovalRequest, request_id, with_for_update=True)
    if row is None:
        raise NotFound("Removal request not found.")
    return row


async def require_proof(db: AsyncSession, request_id: UUID, *, proof_checked: bool) -> None:
    """Refuse to apply a request with ``weak`` proof unless the operator checked it."""
    row = await db.get(ResearchRemovalRequest, request_id)
    if row is None:
        raise NotFound("Removal request not found.")
    proof = await proof_of(db, row)
    if proof["strength"] != "strong" and not proof_checked:
        raise Conflict(str(proof["warning"]), details={"proof": proof})


async def reject(db: AsyncSession, request_id: UUID, *, note: str, now: datetime) -> None:
    row = await _get(db, request_id)
    if row.status == RemovalStatus.APPLIED.value:
        raise Conflict("This request was already applied.")
    row.status = RemovalStatus.REJECTED.value
    row.decided_at = now
    row.decided_note = note.strip()[:500] or None
    await db.flush()


async def proof_of(db: AsyncSession, row: ResearchRemovalRequest) -> dict[str, Any]:
    """How well the confirmed email ties the requester to the person named (for the operator).

    Confirming the link proves only that the requester reads that mailbox. It is ``strong``
    when the email is on the person's firm's domain (the firm given, or the firm domain of an
    identity research found for that LinkedIn) or the request names nothing but that email;
    otherwise ``weak``: anyone could have asked about someone else, so the operator checks
    proof (for example, a reply from the person's work email) before applying."""
    from raisebook.services.privacy_filter import CONSUMER_MAIL_DOMAINS
    from raisebook.services.research_validate import domain_of, domain_resembles_firm

    email = str(row.email).lower()
    email_domain = email.rsplit("@", 1)[-1] if "@" in email else ""
    consumer = email_domain in CONSUMER_MAIL_DOMAINS
    lk = linkedin_key(row.linkedin_url)
    matches: list[str] = []
    if row.firm and not consumer and domain_resembles_firm(email_domain, row.firm):
        matches.append("firm_name")
    if lk and not consumer:
        domains = (
            await db.execute(
                text(
                    "SELECT DISTINCT ii.firm_domain, i.website_url FROM investors i"
                    " LEFT JOIN investor_identities ii"
                    "   ON ii.workspace_id = i.workspace_id AND ii.investor_id = i.id"
                    " WHERE i.linkedin_key = :lk OR ii.linkedin_key = :lk LIMIT 50"
                ),
                {"lk": lk},
            )
        ).all()
        for firm_domain, site in domains:
            for d in (firm_domain, domain_of(site)):
                if d and (email_domain == d or email_domain.endswith("." + d)):
                    matches.append("firm_domain")
    only_email = not lk and not row.firm
    strength = "strong" if matches or only_email else "weak"
    return {
        "strength": strength,
        "email_domain": email_domain,
        "consumer_email": consumer,
        "matches": sorted(set(matches)),
        "warning": None
        if strength == "strong"
        else "The confirmed email is not on this person's firm domain, so it does not prove "
        "the requester is the person named (it would delete research about them in every "
        "workspace). Ask for proof, then apply with --proof-checked, or reject.",
    }


async def enqueue_apply(
    db: AsyncSession, request_id: UUID, *, now: datetime, proof_checked: bool = False
) -> UUID:
    row = await _get(db, request_id)
    if row.status != RemovalStatus.VERIFIED.value:
        raise Conflict(f"Only verified requests can be applied (this one is {row.status}).")
    await require_proof(db, request_id, proof_checked=proof_checked)
    job_id, _ = await jobs_svc.enqueue(
        db,
        kind=jobs_svc.KIND_RESEARCH_REMOVAL,
        now=now,
        payload={"request_id": str(row.id)},
        dedupe_key=f"removal:{row.id}",
        priority=jobs_svc.PRIORITY_SINGLE,
    )
    return job_id


_RESET_LIST = ("stage_focus", "industries")
_RESETTABLE = (
    "firm",
    "title",
    "type",
    "location",
    "linkedin_url",
    "website_url",
    "email",
    "check_min",
    "check_max",
    "stage_focus",
    "industries",
)


async def apply_request(
    db: AsyncSession, request_id: UUID, *, now: datetime, sender: EmailSender | None
) -> dict[str, int]:
    """Delete research about the requester in every workspace; counts only (the caller
    commits). Idempotent: an applied request returns its stored counts."""
    row = await _get(db, request_id)
    if row.status == RemovalStatus.APPLIED.value:
        return dict(row.applied_counts or {})
    if row.status != RemovalStatus.VERIFIED.value:
        raise Conflict(f"Only verified requests can be applied (this one is {row.status}).")
    lk = linkedin_key(row.linkedin_url)
    nk = name_key(row.name, row.firm) if row.firm else None
    eh = email_hash(str(row.email))
    # Targets: (workspace_id, investor_id) pairs whose anchor matches, in any workspace.
    params: dict[str, Any] = {"lk": lk, "nk": nk, "eh": eh, "email": str(row.email).lower()}
    targets = (
        await db.execute(
            text(
                "SELECT DISTINCT i.workspace_id, i.id FROM investors i"
                " LEFT JOIN investor_identities ii"
                "   ON ii.workspace_id = i.workspace_id AND ii.investor_id = i.id"
                " WHERE (CAST(:lk AS text) IS NOT NULL"
                "        AND (i.linkedin_key = :lk OR ii.linkedin_key = :lk))"
                "    OR (CAST(:nk AS text) IS NOT NULL AND i.name_key = :nk)"
                "    OR lower(i.email::text) = :email"
            ),
            params,
        )
    ).all()
    counts = {
        "investors": len(targets),
        "dossiers": 0,
        "sources": 0,
        "identities": 0,
        "suggestions": 0,
        "runs": 0,
        "activities": 0,
        "values_reset": 0,
    }
    # Every key the targets were known by, collected before anything is reset or deleted:
    # the reset below strips "from research" LinkedIn values and the identity rows go, so
    # the suppression must carry the keys itself or research would find them again.
    lk_all: set[str] = {lk} if lk else set()
    nk_all: set[str] = {nk} if nk else set()
    for ws_id, inv_id in targets:
        known = (
            await db.execute(
                text(
                    "SELECT i.linkedin_key, i.name_key, ii.linkedin_key, i.name, ii.firm"
                    " FROM investors i LEFT JOIN investor_identities ii"
                    "   ON ii.workspace_id = i.workspace_id AND ii.investor_id = i.id"
                    " WHERE i.workspace_id = :ws AND i.id = :inv"
                ),
                {"ws": ws_id, "inv": inv_id},
            )
        ).one_or_none()
        if known is None:
            continue
        lk_all.update(k for k in (known[0], known[2]) if k)
        if known[1] and not known[1].endswith("|"):
            nk_all.add(known[1])
        if known[3] and known[4]:
            nk_all.add(name_key(known[3], known[4]))
    for ws_id, inv_id in targets:
        p = {"ws": ws_id, "inv": inv_id}
        # Reset "from research" values nobody changed since (direct; no activity is written).
        auto = (
            await db.execute(
                text(
                    "SELECT field, suggested_value FROM field_suggestions"
                    " WHERE workspace_id = :ws AND investor_id = :inv"
                    " AND status = 'auto_applied' AND round_id IS NULL"
                ),
                p,
            )
        ).all()
        inv = await db.get(Investor, inv_id, populate_existing=True)
        for field_name, value in auto:
            if inv is None or field_name not in _RESETTABLE:
                continue
            current = getattr(inv, field_name)
            same = current is not None and (
                str(current).casefold() == str(value).casefold()
                if not isinstance(current, list)
                else [str(x).casefold() for x in current]
                == [str(x).casefold() for x in (value or [])]
            )
            if same:
                setattr(inv, field_name, [] if field_name in _RESET_LIST else None)
                if field_name == "linkedin_url":
                    inv.linkedin_key = None
                counts["values_reset"] += 1
        await db.flush()
        for table, key in (
            ("field_suggestions", "suggestions"),
            ("dossiers", "dossiers"),
            ("investor_identity_candidates", None),
            ("investor_identities", "identities"),
            ("research_sources", "sources"),
            ("research_runs", "runs"),
        ):
            result = await db.execute(
                text(f"DELETE FROM {table} WHERE workspace_id = :ws AND investor_id = :inv"),  # noqa: S608
                p,
            )
            if key:
                counts[key] += int(getattr(result, "rowcount", 0) or 0)
        result = await db.execute(
            text(
                "DELETE FROM activities WHERE workspace_id = :ws AND investor_id = :inv"
                " AND kind = 'research'"
            ),
            p,
        )
        counts["activities"] += int(getattr(result, "rowcount", 0) or 0)
    db.add(
        ResearchSuppression(
            linkedin_key=lk,
            email_sha256=eh,
            name_key=nk,
            request_id=row.id,
            created_at=now,
        )
    )
    for extra_lk in sorted(lk_all - {lk}):
        db.add(ResearchSuppression(linkedin_key=extra_lk, request_id=row.id, created_at=now))
    for extra_nk in sorted(nk_all - {nk}):
        db.add(ResearchSuppression(name_key=extra_nk, request_id=row.id, created_at=now))
    row.status = RemovalStatus.APPLIED.value
    row.decided_at = now
    row.applied_counts = counts
    await db.flush()
    log.warning("research_removal_applied", request_id=str(row.id), investors=counts["investors"])
    if sender is not None:
        await sender.send(done_email(str(row.email)))
    return counts


async def purge(db: AsyncSession, *, now: datetime) -> int:
    """Housekeeping: unverified requests after 7 days, decided ones after 90 days."""
    result = await db.execute(
        text(
            "DELETE FROM research_removal_requests"
            " WHERE (status = 'unverified' AND created_at < :week)"
            " OR (status IN ('applied', 'rejected') AND decided_at < :quarter)"
        ),
        {"week": now - timedelta(days=7), "quarter": now - timedelta(days=90)},
    )
    return int(getattr(result, "rowcount", 0) or 0)


def request_dict(
    row: ResearchRemovalRequest, proof: dict[str, Any] | None = None
) -> dict[str, Any]:
    """For the operator CLI (who asked, what they gave; never shown to workspaces)."""
    return {
        **({"proof": proof} if proof is not None else {}),
        "id": str(row.id),
        "status": row.status,
        "name": row.name,
        "email": str(row.email),
        "linkedin_url": row.linkedin_url,
        "firm": row.firm,
        "message": row.message,
        "created_at": row.created_at.isoformat(),
        "verified_at": row.verified_at.isoformat() if row.verified_at else None,
        "applied_counts": row.applied_counts,
    }
