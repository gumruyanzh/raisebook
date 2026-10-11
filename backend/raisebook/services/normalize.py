"""Normalization and dedupe keys for investor data (SPEC §3.4). Owner: API+MCP (AM).

The single implementation that the REST API, MCP tools and imports all use:

- :func:`normalize_investor_input` cleans user/agent/CSV input for the investor columns
  (text, arrays, URLs, email, type, money) and raises ``validation_error`` with the field
  name when a value cannot be accepted.
- :func:`derived_fields` computes the columns maintained on every write
  (``linkedin_key``, ``name_key``, ``search_text``); they are never set from input.
- :func:`dedupe_keys` returns the keys used for matching, in SPEC order:
  email → LinkedIn profile → name+firm.

Parsing helpers (:func:`parse_money`, :func:`parse_check_note`, :func:`parse_investor_type`,
:func:`parse_instrument`, :func:`parse_date_loose`) are shared with CSV import.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal
from urllib.parse import urlsplit

from raisebook.core.errors import ValidationFailed

MatchedOn = Literal["email", "linkedin", "name_firm", "name"]

# Column limits (SPEC §3.4 CHECKs). Services validate before the database does.
TEXT_LIMITS: dict[str, int] = {
    "name": 200,
    "firm": 200,
    "title": 200,
    "check_note": 200,
    "location": 200,
    "source": 200,
    "warm_intro_by": 200,
    "email": 254,
    "linkedin_url": 500,
    "website_url": 500,
    "x_url": 500,
    "notes": 20000,
}
ARRAY_LIMITS: dict[str, int] = {"stage_focus": 10, "industries": 30, "tags": 30}
ARRAY_ITEM_MAX = 40
MONEY_FIELDS: tuple[str, ...] = ("check_min", "check_max")

# Every investor input field (SPEC §5.7), in display order.
INVESTOR_FIELDS: tuple[str, ...] = (
    "name",
    "firm",
    "title",
    "type",
    "email",
    "linkedin_url",
    "website_url",
    "x_url",
    "location",
    "check_min",
    "check_max",
    "check_note",
    "stage_focus",
    "industries",
    "tags",
    "notes",
    "source",
    "warm_intro_by",
)
REQUIRED_FIELDS: frozenset[str] = frozenset({"name", "type", "stage_focus", "industries", "tags"})

FIRM_SUFFIXES: frozenset[str] = frozenset(
    {"capital", "ventures", "partners", "vc", "fund", "llc", "lp", "inc"}
)

INVESTOR_TYPES: tuple[str, ...] = (
    "vc",
    "angel",
    "family_office",
    "corporate_vc",
    "accelerator",
    "scout",
    "other",
)
_TYPE_ALIASES: dict[str, str] = {
    "vc": "vc",
    "venture": "vc",
    "venture capital": "vc",
    "venture capitalist": "vc",
    "vc fund": "vc",
    "fund": "vc",
    "angel": "angel",
    "angel investor": "angel",
    "business angel": "angel",
    "family office": "family_office",
    "family_office": "family_office",
    "fo": "family_office",
    "corporate vc": "corporate_vc",
    "corporate_vc": "corporate_vc",
    "corporate venture": "corporate_vc",
    "corporate venture capital": "corporate_vc",
    "cvc": "corporate_vc",
    "corporate": "corporate_vc",
    "accelerator": "accelerator",
    "incubator": "accelerator",
    "scout": "scout",
    "other": "other",
}
INSTRUMENTS: tuple[str, ...] = ("safe", "priced", "convertible_note", "other")
_INSTRUMENT_ALIASES: dict[str, str] = {
    "safe": "safe",
    "post money safe": "safe",
    "post-money safe": "safe",
    "pre money safe": "safe",
    "priced": "priced",
    "priced round": "priced",
    "equity": "priced",
    "convertible note": "convertible_note",
    "convertible_note": "convertible_note",
    "convertible": "convertible_note",
    "note": "convertible_note",
    "other": "other",
}

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_LINKEDIN_RE = re.compile(
    r"^(?:https?://)?(?:[a-z0-9-]+\.)*linkedin\.com/in/([^/?#\s]+)/?(?:[?#].*)?$",
    re.IGNORECASE,
)
_X_HANDLE_RE = re.compile(r"^@?([A-Za-z0-9_]{1,15})$")
_MONEY_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*([kmb])?$")
_WS_RE = re.compile(r"\s+")


# --- text --------------------------------------------------------------------------------


def collapse(value: str) -> str:
    """Strip and collapse internal whitespace to single spaces."""
    return _WS_RE.sub(" ", value).strip()


def clean_text(value: Any, field: str, *, max_len: int, multiline: bool = False) -> str | None:
    """Strip (and, unless ``multiline``, collapse whitespace); empty → None; enforce length."""
    if value is None:
        return None
    raw: str = value if isinstance(value, str) else str(value)
    if multiline:
        text = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
    else:
        text = collapse(raw)
    if not text:
        return None
    if len(text) > max_len:
        raise ValidationFailed(field, f"{field} must be at most {max_len} characters.")
    return text


def clean_list(value: Any, field: str, *, max_items: int) -> list[str]:
    """Array cleaning: strip items, drop empties, 1..40 chars each, dedupe case-insensitively
    (keeping the first casing), preserve order. A string is split on ``;``/``|`` (or ``,``)."""
    if value is None:
        return []
    items: Iterable[Any]
    if isinstance(value, str):
        items = split_list_cell(value)
    elif isinstance(value, list | tuple):
        items = value
    else:
        raise ValidationFailed(field, f"{field} must be a list of strings.")
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        if item is None:
            continue
        text = collapse(str(item))
        if not text:
            continue
        if len(text) > ARRAY_ITEM_MAX:
            raise ValidationFailed(
                field, f"Each {field} item must be at most {ARRAY_ITEM_MAX} characters."
            )
        low = text.casefold()
        if low in seen:
            continue
        seen.add(low)
        out.append(text)
    if len(out) > max_items:
        raise ValidationFailed(field, f"{field} can have at most {max_items} items.")
    return out


def split_list_cell(value: str) -> list[str]:
    """Split a list cell on ``;`` or ``|``, and on ``,`` only when neither appears."""
    if ";" in value or "|" in value:
        return [p for p in re.split(r"[;|]", value)]
    return value.split(",")


def merge_lists(existing: Iterable[str], extra: Iterable[str]) -> list[str]:
    """Union preserving order, case-insensitive (existing casing wins)."""
    out = list(existing)
    seen = {x.casefold() for x in out}
    for item in extra:
        if item.casefold() not in seen:
            seen.add(item.casefold())
            out.append(item)
    return out


def norm(value: str | None) -> str:
    """NFKD, strip accents, lowercase, ``&`` → ``and``, drop punctuation, collapse spaces."""
    text = unicodedata.normalize("NFKD", value or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower().replace("&", " and ")
    return " ".join(re.findall(r"[^\W_]+", text))


def norm_firm(firm: str | None) -> str:
    """``norm(firm)`` without trailing firm suffixes (capital, ventures, partners, …)."""
    words = norm(firm).split()
    while words and words[-1] in FIRM_SUFFIXES:
        words.pop()
    return " ".join(words)


def name_key(name: str, firm: str | None) -> str:
    """``norm(name) || '|' || norm_firm(firm)`` (the advisory name+firm dedupe key)."""
    return f"{norm(name)}|{norm_firm(firm)}"


# --- contact fields ----------------------------------------------------------------------


def clean_email(value: Any, field: str = "email") -> str | None:
    text = clean_text(value, field, max_len=TEXT_LIMITS["email"])
    if text is None:
        return None
    if text.lower().startswith("mailto:"):
        text = text[7:].strip()
    if not _EMAIL_RE.match(text):
        raise ValidationFailed(field, f"{text!r} is not a valid email address.")
    return text.lower()


def linkedin_key(url: str | None) -> str | None:
    """``in/<slug>`` (lowercased) for a LinkedIn profile URL, else None."""
    if not url:
        return None
    m = _LINKEDIN_RE.match(url.strip())
    if not m:
        return None
    slug = m.group(1).strip().lower()
    return f"in/{slug}" if slug else None


def clean_url(value: Any, field: str) -> str | None:
    """Add ``https://`` when there is no scheme; only http/https with a host are allowed."""
    text = clean_text(value, field, max_len=TEXT_LIMITS.get(field, 500))
    if text is None:
        return None
    if " " in text:
        raise ValidationFailed(field, f"{field} must be a URL without spaces.")
    if "://" not in text:
        text = "https://" + text.lstrip("/")
    parts = urlsplit(text)
    if parts.scheme.lower() not in ("http", "https"):
        raise ValidationFailed(field, f"{field} must be an http or https URL.")
    host = parts.hostname or ""
    if "." not in host:
        raise ValidationFailed(field, f"{field} must be a full URL such as https://example.com.")
    if len(text) > TEXT_LIMITS.get(field, 500):
        raise ValidationFailed(field, f"{field} must be at most 500 characters.")
    return text


def clean_x_url(value: Any, field: str = "x_url") -> str | None:
    """X/Twitter: an ``@handle`` (or bare handle) becomes ``https://x.com/handle``."""
    text = clean_text(value, field, max_len=TEXT_LIMITS["x_url"])
    if text is None:
        return None
    m = _X_HANDLE_RE.match(text)
    if m and (text.startswith("@") or "." not in text):
        return f"https://x.com/{m.group(1)}"
    return clean_url(text, field)


def parse_investor_type(value: Any, field: str = "type") -> str:
    """An investor type from a value, label or alias (``VC``, ``Angel investor``, ``FO``…)."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return "other"
    key = " ".join(str(value).strip().lower().replace("_", " ").replace("-", " ").split())
    found = _TYPE_ALIASES.get(key) or _TYPE_ALIASES.get(key.replace(" ", "_"))
    if found is None:
        raise ValidationFailed(
            field,
            f"Unknown investor type {value!r}. Use one of: {', '.join(INVESTOR_TYPES)}.",
        )
    return found


def parse_instrument(value: Any, field: str = "instrument") -> str:
    """A round instrument from a value, label or alias (``SAFE``, ``equity``, ``note``…)."""
    key = " ".join(str(value or "").strip().lower().replace("_", " ").split())
    found = _INSTRUMENT_ALIASES.get(key)
    if found is None:
        raise ValidationFailed(
            field, f"Unknown instrument {value!r}. Use one of: {', '.join(INSTRUMENTS)}."
        )
    return found


# --- money and dates ---------------------------------------------------------------------


def parse_money(value: Any) -> int | None:
    """``$250k``, ``250K``, ``1.5M``, ``250,000``, ``€500k`` → whole units; else None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float):
        return round(value) if value >= 0 else None
    text = str(value).strip().lower()
    text = re.sub(r"[\s$€£¥₹,_]", "", text)
    text = re.sub(r"^(usd|eur|gbp|cad|aud|chf|sgd|inr)", "", text)
    text = re.sub(r"(usd|eur|gbp|cad|aud|chf|sgd|inr)$", "", text)
    text = text.replace("mm", "m")
    if not text:
        return None
    m = _MONEY_RE.match(text)
    if not m:
        return None
    amount = float(m.group(1))
    mult = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}.get(m.group(2) or "", 1)
    return round(amount * mult)


def parse_check_note(note: str | None) -> tuple[int | None, int | None]:
    """``$250k-$1M`` → (250000, 1000000); ``$250k`` → (250000, 250000); else (None, None)."""
    if not note:
        return None, None
    text = note.strip()
    # Only the leading money expression counts ("$250k-$1M, leads" → "$250k-$1M").
    text = re.split(r"[,;(](?![\d])", text, maxsplit=1)[0]
    parts = re.split(r"\s*(?:-|\u2013|\u2014|\bto\b)\s*", text, maxsplit=1)
    if len(parts) == 2:
        lo, hi = parse_money(parts[0]), parse_money(parts[1])
        if lo is not None and hi is not None and lo <= hi:
            return lo, hi
        return None, None
    one = parse_money(parts[0])
    return (one, one) if one is not None else (None, None)


_MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
    )
}


def parse_date_loose(value: Any) -> tuple[date | None, bool]:
    """Parse ``YYYY-MM-DD``, ``M/D/YYYY``, ``D.M.YYYY``, ``Oct 14 2026``, ``14 Oct 2026``.

    Returns ``(date, ambiguous)``; ``ambiguous`` is True for ``03/04/2026`` (read as M/D).
    ``(None, False)`` when the value is not a date.
    """
    if value is None:
        return None, False
    if isinstance(value, datetime):
        return value.date(), False
    if isinstance(value, date):
        return value, False
    text = str(value).strip()
    if not text:
        return None, False
    try:
        return date.fromisoformat(text[:10]), False
    except ValueError:
        pass
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", text)
    if m:
        a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return date(y, a, b), (a <= 12 and b <= 12 and a != b)
        except ValueError:
            try:
                return date(y, b, a), False
            except ValueError:
                return None, False
    m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})$", text)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))), False
        except ValueError:
            return None, False
    words = re.findall(r"[A-Za-z]+|\d+", text)
    if len(words) == 3:
        mon = day = year = None
        for w in words:
            if w[:3].lower() in _MONTHS and not w.isdigit():
                mon = _MONTHS[w[:3].lower()]
            elif w.isdigit() and len(w) == 4:
                year = int(w)
            elif w.isdigit():
                day = int(w)
        if mon and day and year:
            try:
                return date(year, mon, day), False
            except ValueError:
                return None, False
    return None, False


def clean_amount(value: Any, field: str, *, allow_zero: bool = True) -> int | None:
    """A non-negative whole amount (int, or a money string such as ``250k``)."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, bool):
        raise ValidationFailed(field, f"{field} must be a whole number.")
    amount = parse_money(value)
    if amount is None:
        raise ValidationFailed(
            field, f"{field} must be a whole non-negative amount such as 250000 or '250k'."
        )
    if amount > 10**15:
        raise ValidationFailed(field, f"{field} is too large.")
    if not allow_zero and amount == 0:
        raise ValidationFailed(field, f"{field} must be greater than 0.")
    return amount


# --- investors ---------------------------------------------------------------------------


def normalize_investor_input(raw: Mapping[str, Any], *, partial: bool) -> dict[str, Any]:
    """Clean the investor fields present in ``raw`` (unknown keys are ignored).

    ``partial=False`` (create) requires ``name``. Absent keys stay absent; ``None`` means
    "clear" (rejected for ``name``). ``check_note`` fills ``check_min``/``check_max`` when
    those are not given. Returns column → value.
    """
    out: dict[str, Any] = {}
    for field in INVESTOR_FIELDS:
        if field not in raw:
            continue
        value = raw[field]
        if field == "name":
            name = clean_text(value, "name", max_len=TEXT_LIMITS["name"])
            if name is None:
                raise ValidationFailed("name", "name is required (1 to 200 characters).")
            out["name"] = name
        elif field == "type":
            out["type"] = parse_investor_type(value)
        elif field == "email":
            out["email"] = clean_email(value)
        elif field in ("linkedin_url", "website_url"):
            out[field] = clean_url(value, field)
        elif field == "x_url":
            out["x_url"] = clean_x_url(value)
        elif field in MONEY_FIELDS:
            out[field] = clean_amount(value, field)
        elif field in ARRAY_LIMITS:
            out[field] = clean_list(value, field, max_items=ARRAY_LIMITS[field])
        elif field == "notes":
            out["notes"] = clean_text(value, "notes", max_len=TEXT_LIMITS["notes"], multiline=True)
        else:
            out[field] = clean_text(value, field, max_len=TEXT_LIMITS[field])
    if not partial and "name" not in out:
        raise ValidationFailed("name", "name is required (1 to 200 characters).")
    if out.get("check_note") and "check_min" not in out and "check_max" not in out:
        lo, hi = parse_check_note(out["check_note"])
        if lo is not None:
            out["check_min"], out["check_max"] = lo, hi
    lo_v, hi_v = out.get("check_min"), out.get("check_max")
    if lo_v is not None and hi_v is not None and lo_v > hi_v:
        raise ValidationFailed("check_min", "check_min must not be greater than check_max.")
    return out


def search_text(fields: Mapping[str, Any]) -> str:
    """Lowercase haystack: name firm title email location tags industries source notes[:2000]."""
    parts: list[str] = []
    for key in ("name", "firm", "title", "email", "location"):
        v = fields.get(key)
        if v:
            parts.append(str(v))
    for key in ("tags", "industries", "stage_focus"):
        parts.extend(str(x) for x in fields.get(key) or [])
    for key in ("source", "warm_intro_by"):
        v = fields.get(key)
        if v:
            parts.append(str(v))
    notes = fields.get("notes")
    if notes:
        parts.append(str(notes)[:2000])
    text = " ".join(parts).lower()
    return " ".join(text.split())


def derived_fields(fields: Mapping[str, Any]) -> dict[str, Any]:
    """``linkedin_key``, ``name_key`` and ``search_text`` for the full investor state."""
    return {
        "linkedin_key": linkedin_key(fields.get("linkedin_url")),
        "name_key": name_key(str(fields.get("name") or ""), fields.get("firm")),
        "search_text": search_text(fields),
    }


@dataclass(frozen=True)
class DedupeKeys:
    """The keys an investor is matched on, in SPEC order."""

    email: str | None
    linkedin_key: str | None
    name_key: str | None

    def ordered(self) -> list[tuple[MatchedOn, str]]:
        out: list[tuple[MatchedOn, str]] = []
        if self.email:
            out.append(("email", self.email))
        if self.linkedin_key:
            out.append(("linkedin", self.linkedin_key))
        if self.name_key:
            out.append(("name_firm", self.name_key))
        return out


def dedupe_keys(fields: Mapping[str, Any]) -> DedupeKeys:
    """Keys from *normalized* fields (see :func:`normalize_investor_input`)."""
    email = fields.get("email")
    name = fields.get("name")
    return DedupeKeys(
        email=str(email).lower() if email else None,
        linkedin_key=linkedin_key(fields.get("linkedin_url")),
        name_key=name_key(str(name), fields.get("firm")) if name else None,
    )


# --- name references ---------------------------------------------------------------------


def split_name_at_firm(ref: str) -> tuple[str, str | None]:
    """``"Dana Whitfield @ Harbor Light"`` → ("Dana Whitfield", "Harbor Light")."""
    if " @ " in ref:
        name, _, firm = ref.rpartition(" @ ")
        return name.strip(), firm.strip() or None
    return ref.strip(), None


def stage_key_from_label(label: str) -> str:
    """A stage key (``^[a-z][a-z0-9_]{0,31}$``) from a label: ``slugify(label, "_")``."""
    key = "_".join(norm(label).split())
    key = re.sub(r"[^a-z0-9_]", "", key)
    if not key or not key[0].isalpha():
        key = "s_" + key
    return key[:32].rstrip("_") or "stage"
