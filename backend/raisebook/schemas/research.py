"""Research REST shapes (RESEARCH-PLAN §6.3 to §6.5). Money is float USD (6 decimals)."""

from __future__ import annotations

import datetime as dt
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, WithJsonSchema, model_validator

from raisebook.schemas.common import StrictInput, Timestamp
from raisebook.schemas.dossier import DossierDoc, inline_schema

DossierArg = Annotated[dict[str, Any], WithJsonSchema(inline_schema(DossierDoc))]

RunKindIn = Literal["identity", "dossier", "refresh"]


class StartResearchIn(StrictInput):
    kind: RunKindIn = "dossier"
    round: str | None = Field(
        None,
        max_length=200,
        description="Round id, slug or name: the dossier's Fit compares to it.",
    )


class StepOut(BaseModel):
    key: str
    label: str
    state: Literal["pending", "running", "done", "skipped", "failed"]


class ProgressOut(BaseModel):
    step: str | None = None
    steps: list[StepOut] = []
    done: int = 0
    total: int = 0
    sources_accepted: int | None = None
    privacy_removed: int | None = None


class RunError(BaseModel):
    code: str
    message: str | None = None


class SourceCounts(BaseModel):
    gathered: int = 0
    accepted: int = 0


class RunBy(BaseModel):
    type: str
    label: str | None = None
    via: str


class RunModels(BaseModel):
    identity: str | None = None
    search: str | None = None
    writer: str | None = None


class RunOut(BaseModel):
    id: UUID
    investor_id: UUID | None = None
    round_id: UUID | None = None
    batch_id: UUID | None = None
    kind: str
    status: str
    preset: str | None = None
    models: RunModels
    estimate_usd: float | None = None
    cost_usd: float | None = None
    progress: ProgressOut
    error: RunError | None = None
    dossier_id: UUID | None = None
    result: dict[str, Any] | None = Field(
        None,
        description="identity: {identity: {status, candidates, confidence}}; dossier: "
        "{dossier_id, version, facts, moved_to_unverified, dropped, new_facts, writeback}; "
        "prefill: {draft, website_url, deck_filename}.",
    )
    sources: SourceCounts
    can_resume: bool
    by: RunBy
    created_at: Timestamp
    started_at: Timestamp | None = None
    finished_at: Timestamp | None = None


class RunStartedOut(BaseModel):
    run: RunOut
    estimate_usd: float | None = None
    created: bool


class RunPage(BaseModel):
    data: list[RunOut]
    next_cursor: str | None = None


# --- identity -----------------------------------------------------------------------------------


class CandidateSource(BaseModel):
    id: UUID
    url: str
    domain: str
    title: str | None = None


class CandidateOut(BaseModel):
    id: UUID
    rank: int
    name: str
    title: str | None = None
    firm: str | None = None
    linkedin_url: str | None = None
    firm_website: str | None = None
    confidence: float
    confidence_label: Literal["likely", "possible", "unlikely"]
    picked: bool | None = None
    sources: list[CandidateSource] = []


class IdentityOut(BaseModel):
    investor_id: UUID
    status: Literal[
        "none", "pending", "matched", "confirmed", "needs_pick", "not_found", "rejected"
    ]
    source: str | None = None
    linkedin_url: str | None = None
    firm: str | None = None
    firm_website: str | None = None
    title: str | None = None
    confidence: float | None = None
    confirmed_at: Timestamp | None = None
    candidates: list[CandidateOut] = []
    active_run: dict[str, Any] | None = None


class IdentityPickIn(StrictInput):
    """Exactly one of: ``candidate_id``, ``rank`` (1 to 3), ``none: true``, ``linkedin_url``."""

    candidate_id: UUID | None = None
    rank: int | None = Field(None, ge=1, le=3)
    none: bool = False
    linkedin_url: str | None = Field(None, max_length=500)
    firm_website: str | None = Field(None, max_length=500)
    title: str | None = Field(None, max_length=200)

    @model_validator(mode="after")
    def _one(self) -> IdentityPickIn:
        chosen = [
            self.candidate_id is not None,
            self.rank is not None,
            self.none,
            self.linkedin_url is not None,
        ]
        if sum(chosen) != 1:
            raise ValueError("Send exactly one of candidate_id, rank, none or linkedin_url.")
        return self


# --- dossiers -----------------------------------------------------------------------------------


class AuthorOut(BaseModel):
    kind: Literal["model", "agent"]
    label: str
    by: str | None = Field(None, description='"by <agent-name>" for agent dossiers (R11).')


class DossierOut(BaseModel):
    id: UUID
    investor_id: UUID
    version: int
    schema_version: int
    verdict: Literal["strong", "possible", "poor"]
    analysis: dict[str, Any] = Field(
        description="{brief: {verdict, why, best_way_in, opener, risk, fact_keys}, fit: {stage?, "
        "sector?, check?, deploying?, conflicts}, ways_in: [{text, basis, fact_keys}], "
        "talking_points: [{text, fact_keys}]}; every claim's fact_keys point at `facts`."
    )
    unverified: list[dict[str, Any]] = Field(
        description="[{section, text}]: from model memory, not cited (R2). Show collapsed."
    )
    new_fact_keys: list[str] = []
    round_id: UUID | None = None
    run_id: UUID | None = None
    created_at: Timestamp
    as_of: dt.date | None = None
    identity: dict[str, Any] = {}
    cost_usd: float | None = None


class FactOut(BaseModel):
    key: str
    section: Literal["profile", "fit", "activity", "thesis", "red_flags"]
    kind: str
    text: str
    date: str | None = None
    source_ids: list[str]


class SourceOut(BaseModel):
    id: UUID
    url: str
    domain: str
    title: str | None = None
    published_at: dt.date | None = None
    matched_anchor: str | None = None


class SuggestionOut(BaseModel):
    id: UUID
    investor_id: UUID
    round_id: UUID | None = None
    dossier_id: UUID | None = None
    field: str
    current_value: Any = None
    suggested_value: Any = None
    status: str
    created_at: Timestamp
    decided_at: Timestamp | None = None


class DossierViewOut(BaseModel):
    dossier: DossierOut
    facts: list[FactOut]
    sources: list[SourceOut] = Field(description="Cited sources only.")
    author: AuthorOut
    new_since: Timestamp | None = Field(
        None, description="The previous version's date: show its new_fact_keys first (R10)."
    )
    stale: bool = Field(description="Older than 90 days: 'may be stale'.")
    age_days: int
    refresh_offer: bool = Field(
        description="In a Meeting stage with a dossier older than 30 days: offer a refresh."
    )
    suggestions: list[SuggestionOut] = Field(description="Pending suggestions for this investor.")


class DossierVersionOut(BaseModel):
    id: UUID
    version: int
    verdict: str
    created_at: Timestamp
    author: AuthorOut


class SaveDossierIn(StrictInput):
    dossier: DossierArg = Field(
        description="A DossierDoc v1 (validated by the same rules as model dossiers)."
    )
    round: str | None = Field(None, max_length=200)
    idempotency_key: str | None = Field(None, max_length=200)


class SaveDossierOut(BaseModel):
    dossier_id: UUID
    version: int
    by: str
    kept: dict[str, int]
    dropped: list[dict[str, str]] = []
    sources_rejected: list[dict[str, Any]] = []
    privacy_removed: int = 0
    suggestions: dict[str, int] = {}
    new_facts: int = 0
    repeated: bool = False


# --- bulk, usage, suggestions ---------------------------------------------------------------------


class EstimateIn(StrictInput):
    kind: Literal["identity", "dossier"] = "dossier"
    investor_ids: list[UUID] | None = Field(None, max_length=1000)
    round: str | None = Field(None, max_length=200)


class EstimateOut(BaseModel):
    kind: str
    count: int = Field(description="Investors that would be researched.")
    skipped: dict[str, int] = Field(
        description="{no_identity, suppressed, fresh, active}: left out, and why."
    )
    per_run_usd: float | None
    total_usd: float | None
    remaining_usd: float | None = Field(description="Left under this month's cap.")
    fits: int = Field(description="How many fit under the remaining cap.")


class BatchIn(StrictInput):
    kind: Literal["identity", "dossier"] = "dossier"
    investor_ids: list[UUID] | None = Field(None, max_length=500)
    round: str | None = Field(None, max_length=200)
    confirm_usd: float = Field(..., ge=0, description="The total the person confirmed.")
    allow_partial: bool = False


class BatchOut(BaseModel):
    id: UUID
    kind: str
    round_id: UUID | None = None
    total: int
    counts: dict[str, int] = Field(description="Runs by status.")
    active: int
    estimate_usd: float | None = None
    spent_usd: float | None = None
    created_at: Timestamp


class BatchStartedOut(BaseModel):
    batch: BatchOut
    runs: int


class CancelledOut(BaseModel):
    cancelled: int


class UsageReportOut(BaseModel):
    month: str
    spent_usd: float | None
    reserved_usd: float | None
    calls: int
    cap_usd: float | None
    remaining_usd: float | None
    by_kind: dict[str, dict[str, Any]]


class AcceptAllIn(StrictInput):
    investor_ids: list[UUID] | None = Field(None, max_length=1000)
    round: str | None = Field(None, max_length=200)


class AcceptAllOut(BaseModel):
    accepted: int
    skipped: list[dict[str, str]] = []
    bulk_id: UUID


class SuggestionPage(BaseModel):
    data: list[SuggestionOut]


class ActiveRunBrief(BaseModel):
    id: UUID
    kind: str
    status: str


class ResearchSummaryOut(BaseModel):
    identity_status: str
    verdict: str | None = None
    dossier_at: Timestamp | None = None
    dossier_author: dict[str, str] | None = None
    stale: bool = False
    pending_suggestions: int = 0
    active_run: ActiveRunBrief | None = None
    refresh_offer: bool = False
    from_research: list[str] = Field(
        [], description="Fields whose value research filled in (show a 'from research' mark)."
    )


class RoundResearchRow(ResearchSummaryOut):
    investor_id: UUID


# --- the Research Policy (public) -----------------------------------------------------------------


class RemovalRequestIn(StrictInput):
    name: str = Field(..., min_length=1, max_length=200)
    email: str = Field(..., min_length=3, max_length=254)
    linkedin_url: str | None = Field(None, max_length=500)
    firm: str | None = Field(None, max_length=200)
    message: str | None = Field(None, max_length=2000)


class RemovalVerifyIn(StrictInput):
    token: str = Field(..., min_length=10, max_length=200)


class AcceptedOut(BaseModel):
    ok: bool = True
    message: str
