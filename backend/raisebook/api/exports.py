"""Exports: ``/v1/export``, ``/v1/investors/export``, ``/v1/rounds/{round}/export`` (SPEC §5.8).

Owner: Import-Export+Ops (IE). Files download as attachments (CSV is formula-guarded).
Every viewer and every key can export (``raisebook:read``); exports share the
per-workspace ``export`` rate limit (60 per hour).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api.deps import WorkspaceContext, get_now, get_session, get_workspace_ctx, rate_limit
from raisebook.core import refs
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.services import exports as svc

router = APIRouter(prefix="/v1", tags=["exports"], responses=ERROR_RESPONSES)

_CSV = {"content": {"text/csv": {}}, "description": "CSV file"}
_JSON = {"content": {"application/json": {}}, "description": "JSON file"}


def file_response(f: svc.ExportFile) -> Response:
    return Response(
        content=f.content.encode("utf-8"),
        media_type=f.media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{f.filename}"',
            "Cache-Control": "no-store",
            "X-Row-Count": str(f.row_count),
        },
    )


@router.get(
    "/export",
    summary="Export the whole workspace (JSON)",
    response_class=Response,
    responses={200: _JSON},
)
async def export_workspace(
    format: Literal["json"] = Query("json"),
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    _rl: object = Depends(rate_limit("export")),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """Everything in the workspace: rounds and stages, investors, participants, the full
    timeline, members and import runs (`format: raisebook.export`, version 1). API keys,
    sessions and sign-in tokens are never exported."""
    return file_response(await svc.export_workspace_json(db, ws, now=now))


@router.get(
    "/investors/export",
    summary="Export investors (CSV)",
    response_class=Response,
    responses={200: _CSV},
)
async def export_investors(
    format: Literal["csv"] = Query("csv"),
    ids: list[UUID] | None = Query(None, description="Only these investors (repeatable)."),
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    _rl: object = Depends(rate_limit("export")),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """Every contact with its fields and a `rounds` column (`Seed: Meeting; …`)."""
    return file_response(await svc.export_investors_csv(db, ws, now=now, ids=ids))


@router.get(
    "/rounds/{round}/export",
    summary="Export a round (CSV or JSON)",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}, "application/json": {}}}},
)
async def export_round(
    round: str,
    format: Literal["csv", "json"] = Query("csv"),
    include_activities: bool = Query(False, description="JSON only: add each timeline."),
    ws: WorkspaceContext = Depends(get_workspace_ctx),
    _rl: object = Depends(rate_limit("export")),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """Every investor in the round with contact fields, stage, fit, follow-up, amounts and
    last activity. The CSV uses canonical column names, so it re-imports unchanged."""
    rnd = await refs.resolve_round(db, ws, round, required=True)
    assert rnd is not None
    f = await svc.export_round(
        db, ws, rnd, fmt=format, now=now, include_activities=include_activities
    )
    return file_response(f)
