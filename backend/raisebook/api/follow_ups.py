"""Due follow-ups: ``/v1/follow-ups`` (SPEC §5.6).

Owner: API+MCP (AM) replaces this stub (routes in SPEC §5). Keep ``router``'s prefix.
"""

from __future__ import annotations

from fastapi import APIRouter

from raisebook.schemas.common import ERROR_RESPONSES

router = APIRouter(prefix="/v1/follow-ups", tags=["follow-ups"], responses=ERROR_RESPONSES)
