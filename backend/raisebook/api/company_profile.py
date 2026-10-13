"""The company profile (R6; RESEARCH-PLAN §6.2). Prefill (website / deck) comes in Part 2.

- ``GET /v1/workspace/company-profile`` (read): 200 with empty fields when none was saved.
- ``PUT /v1/workspace/company-profile`` (write): replace it.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends
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
from raisebook.services import company_profile as profile_svc

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
