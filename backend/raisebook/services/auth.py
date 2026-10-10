"""Sign-in flows: request a magic link, verify it, sign out (SPEC §4.1).

``request_magic_link`` never reveals whether an account exists and answers the
same way when rate-limited (5 per email per 15 minutes, 30 per IP per hour): no
email is sent and a warning is logged with the email hashed. The user row is
created on the first successful verify. An invite attached to the request is
accepted in the verify transaction when the emails match.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth import magic_link
from raisebook.auth.principal import user_workspaces
from raisebook.auth.session import create_user_session
from raisebook.config import get_settings
from raisebook.core import ratelimit
from raisebook.core.errors import InvalidToken, ValidationFailed
from raisebook.core.logging import hash_email
from raisebook.models.enums import Role
from raisebook.models.user import User, UserSession
from raisebook.models.workspace import Invite, Workspace
from raisebook.services import invites as invites_svc
from raisebook.services.email import EmailSender, magic_link_email
from raisebook.services.users import get_or_create_user

log = structlog.get_logger(__name__)

MAGIC_LINKS_PER_EMAIL = 5


@dataclass(frozen=True)
class MagicLinkResult:
    sent: bool
    link: str | None  # only for the dev_link echo


async def request_magic_link(
    db: AsyncSession,
    sender: EmailSender,
    *,
    email: str,
    now: datetime,
    redirect_path: str | None = None,
    invite_token: str | None = None,
    ip: str | None = None,
) -> MagicLinkResult:
    addr = magic_link.normalize_email(email)
    if addr is None:
        raise ValidationFailed("email", "Enter a valid email address.")
    limited = await magic_link.recent_token_count(db, addr, now=now) >= MAGIC_LINKS_PER_EMAIL
    if not limited and ip:
        limited = not (await ratelimit.check("magic_ip", ip, now=now)).allowed
    if limited:
        log.warning("magic_link_rate_limited", email_hash=hash_email(addr))
        return MagicLinkResult(sent=False, link=None)

    invite: Invite | None = None
    if invite_token:
        found = await invites_svc.find_by_token(db, invite_token)
        if (
            found is not None
            and str(found.email).lower() == addr
            and invites_svc.invite_status(found, now) == "pending"
        ):
            invite = found
    issued = await magic_link.issue_login_token(
        db,
        addr,
        now=now,
        redirect_path=redirect_path,
        invite_id=invite.id if invite else None,
        ip=ip,
    )
    await db.commit()
    s = get_settings()
    await sender.send(magic_link_email(addr, issued.link, ttl_minutes=s.magic_link_ttl_minutes))
    return MagicLinkResult(sent=True, link=issued.link if s.echo_magic_links else None)


@dataclass(frozen=True)
class VerifyResult:
    user: User
    session: UserSession
    cookie: str
    redirect_path: str | None
    workspaces: list[tuple[Workspace, Role]]


async def verify(
    db: AsyncSession,
    token: str,
    *,
    now: datetime,
    user_agent: str | None = None,
    ip: str | None = None,
) -> VerifyResult:
    login = await magic_link.consume_login_token(db, token, now=now)
    if login is None:
        raise InvalidToken(
            "This sign-in link is invalid, already used or expired. Request a new one."
        )
    user, _created = await get_or_create_user(db, str(login.email), now=now)
    user.last_signin_at = now
    redirect_path = login.redirect_path
    if login.invite_id is not None:
        inv = await db.get(Invite, login.invite_id)
        if inv is not None and invites_svc.invite_status(inv, now) == "pending":
            ws = await invites_svc.accept_invite_row(db, inv, user, now=now)
            redirect_path = redirect_path or f"/w/{ws.slug}"
    sess, cookie = await create_user_session(db, user, now=now, user_agent=user_agent, ip=ip)
    await db.flush()
    return VerifyResult(
        user=user,
        session=sess,
        cookie=cookie,
        redirect_path=redirect_path,
        workspaces=await user_workspaces(db, user.id),
    )
