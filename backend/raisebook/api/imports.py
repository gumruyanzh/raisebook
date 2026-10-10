"""Imports: ``/v1/imports`` (SPEC §5.8).

Owner: Import-Export+Ops (IE) replaces this stub (routes in SPEC §5). Keep ``router``'s prefix.
"""

from __future__ import annotations

from fastapi import APIRouter

from raisebook.schemas.common import ERROR_RESPONSES

router = APIRouter(prefix="/v1/imports", tags=["imports"], responses=ERROR_RESPONSES)
