"""Shared MCP argument types: descriptions an LLM reads in ``tools/list``, and lenient
parsing for the values agents actually send (``"VC"``, ``"Family Office"``, ``"250k"``).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BeforeValidator, Field

from raisebook.core.errors import ValidationFailed
from raisebook.services.normalize import parse_investor_type, parse_money

INVESTOR_TYPE_VALUES = (
    "vc",
    "angel",
    "family_office",
    "corporate_vc",
    "accelerator",
    "scout",
    "other",
)


def _investor_type(value: Any) -> Any:
    if isinstance(value, str) and value.strip():
        try:
            return parse_investor_type(value)
        except ValidationFailed:
            return value  # let the Literal report the allowed values
    return value


def parse_amount_arg(value: Any) -> Any:
    if isinstance(value, str) and value.strip():
        parsed = parse_money(value)
        return parsed if parsed is not None else value
    if isinstance(value, float) and value >= 0:
        return round(value)
    return value


def _lower(value: Any) -> Any:
    return value.strip().lower() if isinstance(value, str) else value


InvestorType = Annotated[
    Literal["vc", "angel", "family_office", "corporate_vc", "accelerator", "scout", "other"],
    BeforeValidator(_investor_type),
    Field(
        description="vc, angel, family_office, corporate_vc, accelerator, scout or other "
        '(labels such as "VC" or "Family Office" are accepted). Leave out when unknown.'
    ),
]
InvestorArg = Annotated[
    str,
    Field(
        description='Investor id, email, LinkedIn URL, exact "Name", or "Name @ Firm".',
        min_length=1,
        max_length=500,
    ),
]
RoundArg = Annotated[
    str | None,
    Field(
        description="Round id, slug or name. Omit when the workspace has exactly one open "
        "round, or when the investor is in exactly one of the open rounds.",
        max_length=200,
    ),
]
RoundOpt = Annotated[str | None, Field(description="Round id, slug or name.", max_length=200)]
Str200 = Annotated[str | None, Field(max_length=200)]
Url = Annotated[str | None, Field(max_length=500)]
Amount = Annotated[
    int | None,
    BeforeValidator(parse_amount_arg),
    Field(ge=0, description="Whole currency units (250000 = $250k; '250k' and '$1.5M' work)."),
]
Fit = Annotated[
    int | None,
    Field(
        ge=0,
        le=5,
        description="How good a fit for this round: 0 = unrated; 1-5 (5 hot, 4 warm, 3 maybe, "
        "1-2 low).",
    ),
]
Probability = Annotated[
    int | None,
    Field(ge=0, le=100, description="Chance they invest (0-100), for the weighted pipeline."),
]
DateArg = Annotated[str | None, Field(description="YYYY-MM-DD", max_length=10)]
Tags = Annotated[list[str] | None, Field(max_length=30)]
LoggableKind = Annotated[
    Literal["note", "email", "call", "meeting"],
    BeforeValidator(_lower),
    Field(description="note, email, call or meeting."),
]
Email = Annotated[
    str | None,
    Field(max_length=254, description="Email address. Used to find duplicates."),
]
LinkedIn = Annotated[
    str | None,
    Field(max_length=500, description="LinkedIn profile URL. Used to find duplicates."),
]
CheckNote = Annotated[
    str | None,
    Field(
        max_length=200,
        description='Check size as written, e.g. "$250k-$1M, leads". Parsed into '
        "check_min/check_max when those are not given.",
    ),
]
StageArg = Annotated[str | None, Field(description="Stage key or label (see get_workspace).")]
