"""The dossier document, ``schema_version: 1`` (RESEARCH-PLAN §4.3; R2, R5, R8, R11).

One schema for three producers and every reader:

- the pipeline's **writer model** (structured output; it cites the run's sources by id),
- an **agent** through ``save_dossier`` / ``POST /v1/investors/{id}/dossier`` (it brings its
  own ``sources``, each fetched by the agent),
- the REST and MCP readers.

``facts`` is the public layer (stored in ``dossier_facts``): professional claims, each citing
at least one source. ``analysis`` is private (stored in ``dossiers``): the Brief, the Fit
assessment, Ways in and Talking points, which point at facts through ``fact_keys``.
``unverified`` holds claims from model memory (R2), shown collapsed and marked.

Layout (R5, fixed): Brief = ``analysis.brief``; Fit = ``analysis.fit`` + facts in
``fit``/``profile``; Recent activity = facts ``activity``; Thesis & public views = facts
``thesis``; Ways in = ``analysis.ways_in``; Talking points = ``analysis.talking_points``;
Red flags = facts ``red_flags``.
"""

from __future__ import annotations

import copy
import datetime as dt
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

SCHEMA_VERSION = 1

Section = Literal["profile", "fit", "activity", "thesis", "red_flags"]
FactKind = Literal[
    "deal",
    "fund_raise",
    "partner_move",
    "post",
    "talk",
    "podcast",
    "interview",
    "check_size",
    "stage_focus",
    "sector_focus",
    "portfolio",
    "reputation",
    "fund_age",
    "role",
    "other",
]
VerdictName = Literal["strong", "possible", "poor"]
SECTIONS: tuple[str, ...] = ("profile", "fit", "activity", "thesis", "red_flags")

Key = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=60, pattern=r"^[A-Za-z0-9_.:-]+$"
    ),
]
Keys = Annotated[list[Key], Field(max_length=12)]


def _t(limit: int, min_length: int = 1) -> StringConstraints:
    return StringConstraints(strip_whitespace=True, min_length=min_length, max_length=limit)


T60 = Annotated[str, _t(60)]
T80 = Annotated[str, _t(80)]
T160 = Annotated[str, _t(160)]
T200 = Annotated[str, _t(200)]
T300 = Annotated[str, _t(300)]
T400 = Annotated[str, _t(400)]
T500 = Annotated[str, _t(500)]
T1200 = Annotated[str, _t(1200)]
T2000 = Annotated[str, _t(2000)]
E160 = Annotated[str, _t(160, 0)]  # may be empty
E200 = Annotated[str, _t(200, 0)]
E500 = Annotated[str, _t(500, 0)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DossierIdentity(_Strict):
    name: T200
    firm: T200 | None = None
    title: T200 | None = None
    linkedin_url: T500 | None = None
    firm_website: T500 | None = None


class DossierSource(_Strict):
    """A page the agent fetched (agents only; the pipeline uses its own run sources)."""

    id: Key
    url: T2000
    title: T300 | None = None
    snippet: T1200 | None = None
    published_at: dt.date | None = None
    fetched_at: dt.datetime | None = None


class Fact(_Strict):
    key: Key
    section: Section
    kind: FactKind
    text: T400
    date: dt.date | None = None
    source_ids: Annotated[list[Key], Field(max_length=10)] = []


class Brief(_Strict):
    verdict: VerdictName
    why: T160
    best_way_in: E160 = ""
    opener: E200 = ""
    risk: E160 = ""
    fact_keys: Keys = []


class Claim(_Strict):
    text: T300
    fact_keys: Keys = []


class FitAssessment(_Strict):
    stage: Claim | None = None
    sector: Claim | None = None
    check: Claim | None = None
    deploying: Claim | None = None
    conflicts: Annotated[list[Claim], Field(max_length=10)] = []


class WayIn(_Strict):
    text: T300
    basis: Literal["public", "workspace"] = "public"
    fact_keys: Keys = []


class Analysis(_Strict):
    brief: Brief
    fit: FitAssessment = FitAssessment()
    ways_in: Annotated[list[WayIn], Field(max_length=20)] = []
    talking_points: Annotated[list[Claim], Field(max_length=20)] = []


class SuggestText(_Strict):
    value: T500
    fact_keys: Keys = []


class SuggestAmount(_Strict):
    value: Annotated[int, Field(ge=0, le=10**12)]
    fact_keys: Keys = []


class SuggestList(_Strict):
    value: Annotated[list[T80], Field(min_length=1, max_length=10)]
    fact_keys: Keys = []


class SuggestType(_Strict):
    value: Literal["vc", "angel", "family_office", "corporate_vc", "accelerator", "scout"]
    fact_keys: Keys = []


class Suggestions(_Strict):
    firm: SuggestText | None = None
    title: SuggestText | None = None
    type: SuggestType | None = None
    location: SuggestText | None = None
    linkedin_url: SuggestText | None = None
    website_url: SuggestText | None = None
    email: SuggestText | None = None
    check_min: SuggestAmount | None = None
    check_max: SuggestAmount | None = None
    stage_focus: SuggestList | None = None
    industries: SuggestList | None = None


class UnverifiedClaim(_Strict):
    section: Section
    text: T400


class DossierDoc(_Strict):
    """DossierDoc v1 (RESEARCH-PLAN §4.3)."""

    schema_version: Literal[1] = 1
    identity: DossierIdentity
    sources: Annotated[list[DossierSource], Field(max_length=60)] = []
    facts: Annotated[list[Fact], Field(max_length=80)] = []
    analysis: Analysis
    suggestions: Suggestions = Suggestions()
    unverified: Annotated[list[UnverifiedClaim], Field(max_length=30)] = []


class WriterDoc(_Strict):
    """What the writer model returns: a DossierDoc without ``sources`` (it cites ours)."""

    schema_version: Literal[1] = 1
    identity: DossierIdentity
    facts: Annotated[list[Fact], Field(max_length=80)] = []
    analysis: Analysis
    suggestions: Suggestions = Suggestions()
    unverified: Annotated[list[UnverifiedClaim], Field(max_length=30)] = []


class CompanyProfileDraft(_Strict):
    """What the prefill call returns (R6: the model drafts, the founder edits and saves)."""

    pitch: E200 | None = None
    sectors: Annotated[list[T60], Field(max_length=10)] = []
    stage: Literal["pre-seed", "seed", "series-a", "series-b+", "other"] | None = None
    location: E200 | None = None
    traction: Annotated[list[T200], Field(max_length=3)] = []
    wants_lead: Literal["lead", "follow", "either"] | None = None
    check_min: Annotated[int, Field(ge=0, le=10**12)] | None = None
    check_max: Annotated[int, Field(ge=0, le=10**12)] | None = None
    strategic_help: E500 | None = None


# --- JSON schema for structured outputs ----------------------------------------------------

# Keywords some providers reject in strict mode; our own Pydantic validation enforces them.
_DROP_KEYWORDS = (
    "default",
    "title",
    "maxLength",
    "minLength",
    "maxItems",
    "minItems",
    "pattern",
    "format",
    "maximum",
    "minimum",
    "description",
)


def _strictify(node: Any) -> Any:
    if isinstance(node, list):
        return [_strictify(n) for n in node]
    if not isinstance(node, dict):
        return node
    out = {k: _strictify(v) for k, v in node.items() if k not in _DROP_KEYWORDS}
    if out.get("type") == "object" and "properties" in out:
        out["required"] = list(out["properties"])
        out["additionalProperties"] = False
    return out


def strict_json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """``model``'s JSON schema shaped for ``response_format: json_schema, strict: true``:
    every property required (optional ones are nullable), no extra keys."""
    out: dict[str, Any] = _strictify(copy.deepcopy(model.model_json_schema()))
    return out


def response_format(name: str, model: type[BaseModel]) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {"name": name, "strict": True, "schema": strict_json_schema(model)},
    }


WRITER_FORMAT_NAME = "raisebook_dossier_v1"
PREFILL_FORMAT_NAME = "raisebook_company_profile_v1"


def inline_schema(model: type[BaseModel]) -> dict[str, Any]:
    """``model``'s JSON schema with every ``$ref`` inlined (for a nested tool argument)."""
    raw = model.model_json_schema()
    defs = raw.pop("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(n) for n in node]
        if not isinstance(node, dict):
            return node
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            return walk(copy.deepcopy(defs[ref.removeprefix("#/$defs/")]))
        return {k: walk(v) for k, v in node.items() if k != "title"}

    out: dict[str, Any] = walk(raw)
    return out
