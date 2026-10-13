"""The Research Policy's removal process (R13; RESEARCH-PLAN §6.5). Public, anonymous.

- ``POST /v1/research-policy/removal-requests``: anyone asks Raisebook to delete research
  about them. Always 202 (it never reveals whether anything is stored); a confirmation link
  is emailed. Rate-limited per IP (``anon_ip`` + ``removal_request``) and per email.
- ``POST /v1/research-policy/removal-requests/verify``: the emailed token confirms it; the
  operator then applies it with ``rbctl research removals apply``.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import get_email_sender, get_now, get_session
from raisebook.core import ratelimit
from raisebook.core.errors import ValidationFailed
from raisebook.core.logging import hash_email
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.schemas.research import AcceptedOut, RemovalRequestIn, RemovalVerifyIn
from raisebook.services import research_removal as removal_svc
from raisebook.services.email import EmailSender
from raisebook.services.normalize import clean_email

router = APIRouter(
    prefix="/v1/research-policy", tags=["research policy"], responses=ERROR_RESPONSES
)

ACCEPTED = (
    "If the address is valid, we sent a confirmation link to it. Open it within 7 days to "
    "confirm the request."
)


@router.post("/removal-requests", status_code=202, response_model=AcceptedOut)
async def request_removal(
    body: RemovalRequestIn,
    request: Request,
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
    sender: EmailSender = Depends(get_email_sender),
) -> AcceptedOut:
    """Ask Raisebook to delete the research it stores about you (in every workspace) and to
    stop researching you. We email a confirmation link first."""
    ip = ratelimit.client_ip(request)
    await ratelimit.enforce("anon_ip", ip, request=request, now=now)
    await ratelimit.enforce("removal_request", ip, request=request, now=now)
    email = clean_email(body.email)
    if email is None:
        raise ValidationFailed("email", "email is required.")
    per_email = await ratelimit.check("removal_email", hash_email(email), now=now)
    if per_email.allowed:
        await removal_svc.create_request(
            db,
            name=body.name,
            email=email,
            linkedin_url=body.linkedin_url,
            firm=body.firm,
            message=body.message,
            now=now,
            sender=sender,
        )
        await db.commit()
    return AcceptedOut(message=ACCEPTED)


@router.post("/removal-requests/verify", response_model=AcceptedOut)
async def verify_removal(
    body: RemovalVerifyIn,
    request: Request,
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
    sender: EmailSender = Depends(get_email_sender),
) -> AcceptedOut:
    """Confirm a removal request with the emailed token."""
    await ratelimit.enforce("anon_ip", ratelimit.client_ip(request), request=request, now=now)
    await removal_svc.verify_request(db, body.token, now=now, sender=sender)
    await db.commit()
    return AcceptedOut(
        message="Confirmed. We will delete the research about you and email you when it is done."
    )
