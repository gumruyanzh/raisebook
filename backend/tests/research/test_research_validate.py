"""Dossier validation (services/research_validate.py; RESEARCH-PLAN §4.6). Pure functions."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from raisebook.schemas.dossier import DossierDoc, WriterDoc, response_format
from raisebook.services.research_validate import (
    Anchor,
    RawSource,
    check_source,
    check_sources,
    finalize,
    identity_matches,
    url_key,
)

ANCHOR = Anchor.of(
    name="Dana Whitfield",
    firm="Harbor Light Ventures",
    firm_website="https://www.harborlight.example/",
    linkedin_url="https://www.linkedin.com/in/example-dana-whitfield/",
    title="Partner",
)


def test_url_key_normalizes() -> None:
    assert url_key("HTTPS://WWW.News.Example/a/b/?utm_source=x&b=2&a=1#top") == (
        "https://news.example/a/b?a=1&b=2"
    )
    assert url_key("ftp://x.example/a") is None
    assert url_key("not a url") is None


@pytest.mark.parametrize(
    ("url", "title", "snippet", "matched", "reason"),
    [
        # The anchor's own LinkedIn profile, its activity pages and posts.
        ("https://www.linkedin.com/in/example-dana-whitfield", "x", "", "linkedin", None),
        (
            "https://linkedin.com/in/Example-Dana-Whitfield/recent-activity/all/",
            "",
            "",
            "linkedin",
            None,
        ),
        (
            "https://www.linkedin.com/posts/example-dana-whitfield_robotics-activity-1",
            "",
            "",
            "linkedin",
            None,
        ),
        # Someone else's LinkedIn page, even with the same name.
        (
            "https://www.linkedin.com/in/example-dana-whitfield-chef",
            NAME := "Dana Whitfield",
            "Harbor Light Ventures",
            None,
            "anchor_mismatch",
        ),
        # The firm's domain and subdomains.
        ("https://harborlight.example/team", "Team", "", "firm_domain", None),
        ("https://blog.harborlight.example/p/1", "Post", "", "firm_domain", None),
        # Name with firm, or name with title and no other firm.
        (
            "https://news.example/a",
            "Dana Whitfield of Harbor Light leads round",
            "",
            "name_firm",
            None,
        ),
        (
            "https://news.example/b",
            "Q&A",
            "Dana Whitfield, Partner, on robotics",
            "name_title",
            None,
        ),
        (
            "https://news.example/c",
            "Q&A",
            "Dana Whitfield, Partner at Stonepine Capital",
            None,
            "anchor_mismatch",
        ),
        (
            "https://news.example/d",
            "Marcus Ellery raises",
            "Harbor Light Ventures co-invests",
            None,
            "anchor_mismatch",
        ),
        # Personal social sites are never sources (R13).
        (
            "https://www.facebook.com/dana.w",
            "Dana Whitfield",
            "Harbor Light Ventures",
            None,
            "personal_domain",
        ),
        ("https://m.instagram.com/danaw", "Dana Whitfield", "", None, "personal_domain"),
        ("mailto:dana@harborlight.example", "", "", None, "anchor_mismatch"),
    ],
)
def test_anchor_rules(
    url: str, title: str, snippet: str, matched: str | None, reason: str | None
) -> None:
    got = check_source(url, title, snippet, ANCHOR)
    assert (got.matched, got.reason, got.accepted) == (matched, reason, matched is not None)


def test_check_sources_dedupes_and_scrubs() -> None:
    raw = [
        RawSource(
            "a",
            "https://harborlight.example/team?utm_source=x",
            "Team",
            "Call 415-555-0100 to reach the partners.",
        ),
        RawSource("b", "https://harborlight.example/team/", "Team again", ""),
        RawSource("c", "https://news.example/x", "Dana and her husband", "Harbor Light gala"),
    ]
    out, removed = check_sources(raw, ANCHOR)
    assert [c.check.reason for c in out] == [None, "duplicate", "anchor_mismatch"]
    assert "555-0100" not in (out[0].snippet or "")
    assert out[2].title is None  # a private title is not kept
    assert removed == 2


def _doc(**over: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "identity": {"name": "Dana Whitfield"},
        "sources": [{"id": "s1", "url": "https://harborlight.example/a"}],
        "facts": [
            {
                "key": "f1",
                "section": "activity",
                "kind": "deal",
                "text": "Led A.",
                "date": "2026-01-01",
                "source_ids": ["s1"],
            },
            {
                "key": "f2",
                "section": "thesis",
                "kind": "post",
                "text": "Wrote B.",
                "source_ids": ["s9"],
            },
        ],
        "analysis": {
            "brief": {"verdict": "possible", "why": "Maybe.", "fact_keys": ["f1", "f2"]},
            "ways_in": [
                {"text": "Via Brightquay.", "basis": "public", "fact_keys": ["f1"]},
                {"text": "Via a friend.", "basis": "public", "fact_keys": ["f2"]},
                {"text": "Intro via Ines Calloway.", "basis": "workspace"},
                {"text": "Intro via Marcus.", "basis": "workspace"},
            ],
            "talking_points": [{"text": "Lead with pilots.", "fact_keys": ["f2"]}],
        },
        "suggestions": {
            "title": {"value": "General Partner", "fact_keys": ["f1"]},
            "location": {"value": "Oakland", "fact_keys": ["f2"]},
            "email": {"value": "dana@gmail.com", "fact_keys": ["f1"]},
        },
    }
    doc.update(over)
    return doc


def test_uncited_facts_move_to_unverified_for_the_model() -> None:
    doc = WriterDoc.model_validate({k: v for k, v in _doc().items() if k != "sources"})
    out = finalize(
        doc, accepted_ids={"s1"}, agent=False, workspace_facts=["Ines Calloway"], anchor=ANCHOR
    )
    assert [f["key"] for f in out.facts] == ["f1"]
    assert out.unverified == [{"section": "thesis", "text": "Wrote B."}]
    assert out.moved_to_unverified == 1
    assert out.analysis["brief"]["fact_keys"] == ["f1"]
    assert [w["text"] for w in out.analysis["ways_in"]] == [
        "Via Brightquay.",
        "Intro via Ines Calloway.",
    ]
    assert out.analysis["talking_points"] == [{"text": "Lead with pilots.", "fact_keys": []}]
    assert set(out.suggestions) == {"title"}  # location uncited; gmail is not a work email
    reasons = {d.key: d.reason for d in out.dropped}
    assert reasons["ways_in.1"] == "no_evidence"
    assert reasons["ways_in.3"] == "not_in_workspace_facts"
    assert reasons["suggestions.email"] == "not_a_work_email"


def test_agents_drop_uncited_and_may_not_use_workspace_paths() -> None:
    doc = DossierDoc.model_validate(_doc())
    out = finalize(doc, accepted_ids={"s1"}, agent=True, anchor=ANCHOR)
    assert out.unverified == [] and out.moved_to_unverified == 0
    reasons = {d.key: d.reason for d in out.dropped}
    assert reasons["f2"] == "uncited"
    assert reasons["ways_in.2"] == "workspace_basis_not_allowed"


def test_work_email_on_the_firm_domain_is_kept() -> None:
    doc = DossierDoc.model_validate(
        _doc(suggestions={"email": {"value": "dana@harborlight.example", "fact_keys": ["f1"]}})
    )
    out = finalize(doc, accepted_ids={"s1"}, agent=True, anchor=ANCHOR)
    assert out.suggestions["email"]["value"] == "dana@harborlight.example"


def test_caps_keep_the_newest_activity() -> None:
    facts = [
        {
            "key": f"a{i}",
            "section": "activity",
            "kind": "deal",
            "text": f"Deal {i}.",
            "date": f"2026-{(i % 12) + 1:02d}-01",
            "source_ids": ["s1"],
        }
        for i in range(14)
    ]
    doc = DossierDoc.model_validate(_doc(facts=facts))
    out = finalize(doc, accepted_ids={"s1"}, agent=True, anchor=ANCHOR)
    assert len(out.facts) == 10
    kept_months = sorted(f["date"] for f in out.facts)
    assert kept_months[0] >= "2026-03-01"
    assert sum(1 for d in out.dropped if d.reason == "cap") == 4


def test_duplicate_fact_keys_and_privacy() -> None:
    facts = [
        {
            "key": "f1",
            "section": "profile",
            "kind": "role",
            "text": "Partner.",
            "source_ids": ["s1"],
        },
        {"key": "f1", "section": "profile", "kind": "role", "text": "Again.", "source_ids": ["s1"]},
        {
            "key": "f2",
            "section": "profile",
            "kind": "other",
            "text": "Has three kids.",
            "source_ids": ["s1"],
        },
    ]
    out = finalize(
        DossierDoc.model_validate(_doc(facts=facts)), accepted_ids={"s1"}, agent=True, anchor=ANCHOR
    )
    assert [f["text"] for f in out.facts] == ["Partner."]
    assert {(d.key, d.reason) for d in out.dropped} >= {("f1", "duplicate_key"), ("f2", "privacy")}
    assert out.privacy_removed >= 1


def test_schema_errors() -> None:
    bad = [
        _doc(schema_version=2),
        _doc(analysis={"brief": {"verdict": "great", "why": "x"}}),
        _doc(facts=[{"key": "f 1", "section": "activity", "kind": "deal", "text": "x"}]),
        _doc(facts=[{"key": "f1", "section": "gossip", "kind": "deal", "text": "x"}]),
        _doc(facts=[{"key": "f1", "section": "activity", "kind": "deal", "text": "x" * 401}]),
        _doc(extra_field=1),
    ]
    for doc in bad:
        with pytest.raises(ValidationError):
            DossierDoc.model_validate(doc)


def test_writer_format_is_strict_json_schema() -> None:
    fmt = response_format("raisebook_dossier_v1", WriterDoc)
    schema = fmt["json_schema"]["schema"]
    assert fmt["json_schema"]["strict"] is True
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    assert "sources" not in schema["properties"]
    assert "maxLength" not in str(schema)


def test_identity_match_rules() -> None:
    li = "https://www.linkedin.com/in/example-dana-whitfield"
    assert identity_matches("Dana Whitfield", li, None, ANCHOR)
    assert not identity_matches("Dana Whitfield", li + "-2", None, ANCHOR)
    assert identity_matches("Dana Whitfield", None, "https://harborlight.example", ANCHOR)
    assert not identity_matches("Dana W.", None, "https://harborlight.example", ANCHOR)
    assert not identity_matches("Dana Whitfield", None, None, ANCHOR)
    bare = Anchor.of(name="Dana Whitfield")
    assert identity_matches("Dana Whitfield", None, None, bare)
