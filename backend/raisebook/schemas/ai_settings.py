"""AI research settings and company profile schemas (RESEARCH-PLAN §6.1, §6.2)."""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import (
    BaseModel,
    Field,
    SecretStr,
    StringConstraints,
    field_validator,
    model_validator,
)

from raisebook.models.enums import AiPreset, CompanyStage, WantsLead
from raisebook.schemas.common import StrictInput, Timestamp

ModelId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=200)]


class AiKeyIn(StrictInput):
    key: SecretStr = Field(..., description="The workspace's OpenRouter key (sk-or-…).")


class AiSettingsUpdate(StrictInput):
    preset: AiPreset | None = None
    identity_model: ModelId | None = None
    search_model: ModelId | None = None
    writer_model: ModelId | None = None
    monthly_cap_usd: Decimal | None = Field(None, ge=0, le=10_000, decimal_places=2)


class UsageOut(BaseModel):
    month: str  # YYYY-MM, in the workspace timezone
    spent_usd: float
    reserved_usd: float
    remaining_usd: float
    calls: int


class EstimatesOut(BaseModel):
    """≈ USD per dossier for each preset and for one identity match (None: no price known)."""

    best: float | None
    balanced: float | None
    budget: float | None
    current: float | None
    identity: float | None


class PresetOut(BaseModel):
    id: Literal["best", "balanced", "budget"]
    label: str
    identity_model: str
    search_model: str
    writer_model: str
    dossier_usd: float | None


class AiSettingsOut(BaseModel):
    """Never contains the key: ``key_last4`` is the only part ever shown (R12)."""

    has_key: bool
    key_status: Literal["none", "ok", "unreadable"]
    key_last4: str | None
    key_label: str | None
    key_set_at: Timestamp | None
    key_validated_at: Timestamp | None
    preset: AiPreset
    identity_model: str
    search_model: str
    writer_model: str
    models_verified_at: Timestamp | None
    monthly_cap_usd: float
    usage: UsageOut
    estimates: EstimatesOut
    presets: list[PresetOut]
    kek_configured: bool
    research_available: bool
    can_manage_key: bool  # owner signed in to the web
    can_edit: bool  # raisebook:admin


class ModelOut(BaseModel):
    id: str
    name: str
    prompt_per_mtok_usd: float
    completion_per_mtok_usd: float
    web_search_usd: float
    context_length: int | None
    supports_structured: bool
    supports_file: bool
    native_search: bool


# --- company profile ---------------------------------------------------------------------

_MAX_MONEY = 10**12
_SPACES = re.compile(r"\s+")


def _line(value: str | None) -> str | None:
    if value is None:
        return None
    out = _SPACES.sub(" ", value).strip()
    return out or None


class CompanyProfileIn(StrictInput):
    """A full replace (PUT). Every field is optional; empty strings clear a field."""

    pitch: str | None = Field(None, max_length=200, description="One-line pitch.")
    sectors: list[Annotated[str, StringConstraints(max_length=60)]] = Field(
        default_factory=list, max_length=10
    )
    stage: CompanyStage | None = None
    location: str | None = Field(None, max_length=200)
    traction: list[Annotated[str, StringConstraints(max_length=200)]] = Field(
        default_factory=list, max_length=3, description="Up to three traction points."
    )
    wants_lead: WantsLead | None = Field(None, description="Looking for a lead, followers, either.")
    check_min: int | None = Field(None, ge=0, le=_MAX_MONEY)
    check_max: int | None = Field(None, ge=0, le=_MAX_MONEY)
    strategic_help: str | None = Field(None, max_length=500)
    website_url: str | None = Field(None, max_length=500)

    @field_validator("pitch", "location", "strategic_help", "website_url", mode="after")
    @classmethod
    def _blank_is_none(cls, v: str | None) -> str | None:
        return _line(v)

    @field_validator("sectors", "traction", mode="after")
    @classmethod
    def _clean_list(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for item in v:
            line = _line(item)
            if line and line.lower() not in seen:
                seen.add(line.lower())
                out.append(line)
        return out

    @field_validator("website_url", mode="after")
    @classmethod
    def _http_url(cls, v: str | None) -> str | None:
        if v is None:
            return None
        url = v if "://" in v else f"https://{v}"
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or "." not in parts.hostname:
            raise ValueError("Use a web address like https://example.com.")
        return url

    @model_validator(mode="after")
    def _check_range(self) -> CompanyProfileIn:
        if self.check_min is not None and self.check_max is not None:
            if self.check_min > self.check_max:
                raise ValueError("check_min must not be more than check_max.")
        return self


class CompanyProfileOut(BaseModel):
    pitch: str | None
    sectors: list[str]
    stage: CompanyStage | None
    location: str | None
    traction: list[str]
    wants_lead: WantsLead | None
    check_min: int | None
    check_max: int | None
    currency: str  # the workspace currency (check range is in whole units of it)
    strategic_help: str | None
    website_url: str | None
    deck_filename: str | None
    prefilled_at: Timestamp | None
    updated_at: Timestamp | None
    is_empty: bool
