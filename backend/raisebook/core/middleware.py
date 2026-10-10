"""Pure-ASGI middlewares: request body limit and the no-PII access log (SPEC §5.1, §8.4)."""

from __future__ import annotations

import time

import structlog
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from raisebook.core.errors import error_body, internal_error_message
from raisebook.core.logging import safe_traceback

log = structlog.get_logger("raisebook.access")

MB = 1024 * 1024
DEFAULT_BODY_LIMIT = 1 * MB
# Paths with a larger limit: imports (≤5 MB of CSV/JSON) and /mcp (import_investors_csv).
LARGE_BODY_PREFIXES: tuple[tuple[str, int], ...] = (("/v1/imports", 6 * MB), ("/mcp", 6 * MB))


class _TooLarge(Exception):
    pass


def body_limit_for(path: str) -> int:
    for prefix, limit in LARGE_BODY_PREFIXES:
        if path == prefix or path.startswith(prefix + "/") or path.startswith(prefix + "?"):
            return limit
    return DEFAULT_BODY_LIMIT


class BodySizeLimitMiddleware:
    """413 ``payload_too_large`` above 1 MB (6 MB for ``/v1/imports*`` and ``/mcp``)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def _reject(self, scope: Scope, receive: Receive, send: Send, limit: int) -> None:
        resp = JSONResponse(
            error_body(
                "payload_too_large",
                f"The request body is larger than {limit // MB} MB. Send less data per request.",
                {"limit_bytes": limit},
            ),
            status_code=413,
        )
        await resp(scope, receive, send)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = body_limit_for(scope.get("path", ""))
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    if int(value) > limit:
                        await self._reject(scope, receive, send, limit)
                        return
                except ValueError:
                    pass
                break
        seen = 0
        started = False

        async def limited_receive() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    raise _TooLarge
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _TooLarge:
            if not started:
                await self._reject(scope, receive, send, limit)


class AccessLogMiddleware:
    """One log line per request: method, route template, status, duration, workspace id,
    actor type and key prefix. Never the query string, body, emails or tokens."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        start = time.perf_counter()
        status = {"code": 500}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            route = scope.get("route")
            path = getattr(route, "path", None)
            if path is None:
                path = "/mcp" if scope.get("path") == "/mcp" else "unmatched"
            state = scope.get("state", {})
            log.info(
                "request",
                method=scope.get("method"),
                route=path,
                status=status["code"],
                duration_ms=round((time.perf_counter() - start) * 1000, 1),
                workspace_id=state.get("workspace_id"),
                actor_type=state.get("actor_type"),
                key_prefix=state.get("key_prefix"),
            )


class InternalErrorMiddleware:
    """Turns an unhandled exception into the 500 envelope while the request id is still
    known, and logs only the exception type and frames (messages may carry data)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        except Exception as exc:
            log.error(
                "unhandled_exception",
                exc_type=type(exc).__name__,
                traceback=safe_traceback(exc),
            )
            if started:
                raise
            resp = JSONResponse(
                error_body("internal_error", internal_error_message()), status_code=500
            )
            await resp(scope, receive, send)
