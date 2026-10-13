"""The company profile (R6; RESEARCH-PLAN §6.2).

- ``GET /v1/workspace/company-profile`` (read): 200 with empty fields when none was saved.
- ``PUT /v1/workspace/company-profile`` (write): replace it.
- ``POST /v1/workspace/company-profile/prefill`` (write, multipart ``website_url`` and/or
  ``deck`` PDF ≤10 MB): a research run drafts the profile on the workspace's OpenRouter key;
  the draft is in ``run.result.draft`` and nothing is saved until the founder PUTs it.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import (
    WorkspaceContext,
    get_now,
    get_session,
    get_workspace_ctx,
    get_write_ctx,
)
from raisebook.schemas.ai_settings import CompanyProfileIn, CompanyProfileOut
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.schemas.research import RunOut, RunStartedOut
from raisebook.services import company_profile as profile_svc
from raisebook.services import research as research_svc

router = APIRouter(prefix="/v1/workspace", tags=["company profile"], responses=ERROR_RESPONSES)


@router.get("/company-profile", response_model=CompanyProfileOut)
async def get_company_profile(
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> CompanyProfileOut:
    """What your company is and wants from investors. Research uses it for Fit and Talking
    points."""
    return profile_svc.profile_out(await profile_svc.get_profile(db, ws), ws)


@router.put("/company-profile", response_model=CompanyProfileOut)
async def put_company_profile(
    body: CompanyProfileIn,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> CompanyProfileOut:
    """Replace the company profile: pitch (one line), sectors (≤10), stage, location,
    traction (≤3 lines), lead or follow, check range in the workspace currency, and the
    strategic help you want."""
    row = await profile_svc.put_profile(db, ws, body, now=now)
    await db.commit()
    return profile_svc.profile_out(row, ws)


@router.post("/company-profile/prefill", status_code=202, response_model=RunStartedOut)
async def prefill_company_profile(
    website_url: str | None = Form(None, max_length=500),
    deck: UploadFile | None = File(None, description="Pitch deck PDF, at most 10 MB."),
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> RunStartedOut:
    """Draft the profile from your website and/or deck (sent to the AI provider through your
    OpenRouter key; the deck is not kept). Poll ``GET /v1/research/runs/{id}``: the draft is
    in ``result.draft``; review it and PUT the profile to save."""
    file = None
    if deck is not None:
        content = await deck.read(profile_svc.MAX_DECK_BYTES + 1)
        file = profile_svc.check_deck(deck.filename, content)
    run = await profile_svc.start_prefill(
        db, ws, website_url=(website_url or "").strip() or None, deck=file, now=now
    )
    await db.commit()
    counts = await research_svc.source_counts(db, ws, [run.id])
    return RunStartedOut(
        run=RunOut.model_validate(research_svc.run_dict(run, counts.get(run.id))),
        estimate_usd=round(run.estimate_micros / 1_000_000, 6),
        created=True,
    )
