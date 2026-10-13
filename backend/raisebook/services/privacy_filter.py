"""The professional-only output filter (R13; RESEARCH-PLAN §4.6 step 5). Pure functions.

Applied to every text a dossier can carry (facts, analysis, unverified claims, suggestions,
source titles and snippets) for **model and agent dossiers alike**, after the prompts have
already asked for professional information only:

- **Strip** personal contact details, replacing each match with ``[removed]``: phone numbers
  (E.164, North American, and digit groups next to a phone cue word), street addresses,
  apartment/suite numbers next to an address, PO boxes, postcodes on an address line, and
  email addresses on consumer mail domains. A claim that is mostly ``[removed]`` afterwards
  is dropped.
- **Drop** a claim that touches family, health, politics, religion or someone's home.
  Investment language passes ("healthcare fund", "led the seed round"); a false drop is
  preferred over a leak.

Only counts leave this module (``removed``), never the removed text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

REMOVED = "[removed]"

# --- strip patterns -------------------------------------------------------------------------

_PHONE_CUE = r"(?:tel|telephone|phone|mobile|cell|call|whatsapp|ph|fax)\b\.?"
_PATTERNS: tuple[re.Pattern[str], ...] = (
    # E.164 / international: +44 20 7946 0958, +1 (415) 555-0100
    re.compile(r"\+\d[\d\s().-]{7,}\d"),
    # North American: (415) 555-0100, 415.555.0100, 415-555-0100
    re.compile(r"\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b"),
    # PO boxes.
    re.compile(r"(?i)\bP\.?\s?O\.?\s*Box\s+\d+\b"),
    # Street addresses: "221 Baker Street", "1600 Amphitheatre Pkwy" (suffix list).
    re.compile(
        r"\b\d{1,6}\s+(?:[A-Z][\w'.-]*\s+){0,4}"
        r"(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|"
        r"Place|Pl|Terrace|Circle|Highway|Hwy|Parkway|Pkwy|Square|Sq)\b\.?"
        r"(?:,?\s*(?:Apt|Apartment|Suite|Ste|Unit|#)\.?\s*\d+\w?)?"
    ),
)
# Digit groups after a phone cue word within 20 characters: "mobile: 07700 900 123".
_CUED_PHONE = re.compile(
    rf"(?i)(\b{_PHONE_CUE}[^\d\n]{{0,20}})\d{{2,5}}(?:[\s.-]\d{{2,5}}){{1,4}}\b"
)
# Postcodes only count when an address was found on the same line.
_POSTCODE = re.compile(
    r"\b\d{5}(?:-\d{4})?\b|\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b"  # US ZIP(+4), UK postcode
)
_UNIT = re.compile(r"(?i)\b(?:Apt|Apartment|Suite|Ste|Unit)\.?\s*#?\d+\w?\b|#\s?\d+\w?\b")

CONSUMER_MAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "yahoo.com",
        "yahoo.co.uk",
        "ymail.com",
        "hotmail.com",
        "hotmail.co.uk",
        "outlook.com",
        "live.com",
        "msn.com",
        "icloud.com",
        "me.com",
        "mac.com",
        "aol.com",
        "proton.me",
        "protonmail.com",
        "pm.me",
        "gmx.com",
        "gmx.de",
        "gmx.net",
        "mail.ru",
        "yandex.ru",
        "yandex.com",
        "zoho.com",
        "fastmail.com",
        "hey.com",
        "qq.com",
        "163.com",
        "web.de",
    }
)
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")

# --- drop topics -----------------------------------------------------------------------------

_SENSITIVE = re.compile(
    r"(?i)\b(?:"
    # family and relationships
    r"spouse|wife|husband|married|marriage|wedding|divorce[ds]?|girlfriend|boyfriend|fianc[eé]e?|"
    r"children|kids?|son|daughters?|sons|pregnan(?:t|cy)|baby|newborn|grandchild(?:ren)?|"
    r"his family|her family|their family|"
    # health
    r"diagnos(?:is|ed)|illness|ill with|cancer|tumou?r|surgery|therapy|rehab|disabilit(?:y|ies)|"
    r"disabled|chemotherapy|mental health struggles?|depression|hospitali[sz]ed|"
    # politics
    r"democrat(?:s|ic)?|republicans?|voted|voting for|political party|campaign donation|"
    r"donated to (?:the )?\w+(?: \w+)? campaign|super ?pac|"
    # religion
    r"church|mosque|synagogue|temple|faith|religious|religion|"
    # home
    r"lives in|living in|home in|house in|resides in|residence in|neighbou?rhood|"
    r"home address|personal address|personal phone|personal email"
    r")\b"
)
# Investment phrases that contain a sensitive word but are professional ("healthcare fund").
_ALLOW = re.compile(
    r"(?i)\b(?:health ?care|health ?tech|digital health|healthtech|"
    r"family offices?|family fund|portfolio company|children's education (?:startup|company)|"
    r"kids? (?:edtech|startup|company|app)|faith-?tech|temple capital)\b"
)


@dataclass
class Scrubbed:
    text: str | None  # None: the claim must be dropped
    removed: int  # matches stripped (or 1 for a dropped claim)


def strip_contacts(
    text: str, *, keep_email_domains: frozenset[str] = frozenset()
) -> tuple[str, int]:
    """Replace phones, addresses and consumer emails with ``[removed]``. Returns the count."""
    count = 0
    out_lines: list[str] = []
    for line in text.split("\n"):
        had_address = False
        for i, pattern in enumerate(_PATTERNS):
            line, n = pattern.subn(REMOVED, line)
            count += n
            if i >= 2 and n:  # PO box or street address
                had_address = True
        line, n = _CUED_PHONE.subn(lambda m: m.group(1) + REMOVED, line)
        count += n
        if had_address:
            line, n = _POSTCODE.subn(REMOVED, line)
            count += n
            line, n = _UNIT.subn(REMOVED, line)
            count += n

        def email(m: re.Match[str]) -> str:
            nonlocal count
            domain = m.group(1).lower()
            if domain in keep_email_domains:
                return m.group(0)
            if domain in CONSUMER_MAIL_DOMAINS:
                count += 1
                return REMOVED
            return m.group(0)

        line = _EMAIL.sub(email, line)
        out_lines.append(line)
    return "\n".join(out_lines), count


def is_sensitive(text: str) -> bool:
    """True when the claim is about family, health, politics, religion or someone's home."""
    cleaned = _ALLOW.sub(" ", text)
    return bool(_SENSITIVE.search(cleaned))


def mostly_removed(text: str) -> bool:
    rest = text.replace(REMOVED, " ")
    words = re.findall(r"[A-Za-z0-9]{2,}", rest)
    return text.count(REMOVED) > 0 and len(words) < 3


def scrub(text: str | None, *, drop_sensitive: bool = True) -> Scrubbed:
    """One claim: stripped of contact details, or dropped (``text=None``)."""
    if text is None:
        return Scrubbed(None, 0)
    if drop_sensitive and is_sensitive(text):
        return Scrubbed(None, 1)
    cleaned, n = strip_contacts(text)
    if n and mostly_removed(cleaned):
        return Scrubbed(None, n)
    return Scrubbed(cleaned, n)


def scrub_source_text(text: str | None) -> tuple[str | None, int]:
    """Source titles and snippets: strip contacts; a sensitive snippet is emptied (the page may
    still back professional facts, but its private text is not kept)."""
    if not text:
        return text, 0
    if is_sensitive(text):
        return None, 1
    cleaned, n = strip_contacts(text)
    return (None if n and mostly_removed(cleaned) else cleaned), n
