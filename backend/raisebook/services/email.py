"""Outbound email (magic links, invites) behind a small interface.

Backends (``RAISEBOOK_EMAIL_BACKEND``):

- ``log`` (default): logs the subject only. In local development (the
  ``echo_magic_links`` rule) the link is logged too, never the address.
- ``smtp``: stdlib ``smtplib`` (STARTTLS), run in a thread with a 15s timeout.
- ``memory``: appends to :data:`OUTBOX` (tests: the ``outbox`` fixture).

Only the recipient address and the message leave the system (SPEC §8.4).
"""

from __future__ import annotations

import asyncio
import smtplib
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Protocol

import structlog

from raisebook.config import Settings, get_settings
from raisebook.core.logging import hash_email

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class OutboundEmail:
    to: str
    subject: str
    text: str
    link: str | None = None  # the actionable link, logged in local dev only
    tags: tuple[str, ...] = field(default=())


class EmailSender(Protocol):
    async def send(self, message: OutboundEmail) -> None: ...


class LogEmailSender:
    def __init__(self, *, include_link: bool) -> None:
        self.include_link = include_link

    async def send(self, message: OutboundEmail) -> None:
        if self.include_link and message.link:
            # structlog redaction would hide a "link" key named like a token; print explicitly.
            log.info("email_logged", subject=message.subject, to_hash=hash_email(message.to))
            print(f"[raisebook dev] {message.subject}: {message.link}", flush=True)
        else:
            log.info("email_logged", subject=message.subject, to_hash=hash_email(message.to))


class SmtpEmailSender:
    def __init__(self, settings: Settings) -> None:
        if not settings.smtp_host:
            raise RuntimeError("RAISEBOOK_SMTP_HOST is required for RAISEBOOK_EMAIL_BACKEND=smtp")
        self.s = settings

    def _send_sync(self, message: OutboundEmail) -> None:
        msg = EmailMessage()
        msg["From"] = self.s.email_from
        msg["To"] = message.to
        msg["Subject"] = message.subject
        msg.set_content(message.text)
        assert self.s.smtp_host is not None
        with smtplib.SMTP(self.s.smtp_host, self.s.smtp_port, timeout=15) as smtp:
            if self.s.smtp_starttls:
                smtp.starttls()
            if self.s.smtp_username and self.s.smtp_password:
                smtp.login(self.s.smtp_username, self.s.smtp_password.get_secret_value())
            smtp.send_message(msg)

    async def send(self, message: OutboundEmail) -> None:
        await asyncio.to_thread(self._send_sync, message)
        log.info("email_sent", subject=message.subject, to_hash=hash_email(message.to))


OUTBOX: list[OutboundEmail] = []


class MemoryEmailSender:
    async def send(self, message: OutboundEmail) -> None:
        OUTBOX.append(message)


def build_email_sender(settings: Settings | None = None) -> EmailSender:
    s = settings or get_settings()
    if s.email_backend == "smtp":
        return SmtpEmailSender(s)
    if s.email_backend == "memory":
        return MemoryEmailSender()
    return LogEmailSender(include_link=s.echo_magic_links)


def get_email_sender() -> EmailSender:
    """FastAPI dependency (override in tests, or use the ``memory`` backend)."""
    return build_email_sender()


def magic_link_email(to: str, link: str, *, ttl_minutes: int) -> OutboundEmail:
    return OutboundEmail(
        to=to,
        subject="Your Raisebook sign-in link",
        text=(
            f"Open this link within {ttl_minutes} minutes to sign in to Raisebook:\n\n"
            f"{link}\n\n"
            "The link works once. If you did not ask for it, ignore this email; nobody can "
            "sign in without it.\n\n"
            "Raisebook is free forever and open source. https://raisebook.org\n"
        ),
        link=link,
        tags=("magic_link",),
    )


def invite_email(
    to: str, link: str, *, workspace_name: str, inviter: str | None, role: str, ttl_days: int
) -> OutboundEmail:
    who = inviter or "A teammate"
    return OutboundEmail(
        to=to,
        subject=f"{who} invited you to {workspace_name} on Raisebook",
        text=(
            f"{who} invited you to join {workspace_name} on Raisebook as {role}.\n\n"
            f"Accept within {ttl_days} days:\n\n{link}\n\n"
            "Raisebook is a free, open-source fundraising CRM. If you were not expecting this "
            "invite, ignore this email.\n"
        ),
        link=link,
        tags=("invite",),
    )
