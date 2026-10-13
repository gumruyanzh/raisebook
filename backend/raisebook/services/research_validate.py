"""Dossier validation shared by model and agent dossiers (RESEARCH-PLAN §4.6; R2, R3, R13).

Pure functions, in the order they run:

1. **Schema**: Pydantic (``schemas/dossier.py``); the caller turns errors into
   ``invalid_dossier`` (agents) or one writer retry (model).
2. **Suppression** lives in ``services/research_removal.py`` (it needs the database).
3. **Anchor match** per source (:func:`check_source`): a source is kept only when it is about
   the confirmed identity: the anchor LinkedIn profile (``linkedin``), the firm's own domain
   (``firm_domain``), the full name together with the firm (``name_firm``), or the full name
   together with the title and no other firm (``name_title``). Personal social sites are
   discarded (``personal_domain``), and so are other people's LinkedIn pages.
4. **Privacy** (``services/privacy_filter.py``) on every text.
5. **Citations** (R2): each fact keeps only source ids that were accepted; a fact left with
   none moves to ``unverified`` (model) or is dropped (agent). Analysis keeps only fact keys
   that survived; a public "way in" with no evidence is dropped (never guess who knows whom);
   a "workspace" way in must name a value from the workspace facts given (model only).
   Suggestions without evidence are dropped.
6. **Caps**: ≤40 facts, ≤10 activity items (newest first), ≤8 talking points, ≤6 ways in,
   ≤10 unverified claims.
"""

from __future__ import annotations

import datetime as dt
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from raisebook.models.enums import AnchorMatch
from raisebook.schemas.dossier import DossierDoc, WriterDoc
from raisebook.services import privacy_filter
from raisebook.services.normalize import linkedin_key, norm, norm_firm

MAX_FACTS = 40
MAX_ACTIVITY = 10
MAX_TALKING_POINTS = 8
MAX_WAYS_IN = 6
MAX_UNVERIFIED = 10

PERSONAL_DOMAINS = frozenset(
    {
        "facebook.com",
        "fb.com",
        "instagram.com",
        "tiktok.com",
        "threads.net",
        "threads.com",
        "snapchat.com",
        "pinterest.com",
        "vk.com",
        "ok.ru",
        "tinder.com",
        "onlyfans.com",
        "myspace.com",
        "flickr.com",
        "strava.com",
        "venmo.com",
        "nextdoor.com",
        "ancestry.com",
        "findagrave.com",
        "legacy.com",
        "whitepages.com",
        "spokeo.com",
        "beenverified.com",
        "truepeoplesearch.com",
    }
)
_TRACKING = re.compile(r"^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|trk$|trackingid$)", re.I)
_OTHER_FIRM = re.compile(
    r"\b(?:at|of|from|with|joined)\s+((?:[A-Z][\w&.'-]*\s+){0,3}"
    r"(?:Ventures|Capital|Partners|VC|Fund|Investments|Holdings))\b"
)


# --- URLs ------------------------------------------------------------------------------------


def domain_of(url: str | None) -> str | None:
    """Lowercase host without ``www.`` (None for anything that is not http(s) with a host)."""
    if not url:
        return None
    raw = url.strip()
    if "://" not in raw:
        if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:(?!\d)", raw):
            return None  # mailto:, tel:, javascript: …
        raw = "https://" + raw.lstrip("/")
    try:
        parts = urlsplit(raw)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    if "." not in host:
        return None
    return host.removeprefix("www.")


def url_key(url: str) -> str | None:
    """Normalized URL for dedupe: lowercase host, no ``www.``, fragment, tracking parameters
    or trailing slash."""
    host = domain_of(url)
    if host is None:
        return None
    parts = urlsplit(url.strip())
    query = urlencode(
        sorted(
            (k, v)
            for k, v in parse_qsl(parts.query, keep_blank_values=True)
            if not _TRACKING.match(k)
        )
    )
    path = parts.path.rstrip("/") or ""
    return urlunsplit(("https", host, path, query, ""))[:2000]


def _is_subdomain(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


# --- the anchor (R3) -------------------------------------------------------------------------


@dataclass(frozen=True)
class Anchor:
    """Who research is about: the confirmed identity every source must match."""

    name: str
    firm: str | None = None
    firm_domain: str | None = None
    linkedin_key: str | None = None
    title: str | None = None

    @classmethod
    def of(
        cls,
        *,
        name: str,
        firm: str | None = None,
        firm_website: str | None = None,
        linkedin_url: str | None = None,
        title: str | None = None,
        firm_domain: str | None = None,
    ) -> Anchor:
        domain = firm_domain or domain_of(firm_website)
        if domain and domain in ("linkedin.com", *PERSONAL_DOMAINS):
            domain = None
        return cls(
            name=name,
            firm=firm or None,
            firm_domain=domain,
            linkedin_key=linkedin_key(linkedin_url),
            title=title or None,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "firm": self.firm,
            "firm_domain": self.firm_domain,
            "linkedin_key": self.linkedin_key,
            "title": self.title,
        }


@dataclass(frozen=True)
class SourceCheck:
    accepted: bool
    matched: str | None = None  # AnchorMatch
    reason: str | None = None  # anchor_mismatch | personal_domain | privacy | duplicate


def _contains(haystack: str, needle: str) -> bool:
    return bool(needle) and f" {needle} " in f" {haystack} "


def _linkedin_page(path: str, anchor: Anchor) -> str:
    """``anchor`` (the anchor's own profile or posts), ``company``, or ``other``."""
    parts = [p for p in path.lower().split("/") if p]
    if len(parts) >= 2 and parts[0] == "in":
        return "anchor" if anchor.linkedin_key == f"in/{parts[1]}" else "other"
    if len(parts) >= 2 and parts[0] == "posts" and anchor.linkedin_key:
        slug = anchor.linkedin_key.removeprefix("in/")
        return "anchor" if parts[1].startswith(slug + "_") or parts[1] == slug else "other"
    if parts and parts[0] in ("company", "school", "showcase"):
        return "company"
    return "other"


def check_source(url: str, title: str | None, snippet: str | None, anchor: Anchor) -> SourceCheck:
    """Is this page about the anchor? (RESEARCH-PLAN §4.6 step 3.)"""
    host = domain_of(url)
    if host is None:
        return SourceCheck(False, reason="anchor_mismatch")
    if any(_is_subdomain(host, d) for d in PERSONAL_DOMAINS):
        return SourceCheck(False, reason="personal_domain")
    if _is_subdomain(host, "linkedin.com"):
        kind = _linkedin_page(urlsplit(url.strip()).path, anchor)
        if kind == "anchor":
            return SourceCheck(True, matched=AnchorMatch.LINKEDIN.value)
        if kind == "other":
            return SourceCheck(False, reason="anchor_mismatch")
    elif anchor.firm_domain and _is_subdomain(host, anchor.firm_domain):
        return SourceCheck(True, matched=AnchorMatch.FIRM_DOMAIN.value)
    text = norm(f"{title or ''} {snippet or ''}")
    name = norm(anchor.name)
    if not _contains(text, name):
        return SourceCheck(False, reason="anchor_mismatch")
    firm = norm_firm(anchor.firm)
    if firm and _contains(text, firm):
        return SourceCheck(True, matched=AnchorMatch.NAME_FIRM.value)
    if anchor.firm_domain and anchor.firm_domain in f"{title or ''} {snippet or ''}".lower():
        return SourceCheck(True, matched=AnchorMatch.NAME_FIRM.value)
    title_n = norm(anchor.title)
    if title_n and _contains(text, title_n):
        others = [
            m.group(1)
            for m in _OTHER_FIRM.finditer(f"{title or ''} {snippet or ''}")
            if not firm or norm_firm(m.group(1)) != firm
        ]
        if not others:
            return SourceCheck(True, matched=AnchorMatch.NAME_TITLE.value)
    return SourceCheck(False, reason="anchor_mismatch")


@dataclass
class RawSource:
    """A source before checks (from a search call, or an agent's ``sources``)."""

    local_id: str
    url: str
    title: str | None = None
    snippet: str | None = None
    published_at: dt.date | None = None


@dataclass
class CheckedSource:
    local_id: str
    url: str
    url_key: str
    domain: str
    title: str | None
    snippet: str | None
    published_at: dt.date | None
    check: SourceCheck


def check_sources(raw: Iterable[RawSource], anchor: Anchor) -> tuple[list[CheckedSource], int]:
    """Anchor-check, privacy-scrub and dedupe sources. Returns ``(sources, privacy_removed)``.
    Rejected sources are returned too (kept for the run's counts, never cited)."""
    out: list[CheckedSource] = []
    seen: set[str] = set()
    removed = 0
    for src in raw:
        key = url_key(src.url)
        host = domain_of(src.url)
        if key is None or host is None:
            continue
        title, n1 = privacy_filter.scrub_source_text(src.title)
        snippet, n2 = privacy_filter.scrub_source_text(src.snippet)
        removed += n1 + n2
        if key in seen:
            check = SourceCheck(False, reason="duplicate")
        else:
            seen.add(key)
            # The anchor check reads the original text; only scrubbed text is stored.
            check = check_source(src.url, src.title, src.snippet, anchor)
        out.append(
            CheckedSource(
                src.local_id,
                src.url.strip()[:2000],
                key,
                host[:255],
                title[:300] if title else None,
                snippet[:1200] if snippet else None,
                src.published_at,
                check,
            )
        )
    return out, removed


def parse_date(value: Any) -> dt.date | None:
    """A lenient date (``2026-03-04``, ``2026-03``, ``2026``, RFC 3339) or None."""
    if isinstance(value, dt.date):
        return value
    if not isinstance(value, str):
        return None
    text = value.strip()
    for fmt, size in (("%Y-%m-%d", 10), ("%Y-%m", 7), ("%Y", 4)):
        try:
            return dt.datetime.strptime(text[:size], fmt).date()
        except ValueError:
            continue
    return None


# --- the document ------------------------------------------------------------------------------


@dataclass
class Dropped:
    key: str
    reason: str

    def as_dict(self) -> dict[str, str]:
        return {"key": self.key, "reason": self.reason}


@dataclass
class Outcome:
    facts: list[dict[str, Any]]
    analysis: dict[str, Any]
    suggestions: dict[str, Any]
    unverified: list[dict[str, Any]]
    verdict: str
    dropped: list[Dropped] = field(default_factory=list)
    moved_to_unverified: int = 0
    privacy_removed: int = 0

    @property
    def fact_keys(self) -> set[str]:
        return {f["key"] for f in self.facts}


def _clean(text: str, counter: list[int]) -> str | None:
    res = privacy_filter.scrub(text)
    counter[0] += res.removed
    return res.text


def _keys(keys: Sequence[str], live: set[str]) -> list[str]:
    out: list[str] = []
    for k in keys:
        if k in live and k not in out:
            out.append(k)
    return out


def _sort_activity(facts: list[dict[str, Any]], dates: Mapping[str, dt.date | None]) -> None:
    def when(f: dict[str, Any]) -> tuple[int, dt.date]:
        d = parse_date(f.get("date"))
        if d is None:
            ds = [dates.get(s) for s in f["source_ids"]]
            known = [x for x in ds if x is not None]
            d = max(known) if known else None
        return (0, d) if d is not None else (1, dt.date.min)

    facts.sort(key=lambda f: (when(f)[0], -when(f)[1].toordinal()))


def finalize(
    doc: DossierDoc | WriterDoc,
    *,
    accepted_ids: set[str],
    source_dates: Mapping[str, dt.date | None] | None = None,
    agent: bool,
    workspace_facts: Sequence[str] = (),
    anchor: Anchor | None = None,
) -> Outcome:
    """Privacy, citations and caps over a schema-valid document (steps 4 to 6)."""
    dates = source_dates or {}
    counter = [0]
    dropped: list[Dropped] = []
    unverified: list[dict[str, Any]] = []
    moved = 0

    # Facts: privacy, citations, duplicate keys.
    facts: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for fact in doc.facts:
        if fact.key in seen_keys:
            dropped.append(Dropped(fact.key, "duplicate_key"))
            continue
        seen_keys.add(fact.key)
        text = _clean(fact.text, counter)
        if text is None:
            dropped.append(Dropped(fact.key, "privacy"))
            continue
        cited = _keys(fact.source_ids, accepted_ids)
        if not cited:
            if agent:
                dropped.append(Dropped(fact.key, "uncited"))
            else:
                unverified.append({"section": fact.section, "text": text})
                moved += 1
            continue
        facts.append(
            {
                "key": fact.key,
                "section": fact.section,
                "kind": fact.kind,
                "text": text,
                "date": fact.date.isoformat() if fact.date else None,
                "source_ids": cited,
            }
        )

    # Caps: the newest activity first, then the total.
    activity = [f for f in facts if f["section"] == "activity"]
    _sort_activity(activity, dates)
    for f in activity[MAX_ACTIVITY:]:
        dropped.append(Dropped(f["key"], "cap"))
    keep_activity = {id(f) for f in activity[:MAX_ACTIVITY]}
    facts = [f for f in facts if f["section"] != "activity" or id(f) in keep_activity]
    for f in facts[MAX_FACTS:]:
        dropped.append(Dropped(f["key"], "cap"))
    facts = facts[:MAX_FACTS]
    live = {f["key"] for f in facts}

    # Analysis (private): prune evidence, never keep an unsupported path in.
    a = doc.analysis
    brief = {
        "verdict": a.brief.verdict,
        "why": _clean(a.brief.why, counter) or "",
        "best_way_in": _clean(a.brief.best_way_in, counter) or "" if a.brief.best_way_in else "",
        "opener": _clean(a.brief.opener, counter) or "" if a.brief.opener else "",
        "risk": _clean(a.brief.risk, counter) or "" if a.brief.risk else "",
        "fact_keys": _keys(a.brief.fact_keys, live),
    }
    if not brief["why"]:
        brief["why"] = "See the sections below."

    def claim(c: Any, where: str) -> dict[str, Any] | None:
        if c is None:
            return None
        text = _clean(c.text, counter)
        if text is None:
            dropped.append(Dropped(where, "privacy"))
            return None
        keys = _keys(c.fact_keys, live)
        if not keys:
            dropped.append(Dropped(where, "uncited"))
            return None
        return {"text": text, "fact_keys": keys}

    fit: dict[str, Any] = {}
    for part in ("stage", "sector", "check", "deploying"):
        got = claim(getattr(a.fit, part), f"fit.{part}")
        if got is not None:
            fit[part] = got
    conflicts = [claim(c, f"fit.conflicts.{i}") for i, c in enumerate(a.fit.conflicts)]
    fit["conflicts"] = [c for c in conflicts if c is not None]

    lowered_facts = [w.casefold() for w in workspace_facts if w and w.strip()]
    ways_in: list[dict[str, Any]] = []
    for i, way in enumerate(a.ways_in):
        where = f"ways_in.{i}"
        text = _clean(way.text, counter)
        if text is None:
            dropped.append(Dropped(where, "privacy"))
            continue
        keys = _keys(way.fact_keys, live)
        if way.basis == "workspace":
            if agent:
                dropped.append(Dropped(where, "workspace_basis_not_allowed"))
                continue
            if not any(w in text.casefold() for w in lowered_facts):
                dropped.append(Dropped(where, "not_in_workspace_facts"))
                continue
        elif not keys:
            dropped.append(Dropped(where, "no_evidence"))
            continue
        ways_in.append({"text": text, "basis": way.basis, "fact_keys": keys})
    for i in range(MAX_WAYS_IN, len(ways_in)):
        dropped.append(Dropped(f"ways_in.{i}", "cap"))
    ways_in = ways_in[:MAX_WAYS_IN]

    talking: list[dict[str, Any]] = []
    for i, tp in enumerate(a.talking_points):
        text = _clean(tp.text, counter)
        if text is None:
            dropped.append(Dropped(f"talking_points.{i}", "privacy"))
            continue
        talking.append({"text": text, "fact_keys": _keys(tp.fact_keys, live)})
    for i in range(MAX_TALKING_POINTS, len(talking)):
        dropped.append(Dropped(f"talking_points.{i}", "cap"))
    talking = talking[:MAX_TALKING_POINTS]

    # Suggestions: evidence required; a work email only on the firm's own domain.
    suggestions: dict[str, Any] = {}
    for name, sug in doc.suggestions:
        if sug is None:
            continue
        keys = _keys(sug.fact_keys, live)
        if not keys:
            dropped.append(Dropped(f"suggestions.{name}", "uncited"))
            continue
        value = sug.value
        if isinstance(value, str):
            if name == "email":
                at = value.rsplit("@", 1)[-1].lower() if "@" in value else ""
                firm_domain = anchor.firm_domain if anchor else None
                if not firm_domain or not _is_subdomain(at, firm_domain):
                    dropped.append(Dropped("suggestions.email", "not_a_work_email"))
                    continue
            else:
                cleaned = _clean(value, counter)
                if cleaned is None or cleaned != value:
                    dropped.append(Dropped(f"suggestions.{name}", "privacy"))
                    continue
        elif isinstance(value, list):
            items = [x for x in value if not privacy_filter.is_sensitive(x)]
            if not items:
                dropped.append(Dropped(f"suggestions.{name}", "privacy"))
                continue
            value = items
        suggestions[name] = {"value": value, "fact_keys": keys}

    for item in doc.unverified:
        text = _clean(item.text, counter)
        if text is not None:
            unverified.append({"section": item.section, "text": text})
    unverified = unverified[:MAX_UNVERIFIED]

    return Outcome(
        facts=facts,
        analysis={"brief": brief, "fit": fit, "ways_in": ways_in, "talking_points": talking},
        suggestions=suggestions,
        unverified=unverified,
        verdict=a.brief.verdict,
        dropped=dropped,
        moved_to_unverified=moved,
        privacy_removed=counter[0],
    )


def identity_matches(
    submitted_name: str,
    submitted_linkedin: str | None,
    submitted_firm_website: str | None,
    anchor: Anchor,
) -> bool:
    """An agent's ``identity`` equals the confirmed anchor: the same LinkedIn profile, or the
    same firm domain and name (the name alone only when the anchor has neither)."""
    lk = linkedin_key(submitted_linkedin)
    if lk and anchor.linkedin_key and lk == anchor.linkedin_key:
        return True
    if lk and anchor.linkedin_key:
        return False
    same_name = norm(submitted_name) == norm(anchor.name)
    domain = domain_of(submitted_firm_website)
    if domain and anchor.firm_domain:
        return same_name and (
            _is_subdomain(domain, anchor.firm_domain) or _is_subdomain(anchor.firm_domain, domain)
        )
    if anchor.linkedin_key or anchor.firm_domain:
        return False
    return same_name
