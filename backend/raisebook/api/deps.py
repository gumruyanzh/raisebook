"""Shared FastAPI dependencies for route modules (import from here).

- ``get_session``: the request's DB session (handlers commit explicitly).
- ``get_now``: the injectable clock.
- ``get_principal`` / ``require_scopes(...)`` / ``require_owner_session()``.
- ``get_workspace_ctx`` (read) / ``get_write_ctx`` (write) / ``workspace_ctx(*scopes)``:
  a ``WorkspaceContext`` to pass to services (workspace id, tz, currency, principal, actor).
- ``get_session_user``: org-less, session-only endpoints.
- ``rate_limit(kind)``: extra buckets (``import``, ``export``, ``invite``, ``anon_ip``).
- ``get_email_sender``: outbound email.
"""

from __future__ import annotations

from raisebook.auth.principal import (
    Principal,
    SessionUser,
    WorkspaceContext,
    get_principal,
    get_session_user,
    get_workspace_ctx,
    get_write_ctx,
    request_actor,
    require_owner_session,
    require_scopes,
    workspace_ctx,
)
from raisebook.core.clock import get_now
from raisebook.core.database import get_session
from raisebook.core.ratelimit import rate_limit
from raisebook.services.email import get_email_sender

__all__ = [
    "Principal",
    "SessionUser",
    "WorkspaceContext",
    "get_email_sender",
    "get_now",
    "get_principal",
    "get_session",
    "get_session_user",
    "get_workspace_ctx",
    "get_write_ctx",
    "rate_limit",
    "request_actor",
    "require_owner_session",
    "require_scopes",
    "workspace_ctx",
]
