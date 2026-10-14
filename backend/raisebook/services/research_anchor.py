"""Who a source is about: the text side of the anchor check (RESEARCH-PLAN §4.6 step 3).

Pure helpers used by ``research_validate.check_source(s)``:

- :class:`PersonName` turns the anchor's name into the forms a page may use: the full name
  (case, accents, a middle name and common nicknames tolerated: Nikolaos, Nikos or Niko), the
  surname alone, or only the first name. It also says whether the name is **common** (a short
  or very frequent surname, or a surname given only as an initial), in which case the name alone
  never identifies the person.
- :func:`org_mentions` reads the organizations a page ties to the name: ``Name (Org)``,
  ``Org's Name``, ``Name, Partner at Org`` (affiliations) and ``ex-Org``, ``former Org``,
  ``Name leaves Org``, ``Org appoints Name`` (history). An affiliation with an organization that
  is neither the anchor's firm nor a known past firm points at someone else with the same name.
- :func:`same_org` compares organization names leniently (suffixes, ``CG`` for Cinderford
  Group) without letting one generic word stand for a firm.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass, field
from functools import cached_property

from raisebook.services.normalize import norm, norm_firm

# Nickname groups. A first name matches every name of every group it belongs to (groups are
# not merged with each other, so John never reaches Ioannis' Yannis through Jack).
_NICKNAMES: tuple[frozenset[str], ...] = tuple(
    frozenset(g.split())
    for g in (
        "alexander alex alexandr aleksandr aleksander alexandre alessandro sasha",
        "alexandra alex alexa sasha lexi",
        "nikolaos nikolas nicholas nicolas nikola nikolai nikolay niko nico nick nikos nicky",
        "william will bill billy liam",
        "robert rob bob bobby robbie",
        "richard rick rich dick ricky",
        "michael mike mikey mick michal",
        "james jim jimmy jamie",
        "john jack johnny jon",
        "jonathan jon jonny",
        "joseph joe joey",
        "thomas tom tommy",
        "christopher chris kristopher",
        "christina christine kristina chris tina",
        "daniel dan danny",
        "david dave davy",
        "matthew matt",
        "andrew andy drew",
        "anthony tony antony",
        "benjamin ben benji",
        "samuel sam sammy",
        "samantha sam",
        "elizabeth liz beth eliza lizzie betty",
        "katherine catherine kathryn katharine kate katie kat cathy kathy",
        "margaret maggie meg peggy",
        "jennifer jen jenny",
        "rebecca becca becky",
        "patricia pat patty trish",
        "patrick pat paddy",
        "edward ed eddie ted",
        "theodore theo ted teddy",
        "steven stephen steve",
        "timothy tim",
        "kenneth ken kenny",
        "gregory greg",
        "jeffrey geoffrey jeff",
        "nathaniel nathan nate",
        "zachary zach zack",
        "jacob jake",
        "joshua josh",
        "victoria vicky tori",
        "susan sue suzy",
        "deborah debra deb debbie",
        "dmitry dmitri dmitrii dima",
        "mikhail misha",
        "yevgeny evgeny evgenii eugene zhenya",
        "konstantinos constantine kostas costas",
        "georgios giorgos george",
        "ioannis yannis giannis",
        "panagiotis panos",
        "vasileios vasilis bill",
        "dimitrios dimitris jim",
        "francesco frank franco",
        "francisco frank paco",
        "giuseppe joe beppe",
        "jose pepe",
    )
)

# Very frequent surnames (one per person in hundreds or more): with one of these the full name
# alone does not identify an investor, it needs the firm, a past firm or the title too.
COMMON_SURNAMES: frozenset[str] = frozenset(
    """
    smith johnson williams brown jones garcia miller davis rodriguez martinez hernandez lopez
    gonzalez wilson anderson thomas taylor moore jackson martin lee perez thompson white harris
    sanchez clark ramirez lewis robinson walker young allen king wright scott torres nguyen hill
    flores green adams nelson baker hall rivera campbell mitchell carter roberts gomez phillips
    evans turner diaz parker cruz edwards collins reyes stewart morris morales murphy cook rogers
    gutierrez ortiz morgan cooper peterson bailey reed kelly howard ramos kim cox ward richardson
    watson brooks chavez wood james bennett gray grey mendoza ruiz hughes price alvarez castillo
    sanders patel myers long ross foster jimenez powell jenkins perry russell sullivan bell coleman
    butler henderson barnes fisher vasquez simmons graham marshall owens harrison gibson wallace
    chen wang li zhang liu yang huang zhao wu zhou xu sun ma zhu hu guo he lin gao luo zheng liang
    xie tang han feng deng cao peng zeng xiao tian dong pan yuan cai jiang yu du ye cheng wei su
    park choi jung jeong kang cho yoon jang lim shin song
    tran le pham hoang phan vu vo dang bui do ho ngo duong ly
    shah singh kumar sharma gupta khan ali ahmed ahmad hussain rahman das reddy rao iyer mehta
    jain agarwal joshi verma mishra pandey
    cohen levi levy katz friedman
    schmidt schneider fischer weber meyer wagner becker schulz hoffmann muller mueller koch
    rossi russo ferrari esposito bianchi romano colombo ricci
    silva santos ferreira pereira oliveira costa rodrigues martins almeida
    ivanov smirnov kuznetsov popov petrov sokolov novak kowalski nowak wisniewski
    dubois bernard moreau laurent simon michel leroy roux
    tanaka suzuki sato takahashi watanabe ito yamamoto nakamura kobayashi kato
    murray kennedy obrien oconnor ryan walsh byrne
    """.split()
)

# Words that are never an organization on their own (and end an organization name read from a
# page: "Ex-Harbor Light Leader Whitfield" names Harbor Light).
_ROLE_WORDS: frozenset[str] = frozenset(
    """
    partner partners general managing director directors founder founders cofounder co-founder
    founding principal associate analyst investor investors venture ceo cto coo cfo cio
    president vice vp head chief officer md gp chair chairman chairwoman board member advisor
    adviser scout angel operating senior junior investment investing executive exec execs
    author editor writer reporter professor engineer manager lead leader team speaker mentor
    judge backer co
    """.split()
)
_STOP_WORDS: frozenset[str] = _ROLE_WORDS - {"partners", "venture", "investment", "general"} | {
    "a",
    "an",
    "the",
    "to",
    "in",
    "on",
    "for",
    "with",
    "and",
    "at",
    "of",
    "from",
    "by",
    "as",
    "after",
    "before",
    "is",
    "was",
    "has",
    "had",
    "who",
    "his",
    "her",
    "their",
    "its",
    "new",
    "says",
    "said",
    "targets",
    "launches",
    "launch",
    "raises",
    "raise",
    "plans",
    "joins",
    "leaves",
    "quits",
    "departs",
    "email",
    "profile",
    "portfolio",
    "linkedin",
    "contact",
    "phone",
    "breakdown",
    "thesis",
    "news",
    "interview",
    "podcast",
    "episode",
    "million",
    "billion",
}
# One of these alone never stands for a firm when comparing names ("General" is not General
# Cinderford, "Capital" is not Larkspur Capital).
_GENERIC_ORG_WORDS: frozenset[str] = frozenset(
    """
    general capital ventures venture partners partner global international group holdings first
    new digital united american national fund funds investments investment management advisors
    labs studio studios growth equity asset assets private public company the
    """.split()
)
_JUNK_ORGS: frozenset[str] = frozenset(
    "linkedin x twitter email profile vc ai us uk usa nyc sf la eu news blog".split()
)

_SKIP_LEAD = frozenset({"at", "of", "the", "&", "and"})
_CUE_BEFORE = r"(?:ex|former|formerly|previously|prev)(?:[\s-]+(?:at|of|with))?[\s-]+"
_CUE_AFTER_NAME = (
    r"(?:leaves|left|leaving|quits|quit|departs|departed|departing|exits|exited|"
    r"steps\s+down\s+(?:from|at)|stepped\s+down\s+(?:from|at)|joins|joined|"
    r"formerly\s+(?:of|at|with)|previously\s+(?:of|at|with))\s+"
)
_CUE_ORG_VERBS = (
    r"(?:appoints|appointed|hires|hired|names|named|welcomes|welcomed|adds|added|taps|tapped|"
    r"promotes|promoted|recruits|recruited|brings\s+on)"
)
_PUNCT = ',.;:!?"()[]|/\u00b7\u2014\u2013-'
_ENDS_CLAUSE = "[,.;:!?)\\]|/\u00b7\u2014\u2013]$"
_OPENS_CLAUSE = '[(\\["|/\u00b7\u2014\u2013]'
_ORG_WORD = r"(?:[A-Z0-9][\w&.'-]*|&)"
_CAMEL = re.compile(r"(?<=[a-z])(?=[A-Z][a-z])")


def fold(text: str | None) -> str:
    """Accents stripped and curly quotes straightened; case and punctuation kept."""
    t = unicodedata.normalize("NFKD", text or "")
    t = "".join(ch for ch in t if not unicodedata.combining(ch))
    return t.replace("\u2019", "'").replace("\u2018", "'")


def phrase_in(haystack: str, needle: str) -> bool:
    """``needle`` appears in the normalized ``haystack`` as whole words."""
    return bool(needle) and f" {needle} " in f" {haystack} "


def norm_texts(text: str | None) -> tuple[str, str]:
    """``norm`` of the text, plus a copy with glued words split ("investorsNiko Wrenfield")."""
    f = fold(text)
    return norm(f), norm(_CAMEL.sub(" ", f))


def _compact(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


# --- the name -------------------------------------------------------------------------------

_HONORIFICS = frozenset("dr mr mrs ms miss prof sir dame".split())
_SUFFIXES = frozenset("jr sr ii iii iv phd md mba cfa esq".split())


@dataclass(frozen=True)
class PersonName:
    first: str
    firsts: tuple[str, ...]  # the first name and its nicknames, longest first
    last: str  # "" for a one-word name
    initial: bool  # the surname is given as an initial ("Dana W")

    @classmethod
    def of(cls, name: str) -> PersonName:
        tokens = [t for t in norm(fold(name)).split() if t not in _HONORIFICS]
        while len(tokens) > 1 and tokens[-1] in _SUFFIXES:
            tokens.pop()
        if not tokens:
            return cls("", (), "", False)
        first = tokens[0]
        last = tokens[-1] if len(tokens) > 1 else ""
        variants = {first}
        for group in _NICKNAMES:
            if first in group:
                variants |= group
        return cls(first, tuple(sorted(variants, key=lambda v: (-len(v), v))), last, len(last) == 1)

    @property
    def common(self) -> bool:
        """The name alone does not single anyone out."""
        return not self.last or self.initial or len(self.last) <= 3 or self.last in COMMON_SURNAMES

    @property
    def distinctive_surname(self) -> bool:
        """The surname alone points at few people (enough together with a firm)."""
        return not self.common and len(self.last) >= 5

    @cached_property
    def _full_norm(self) -> re.Pattern[str]:
        firsts = "|".join(re.escape(f) for f in self.firsts)
        last = re.escape(self.last) + (r"\w*" if self.initial else "")
        return re.compile(
            rf"(?<!\w)(?:(?:{firsts})(?: \w+){{0,2}} {last}|{last} (?:{firsts}))(?!\w)"
        )

    @cached_property
    def raw_pattern(self) -> str:
        """Regex source finding the full name, or the surname, in folded raw text (any case;
        a glued "...investorsNiko Wrenfield" still counts)."""
        sep = r"[\s.-]+"
        firsts = "|".join(re.escape(f) for f in self.firsts)
        last = re.escape(self.last) + (r"[a-z]*" if self.initial else "")
        if not self.last:
            body = rf"(?i:{firsts})"
        else:
            full = rf"(?:{firsts})(?:{sep}[a-z][\w']*\.?){{0,2}}{sep}{last}"
            body = rf"(?i:{full}|{last})" if self.distinctive_surname else rf"(?i:{full})"
        return rf"(?:(?<![A-Za-z0-9])|(?<=[a-z])(?=[A-Z])){body}(?![A-Za-z0-9])"

    def level(self, *texts: str) -> str | None:
        """``full``, ``surname`` (a distinctive surname alone), ``first`` or None, for
        normalized texts."""
        if not self.firsts:
            return None
        best: str | None = None
        for t in texts:
            if not t:
                continue
            if self.last and self._full_norm.search(t):
                return "full"
            if self.distinctive_surname and phrase_in(t, self.last):
                best = "surname"
            elif best is None and any(phrase_in(t, f) for f in self.firsts):
                best = "first"
        return best

    def handles(self) -> set[str]:
        """Account names that are plainly this person's (``nikowrenfield``)."""
        if not self.last or self.initial:
            return set()
        return {f + self.last for f in self.firsts}


# --- organizations --------------------------------------------------------------------------


def _org_forward(text: str, *, skip_roles: bool = False, max_words: int = 4) -> str | None:
    """The organization name that starts ``text`` (capitalized words, stopping at a role or
    other stop word, punctuation, or after ``max_words``)."""
    out: list[str] = []
    for m in re.finditer(r"\S+", text):
        tok = m.group(0)
        core = tok.strip(_PUNCT)
        core = re.sub(r"'s$", "", core)
        if not core:
            break
        low = core.lower()
        if skip_roles and not out and low != "general" and low in _ROLE_WORDS | _SKIP_LEAD:
            continue
        if low in _STOP_WORDS or not re.fullmatch(_ORG_WORD, core):
            break
        out.append(core)
        if len(out) >= max_words or re.search(_ENDS_CLAUSE, tok) or tok.endswith("'s"):
            break
    while out and out[-1] in ("&",):
        out.pop()
    return " ".join(out) or None


def _org_backward(text: str, max_words: int = 3) -> str | None:
    """The organization name that ends ``text``."""
    out: list[str] = []
    for tok in reversed(text.split()):
        if out and re.search(_ENDS_CLAUSE, tok):
            break
        core = tok.strip(_PUNCT)
        if not core or core.lower() in _STOP_WORDS or not re.fullmatch(_ORG_WORD, core):
            break
        out.insert(0, core)
        if len(out) >= max_words or re.match(_OPENS_CLAUSE, tok):
            break
    return " ".join(out) or None


def _usable(org: str | None, name: PersonName) -> str | None:
    if not org or re.fullmatch(r"[\d\s.,$%&-]+", org):
        return None
    n = norm(org)
    if not n or n in _JUNK_ORGS or n in _GENERIC_ORG_WORDS:
        return None
    toks = n.split()
    if (name.last and name.last in toks) or any(f in toks for f in name.firsts):
        return None
    return org


@dataclass
class OrgMentions:
    affiliations: list[str] = field(default_factory=list)  # Name (Org), Org's Name, Name at Org
    history: list[str] = field(default_factory=list)  # ex-Org, Name leaves Org, Org hires Name

    def all(self) -> list[str]:
        return [*self.affiliations, *self.history]


def org_mentions(text: str | None, name: PersonName) -> OrgMentions:
    """Organizations ``text`` ties to the person's name (read from raw, case-kept text)."""
    out = OrgMentions()
    if not text or not name.firsts:
        return out
    # "General Partner" is a role, not the start of a firm called General…
    s = re.sub(r"(?i)\bgeneral\s+(?:partner|counsel|manager)s?\b", "GP", fold(text))
    nm = name.raw_pattern
    spans = [m.span() for m in re.finditer(nm, s)]
    if not spans:
        return out

    def add(bucket: list[str], org: str | None) -> None:
        got = _usable(org, name)
        if got and got not in bucket:
            bucket.append(got)

    # History: ex-Org / former Org near the name; Name leaves Org; Org appoints Name.
    for m in re.finditer(rf"(?i:(?<![a-z]){_CUE_BEFORE})", s):
        if any(abs(m.start() - a) <= 60 or abs(m.end() - b) <= 60 for a, b in spans):
            add(out.history, _org_forward(s[m.end() :]))
    for m in re.finditer(rf"{nm}\s*,?\s+(?i:{_CUE_AFTER_NAME})", s):
        add(out.history, _org_forward(s[m.end() :]))
    for m in re.finditer(rf"\s+(?i:{_CUE_ORG_VERBS})\s+{nm}", s):
        add(out.history, _org_backward(s[: m.start()]))
    # Affiliations: Name (Org); Org's Name; Name, Partner at Org.
    for m in re.finditer(rf"{nm}\s*\(", s):
        add(out.affiliations, _org_forward(s[m.end() :], skip_roles=True))
    for m in re.finditer(rf"({_ORG_WORD}(?:\s+{_ORG_WORD}){{0,2}})'s?\s+{nm}", s):
        add(out.affiliations, _org_backward(m.group(1)))
    roles = "|".join(sorted(_ROLE_WORDS | {"a", "an", "the", "&", "and"}, key=len, reverse=True))
    for m in re.finditer(
        rf"{nm}\s*[,:\-\u2013\u2014]?\s+(?i:(?:(?:{roles})\s+){{0,5}}(?:at|of|from)\s+)", s
    ):
        add(out.affiliations, _org_forward(s[m.end() :]))
    out.affiliations = [o for o in out.affiliations if not any(same_org(o, h) for h in out.history)]
    return out


def _org_key(org: str) -> str:
    return norm_firm(fold(org)) or norm(fold(org))


def _initials(key: str) -> str:
    words = key.split()
    return "".join(w[0] for w in words) if len(words) >= 2 else ""


def same_org(a: str, b: str) -> bool:
    """Do two organization names name the same firm? (suffixes ignored, ``CG`` for Cinderford
    Group; one generic word such as "General" never matches a longer name)."""
    ka, kb = _org_key(a), _org_key(b)
    if not ka or not kb:
        return False
    if ka == kb:
        return True
    short, long_ = sorted((ka, kb), key=len)
    if phrase_in(long_, short):
        words = short.split()
        if len(words) >= 2 or (len(short) >= 4 and short not in _GENERIC_ORG_WORDS):
            return True
    ca, cb = _compact(ka), _compact(kb)
    return (len(ca) >= 2 and ca == _initials(kb)) or (len(cb) >= 2 and cb == _initials(ka))


def org_in_text(org: str, *texts: str) -> bool:
    """A known organization named anywhere in normalized texts (whole words; at least two words
    or one distinctive word, so "General" alone never counts)."""
    full, key = norm(fold(org)), _org_key(org)
    for cand in {full, key}:
        if not cand:
            continue
        if len(cand.split()) < 2 and (len(cand) < 4 or cand in _GENERIC_ORG_WORDS):
            continue
        if any(phrase_in(t, cand) for t in texts):
            return True
    return False


def matches_any(org: str, known: Iterable[str]) -> bool:
    return any(same_org(org, k) for k in known)
