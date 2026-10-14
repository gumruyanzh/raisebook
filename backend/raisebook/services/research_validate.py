"""Dossier validation shared by model and agent dossiers (RESEARCH-PLAN §4.6; R2, R3, R13).

Pure functions, in the order they run:

1. **Schema**: Pydantic (``schemas/dossier.py``); the caller turns errors into
   ``invalid_dossier`` (agents) or one writer retry (model).
2. **Suppression** lives in ``services/research_removal.py`` (it needs the database).
3. **Anchor match** per source (:func:`check_sources`): a source is kept only when it is about
   the confirmed identity: the anchor LinkedIn profile (``linkedin``) or X account
   (``profile``), the firm's own domain (``firm_domain``), the name with the firm
   (``name_firm``) or with a known past firm (``name_past_firm``), the full name with the title
   (``name_title``), or a distinctive full name alone (``name``). The name tied to another
   firm is a ``conflict``; a first name alone, or a common name without a firm or title, is an
   ``anchor_mismatch``. Personal social sites are discarded (``personal_domain``), and so are
   other LinkedIn profiles. Name forms and organizations are read by ``research_anchor``.
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
from functools import cached_property
from typing import Any
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

from raisebook.models.enums import AnchorMatch
from raisebook.schemas.dossier import DossierDoc, WriterDoc
from raisebook.services import privacy_filter
from raisebook.services import research_anchor as anchor_text
from raisebook.services.normalize import linkedin_key, norm, norm_firm

MAX_FACTS = 40
MAX_ACTIVITY = 10
MAX_TALKING_POINTS = 8
MAX_WAYS_IN = 6
MAX_FROM_NOTES = 20
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


def _compact(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def domain_resembles_firm(domain: str | None, firm: str | None) -> bool:
    """Does the domain carry the firm's name (``harborlight.example`` for Harbor Light
    Ventures)? Used before research writes a website or email into an investor unasked: a
    page a search found can name any domain."""
    if not domain or not firm:
        return False
    name = _compact(norm_firm(firm)) or _compact(norm(firm))
    if len(name) < 3:
        return False
    labels = [_compact(lbl) for lbl in domain.lower().split(".")[:-1]]
    return any(
        lbl == name or (len(name) >= 4 and name in lbl) or (len(lbl) >= 4 and lbl in name)
        for lbl in labels
        if lbl
    )


@dataclass(frozen=True)
class Trust:
    """Which anchor fields research may write into an investor without a person's click."""

    linkedin: bool = False
    domain: bool = False


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

    @cached_property
    def person(self) -> anchor_text.PersonName:
        return anchor_text.PersonName.of(self.name)

    @property
    def firm_domain_label(self) -> str | None:
        """The firm domain's name part (``harborlight`` for harborlight.example), when it can
        stand for the firm."""
        if not self.firm_domain:
            return None
        label = self.firm_domain.split(".")[0]
        return label if len(label) >= 4 else None

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
    # anchor_mismatch | conflict | personal_domain | privacy | duplicate
    reason: str | None = None


_X_HOSTS = ("x.com", "twitter.com")
# A page listing everyone with a name ("12 people named …", "30+ profiles").
_NAME_LIST = re.compile(r"(?i)\b\d+\+?\s+(?:people|profiles|persons|records)\b|\bpeople named\b")
_X_RESERVED = frozenset({"i", "search", "hashtag", "intent", "share", "home", "explore"})


def _linkedin_page(path: str, anchor: Anchor) -> str:
    """``anchor`` (the anchor's own profile or posts), ``profile`` (another person's profile),
    ``company``, or ``other`` (someone else's post, an article…)."""
    parts = [p for p in path.lower().split("/") if p]
    if len(parts) >= 2 and parts[0] == "in":
        return "anchor" if anchor.linkedin_key == f"in/{parts[1]}" else "profile"
    if parts and parts[0] == "pub":
        # /pub/dir/First/Last lists everyone with the name; /pub/<slug> is an old profile URL.
        return "directory" if len(parts) < 2 or parts[1] == "dir" else "profile"
    if len(parts) >= 2 and parts[0] == "posts" and anchor.linkedin_key:
        slug = anchor.linkedin_key.removeprefix("in/")
        if parts[1].startswith(slug + "_") or parts[1] == slug:
            return "anchor"
    if parts and parts[0] in ("company", "school", "showcase"):
        return "company"
    return "other"


def _slug_text(url: str) -> str:
    """The URL path as words (``/people/niko-wrenfield`` → ``people niko wrenfield``)."""
    try:
        path = unquote(urlsplit(url.strip()).path)
    except ValueError:
        return ""
    return norm(re.sub(r"[-_/.+~]", " ", path))


@dataclass
class _Signals:
    """What one page says about the anchor, before past firms are known."""

    level: str | None  # full | surname | first | None
    texts: tuple[str, ...]  # normalized title+snippet (two spellings) and the URL path
    orgs: anchor_text.OrgMentions
    firm_named: bool  # the anchor's firm (or its domain) is named
    firm_named_strong: bool  # …by its full name or domain (enough next to a surname alone)
    title_named: bool
    other_firms: list[str]  # "at/of/with … Capital" for firms that are not the anchor's
    other_person: bool  # another first name right before the surname ("Tom Wrenfield")
    context: bool  # the page is about investing (research_anchor.investing_context)
    off_context: bool  # …or plainly about something else (an obituary, a film page)
    name_list: bool  # a list of everyone with the name ("12 people named …")


def _signals(url: str, title: str | None, snippet: str | None, anchor: Anchor) -> _Signals:
    name = anchor.person
    raw = f"{title or ''} \n {snippet or ''}"
    body, body_split = anchor_text.norm_texts(raw)
    slug = _slug_text(url)
    texts = (body, body_split, slug)
    orgs = anchor_text.OrgMentions()
    for part in (title, snippet):
        got = anchor_text.org_mentions(part, name)
        orgs.affiliations += [o for o in got.affiliations if o not in orgs.affiliations]
        orgs.history += [o for o in got.history if o not in orgs.history]
    firm_full = norm(anchor_text.fold(anchor.firm)) if anchor.firm else ""
    firm_core = norm_firm(anchor_text.fold(anchor.firm)) if anchor.firm else ""
    lowered = anchor_text.fold(raw).lower()
    domain_named = bool(anchor.firm_domain) and bool(
        re.search(rf"(?<![\w.-]){re.escape(anchor.firm_domain or '')}(?![\w-]|\.\w)", lowered)
    )
    full_named = bool(firm_full) and any(anchor_text.phrase_in(t, firm_full) for t in texts)
    core_named = bool(firm_core) and any(anchor_text.phrase_in(t, firm_core) for t in texts)
    strong = domain_named or (full_named and (len(firm_full.split()) >= 2 or len(firm_full) >= 5))
    if not strong and firm_core and len(firm_core.split()) >= 2:
        strong = core_named
    title_n = norm(anchor.title)
    others = [
        m.group(1)
        for m in _OTHER_FIRM.finditer(anchor_text.fold(raw))
        if not anchor.firm or not anchor_text.same_org(m.group(1), anchor.firm)
    ]
    level = name.level(body, body_split, slug)
    host = domain_of(url)
    return _Signals(
        level=level,
        texts=texts,
        orgs=orgs,
        firm_named=domain_named or full_named or core_named,
        firm_named_strong=strong,
        title_named=bool(title_n) and anchor_text.phrase_in(body, title_n),
        other_firms=others,
        other_person=level == "surname"
        and any(
            # Words of the firms the page names may precede the surname ("Ex-Fernhill Group
            # Wrenfield"); another first name may not.
            name.other_person(
                part, [k for k in (anchor.firm, anchor.firm_domain_label) if k] + orgs.all()
            )
            for part in (title, snippet)
        ),
        context=anchor_text.investing_context(texts, host),
        off_context=anchor_text.off_context(texts, host),
        name_list=bool(_NAME_LIST.search(raw)),
    )


def _url_check(url: str, anchor: Anchor) -> SourceCheck | None:
    """Rules that read only the URL: a decision, or None to read the text."""
    host = domain_of(url)
    if host is None:
        return SourceCheck(False, reason="anchor_mismatch")
    if any(_is_subdomain(host, d) for d in PERSONAL_DOMAINS):
        return SourceCheck(False, reason="personal_domain")
    path = urlsplit(url.strip()).path
    if _is_subdomain(host, "linkedin.com"):
        kind = _linkedin_page(path, anchor)
        if kind == "anchor":
            return SourceCheck(True, matched=AnchorMatch.LINKEDIN.value)
        if kind == "directory":
            return SourceCheck(False, reason="anchor_mismatch")
        if kind == "profile" and anchor.linkedin_key:
            # Another profile than the confirmed one: someone else, even with the same name.
            return SourceCheck(False, reason="anchor_mismatch")
        return None
    if anchor.firm_domain and _is_subdomain(host, anchor.firm_domain):
        return SourceCheck(True, matched=AnchorMatch.FIRM_DOMAIN.value)
    if any(_is_subdomain(host, h) for h in _X_HOSTS):
        parts = [p for p in path.lower().split("/") if p]
        if parts and parts[0] not in _X_RESERVED and parts[0] in _handles(anchor):
            return SourceCheck(True, matched=AnchorMatch.PROFILE.value)
    return None


def _handles(anchor: Anchor) -> set[str]:
    out = anchor.person.handles()
    if anchor.linkedin_key:
        out.add(anchor.linkedin_key.removeprefix("in/").lower())
    return out


def _decide(sig: _Signals, anchor: Anchor, past_firms: Sequence[str]) -> SourceCheck:
    """Rules that read the text (``_url_check`` found no answer)."""
    name = anchor.person
    if sig.level not in ("full", "surname") or sig.name_list:
        return SourceCheck(False, reason="anchor_mismatch")
    if sig.other_person:
        # "Tom Wrenfield, Partner at Larkspur": the surname, but someone else's first name.
        return SourceCheck(False, reason="conflict")
    known = [k for k in (anchor.firm, anchor.firm_domain_label) if k]
    past_named = any(anchor_text.org_in_text(p, *sig.texts) for p in past_firms) or any(
        anchor_text.matches_any(o, past_firms) for o in sig.orgs.all()
    )
    elsewhere = [
        o
        for o in sig.orgs.affiliations
        if not anchor_text.matches_any(o, known) and not anchor_text.matches_any(o, past_firms)
    ]
    full = sig.level == "full"
    if sig.firm_named if full else sig.firm_named_strong:
        return SourceCheck(True, matched=AnchorMatch.NAME_FIRM.value)
    if past_named:
        return SourceCheck(True, matched=AnchorMatch.NAME_PAST_FIRM.value)
    if elsewhere:
        # The name next to a firm that is neither the anchor's nor a known past one.
        return SourceCheck(False, reason="conflict")
    if not full:
        return SourceCheck(False, reason="anchor_mismatch")
    # The weakest ties (name and title, or the name alone): any other firm on the page, or a
    # page plainly about something other than investing, points at a namesake.
    if any(not anchor_text.matches_any(o, past_firms) for o in sig.other_firms):
        return SourceCheck(False, reason="conflict")
    if sig.off_context:
        return SourceCheck(False, reason="anchor_mismatch")
    if sig.title_named:
        return SourceCheck(True, matched=AnchorMatch.NAME_TITLE.value)
    if not name.common and sig.context:
        return SourceCheck(True, matched=AnchorMatch.NAME.value)
    return SourceCheck(False, reason="anchor_mismatch")


def check_source(
    url: str,
    title: str | None,
    snippet: str | None,
    anchor: Anchor,
    *,
    past_firms: Sequence[str] = (),
) -> SourceCheck:
    """Is this page about the anchor? (RESEARCH-PLAN §4.6 step 3.) ``past_firms`` are firms
    the person is known to have worked at (``check_sources`` learns them from the run)."""
    decided = _url_check(url, anchor)
    if decided is not None:
        return decided
    return _decide(_signals(url, title, snippet, anchor), anchor, past_firms)


def learn_past_firms(
    pages: Sequence[tuple[SourceCheck, anchor_text.OrgMentions]], anchor: Anchor
) -> list[str]:
    """Firms the person worked at, read from pages already tied to them.

    Pages tied by something besides the name (the anchor's LinkedIn or X profile, the firm's
    domain, the name with the firm) teach every firm they put next to the name. Pages tied by
    a distinctive name alone teach only history ("ex-Org", "Name leaves Org"), and only an
    organization at least two pages tie to the name, so one namesake's page cannot teach its
    firm."""
    strong = {
        AnchorMatch.LINKEDIN.value,
        AnchorMatch.PROFILE.value,
        AnchorMatch.FIRM_DOMAIN.value,
        AnchorMatch.NAME_FIRM.value,
    }
    weak = {AnchorMatch.NAME.value, AnchorMatch.NAME_TITLE.value}
    known = [k for k in (anchor.firm, anchor.firm_domain_label) if k]
    out: list[str] = []

    def add(org: str) -> None:
        if not anchor_text.matches_any(org, known) and not anchor_text.matches_any(org, out):
            out.append(org)

    for check, orgs in pages:
        if check.matched in strong:
            for org in orgs.all():
                add(org)
    for check, orgs in pages:
        if check.matched in weak:
            for org in orgs.history:
                seen = sum(1 for _, o in pages if anchor_text.matches_any(org, o.all()))
                if seen >= 2:
                    add(org)
    return out


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
    Rejected sources are returned too (kept for the run's counts, never cited).

    Two passes: the first checks every page against the anchor alone, the second again with
    the past firms those results vouch for (:func:`learn_past_firms`), so "Ex-Harbor Light
    partner Whitfield" counts once the person's own profile says they worked there."""
    out: list[CheckedSource] = []
    seen: set[str] = set()
    removed = 0
    pending: list[tuple[int, RawSource]] = []
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
            check = SourceCheck(False, reason="anchor_mismatch")  # decided below
            pending.append((len(out), src))
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
    # The anchor check reads the original text; only scrubbed text is stored.
    first: list[tuple[int, SourceCheck | None, _Signals]] = []
    pages: list[tuple[SourceCheck, anchor_text.OrgMentions]] = []
    for i, src in pending:
        decided = _url_check(src.url, anchor)
        sig = _signals(src.url, src.title, src.snippet, anchor)
        check = decided if decided is not None else _decide(sig, anchor, ())
        first.append((i, decided, sig))
        if sig.level in ("full", "surname"):
            pages.append((check, sig.orgs))
    past = learn_past_firms(pages, anchor)
    for i, decided, sig in first:
        out[i].check = decided if decided is not None else _decide(sig, anchor, past)
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
    # Suggestions that become "accept / ignore" even for an empty field (contact details
    # research cannot vouch for: another domain or profile than the confirmed identity's).
    review: set[str] = field(default_factory=set)
    # Claims known only from the founder's notes (``use_notes_in_research``): private, shown
    # "from your notes", never public facts and never verified (owner decision 2026-10-14).
    from_notes: list[dict[str, Any]] = field(default_factory=list)

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
    trusted_anchor: Trust | None = None,
    notes_id: str | None = None,
) -> Outcome:
    """Privacy, citations and caps over a schema-valid document (steps 4 to 6).

    ``notes_id`` (model runs that sent the founder's notes): a fact citing only that id is
    kept apart in ``from_notes``, never among the cited public facts."""
    dates = source_dates or {}
    counter = [0]
    dropped: list[Dropped] = []
    unverified: list[dict[str, Any]] = []
    from_notes: list[dict[str, Any]] = []
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
        if not cited and notes_id is not None and notes_id in fact.source_ids:
            if len(from_notes) < MAX_FROM_NOTES:
                from_notes.append({"section": fact.section, "text": text})
            continue
        if not cited:
            if agent:
                dropped.append(Dropped(fact.key, "uncited"))
            else:
                unverified.append({"section": fact.section, "text": text})
                moved += 1
            continue
        row: dict[str, Any] = {
            "key": fact.key,
            "section": fact.section,
            "kind": fact.kind,
            "text": text,
            "date": fact.date.isoformat() if fact.date else None,
            "source_ids": cited,
        }
        if notes_id is not None and notes_id in fact.source_ids:
            # A source backs it, but its wording may carry the founder's notes: internal
            # marker so it never leaves this workspace (``research_reuse.donor_facts``).
            row["notes"] = True
        facts.append(row)

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
    brief: dict[str, Any] = {
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

    # The Brief's way in and risk are claims too (R2, R5.5): the way in must be one of the
    # evidenced ways in that survived (never a guess at who knows whom), the risk needs a
    # surviving red flag or conflict behind it.
    if brief["best_way_in"]:
        brief["best_way_in"] = _brief_way_in(brief["best_way_in"], ways_in)
        if not brief["best_way_in"]:
            dropped.append(Dropped("brief.best_way_in", "no_evidence"))
    elif ways_in:
        brief["best_way_in"] = ways_in[0]["text"][:160]
    has_flags = any(f["section"] == "red_flags" for f in facts) or bool(fit["conflicts"])
    if brief["risk"] and not has_flags:
        brief["risk"] = ""
        dropped.append(Dropped("brief.risk", "no_evidence"))

    # Suggestions: evidence required; a work email only on the firm's own domain; contact
    # details the confirmed identity does not vouch for wait for a person (``review``).
    trust = trusted_anchor or Trust()
    review: set[str] = set()
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
                if not trust.domain:
                    review.add("email")
            elif name == "website_url":
                host = domain_of(value)
                firm_domain = anchor.firm_domain if anchor else None
                if host is None:
                    dropped.append(Dropped("suggestions.website_url", "invalid"))
                    continue
                if not (trust.domain and firm_domain and _is_subdomain(host, firm_domain)):
                    review.add("website_url")
            elif name == "linkedin_url":
                key = linkedin_key(value)
                if key is None:
                    dropped.append(Dropped("suggestions.linkedin_url", "invalid"))
                    continue
                if not (trust.linkedin and anchor and anchor.linkedin_key == key):
                    review.add("linkedin_url")
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
        review=review,
        from_notes=from_notes,
    )


def _brief_way_in(text: str, ways_in: Sequence[Mapping[str, Any]]) -> str:
    """The Brief's way in, only when it is (or plainly restates) an evidenced way in."""
    t = norm(text)
    for way in ways_in:
        w = norm(str(way["text"]))
        if t and w and (t == w or t in w or w in t):
            return text
    return ways_in[0]["text"][:160] if ways_in else ""


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
