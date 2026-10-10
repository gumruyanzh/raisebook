"""Investors: ``/v1/investors`` (SPEC §5.7).

Owner: API+MCP (AM) replaces this stub (routes in SPEC §5). Keep ``router``'s prefix.
"""

from __future__ import annotations

from fastapi import APIRouter

from raisebook.schemas.common import ERROR_RESPONSES

router = APIRouter(prefix="/v1/investors", tags=["investors"], responses=ERROR_RESPONSES)
