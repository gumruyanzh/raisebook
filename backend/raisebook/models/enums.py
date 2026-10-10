"""Enumerations stored as ``text`` + ``CHECK`` (no Postgres enum types), SPEC §3."""

from __future__ import annotations

from enum import StrEnum


class Role(StrEnum):
    OWNER = "owner"
    EDITOR = "editor"
    VIEWER = "viewer"


class KeyMode(StrEnum):
    LIVE = "live"
    TEST = "test"


class RoundStatus(StrEnum):
    OPEN = "open"
    CLOSED = "closed"


class Instrument(StrEnum):
    SAFE = "safe"
    PRICED = "priced"
    CONVERTIBLE_NOTE = "convertible_note"
    OTHER = "other"


class StageColor(StrEnum):
    SLATE = "slate"
    VIOLET = "violet"
    COBALT = "cobalt"
    TEAL = "teal"
    AMBER = "amber"
    ORANGE = "orange"
    GREEN = "green"
    GRAY = "gray"
    OLIVE = "olive"
    SKY = "sky"


class StageKind(StrEnum):
    OPEN = "open"
    ACTIVE = "active"
    WON = "won"
    LOST = "lost"


class InvestorType(StrEnum):
    VC = "vc"
    ANGEL = "angel"
    FAMILY_OFFICE = "family_office"
    CORPORATE_VC = "corporate_vc"
    ACCELERATOR = "accelerator"
    SCOUT = "scout"
    OTHER = "other"


class ActivityKind(StrEnum):
    NOTE = "note"
    EMAIL = "email"
    CALL = "call"
    MEETING = "meeting"
    STAGE_CHANGE = "stage_change"
    FOLLOW_UP_SET = "follow_up_set"
    COMMITMENT = "commitment"
    INVESTOR_CREATED = "investor_created"
    INVESTOR_UPDATED = "investor_updated"
    ADDED_TO_ROUND = "added_to_round"
    REMOVED_FROM_ROUND = "removed_from_round"
    PARTICIPANT_UPDATED = "participant_updated"


# Kinds a person or agent logs by hand (deletable, SPEC §8.1).
LOGGABLE_ACTIVITY_KINDS: tuple[ActivityKind, ...] = (
    ActivityKind.NOTE,
    ActivityKind.EMAIL,
    ActivityKind.CALL,
    ActivityKind.MEETING,
)


class ActorType(StrEnum):
    USER = "user"
    AGENT = "agent"
    SYSTEM = "system"


class Via(StrEnum):
    WEB = "web"
    API = "api"
    MCP = "mcp"
    IMPORT = "import"
    SYSTEM = "system"


class ImportFormat(StrEnum):
    CSV = "csv"
    PROTOTYPE_JSON = "prototype_json"


# Display labels (SPEC §3.8), shared by API docs, web and CSV.
INVESTOR_TYPE_LABELS: dict[str, str] = {
    "vc": "VC",
    "angel": "Angel",
    "family_office": "Family Office",
    "corporate_vc": "Corporate VC",
    "accelerator": "Accelerator",
    "scout": "Scout",
    "other": "Other",
}
INSTRUMENT_LABELS: dict[str, str] = {
    "safe": "SAFE",
    "priced": "Priced round",
    "convertible_note": "Convertible note",
    "other": "Other",
}
ROUND_STATUS_LABELS: dict[str, str] = {"open": "Open", "closed": "Closed"}
ROLE_LABELS: dict[str, str] = {"owner": "Owner", "editor": "Editor", "viewer": "Viewer"}
ACTIVITY_KIND_LABELS: dict[str, str] = {
    "note": "Note",
    "email": "Email",
    "call": "Call",
    "meeting": "Meeting",
}


def values(enum: type[StrEnum]) -> list[str]:
    return [m.value for m in enum]
