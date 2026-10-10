"""The injectable clock (SPEC §9.1).

Every piece of logic takes ``now`` from here (or as an argument), never from
``datetime.now()``. FastAPI routes depend on :func:`get_now`; tests freeze it with
:func:`freeze` (the ``frozen_now`` fixture) or ``app.dependency_overrides[get_now]``.
The MCP tool clock (``raisebook.mcp.tools._common.Clock``) delegates here too.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

_frozen: datetime | None = None


def get_now() -> datetime:
    """The current time (UTC, timezone-aware). FastAPI dependency."""
    return _frozen if _frozen is not None else datetime.now(UTC)


def freeze(at: datetime | None) -> None:
    """Freeze the clock at ``at`` (aware datetime), or unfreeze with ``None``. Tests only."""
    global _frozen
    if at is not None and at.tzinfo is None:
        raise ValueError("freeze() needs a timezone-aware datetime")
    _frozen = at


def today_in(tz: str, now: datetime | None = None) -> date:
    """Today's date in the IANA timezone ``tz`` (workspace dates are local dates)."""
    return (now or get_now()).astimezone(ZoneInfo(tz)).date()
