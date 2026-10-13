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
    RESEARCH = "research"  # system kind: a saved dossier or a confirmed identity


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


# --- Investor research (docs/RESEARCH-PLAN.md §1) -------------------------------------------


class AiPreset(StrEnum):
    BEST = "best"
    BALANCED = "balanced"
    BUDGET = "budget"
    CUSTOM = "custom"


class ResearchKind(StrEnum):
    IDENTITY = "identity"
    DOSSIER = "dossier"
    REFRESH = "refresh"
    PREFILL = "prefill"
    AGENT = "agent"


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELLED = "cancelled"
    CAPPED = "capped"
    BLOCKED_IDENTITY = "blocked_identity"


ACTIVE_RUN_STATUSES: tuple[RunStatus, ...] = (RunStatus.QUEUED, RunStatus.RUNNING)


class IdentityStatus(StrEnum):
    NONE = "none"
    PENDING = "pending"
    MATCHED = "matched"
    CONFIRMED = "confirmed"
    NEEDS_PICK = "needs_pick"
    NOT_FOUND = "not_found"
    REJECTED = "rejected"


class IdentitySource(StrEnum):
    AUTO = "auto"
    USER = "user"
    AGENT = "agent"
    EXISTING = "existing"


class Verdict(StrEnum):
    STRONG = "strong"
    POSSIBLE = "possible"
    POOR = "poor"


class SuggestionStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    IGNORED = "ignored"
    AUTO_APPLIED = "auto_applied"
    SUPERSEDED = "superseded"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class RemovalStatus(StrEnum):
    UNVERIFIED = "unverified"
    VERIFIED = "verified"
    APPLIED = "applied"
    REJECTED = "rejected"


class AnchorMatch(StrEnum):
    LINKEDIN = "linkedin"
    FIRM_DOMAIN = "firm_domain"
    NAME_FIRM = "name_firm"
    NAME_TITLE = "name_title"


class CompanyStage(StrEnum):
    PRE_SEED = "pre-seed"
    SEED = "seed"
    SERIES_A = "series-a"
    SERIES_B_PLUS = "series-b+"
    OTHER = "other"


class WantsLead(StrEnum):
    LEAD = "lead"
    FOLLOW = "follow"
    EITHER = "either"


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
