"""Investor contacts: ``/v1/investors`` (SPEC §5.7). Owner: API+MCP (AM).

Investors are workspace-level and reusable across rounds. ``POST`` dedupes by email, then
LinkedIn profile, then name+firm (``on_duplicate`` decides what happens to a match). The
export route ``/v1/investors/export`` lives in ``api/exports.py`` (IE) and is registered
before this router.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import (
    WorkspaceContext,
    get_now,
    get_session,
    get_workspace_ctx,
    get_write_ctx,
)
from raisebook.core.refs import resolve_investor, resolve_round
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.schemas.investors import (
    InvestorAddOut,
    InvestorCreate,
    InvestorOut,
    InvestorPage,
    InvestorRef,
    InvestorUpdate,
)
from raisebook.services import investors as investors_svc
from raisebook.services.search import list_investors

router = APIRouter(prefix="/v1/investors", tags=["investors"], responses=ERROR_RESPONSES)


@router.get("", response_model=InvestorPage)
async def list_all(
    q: str | None = Query(None, max_length=200),
    type: str | None = Query(None, max_length=40),
    tag: list[str] | None = Query(None),
    industry: list[str] | None = Query(None),
    round: str | None = Query(None, max_length=200, description="only investors in this round"),
    not_in_round: str | None = Query(None, max_length=200),
    sort: Literal["name", "firm", "updated", "created"] = "name",
    order: Literal["asc", "desc"] | None = None,
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = None,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> InvestorPage:
    """Workspace contacts, each with their stage in every round. ``q``: every word must
    match name, firm, title, email, location, tags, industries, source or notes."""
    in_round = await resolve_round(db, ws, round, required=False)
    out_round = await resolve_round(db, ws, not_in_round, required=False)
    rows, nxt, total = await list_investors(
        db,
        ws,
        limit=limit,
        cursor=cursor,
        q=q,
        type_=type,
        tags=tag,
        industries=industry,
        in_round=in_round.id if in_round else None,
        not_in_round=out_round.id if out_round else None,
        sort=sort,
        order=order,
    )
    return InvestorPage(
        data=await investors_svc.present(db, ws, rows), next_cursor=nxt, total=total
    )


@router.post("", status_code=201, response_model=InvestorAddOut)
async def add_investor(
    body: InvestorCreate,
    response: Response,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> InvestorAddOut:
    """Create an investor (201), or return the existing duplicate (200 with ``matched_on``).
    ``on_duplicate``: ``return_existing`` (default), ``fill_empty``, ``create_anyway``."""
    res = await investors_svc.add(
        db, ws, body.fields_set(), on_duplicate=body.on_duplicate, now=now
    )
    await db.commit()
    if not res.created:
        response.status_code = 200
    return InvestorAddOut(
        investor=await investors_svc.present_one(db, ws, res.investor),
        created=res.created,
        matched_on=res.matched_on,
        filled_fields=res.filled_fields,
    )


@router.get("/resolve", response_model=InvestorRef)
async def resolve(
    ref: str = Query(..., min_length=1, max_length=500),
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> InvestorRef:
    """Find one investor by id, email, LinkedIn URL, ``Name`` or ``Name @ Firm`` (404 with
    suggestions, or 409 ``ambiguous_reference`` with candidates)."""
    inv = await resolve_investor(db, ws, ref)
    return InvestorRef(investor=await investors_svc.present_one(db, ws, inv))


@router.get("/{investor_id}", response_model=InvestorOut)
async def get_investor(
    investor_id: UUID,
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    db: AsyncSession = Depends(get_session),
) -> InvestorOut:
    inv = await investors_svc.get(db, ws, investor_id)
    return await investors_svc.present_one(db, ws, inv)


@router.patch("/{investor_id}", response_model=InvestorOut)
async def update_investor(
    investor_id: UUID,
    body: InvestorUpdate,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> InvestorOut:
    """Change contact fields (absent = unchanged, null = clear), plus ``add_tags``,
    ``remove_tags``, ``add_industries`` and ``append_notes``. 409 ``duplicate`` when the
    email or LinkedIn profile belongs to another investor."""
    inv = await investors_svc.get(db, ws, investor_id)
    await investors_svc.update(
        db,
        ws,
        inv,
        body.fields_set(),
        now=now,
        add_tags=body.add_tags,
        remove_tags=body.remove_tags,
        add_industries=body.add_industries,
        append_notes=body.append_notes,
    )
    await db.commit()
    return await investors_svc.present_one(db, ws, inv)


@router.delete("/{investor_id}", status_code=204, response_class=Response)
async def delete_investor(
    investor_id: UUID,
    ws: WorkspaceContext = Depends(get_write_ctx),
    db: AsyncSession = Depends(get_session),
) -> Response:
    """Delete the investor permanently, with their participations and timeline."""
    inv = await investors_svc.get(db, ws, investor_id)
    await investors_svc.delete_investor(db, ws, inv)
    await db.commit()
    return Response(status_code=204)
