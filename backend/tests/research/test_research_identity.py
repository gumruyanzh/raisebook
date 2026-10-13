"""Identity scoring and decisions (services/research_identity.py; RESEARCH-PLAN §4.5; R3)."""

from __future__ import annotations

from typing import Any

import pytest

from raisebook.models.enums import IdentityStatus
from raisebook.models.investor import Investor
from raisebook.services.openrouter import WebSource
from raisebook.services.research_identity import (
    Candidate,
    decide,
    parse_candidates,
    score,
)

SOURCES = [
    WebSource("https://harborlight.example/team"),
    WebSource("https://news.example/a"),
    WebSource("https://news.example/b"),
    # The search cited both profiles (a LinkedIn URL nobody cited earns nothing).
    WebSource("https://www.linkedin.com/in/example-dana-whitfield"),
    WebSource("https://www.linkedin.com/in/example-dana-2"),
]


def inv(**kw: Any) -> Investor:
    base: dict[str, Any] = {"name": "Dana Whitfield", "firm": "Harbor Light Ventures"}
    base.update(kw)
    return Investor(**base)


def cand(**kw: Any) -> Candidate:
    base: dict[str, Any] = {
        "name": "Dana Whitfield",
        "firm": "Harbor Light",
        "linkedin_url": "https://www.linkedin.com/in/example-dana-whitfield",
        "model_confidence": 1.0,
        "evidence": [1, 2],
    }
    base.update(kw)
    return Candidate(**base)


@pytest.mark.parametrize(
    ("candidate", "expected"),
    [
        (cand(), 1.0),  # 0.25 + 0.35 + 0.25 + 0.1 + 0.15 (clamped)
        (cand(evidence=[2, 3]), 1.0),  # news.example twice: one domain → no +0.1, still 1.0
        (cand(model_confidence=0.0, evidence=[2, 3]), 0.85),
        (cand(linkedin_url=None, model_confidence=0.0, evidence=[]), 0.6),
        (cand(name="D. Whitfield", model_confidence=0.0, evidence=[]), 0.7),
        (cand(name="Dan Whitfield", model_confidence=0.0, evidence=[]), 0.7),
        (cand(name="Dana Whitfeld", model_confidence=0.0, evidence=[]), 0.5),
        (cand(firm="Kelpline Capital", model_confidence=0.0, evidence=[]), 0.6),
    ],
)
def test_scoring_table(candidate: Candidate, expected: float) -> None:
    assert score(candidate, inv(), SOURCES) == pytest.approx(expected)


def test_firm_by_website_domain() -> None:
    c = cand(firm="HLV", firm_website="https://harborlight.example", model_confidence=0)
    assert score(c, inv(website_url="https://www.harborlight.example"), SOURCES) == 0.95


def test_decide_matched_needs_pick_and_not_found() -> None:
    one = decide([cand()], inv(), SOURCES)
    assert one.status == IdentityStatus.MATCHED and one.best is not None
    # Two strong candidates too close together → the person picks.
    close = decide(
        [cand(), cand(linkedin_url="https://www.linkedin.com/in/example-dana-2")], inv(), SOURCES
    )
    assert close.status == IdentityStatus.NEEDS_PICK and len(close.candidates) == 2
    # Below the threshold → the person picks.
    weak = decide([cand(linkedin_url=None, evidence=[])], inv(firm=None), SOURCES)
    assert weak.status == IdentityStatus.NEEDS_PICK
    nothing = decide(
        [cand(name="Someone Else", linkedin_url=None, firm=None, model_confidence=0)],
        inv(),
        SOURCES,
    )
    assert nothing.status == IdentityStatus.NOT_FOUND and nothing.candidates == []
    assert decide([], inv(), SOURCES).status == IdentityStatus.NOT_FOUND


def test_model_links_must_be_backed_by_the_citations() -> None:
    """A page the identity model read can inject a LinkedIn profile and a firm website: an
    uncited profile earns no points, an uncited firm site is dropped, and a candidate with no
    evidence never matches without a person's pick (verify-security finding)."""
    injected = cand(
        linkedin_url="https://www.linkedin.com/in/attacker-controlled",
        firm="Harbor Light Ventures",
        firm_website="https://evil-harbor.example",
        model_confidence=1.0,
        evidence=[],
    )
    out = decide([injected], inv(), SOURCES)
    assert out.status == IdentityStatus.NEEDS_PICK
    assert out.candidates[0].firm_website is None
    assert out.candidates[0].score == pytest.approx(0.75)  # name + firm + confidence only
    # Cited LinkedIn but no evidence numbers: still a person's call.
    assert decide([cand(evidence=[])], inv(), SOURCES).status == IdentityStatus.NEEDS_PICK
    # A firm site on a cited domain stays.
    kept = decide([cand(firm_website="https://harborlight.example")], inv(), SOURCES)
    assert kept.status == IdentityStatus.MATCHED
    assert kept.candidates[0].firm_website == "https://harborlight.example"


def test_parse_is_lenient() -> None:
    text = (
        "Sure! Here you go:\n```json\n"
        '[{"name": "Dana Whitfield", "title": "Partner", "firm": null, "linkedin_url": '
        '"linkedin.com/in/example-dana-whitfield", "firm_website": "N/A", "confidence": 1.7, '
        '"evidence": [1, "2", true]}, {"title": "no name"}, 5]\n```'
    )
    out = parse_candidates(text)
    assert len(out) == 1
    c = out[0]
    assert c.linkedin_url == "https://linkedin.com/in/example-dana-whitfield"
    assert c.firm is None and c.firm_website is None
    assert c.model_confidence == 1.0 and c.evidence == [1]
    assert parse_candidates("no json here") == []
    assert parse_candidates('{"candidates": [{"name": "A B"}]}')[0].name == "A B"
    four = '[{"name": "A"}, {"name": "B"}, {"name": "C"}, {"name": "D"}]'
    assert len(parse_candidates(four)) == 3
