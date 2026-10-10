"""FastAPI app factory: ``uvicorn --factory raisebook.main:create_app``.

Serves the REST API under ``/v1`` (OpenAPI at ``/v1/openapi.json``; Swagger UI at
``/docs`` in development only, since it loads assets from a CDN), the MCP server at
``/mcp`` and the health probes.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware

from raisebook import __version__
from raisebook.api.router import include_api_routers
from raisebook.auth.session import (
    CSRF_HEADER,
    WORKSPACE_HEADER,
    SessionRefreshMiddleware,
    allowed_origins,
    session_key,
)
from raisebook.config import Settings, get_settings
from raisebook.core.actor import AGENT_MODEL_HEADER, AGENT_NAME_HEADER
from raisebook.core.database import dispose_engine
from raisebook.core.errors import install_error_handlers
from raisebook.core.logging import configure_logging
from raisebook.core.middleware import (
    AccessLogMiddleware,
    BodySizeLimitMiddleware,
    InternalErrorMiddleware,
)
from raisebook.core.ratelimit import RateLimitHeadersMiddleware
from raisebook.core.request_id import RequestIDMiddleware
from raisebook.mcp.server import add_mcp_route, create_mcp_server

DESCRIPTION = (
    "Raisebook is a free-forever, open-source fundraising CRM. Authenticate with an API key "
    "(`Authorization: Bearer rb_live_…`) or the web session cookie. Errors use the envelope "
    '`{"error": {code, message, details, request_id}}`. The MCP server is at `/mcp`.'
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Starlette does not run the lifespan of route endpoints: the MCP session manager's
    # task group must be entered here or every /mcp request fails.
    async with app.state.mcp_server.session_manager.run():
        yield
    await dispose_engine()


def create_app(
    settings: Settings | None = None, *, api_modules: list[str] | None = None
) -> FastAPI:
    s = settings or get_settings()
    configure_logging(s.log_level, json=s.log_json)
    session_key(s)  # fail fast: staging/production need RAISEBOOK_SESSION_SECRET
    app = FastAPI(
        title="Raisebook API",
        version=__version__,
        description=DESCRIPTION,
        openapi_url="/v1/openapi.json",
        docs_url="/docs" if s.is_dev else None,
        redoc_url=None,
        lifespan=lifespan,
        license_info={"name": "AGPL-3.0-only", "identifier": "AGPL-3.0-only"},
    )
    install_error_handlers(app)
    app.add_middleware(BodySizeLimitMiddleware)
    app.add_middleware(RateLimitHeadersMiddleware)
    app.add_middleware(SessionRefreshMiddleware)
    app.add_middleware(InternalErrorMiddleware)
    app.add_middleware(AccessLogMiddleware)
    app.add_middleware(RequestIDMiddleware)  # request id visible to everything below
    # Outermost: the web app (RAISEBOOK_APP_URL) calls /v1 with the session cookie.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins(s),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Idempotency-Key",
            "X-API-Key",
            "X-Request-ID",
            CSRF_HEADER,
            WORKSPACE_HEADER,
            AGENT_NAME_HEADER,
            AGENT_MODEL_HEADER,
        ],
        expose_headers=[
            "X-Request-ID",
            "Retry-After",
            "RateLimit-Limit",
            "RateLimit-Remaining",
            "RateLimit-Reset",
            "Content-Disposition",
        ],
        max_age=600,
    )
    include_api_routers(app, api_modules)
    mcp_server = create_mcp_server()
    add_mcp_route(app, mcp_server)
    app.state.mcp_server = mcp_server
    return app
