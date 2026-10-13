"""The company profile (R6; RESEARCH-PLAN §1.3, §6.2): one per workspace, rounds inherit it.

It tells research who "we" are: one-line pitch, sectors, stage, location, three traction
points and what the company wants from investors. Identity matching works without it; the
dossier's Fit verdict and Talking points need it. Prefill from a website or deck (a model
drafts, the founder edits and saves) arrives with the pipeline (Part 2); nothing is saved
until the founder PUTs the profile.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.models.ai import CompanyProfile
from raisebook.schemas.ai_settings import CompanyProfileIn, CompanyProfileOut

EDITABLE = (
    "pitch",
    "sectors",
    "stage",
    "location",
    "traction",
    "wants_lead",
    "check_min",
    "check_max",
    "strategic_help",
    "website_url",
)


async def get_profile(db: AsyncSession, ws: WorkspaceContext) -> CompanyProfile | None:
    row: CompanyProfile | None = await db.scalar(
        select(CompanyProfile).where(CompanyProfile.workspace_id == ws.workspace_id)
    )
    return row


def is_empty(row: CompanyProfile | None) -> bool:
    if row is None:
        return True
    return not any(getattr(row, f) for f in EDITABLE) and row.check_min is None


def profile_out(row: CompanyProfile | None, ws: WorkspaceContext) -> CompanyProfileOut:
    def get(name: str, default: Any = None) -> Any:
        return getattr(row, name) if row is not None else default

    return CompanyProfileOut(
        pitch=get("pitch"),
        sectors=list(get("sectors", []) or []),
        stage=get("stage"),
        location=get("location"),
        traction=list(get("traction", []) or []),
        wants_lead=get("wants_lead"),
        check_min=get("check_min"),
        check_max=get("check_max"),
        currency=ws.currency,
        strategic_help=get("strategic_help"),
        website_url=get("website_url"),
        deck_filename=get("deck_filename"),
        prefilled_at=get("prefilled_at"),
        updated_at=get("updated_at"),
        is_empty=is_empty(row),
    )


async def put_profile(
    db: AsyncSession, ws: WorkspaceContext, body: CompanyProfileIn, *, now: datetime
) -> CompanyProfile:
    """Replace the whole profile (validated by :class:`CompanyProfileIn`)."""
    row = await get_profile(db, ws)
    if row is None:
        row = CompanyProfile(workspace_id=ws.workspace_id, created_at=now)
        db.add(row)
    data = body.model_dump()
    for name in EDITABLE:
        value = data[name]
        if name in ("stage", "wants_lead") and value is not None:
            value = str(value.value if hasattr(value, "value") else value)
        setattr(row, name, value)
    row.updated_at = now
    row.updated_by_user_id = ws.actor.user_id
    await db.flush()
    return row


def export_dict(row: CompanyProfile | None) -> dict[str, Any] | None:
    """For the workspace JSON export (no deck: it is never kept)."""
    if row is None:
        return None
    return {
        **{name: getattr(row, name) for name in EDITABLE},
        "sectors": list(row.sectors or []),
        "traction": list(row.traction or []),
        "deck_filename": row.deck_filename,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
