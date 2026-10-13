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
) -> bool:
    keys = {k for k in (investor.linkedin_key, *(linkedin_key(u) for u in extra_linkedin)) if k}
    ident_key = await db.scalar(
        select(InvestorIdentity.linkedin_key).where(
            InvestorIdentity.workspace_id == investor.workspace_id,
            InvestorIdentity.investor_id == investor.id,
        )
    )
    if ident_key:
        keys.add(ident_key)
    conds: list[Any] = [ResearchSuppression.name_key == investor.name_key]
    if keys:
        conds.append(ResearchSuppression.linkedin_key.in_(sorted(keys)))
    h = email_hash(str(investor.email) if investor.email else None)
    if h is not None:
        conds.append(ResearchSuppression.email_sha256 == h)
    hit = await db.scalar(select(ResearchSuppression.id).where(or_(*conds)).limit(1))
    return hit is not None


async def require_not_suppressed(
    db: AsyncSession, investor: Investor, *, extra_linkedin: Sequence[str | None] = ()
) -> None:
    if await is_suppressed(db, investor, extra_linkedin=extra_linkedin):
        raise ResearchSuppressed(SUPPRESSED_MESSAGE)


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


def done_email(to: str, counts: dict[str, int]) -> OutboundEmail:
    total = sum(counts.values())
    return OutboundEmail(
        to=to,
        subject="Your Raisebook research removal is done",
        text=(
            "We deleted the research Raisebook stored about you "
            f"({total} records across all workspaces) and turned research about you off.\n\n"
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


async def reject(db: AsyncSession, request_id: UUID, *, note: str, now: datetime) -> None:
    row = await _get(db, request_id)
    if row.status == RemovalStatus.APPLIED.value:
        raise Conflict("This request was already applied.")
    row.status = RemovalStatus.REJECTED.value
    row.decided_at = now
    row.decided_note = note.strip()[:500] or None
    await db.flush()


async def enqueue_apply(db: AsyncSession, request_id: UUID, *, now: datetime) -> UUID:
    row = await _get(db, request_id)
    if row.status != RemovalStatus.VERIFIED.value:
        raise Conflict(f"Only verified requests can be applied (this one is {row.status}).")
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
    row.status = RemovalStatus.APPLIED.value
    row.decided_at = now
    row.applied_counts = counts
    await db.flush()
    log.warning("research_removal_applied", request_id=str(row.id), investors=counts["investors"])
    if sender is not None:
        await sender.send(done_email(str(row.email), counts))
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


def request_dict(row: ResearchRemovalRequest) -> dict[str, Any]:
    """For the operator CLI (who asked, what they gave; never shown to workspaces)."""
    return {
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
