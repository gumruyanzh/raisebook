"""Daily housekeeping (``rbctl housekeeping``): drop data Raisebook no longer needs.

Sign-in requests (email + IP) go a day after they expire, sessions when they expire
or a day after they are revoked, and invites (the invitee's email) once revoked or
seven days after they expire. Accepted invites stay as membership history. Finished
background jobs go after 30 days and uploaded decks (held only for a prefill job) after a day.
Research removal requests go 7 days after creation when never confirmed and 90 days after a
decision; research runs after 400 days (sources a kept dossier cites stay, without the run).
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import delete, or_, text
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.research import ResearchUpload
from raisebook.models.user import LoginToken, UserSession
from raisebook.models.workspace import Invite
from raisebook.services import jobs as jobs_svc
from raisebook.services import research_removal


def _n(result: object) -> int:
    return int(getattr(result, "rowcount", 0) or 0)


async def purge(db: AsyncSession, *, now: datetime) -> dict[str, int]:
    tokens = await db.execute(
        delete(LoginToken).where(LoginToken.expires_at < now - timedelta(days=1))
    )
    sessions = await db.execute(
        delete(UserSession).where(
            or_(
                UserSession.expires_at < now,
                UserSession.revoked_at < now - timedelta(days=1),
            )
        )
    )
    invites = await db.execute(
        delete(Invite).where(
            Invite.accepted_at.is_(None),
            or_(Invite.revoked_at.is_not(None), Invite.expires_at < now - timedelta(days=7)),
        )
    )
    finished_jobs = await jobs_svc.purge_finished(db, older_than=now - timedelta(days=30))
    uploads = await db.execute(
        delete(ResearchUpload).where(ResearchUpload.created_at < now - timedelta(hours=24))
    )
    removals = await research_removal.purge(db, now=now)
    # Runs older than 400 days go (their sources with them), except sources a kept dossier
    # cites: those are re-parented to no run first.
    old = now - timedelta(days=400)
    await db.execute(
        text(
            "UPDATE research_sources s SET run_id = NULL FROM research_runs r"
            " WHERE s.run_id = r.id AND r.created_at < :old AND EXISTS ("
            "   SELECT 1 FROM dossier_facts f, jsonb_array_elements(f.facts) fact"
            "   WHERE f.workspace_id = s.workspace_id AND f.investor_id = s.investor_id"
            "   AND fact->'source_ids' ? s.id::text)"
        ),
        {"old": old},
    )
    runs = await db.execute(
        text(
            "DELETE FROM research_runs WHERE created_at < :old"
            " AND status NOT IN ('queued', 'running')"
        ),
        {"old": old},
    )
    return {
        "login_tokens": _n(tokens),
        "sessions": _n(sessions),
        "invites": _n(invites),
        "jobs": finished_jobs,
        "research_uploads": _n(uploads),
        "removal_requests": removals,
        "research_runs": _n(runs),
    }
