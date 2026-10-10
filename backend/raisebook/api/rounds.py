"""Rounds and stages: ``/v1/rounds`` (SPEC §5.5).

Owner: API+MCP (AM) replaces this stub (routes in SPEC §5). Keep ``router``'s prefix.
"""

from __future__ import annotations

from fastapi import APIRouter

from raisebook.schemas.common import ERROR_RESPONSES

router = APIRouter(prefix="/v1/rounds", tags=["rounds"], responses=ERROR_RESPONSES)
