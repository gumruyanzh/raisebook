"""Investor schemas (SPEC §5.3 ``InvestorCompact``, ``Investor``; §5.7). Owner: API+MCP (AM)."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

from raisebook.schemas.common import StrictInput, Timestamp
from raisebook.schemas.rounds import StageOut

OnDuplicate = Literal["return_existing", "fill_empty", "create_anyway"]
MatchedOnName = Literal["email", "linkedin", "name_firm"]


class InvestorCompact(BaseModel):
    id: UUID
    name: str
    firm: str | None = None
    title: str | None = None
    type: str
    email: str | None = None
    linkedin_url: str | None = None
    tags: list[str] = []


class ParticipationBrief(BaseModel):
    round_id: UUID
    round_slug: str
    round_name: str
    stage: StageOut
    fit: int
    follow_up_on: date | None = None
    amount_committed: int | None = None


class InvestorOut(InvestorCompact):
    website_url: str | None = None
    x_url: str | None = None
    location: str | None = None
    check_min: int | None = None
    check_max: int | None = None
    check_note: str | None = None
    stage_focus: list[str] = []
    industries: list[str] = []
    notes: str | None = None
    source: str | None = None
    warm_intro_by: str | None = None
    rounds: list[ParticipationBrief] = []
    created_at: Timestamp
    updated_at: Timestamp


class InvestorFields(StrictInput):
    """Investor input fields (SPEC §5.7). Values are normalized by ``services.normalize``;
    money fields also accept strings such as ``"250k"``."""

    name: str | None = Field(None, max_length=200)
    firm: str | None = Field(None, max_length=200)
    title: str | None = Field(None, max_length=200)
    type: str | None = Field(None, max_length=40)
    email: str | None = Field(None, max_length=254)
    linkedin_url: str | None = Field(None, max_length=500)
    website_url: str | None = Field(None, max_length=500)
    x_url: str | None = Field(None, max_length=500)
    location: str | None = Field(None, max_length=200)
    check_min: int | str | None = None
    check_max: int | str | None = None
    check_note: str | None = Field(None, max_length=200)
    stage_focus: list[str] | None = None
    industries: list[str] | None = None
    tags: list[str] | None = None
    notes: str | None = Field(None, max_length=20000)
    source: str | None = Field(None, max_length=200)
    warm_intro_by: str | None = Field(None, max_length=200)

    def fields_set(self) -> dict[str, Any]:
        """Only the keys the client sent (absent = unchanged, null = clear)."""
        return {k: getattr(self, k) for k in self.model_fields_set if k in type(self).model_fields}


class InvestorCreate(InvestorFields):
    name: str = Field(..., min_length=1, max_length=200)
    on_duplicate: OnDuplicate = "return_existing"

    def fields_set(self) -> dict[str, Any]:
        out = super().fields_set()
        out.pop("on_duplicate", None)
        out["name"] = self.name
        return out


class InvestorUpdate(InvestorFields):
    add_tags: list[str] | None = None
    remove_tags: list[str] | None = None
    add_industries: list[str] | None = None
    append_notes: str | None = Field(None, max_length=20000)

    def fields_set(self) -> dict[str, Any]:
        out = super().fields_set()
        for k in ("add_tags", "remove_tags", "add_industries", "append_notes"):
            out.pop(k, None)
        return out


class InvestorAddOut(BaseModel):
    investor: InvestorOut
    created: bool
    matched_on: MatchedOnName | None = None
    filled_fields: list[str] | None = None


class InvestorPage(BaseModel):
    data: list[InvestorOut]
    next_cursor: str | None = None
    total: int


class InvestorRef(BaseModel):
    investor: InvestorOut
