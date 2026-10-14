"""API errors and the JSON error envelope (SPEC §5.2).

Every error response has the shape
``{"error": {"code", "message", "details", "request_id"}}``. Raise an
:class:`APIError` subclass from anywhere in request handling (services included);
MCP tools turn the same exceptions into ``ToolError("<code>: <message>")``.

Messages are full sentences an agent can act on: say what went wrong and what to
do next. Never put SQL, stack traces or secrets in a message.
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from starlette.exceptions import HTTPException as StarletteHTTPException

from raisebook.core.logging import safe_traceback
from raisebook.core.request_id import get_request_id

log = structlog.get_logger(__name__)

WWW_AUTHENTICATE = {"WWW-Authenticate": 'Bearer realm="raisebook"'}


class APIError(Exception):
    """Base error: ``code`` + HTTP status + a message that says what to do next."""

    status_code: int = 400
    code: str = "bad_request"
    default_message: str = "The request is malformed."

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        status_code: int | None = None,
        details: Any = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.message = message or self.default_message
        super().__init__(self.message)
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code
        self.details = details
        self.headers = headers


# --- 400 -----------------------------------------------------------------------------------
class BadRequest(APIError):
    status_code = 400
    code = "bad_request"


class WorkspaceRequired(APIError):
    status_code = 400
    code = "workspace_required"
    default_message = (
        "You belong to more than one workspace. Send the X-Workspace header with the "
        "workspace slug or id."
    )


class InvalidToken(APIError):
    status_code = 400
    code = "invalid_token"
    default_message = "This link is invalid, already used or expired. Request a new one."


# --- 401 -----------------------------------------------------------------------------------
class Unauthorized(APIError):
    status_code = 401
    code = "unauthorized"
    default_message = "Sign in, or send an API key as 'Authorization: Bearer rb_live_…'."


class InvalidApiKey(Unauthorized):
    code = "invalid_api_key"
    default_message = (
        "This API key is invalid, revoked or expired. Create a new key in Settings → API keys."
    )

    def __init__(self, message: str | None = None, **kw: Any) -> None:
        kw.setdefault("headers", WWW_AUTHENTICATE)
        super().__init__(message, **kw)


class SessionInvalid(Unauthorized):
    code = "session_invalid"
    default_message = "Your session expired or you signed out. Sign in again."


# --- 403 -----------------------------------------------------------------------------------
class Forbidden(APIError):
    status_code = 403
    code = "forbidden"
    default_message = "You are not allowed to do this."


class CsrfFailed(Forbidden):
    code = "csrf_failed"
    default_message = (
        "Missing or invalid X-CSRF-Token header. Get the token from GET /v1/auth/session."
    )


class InsufficientScope(Forbidden):
    code = "insufficient_scope"


class ForbiddenRole(Forbidden):
    code = "forbidden_role"


# --- 404 -----------------------------------------------------------------------------------
class NotFound(APIError):
    status_code = 404
    code = "not_found"
    default_message = "Not found."


class WorkspaceNotFound(NotFound):
    code = "workspace_not_found"
    default_message = (
        "Workspace not found. Use a slug or id from GET /v1/workspaces (you must be a member)."
    )


# --- 409 -----------------------------------------------------------------------------------
class Conflict(APIError):
    status_code = 409
    code = "conflict"


class Duplicate(Conflict):
    code = "duplicate"


class AmbiguousReference(Conflict):
    code = "ambiguous_reference"


class StageInUse(Conflict):
    code = "stage_in_use"


class LastOwner(Conflict):
    code = "last_owner"
    default_message = "A workspace needs at least one owner. Make another member an owner first."


class NotInRound(Conflict):
    code = "not_in_round"


class AlreadyMember(Conflict):
    code = "already_member"


class InviteMismatch(Conflict):
    code = "invite_mismatch"


class TransferOwnershipFirst(Conflict):
    code = "transfer_ownership_first"


class NotDeletable(Conflict):
    code = "not_deletable"


class MeetingDone(Conflict):
    code = "meeting_done"


class SessionConflict(Conflict):
    code = "session_conflict"
    default_message = (
        "You are signed in as someone else in this browser. Send switch_account=true to sign "
        "out of that account and continue with this link."
    )


# --- 413 -----------------------------------------------------------------------------------
class PayloadTooLarge(APIError):
    status_code = 413
    code = "payload_too_large"
    default_message = "The request body is too large."


# --- 422 -----------------------------------------------------------------------------------
class Unprocessable(APIError):
    status_code = 422
    code = "unprocessable"


class ValidationFailed(Unprocessable):
    """Service-level validation: ``details`` mirrors FastAPI's list of ``{loc, msg, type}``."""

    code = "validation_error"

    def __init__(
        self, field: str | list[str], message: str, *, type_: str = "value_error", **kw: Any
    ) -> None:
        loc = ["body", field] if isinstance(field, str) else list(field)
        kw.setdefault("details", [{"loc": loc, "msg": message, "type": type_}])
        super().__init__(message, **kw)


class RoundRequired(Unprocessable):
    code = "round_required"


class StageNotFound(Unprocessable):
    code = "stage_not_found"


class InvalidStageConfig(Unprocessable):
    code = "invalid_stage_config"


class LimitReached(Unprocessable):
    code = "limit_reached"


class ConfirmationRequired(Unprocessable):
    code = "confirmation_required"


class ImportInvalid(Unprocessable):
    code = "import_invalid"


class EmailUnavailable(APIError):
    """The email provider refused or the global send cap is reached (nothing was sent)."""

    status_code = 503
    code = "email_unavailable"
    default_message = (
        "We could not send the email right now. Try again in a few minutes, or continue with "
        "Google if it is offered."
    )


# --- Investor research (docs/RESEARCH-PLAN.md §6.6) -----------------------------------------
class NoAiKey(Unprocessable):
    code = "no_ai_key"
    default_message = (
        "This workspace has no OpenRouter key. An owner can add one in Settings → AI research."
    )


class InvalidOpenRouterKey(Unprocessable):
    code = "invalid_openrouter_key"
    default_message = "OpenRouter did not accept this key. Copy it again from openrouter.ai/keys."


class ModelUnavailable(Unprocessable):
    code = "model_unavailable"


class SpendCapReached(Unprocessable):
    code = "spend_cap_reached"


class InvalidDossier(Unprocessable):
    code = "invalid_dossier"


class NoCitedFacts(Unprocessable):
    code = "no_cited_facts"
    default_message = (
        "No fact in this dossier cites an accepted source, so nothing was saved. Cite a fetched "
        "source for every fact."
    )


class EstimateChanged(Conflict):
    code = "estimate_changed"


class IdentityRequired(Conflict):
    code = "identity_required"
    default_message = "Pick who this investor is first, then research them."


class IdentityMismatch(Conflict):
    code = "identity_mismatch"


class ResearchSuppressed(Conflict):
    code = "research_suppressed"
    default_message = "This person asked Raisebook not to research them, so research is off."


class NoDossier(NotFound):
    code = "no_dossier"
    default_message = "No dossier yet. Run research on this investor first."


class ResearchUnavailable(APIError):
    status_code = 503
    code = "research_unavailable"
    default_message = (
        "Research is off on this server: RAISEBOOK_SECRETS_KEK is not set. Ask whoever runs it."
    )


class OpenRouterUnavailable(APIError):
    status_code = 503
    code = "openrouter_unavailable"
    default_message = "OpenRouter did not answer. Try again in a minute."


# --- 429 / 500 -----------------------------------------------------------------------------
class RateLimited(APIError):
    status_code = 429
    code = "rate_limited"

    def __init__(self, retry_after_s: int, message: str | None = None, **kw: Any) -> None:
        retry_after_s = max(1, int(retry_after_s))
        self.retry_after_s = retry_after_s
        headers = {"Retry-After": str(retry_after_s), **(kw.pop("headers", None) or {})}
        super().__init__(
            message or f"Rate limit reached. Retry after {retry_after_s}s.",
            details={"retry_after_s": retry_after_s},
            headers=headers,
            **kw,
        )


class InternalError(APIError):
    status_code = 500
    code = "internal_error"


def internal_error_message() -> str:
    return f"Unexpected error. Reference {get_request_id() or 'unknown'}."


def not_found(what: str = "Resource") -> NotFound:
    """A 404 for ``what`` (used for missing *and* other-workspace ids; never 403)."""
    return NotFound(f"{what} not found in this workspace.")


def error_body(code: str, message: str, details: Any = None) -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "details": details,
            "request_id": get_request_id(),
        }
    }


_HTTP_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "validation_error",
    429: "rate_limited",
}


def _pg_code(exc: IntegrityError) -> str | None:
    orig = getattr(exc, "orig", None)
    code = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
    cause = getattr(orig, "__cause__", None)
    return code or getattr(cause, "sqlstate", None)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(APIError)
    async def _api_error(_: Request, exc: APIError) -> JSONResponse:
        return JSONResponse(
            error_body(exc.code, exc.message, exc.details),
            status_code=exc.status_code,
            headers=exc.headers,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            error_body(_HTTP_CODES.get(exc.status_code, "http_error"), str(exc.detail)),
            status_code=exc.status_code,
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {"loc": list(e.get("loc", ())), "msg": e.get("msg"), "type": e.get("type")}
            for e in exc.errors()
        ]
        return JSONResponse(
            error_body(
                "validation_error",
                "Some fields are invalid. See details for each field and fix them.",
                details,
            ),
            status_code=422,
        )

    @app.exception_handler(IntegrityError)
    async def _integrity_error(_: Request, exc: IntegrityError) -> JSONResponse:
        # Safety net: services should check first and raise a precise APIError.
        code = _pg_code(exc)
        log.warning("integrity_error", sqlstate=code)
        if code == "23505":
            return JSONResponse(
                error_body("duplicate", "This conflicts with an existing record."),
                status_code=409,
            )
        if code == "23503":
            return JSONResponse(
                error_body("not_found", "A referenced record was not found in this workspace."),
                status_code=404,
            )
        if code in ("23514", "23502", "22001", "22P02"):
            return JSONResponse(
                error_body("validation_error", "A value is out of range or malformed.", []),
                status_code=422,
            )
        return JSONResponse(error_body("internal_error", internal_error_message()), status_code=500)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        # Never leak internals (SQL, schema, secrets) to clients; log the type only.
        log.error("unhandled_exception", exc_type=type(exc).__name__, traceback=safe_traceback(exc))
        return JSONResponse(error_body("internal_error", internal_error_message()), status_code=500)
