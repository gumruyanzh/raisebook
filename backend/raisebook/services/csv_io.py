"""CSV reading, header auto-mapping and safe CSV writing (SPEC §8.2, §8.3).

Owner: Import-Export+Ops (IE). Pure functions only (no database), strict-typed.

- :func:`parse_csv`: UTF-8 text (BOM stripped), delimiter sniffed among ``,`` ``;`` and tab,
  RFC 4180 quoting, a header row, at most 5,000 data rows and 5 MB.
- :func:`auto_map`: header → canonical import field, case-, space- and
  punctuation-insensitive, with the SPEC aliases. A bare ``Stage`` column maps to the
  round stage only when its values look like the round's stage keys or labels, else to
  ``stage_focus``.
- :func:`parse_fit`, :func:`parse_probability`: round-field cell parsers.
- :func:`write_csv` / :func:`guard_cell`: CSV output with the formula-injection guard.
"""

from __future__ import annotations

import csv
import io
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, Literal

from raisebook.core.errors import ImportInvalid

MAX_ROWS: Final = 5_000
MAX_BYTES: Final = 5 * 1024 * 1024
MAX_COLUMNS: Final = 200
MAX_CELL: Final = 20_000

ImportField = Literal[
    "name",
    "first_name",
    "last_name",
    "firm",
    "title",
    "type",
    "email",
    "linkedin_url",
    "website_url",
    "x_url",
    "location",
    "check_note",
    "check_min",
    "check_max",
    "stage_focus",
    "industries",
    "tags",
    "notes",
    "source",
    "warm_intro_by",
    "stage",
    "fit",
    "follow_up_on",
    "follow_up_note",
    "amount_soft",
    "amount_committed",
    "probability",
    "next_step",
    "owner_email",
]

CONTACT_FIELDS: Final[tuple[ImportField, ...]] = (
    "name",
    "first_name",
    "last_name",
    "firm",
    "title",
    "type",
    "email",
    "linkedin_url",
    "website_url",
    "x_url",
    "location",
    "check_note",
    "check_min",
    "check_max",
    "stage_focus",
    "industries",
    "tags",
    "notes",
    "source",
    "warm_intro_by",
)
ROUND_FIELDS: Final[tuple[ImportField, ...]] = (
    "stage",
    "fit",
    "follow_up_on",
    "follow_up_note",
    "amount_soft",
    "amount_committed",
    "probability",
    "next_step",
    "owner_email",
)
ALL_FIELDS: Final[tuple[ImportField, ...]] = CONTACT_FIELDS + ROUND_FIELDS
LIST_FIELDS: Final[frozenset[str]] = frozenset({"stage_focus", "industries", "tags"})

# Labels for the web column picker (SPEC §4.10) and docs.
FIELD_LABELS: Final[dict[str, str]] = {
    "name": "Name",
    "first_name": "First name",
    "last_name": "Last name",
    "firm": "Firm",
    "title": "Title",
    "type": "Investor type",
    "email": "Email",
    "linkedin_url": "LinkedIn",
    "website_url": "Website",
    "x_url": "X / Twitter",
    "location": "Location",
    "check_note": "Check size",
    "check_min": "Check min",
    "check_max": "Check max",
    "stage_focus": "Stage focus",
    "industries": "Industries",
    "tags": "Tags",
    "notes": "Notes",
    "source": "Source",
    "warm_intro_by": "Warm intro by",
    "stage": "Pipeline stage",
    "fit": "Fit (0-5)",
    "follow_up_on": "Follow up on",
    "follow_up_note": "Follow-up note",
    "amount_soft": "Soft amount",
    "amount_committed": "Committed amount",
    "probability": "Probability %",
    "next_step": "Next step",
    "owner_email": "Owner email",
}


def canon(header: str) -> str:
    """Case-, space- and punctuation-insensitive form of a header (``"E-mail "`` → ``email``).

    ``%`` is kept as a word so a ``%`` column can map to probability."""
    text = header.strip().lower().replace("%", " pct ")
    return "".join(re.findall(r"[a-z0-9]+", text))


# SPEC §8.2 alias table. ``stage`` is handled specially (see auto_map).
_ALIASES: Final[dict[ImportField, tuple[str, ...]]] = {
    "name": ("name", "full name", "investor", "investor name", "contact", "person", "contact name"),
    "first_name": ("first name", "firstname", "given name"),
    "last_name": ("last name", "lastname", "surname", "family name"),
    "firm": ("firm", "fund", "company", "organization", "organisation", "org", "vc firm"),
    "title": ("title", "role", "position", "job title"),
    "type": ("type", "investor type", "category"),
    "email": ("email", "email address", "e-mail", "mail"),
    "linkedin_url": ("linkedin", "linkedin url", "linkedin profile"),
    "website_url": ("website", "url", "site", "web", "website url"),
    "x_url": ("x", "twitter", "x handle", "twitter handle", "x url", "twitter url"),
    "location": ("location", "city", "based in", "hq"),
    "check_note": ("check", "check size", "ticket", "ticket size", "cheque size", "cheque"),
    "check_min": ("min check", "check min", "minimum check"),
    "check_max": ("max check", "check max", "maximum check"),
    "stage_focus": ("stage focus", "stages", "invests at"),
    "industries": ("industry", "industries", "sector", "sectors", "focus areas"),
    "tags": ("tags", "labels", "focus", "tag"),
    "notes": ("notes", "note", "comments", "research", "comment"),
    "source": ("source", "met at", "event", "list"),
    "warm_intro_by": ("warm intro", "intro by", "introducer", "referred by", "warm intro by"),
    "stage": ("pipeline stage", "status", "round stage"),
    "fit": ("fit", "priority", "score"),
    "follow_up_on": (
        "follow up",
        "follow-up date",
        "next follow up",
        "follow up on",
        "follow up date",
    ),
    "follow_up_note": ("follow up note", "follow-up note"),
    "amount_soft": ("soft", "soft circle", "ask", "target amount", "amount soft", "soft amount"),
    "amount_committed": (
        "committed",
        "commitment",
        "amount committed",
        "invested",
        "committed amount",
    ),
    "probability": ("probability", "likelihood", "%", "probability %"),
    "next_step": ("next step", "next action", "todo", "to do"),
    "owner_email": ("owner", "owner email", "assigned to"),
}

ALIAS_INDEX: Final[dict[str, ImportField]] = {
    canon(alias): field for field, aliases in _ALIASES.items() for alias in aliases
}
# Canonical field names map to themselves, so an exported CSV re-imports untouched
# (``linkedin_url``, ``follow_up_on``…). The export's ``stage`` column is the round stage key.
for _f in ALL_FIELDS:
    ALIAS_INDEX.setdefault(canon(_f), _f)


@dataclass(frozen=True)
class ParsedCsv:
    columns: list[str]
    rows: list[list[str]]  # data rows, each padded/truncated to len(columns)
    delimiter: str
    line_numbers: list[int]  # the CSV line number of each data row (header = 1)


def decode(content: str | bytes) -> str:
    """Text from a UTF-8 payload, without a BOM."""
    if isinstance(content, bytes):
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            raise ImportInvalid(
                "The file is not UTF-8 text. Save it as 'CSV UTF-8' and try again."
            ) from None
    else:
        text = content
    return text[1:] if text.startswith("﻿") else text


def sniff_delimiter(text: str) -> str:
    """The delimiter among ``,`` ``;`` and tab that best splits the header line."""
    header = text.split("\n", 1)[0]
    counts = {d: _count_outside_quotes(header, d) for d in (",", ";", "\t")}
    best = max(counts, key=lambda d: (counts[d], d == ","))
    return best if counts[best] > 0 else ","


def _count_outside_quotes(line: str, delim: str) -> int:
    n = 0
    quoted = False
    for ch in line:
        if ch == '"':
            quoted = not quoted
        elif ch == delim and not quoted:
            n += 1
    return n


def parse_csv(content: str | bytes, *, max_rows: int = MAX_ROWS) -> ParsedCsv:
    """Parse CSV text with a header row. Raises 422 ``import_invalid`` on unusable input."""
    raw_len = len(content) if isinstance(content, bytes) else len(content.encode("utf-8"))
    if raw_len > MAX_BYTES:
        raise ImportInvalid(
            f"The file is larger than {MAX_BYTES // (1024 * 1024)} MB. Split it and import "
            "the parts one after another.",
            details={"limit_bytes": MAX_BYTES},
        )
    text = decode(content).replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        raise ImportInvalid("The file is empty. Paste CSV text with a header row first.")
    delimiter = sniff_delimiter(text)
    reader = csv.reader(io.StringIO(text), delimiter=delimiter, quotechar='"', strict=False)
    columns: list[str] | None = None
    rows: list[list[str]] = []
    lines: list[int] = []
    try:
        for record in reader:
            if columns is None:
                if not any(c.strip() for c in record):
                    continue  # leading blank lines
                columns = _unique_headers(record)
                continue
            if not any(c.strip() for c in record):
                continue  # blank line
            if len(rows) >= max_rows:
                raise ImportInvalid(
                    f"The file has more than {max_rows:,} rows. Split it and import the parts "
                    "one after another.",
                    details={"limit_rows": max_rows},
                )
            width = len(columns)
            cells = [c[:MAX_CELL] for c in record[:width]]
            cells += [""] * (width - len(cells))
            rows.append(cells)
            lines.append(reader.line_num)
    except csv.Error as exc:
        raise ImportInvalid(
            f"The CSV could not be read near line {reader.line_num}: {exc}. Check the quotes "
            "on that line."
        ) from None
    if columns is None:
        raise ImportInvalid("The file has no header row. The first row must name the columns.")
    if len(columns) > MAX_COLUMNS:
        raise ImportInvalid(f"The file has more than {MAX_COLUMNS} columns.")
    return ParsedCsv(columns=columns, rows=rows, delimiter=delimiter, line_numbers=lines)


def _unique_headers(record: Sequence[str]) -> list[str]:
    out: list[str] = []
    seen: dict[str, int] = {}
    for i, raw in enumerate(record):
        name = raw.strip() or f"Column {i + 1}"
        if name in seen:
            seen[name] += 1
            name = f"{name} ({seen[name]})"
        else:
            seen[name] = 1
        out.append(name)
    return out


def _looks_like_stage(values: Iterable[str], stage_names: set[str]) -> bool:
    """True when most non-empty values are round stage keys or labels."""
    vals = [canon(v) for v in values if v.strip()]
    if not vals or not stage_names:
        return False
    hits = sum(1 for v in vals if v in stage_names)
    return hits >= max(1, (len(vals) + 1) // 2)


def auto_map(
    columns: Sequence[str],
    rows: Sequence[Sequence[str]] = (),
    *,
    stage_names: Iterable[str] = (),
) -> dict[str, ImportField | None]:
    """Map each column to a canonical field (or None to ignore).

    ``stage_names``: keys and labels of the target round's stages, used to decide whether a
    bare ``Stage`` column is the pipeline stage or the investor's stage focus. The first
    column that claims a field wins; later ones are ignored.
    """
    names = {canon(s) for s in stage_names}
    taken: set[str] = set()
    out: dict[str, ImportField | None] = {}
    for idx, col in enumerate(columns):
        key = canon(col)
        field: ImportField | None
        if key == "stage":
            sample = [r[idx] for r in rows[:200] if idx < len(r)]
            field = "stage" if _looks_like_stage(sample, names) else "stage_focus"
        else:
            field = ALIAS_INDEX.get(key)
        if field is not None and field in taken:
            field = None
        if field is not None:
            taken.add(field)
        out[col] = field
    return out


def validate_mapping(
    columns: Sequence[str], mapping: Mapping[str, str | None]
) -> dict[str, ImportField | None]:
    """A client-supplied mapping: unknown columns or fields are 422 ``import_invalid``."""
    allowed = set(ALL_FIELDS)
    out: dict[str, ImportField | None] = {c: None for c in columns}
    used: dict[str, str] = {}
    for col, field in mapping.items():
        if col not in out:
            raise ImportInvalid(
                f"The mapping names a column {col!r} that is not in the file.",
                details={"columns": list(columns)},
            )
        if field is None or field == "":
            continue
        if field not in allowed:
            raise ImportInvalid(
                f"Unknown field {field!r} for column {col!r}.",
                details={"valid": list(ALL_FIELDS)},
            )
        if field in used:
            raise ImportInvalid(
                f"Columns {used[field]!r} and {col!r} both map to {field!r}. Map one of them "
                "to null.",
            )
        used[field] = col
        out[col] = _as_field(field)
    return out


def _as_field(value: str) -> ImportField:
    for f in ALL_FIELDS:
        if f == value:
            return f
    raise ImportInvalid(f"Unknown field {value!r}.")


# --- round-field cells -------------------------------------------------------------------

_FIT_WORDS: Final[dict[str, int]] = {
    "hot": 5,
    "warm": 4,
    "maybe": 3,
    "low": 1,
    "lowfit": 1,
    "cold": 1,
    "high": 5,
    "medium": 3,
}


def parse_fit(value: str) -> int | None:
    """0-5, or ``hot``/``warm``/``maybe``/``low`` → 5/4/3/1. Raises ValueError when invalid."""
    text = value.strip()
    if not text:
        return None
    word = canon(text)
    if word in _FIT_WORDS:
        return _FIT_WORDS[word]
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(?:/\s*5)?", text)
    if not m:
        raise ValueError("fit must be 0 to 5, or hot, warm, maybe or low")
    num = round(float(m.group(1)))
    if not 0 <= num <= 5:
        raise ValueError("fit must be 0 to 5")
    return int(num)


def parse_probability(value: str) -> int | None:
    """``40``, ``40%`` or ``0.4`` → 40. Raises ValueError when outside 0..100."""
    text = value.strip().rstrip("%").strip()
    if not text:
        return None
    try:
        num = float(text)
    except ValueError:
        raise ValueError("probability must be a number from 0 to 100") from None
    if 0 < num < 1 and "." in text:
        num *= 100
    if not 0 <= num <= 100:
        raise ValueError("probability must be from 0 to 100")
    return round(num)


def currency_symbol_of(value: str) -> str | None:
    """The currency a money cell names (``€500k`` → EUR), or None when it names none."""
    text = value.strip().upper()
    for sym, code in (("$", "USD"), ("€", "EUR"), ("£", "GBP"), ("¥", "JPY"), ("₹", "INR")):
        if sym in text:
            return code
    m = re.search(r"\b(USD|EUR|GBP|CAD|AUD|CHF|SGD|INR)\b", text)
    return m.group(1) if m else None


# --- writing -----------------------------------------------------------------------------

_FORMULA_START: Final = ("=", "+", "-", "@", "\t", "\r")


def guard_cell(value: str) -> str:
    """Prefix ``'`` to a cell that a spreadsheet would run as a formula."""
    return "'" + value if value.startswith(_FORMULA_START) else value


def unguard_cell(value: str) -> str:
    """Undo :func:`guard_cell` on import, so exported files round-trip unchanged."""
    if len(value) > 1 and value[0] == "'" and value[1:].startswith(_FORMULA_START):
        return value[1:]
    return value


def cell(value: object) -> str:
    """A Python value as CSV text: None → empty, lists joined with ``; ``."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list | tuple):
        return "; ".join(str(v) for v in value)
    return str(value)


def write_csv(header: Sequence[str], rows: Iterable[Sequence[object]]) -> str:
    """CSV text (RFC 4180, ``\\r\\n`` line ends) with every cell formula-guarded."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow(list(header))
    for row in rows:
        writer.writerow([guard_cell(cell(v)) for v in row])
    return buf.getvalue()
