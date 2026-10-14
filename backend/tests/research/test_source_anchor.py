"""Which sources are about the confirmed identity (research_validate.check_source(s) and
research_anchor; RESEARCH-PLAN §4.6 step 3). Pure functions; every person, firm and domain
here is fictional."""

from __future__ import annotations

import pytest

from raisebook.services.research_anchor import OrgMentions, PersonName, org_mentions, same_org
from raisebook.services.research_validate import (
    Anchor,
    RawSource,
    SourceCheck,
    check_source,
    check_sources,
    learn_past_firms,
)

# A distinctive name, a confirmed LinkedIn profile and firm domain, one past firm.
TOBIAS = Anchor.of(
    name="Nikolaos Wrenfield",
    firm="Larkspur Capital",
    firm_website="https://larkspur.example",
    linkedin_url="https://www.linkedin.com/in/nwrenfield-example",
    title="General Partner",
)
# A common name (frequent surname): the name alone never identifies her.
WEI = Anchor.of(name="Wei Chen", firm="Harbor Light Ventures", title="Partner")
# Accents in the stored name.
RENEE = Anchor.of(name="Renée Quillfeather", firm="Ostrava Bridge Partners")


def _check(anchor: Anchor, url: str, title: str = "", snippet: str = "") -> tuple[str | None, ...]:
    got = check_source(url, title, snippet, anchor)
    assert got.accepted is (got.matched is not None)
    return (got.matched, got.reason)


def test_name_forms() -> None:
    assert PersonName.of("Nikolaos Wrenfield").common is False
    for common in ("Wei Chen", "Celia R", "Ana Li", "Madonna", "Sam Patel"):
        assert PersonName.of(common).common is True, common
    niko = PersonName.of("Dr. Nikolaos Wrenfield Jr.")
    assert {"niko", "nick", "nikos"} <= set(niko.firsts) and niko.last == "wrenfield"
    # John is in two nickname groups; the groups are not merged (no Yannis via Jack).
    assert "yannis" not in PersonName.of("Jack Ostrander").firsts


@pytest.mark.parametrize(
    ("url", "title", "snippet", "expected"),
    [
        # Full name, nickname, case and middle name tolerated; title-only sources count.
        ("https://news.example/a", "Niko Wrenfield on seed rounds", "", ("name", None)),
        ("https://news.example/b", "NIKOLAOS P. WRENFIELD SPEAKS", "", ("name", None)),
        ("https://news.example/c", "Wrenfield, Niko · Brief", "", ("name", None)),
        # The full name only in the URL slug (no snippet, generic title).
        ("https://db.example/investors/niko-wrenfield", "Investor database", "", ("name", None)),
        # Glued directory titles still read.
        (
            "https://dir.example/x",
            "dir.example · investors · niko-wrenfieldNiko Wrenfield (Larkspur Capital) Email",
            "",
            ("name_firm", None),
        ),
        # Name with the firm or its domain, and with the title.
        (
            "https://news.example/d",
            "Larkspur leads round",
            "Niko Wrenfield said",
            ("name_firm", None),
        ),
        (
            "https://news.example/e",
            "Niko Wrenfield",
            "Reach him at larkspur.example",
            ("name_firm", None),
        ),
        # A distinctive surname alone needs the firm by its full name.
        (
            "https://news.example/f",
            "Wrenfield's Larkspur Capital closes fund",
            "",
            ("name_firm", None),
        ),
        ("https://news.example/g", "Wrenfield says hello", "", (None, "anchor_mismatch")),
        # Only a first name is never enough, even with the firm.
        (
            "https://dir.example/people/niko-larkspur",
            "Niko - Investor at Larkspur Capital",
            "",
            (None, "anchor_mismatch"),
        ),
        # Same name, another firm or role: someone else.
        (
            "https://news.example/h",
            "Niko Wrenfield (Fernhill Orthodontics)",
            "",
            (None, "conflict"),
        ),
        (
            "https://news.example/i",
            "Niko Wrenfield, Author at Gazette Daily",
            "",
            (None, "conflict"),
        ),
        (
            "https://news.example/j",
            "Fernhill Dental's Niko Wrenfield wins award",
            "",
            (None, "conflict"),
        ),
        # History is not a conflict: "ex-Org" and "leaves Org" describe the same person.
        ("https://news.example/k", "Niko Wrenfield leaves Cinderford Group", "", ("name", None)),
        # The firm's own pages always count; so do the person's own profiles.
        ("https://larkspur.example/about", "About", "", ("firm_domain", None)),
        ("https://blog.larkspur.example/p/1", "", "", ("firm_domain", None)),
        ("https://www.linkedin.com/in/nwrenfield-example", "x", "", ("linkedin", None)),
        ("https://x.com/nwrenfield-example/status/1", "gm", "", ("profile", None)),
        ("https://twitter.com/nikowrenfield", "", "", ("profile", None)),
        ("https://x.com/someone_else/status/2", "Unrelated post", "", (None, "anchor_mismatch")),
        # Another LinkedIn profile is someone else even with the same name and firm; others'
        # posts about the person are read like any page.
        (
            "https://www.linkedin.com/in/niko-wrenfield-2",
            "Niko Wrenfield - Larkspur Capital",
            "",
            (None, "anchor_mismatch"),
        ),
        (
            "https://www.linkedin.com/posts/someone_niko-wrenfield-on-larkspur-activity-1",
            "Niko Wrenfield on Larkspur Capital",
            "",
            ("name_firm", None),
        ),
        # A directory page about the firm only says nothing about the person.
        (
            "https://dir.example/funds/larkspur-capital",
            "Larkspur Capital - Portfolio",
            "",
            (None, "anchor_mismatch"),
        ),
        ("https://www.facebook.com/niko.w", "Niko Wrenfield", "", (None, "personal_domain")),
    ],
)
def test_distinctive_name_rules(
    url: str, title: str, snippet: str, expected: tuple[str | None, ...]
) -> None:
    assert _check(TOBIAS, url, title, snippet) == expected


@pytest.mark.parametrize(
    ("title", "snippet", "expected"),
    [
        ("Wei Chen | Profile", "", (None, "anchor_mismatch")),  # the name alone
        ("Wei Chen of Harbor Light leads round", "", ("name_firm", None)),
        ("Q&A", "Wei Chen, Partner, on robotics", ("name_title", None)),
        ("Wei Chen, Partner at Stonepine Capital", "", (None, "conflict")),
        (
            "Q&A with Wei Chen, Partner",
            "Also on the panel: an investor at Stonepine Capital",
            (None, "conflict"),
        ),
        ("Chen's Harbor Light Ventures", "", (None, "anchor_mismatch")),  # common surname alone
        ("Wei joins the panel", "Harbor Light Ventures", (None, "anchor_mismatch")),
    ],
)
def test_common_name_needs_an_org_or_role(
    title: str, snippet: str, expected: tuple[str | None, ...]
) -> None:
    assert _check(WEI, "https://news.example/w", title, snippet) == expected


def test_accents_and_case() -> None:
    assert _check(RENEE, "https://news.example/r", "RENEE QUILLFEATHER joins a panel") == (
        "name",
        None,
    )
    assert _check(RENEE, "https://news.example/r2", "Renée Quillfeather") == ("name", None)
    assert _check(RENEE, "https://news.example/r3", "Renée Q. talks") == (None, "anchor_mismatch")


def test_former_firm_news_is_kept_once_a_trusted_page_names_the_firm() -> None:
    raw = [
        # The person's own LinkedIn post ties the past firm to them.
        RawSource(
            "own",
            "https://www.linkedin.com/posts/nwrenfield-example_news-activity-1",
            "Cinderford Group appoints Niko Wrenfield to lead seed",
        ),
        # Surname plus the past firm, and the full name next to the past firm.
        RawSource(
            "ex",
            "https://news.example/1",
            "Ex-Cinderford Group Leader Wrenfield Targets $50 Million",
        ),
        RawSource("paren", "https://dir.example/2", "Niko Wrenfield (Cinderford Group) / Contact"),
        RawSource("acronym", "https://news.example/3", "CG's Niko Wrenfield on fintech"),
        # A namesake at an unrelated firm stays out.
        RawSource("namesake", "https://news.example/4", "Niko Wrenfield (Fernhill Orthodontics)"),
    ]
    out, _ = check_sources(raw, TOBIAS)
    got = {c.local_id: (c.check.matched, c.check.reason) for c in out}
    assert got == {
        "own": ("linkedin", None),
        "ex": ("name_past_firm", None),
        "paren": ("name_past_firm", None),
        "acronym": ("name_past_firm", None),
        "namesake": (None, "conflict"),
    }
    # Without the run's evidence, the same pages are not enough on their own.
    assert check_source(raw[2].url, raw[2].title, None, TOBIAS).reason == "conflict"
    assert check_source(raw[1].url, raw[1].title, None, TOBIAS).reason == "anchor_mismatch"
    # A caller that knows the past firm can pass it.
    assert check_source(
        raw[2].url, raw[2].title, None, TOBIAS, past_firms=["Cinderford Group"]
    ).matched == ("name_past_firm")


def test_one_name_only_page_cannot_teach_a_past_firm() -> None:
    weak = SourceCheck(True, matched="name")
    strong = SourceCheck(True, matched="linkedin")
    once = [(weak, OrgMentions(history=["Mossgate Bakery"]))]
    assert learn_past_firms(once, TOBIAS) == []
    other = (SourceCheck(False, reason="conflict"), OrgMentions(affiliations=["Mossgate Bakery"]))
    twice = [*once, other]
    assert learn_past_firms(twice, TOBIAS) == ["Mossgate Bakery"]
    # Pages tied by more than the name teach what they put next to it; the current firm is
    # never a "past" firm.
    trusted = [(strong, OrgMentions(affiliations=["Larkspur Capital", "Cinderford Group"]))]
    assert learn_past_firms(trusted, TOBIAS) == ["Cinderford Group"]


def test_org_mentions_and_same_org() -> None:
    name = PersonName.of("Niko Wrenfield")
    got = org_mentions("Niko Wrenfield, Founder & Managing Director at Larkspur Capital", name)
    assert got.affiliations == ["Larkspur Capital"] and got.history == []
    got = org_mentions("Ex-Cinderford Group Leader Wrenfield Targets $50 Million", name)
    assert got.history == ["Cinderford Group"] and got.affiliations == []
    got = org_mentions("Niko Wrenfield (General Partner, Larkspur)", name)
    assert got.affiliations == ["Larkspur"]
    assert org_mentions("Niko Wrenfield (2024)", name).all() == []
    assert same_org("Larkspur", "Larkspur Capital")
    assert same_org("CG", "Cinderford Group")
    assert not same_org("Capital", "Larkspur Capital")
    assert not same_org("General", "General Cinderford")
    assert not same_org("Fernhill Dental", "Larkspur Capital")
