"""Who did something (SPEC §4.7). Every service write takes an :class:`Actor`.

- Session: ``type=user``, ``user_id``, ``via=web``.
- API key on ``/v1``: ``type=agent``, ``api_key_id``, ``via=api``.
- ``/mcp``: ``type=agent``, ``api_key_id``, ``via=mcp``.
- Imports: the same actor with ``via=import`` (``actor.with_via(Via.IMPORT)``).
- Sample data and maintenance: :data:`SYSTEM_ACTOR`.

Agent name (``label``): the ``X-Agent-Name`` header when valid, else the key's
``agent_name``, else the key's name. Agent model: ``X-Agent-Model`` (≤80
printable chars), else None. User display names are resolved at read time and
are never copied into activity rows.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any
from uuid import UUID

from raisebook.models.enums import ActorType, Via

AGENT_NAME_HEADER = "X-Agent-Name"
AGENT_MODEL_HEADER = "X-Agent-Model"
AGENT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$")
MAX_LABEL = 120
MAX_MODEL = 80


@dataclass(frozen=True)
class Actor:
    type: ActorType
    via: Via
    user_id: UUID | None = None
    api_key_id: UUID | None = None
    label: str | None = None  # agent or system name; None for users
    model: str | None = None

    @property
    def is_user(self) -> bool:
        return self.type == ActorType.USER

    @property
    def is_agent(self) -> bool:
        return self.type == ActorType.AGENT

    def with_via(self, via: Via) -> Actor:
        return replace(self, via=via)

    def activity_fields(self) -> dict[str, Any]:
        """Column values for an ``activities`` (or ``import_runs``) row."""
        return {
            "actor_type": self.type.value,
            "actor_user_id": self.user_id,
            "api_key_id": self.api_key_id,
            "actor_label": self.label,
            "agent_model": self.model,
            "via": self.via.value,
        }


SYSTEM_ACTOR = Actor(ActorType.SYSTEM, Via.SYSTEM, label="raisebook")


def clean_agent_name(value: str | None) -> str | None:
    """A valid ``X-Agent-Name`` value, or None (invalid values are ignored, not errors)."""
    if value is None:
        return None
    value = value.strip()
    return value if AGENT_NAME_RE.match(value) else None


def clean_agent_model(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not value or len(value) > MAX_MODEL or not value.isprintable():
        return None
    return value


def user_actor(user_id: UUID) -> Actor:
    return Actor(ActorType.USER, Via.WEB, user_id=user_id)


def agent_actor(
    *,
    api_key_id: UUID,
    key_name: str,
    key_agent_name: str | None,
    header_name: str | None,
    header_model: str | None,
    via: Via,
) -> Actor:
    label = clean_agent_name(header_name) or key_agent_name or key_name
    return Actor(
        ActorType.AGENT,
        via,
        api_key_id=api_key_id,
        label=label[:MAX_LABEL],
        model=clean_agent_model(header_model),
    )
