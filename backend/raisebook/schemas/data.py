"""Import and export schemas (SPEC §5.8). Owner: Import-Export+Ops (IE)."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

from raisebook.schemas.common import StrictInput, Timestamp

ImportFormatName = Literal["csv", "prototype_json"]
OnDuplicateImport = Literal["skip", "fill_empty", "update"]
RowAction = Literal["create", "update", "skip", "error"]
MatchedOnName = Literal["email", "linkedin", "name_firm", "name"]

MAX_CONTENT_CHARS = 5 * 1024 * 1024


class RoundMapEntry(StrictInput):
    """Prototype JSON: map ``p[source_key]`` to a Raisebook round."""

    source_key: str = Field(..., min_length=1, max_length=80)
    round: str = Field(..., min_length=1, max_length=200)
    fit_field: str | None = Field(None, max_length=40, description="e.g. qFit or eFit")


class ImportRequest(StrictInput):
    format: ImportFormatName = "csv"
    content: str = Field(
        ...,
        min_length=1,
        max_length=MAX_CONTENT_CHARS,
        description="CSV text or JSON text, at most 5 MB and 5,000 rows/records.",
    )
    filename: str | None = Field(None, max_length=255)
    mapping: dict[str, str | None] | None = Field(
        None,
        description='CSV only: {"Column header": "field" or null to ignore}. Omitted = auto-map.',
    )
    round: str | None = Field(
        None,
        max_length=200,
        description="Round id, slug or name. Omitted = contacts only (round columns ignored).",
    )
    default_stage: str | None = Field(None, max_length=40)
    on_duplicate: OnDuplicateImport = "skip"
    source: str | None = Field(None, max_length=200)
    round_map: list[RoundMapEntry] | None = Field(None, max_length=20)
    value_map: dict[str, dict[str, str]] | None = Field(
        None,
        description='CSV values to Raisebook values per field: {"stage": {"Intro requested": '
        '"contacted"}, "fit": {"hot": "5"}}. Keys are the cell text as in the file.',
    )


class RowMatch(BaseModel):
    investor_id: UUID | None = None
    row: int | None = None
    name: str
    matched_on: MatchedOnName


class RowError(BaseModel):
    field: str
    message: str


class RowParticipant(BaseModel):
    round: str | None = None  # round slug (prototype JSON may target several rounds)
    stage: str | None = None
    fit: int | None = None
    follow_up_on: str | None = None
    follow_up_note: str | None = None
    amount_soft: int | None = None
    amount_committed: int | None = None
    probability: int | None = None
    next_step: str | None = None
    owner_email: str | None = None


class ImportRow(BaseModel):
    row: int
    action: RowAction
    investor: dict[str, Any]
    participant: RowParticipant | None = None
    match: RowMatch | None = None
    errors: list[RowError] = []
    warnings: list[str] = []


class PreviewCounts(BaseModel):
    create: int = 0
    update: int = 0
    skip: int = 0
    error: int = 0
    add_to_round: int = 0
    # Optional cells that were unreadable and left empty (their rows still import).
    cells_left_empty: int = 0


class ColumnStats(BaseModel):
    empty: int = 0  # rows with nothing in this column
    unreadable: int = 0  # rows whose value here could not be read and is left empty


class ValueCount(BaseModel):
    """One distinct value of a stage or fit column, and what it becomes."""

    value: str
    count: int
    stage: str | None = None  # stage key it matches (exactly or by label), if any
    suggestion: str | None = None  # a likely stage key when it does not match
    fit: int | None = None  # fit columns: the 0-5 it reads as, if it does


class ImportPreview(BaseModel):
    format: ImportFormatName
    columns: list[str]
    mapping: dict[str, str | None]
    row_count: int
    rows: list[ImportRow]
    counts: PreviewCounts
    warnings: list[str]
    warning_kinds: dict[str, int] = Field(
        default_factory=dict,
        description='Dropped optional cells by kind, e.g. {"follow_up_unreadable": 74}.',
    )
    column_stats: dict[str, ColumnStats] = Field(
        default_factory=dict, description="CSV: per column, empty and unreadable cells."
    )
    values: dict[str, list[ValueCount]] = Field(
        default_factory=dict,
        description="CSV: distinct values of the columns mapped to stage or fit (top 60).",
    )
    samples: dict[str, list[str]] = Field(
        default_factory=dict, description="Up to three sample values per column (CSV)."
    )


class ResultCounts(BaseModel):
    rows: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: int = 0
    added_to_round: int = 0
    cells_left_empty: int = 0


class ResultError(BaseModel):
    row: int
    field: str
    message: str


class CreatedRow(BaseModel):
    row: int
    id: UUID
    name: str


class ImportResult(BaseModel):
    import_run_id: UUID
    counts: ResultCounts
    errors: list[ResultError]
    warning_kinds: dict[str, int] = Field(default_factory=dict)
    created: list[CreatedRow] = Field(
        default_factory=list, description="Investors this import created (row number, id, name)."
    )
    round: dict[str, str] | None = None  # {id, slug, name} when a round was targeted


class ImportRunOut(BaseModel):
    id: UUID
    format: ImportFormatName
    filename: str | None = None
    round_id: UUID | None = None
    round_name: str | None = None
    actor_type: Literal["user", "agent", "system"]
    actor_label: str
    counts: dict[str, int]
    options: dict[str, Any]
    created_at: Timestamp


class ImportRunList(BaseModel):
    data: list[ImportRunOut]


ExportFormat = Literal["csv", "json"]
