"""Exports: ``/v1/export``, ``/v1/investors/export``, ``/v1/rounds/{round}/export`` (SPEC §5.8).

Owner: Import-Export+Ops (IE) replaces this stub (routes in SPEC §5). Keep ``router``'s prefix.
"""

from __future__ import annotations

from fastapi import APIRouter

from raisebook.schemas.common import ERROR_RESPONSES

router = APIRouter(prefix="/v1", tags=["exports"], responses=ERROR_RESPONSES)
