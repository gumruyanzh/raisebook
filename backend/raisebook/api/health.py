"""Liveness and readiness probes (no auth, not in the OpenAPI schema)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from raisebook import __version__
from raisebook.core.database import get_engine

router = APIRouter(include_in_schema=False)


@router.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"status": "ok", "version": __version__}


@router.get("/healthz/ready")
async def ready() -> JSONResponse:
    try:
        async with get_engine().connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse({"status": "unavailable", "db": "down"}, status_code=503)
    return JSONResponse({"status": "ok", "db": "ok"})
