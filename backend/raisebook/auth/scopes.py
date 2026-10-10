"""Raisebook scopes (SPEC §4.5): one definition for issuers and enforcers.

Every key includes ``raisebook:read``; ``raisebook:admin`` also requires
``raisebook:write``. Session users get scopes from their role.
"""

from __future__ import annotations

from collections.abc import Iterable

from raisebook.models.enums import Role

SCOPE_READ = "raisebook:read"
SCOPE_WRITE = "raisebook:write"
SCOPE_ADMIN = "raisebook:admin"

ALL_SCOPES: tuple[str, ...] = (SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN)
SUPPORTED_SCOPES = frozenset(ALL_SCOPES)
_SHORT = {s.split(":", 1)[1]: s for s in ALL_SCOPES}

ROLE_SCOPES: dict[Role, frozenset[str]] = {
    Role.OWNER: frozenset(ALL_SCOPES),
    Role.EDITOR: frozenset({SCOPE_READ, SCOPE_WRITE}),
    Role.VIEWER: frozenset({SCOPE_READ}),
}


class InvalidScope(ValueError):
    pass


def canonical_order(scopes: Iterable[str]) -> list[str]:
    wanted = set(scopes)
    return [s for s in ALL_SCOPES if s in wanted]


def parse_scopes(raw: Iterable[str] | str) -> list[str]:
    """Parse full (``raisebook:write``) or short (``write``) names; unknown names raise."""
    items = raw.replace(",", " ").split() if isinstance(raw, str) else list(raw)
    out: list[str] = []
    for item in items:
        name = item.strip()
        if not name:
            continue
        full = name if name in SUPPORTED_SCOPES else _SHORT.get(name.lower())
        if full is None:
            raise InvalidScope(
                f"Unknown scope {name!r}. Use raisebook:read, raisebook:write or raisebook:admin."
            )
        out.append(full)
    return canonical_order(out)


def key_scopes(raw: Iterable[str] | str) -> list[str]:
    """Scopes to store on a new key: read is always added; admin needs write."""
    parsed = set(parse_scopes(raw))
    parsed.add(SCOPE_READ)
    if SCOPE_ADMIN in parsed and SCOPE_WRITE not in parsed:
        raise InvalidScope("raisebook:admin requires raisebook:write. Add both scopes.")
    return canonical_order(parsed)


def granted_scopes(stored: Iterable[str] | None) -> frozenset[str]:
    """Scopes a stored grant actually confers. NULL or unknown names confer nothing."""
    if not stored:
        return frozenset()
    return frozenset(s for s in stored if s in SUPPORTED_SCOPES)


def missing_scopes(granted: Iterable[str], *required: str) -> list[str]:
    g = set(granted)
    return [r for r in required if r not in g]
