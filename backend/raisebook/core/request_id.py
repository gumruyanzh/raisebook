"""Request-ID propagation (pure ASGI middleware + contextvar).

Accept an upstream ``X-Request-ID`` if it is short and ``[A-Za-z0-9_-]``, otherwise
mint ``req_<uuid4 hex>``; expose it through :func:`get_request_id`, bind it into the
structlog context and echo it on every response.
"""

from __future__ import annotations

import uuid
from contextvars import ContextVar

import structlog
from starlette.types import ASGIApp, Message, Receive, Scope, Send

HEADER = "x-request-id"
_request_id: ContextVar[str | None] = ContextVar("raisebook_request_id", default=None)


def get_request_id() -> str | None:
    return _request_id.get()


def new_request_id() -> str:
    return "req_" + uuid.uuid4().hex


def _valid(value: str) -> bool:
    return 0 < len(value) <= 64 and all(c.isalnum() or c in "-_" for c in value)


class RequestIDMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = None
        for name, value in scope.get("headers", []):
            if name == HEADER.encode():
                incoming = value.decode("latin-1")
                break
        rid = incoming if incoming and _valid(incoming) else new_request_id()
        token = _request_id.set(rid)
        structlog.contextvars.bind_contextvars(request_id=rid)
        scope.setdefault("state", {})["request_id"] = rid

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((HEADER.encode(), rid.encode()))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            structlog.contextvars.unbind_contextvars("request_id")
            _request_id.reset(token)
