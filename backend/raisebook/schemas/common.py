"""Shared schema pieces: the error envelope, pagination, cursors."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from typing import Annotated, Any, TypeVar

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer

from raisebook.core.errors import BadRequest

T = TypeVar("T")


def _utc(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


Timestamp = Annotated[datetime, PlainSerializer(_utc, return_type=str, when_used="json")]
"""A datetime serialized as RFC 3339 UTC (``2026-10-10T17:04:05Z``)."""


class APIModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class StrictInput(BaseModel):
    """Request bodies: unknown keys are rejected so typos surface as validation errors."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ErrorInfo(BaseModel):
    code: str
    message: str
    details: Any = None
    request_id: str | None = None


class ErrorEnvelope(BaseModel):
    error: ErrorInfo


ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    400: {"model": ErrorEnvelope, "description": "Malformed request or workspace_required"},
    401: {"model": ErrorEnvelope, "description": "Missing or invalid credentials"},
    403: {"model": ErrorEnvelope, "description": "csrf_failed, insufficient_scope, forbidden_role"},
    404: {"model": ErrorEnvelope, "description": "Not found (or in another workspace)"},
    422: {"model": ErrorEnvelope, "description": "validation_error and semantic errors"},
    429: {"model": ErrorEnvelope, "description": "rate_limited (see Retry-After)"},
}


class Page[T](BaseModel):
    data: list[T]
    next_cursor: str | None = None


class DataList[T](BaseModel):
    data: list[T]


class Ok(BaseModel):
    ok: bool = True


class LimitParams(BaseModel):
    limit: int = Field(50, ge=1, le=200)
    cursor: str | None = None


def encode_cursor(payload: dict[str, Any]) -> str:
    """Opaque cursor (base64url JSON). Never put secrets in it."""
    raw = json.dumps(payload, separators=(",", ":"), default=str).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> dict[str, Any] | None:
    if not cursor:
        return None
    try:
        pad = "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(cursor + pad))
    except (ValueError, TypeError):
        raise BadRequest("The cursor is invalid. Start again without 'cursor'.") from None
    if not isinstance(data, dict):
        raise BadRequest("The cursor is invalid. Start again without 'cursor'.")
    return data
