"""services.normalize: the single normalization and dedupe-key implementation (SPEC §3.4)."""

from __future__ import annotations

from datetime import date

import pytest

from raisebook.core.errors import ValidationFailed
from raisebook.services import normalize as n


def test_norm_and_name_key() -> None:
    assert n.norm("  Ana-María  O'Neil & Co. ") == "ana maria o neil and co"
    assert n.name_key("Dana Whitfield", "Harbor Light Ventures") == "dana whitfield|harbor light"
    assert n.name_key("Dana Whitfield", "Harbor Light Capital Partners LLC") == (
        "dana whitfield|harbor light"
    )
    assert n.name_key("Dana Whitfield", None) == "dana whitfield|"
    assert n.name_key("DANA  whitfield", "harbor light") == n.name_key(
        "Dana Whitfield", "Harbor Light Ventures"
    )


@pytest.mark.parametrize(
    ("url", "key"),
    [
        ("https://www.linkedin.com/in/Example-Dana/", "in/example-dana"),
        ("linkedin.com/in/example-dana?trk=abc", "in/example-dana"),
        ("http://uk.linkedin.com/in/example-dana#x", "in/example-dana"),
        ("https://www.linkedin.com/search/results/people/?q=dana", None),
        ("https://www.linkedin.com/company/example-co", None),
        ("https://example.com/in/dana", None),
        (None, None),
    ],
)
def test_linkedin_key(url: str | None, key: str | None) -> None:
    assert n.linkedin_key(url) == key


def test_urls_and_x() -> None:
    assert n.clean_url("example.com/fund", "website_url") == "https://example.com/fund"
    assert n.clean_url("http://example.com", "website_url") == "http://example.com"
    with pytest.raises(ValidationFailed):
        n.clean_url("ftp://example.com", "website_url")
    with pytest.raises(ValidationFailed):
        n.clean_url("not a url", "website_url")
    assert n.clean_x_url("@example_vc") == "https://x.com/example_vc"
    assert n.clean_x_url("example_vc") == "https://x.com/example_vc"
    assert n.clean_x_url("x.com/example_vc") == "https://x.com/example_vc"


def test_text_and_lists() -> None:
    assert n.clean_text("  a   b \n c ", "title", max_len=200) == "a b c"
    assert n.clean_text("   ", "title", max_len=200) is None
    with pytest.raises(ValidationFailed) as exc:
        n.clean_text("x" * 201, "title", max_len=200)
    assert exc.value.details[0]["loc"] == ["body", "title"]
    assert n.clean_list(["AI", " ai ", "", "Fintech", "fintech"], "tags", max_items=30) == [
        "AI",
        "Fintech",
    ]
    assert n.clean_list("robotics; AI | climate", "tags", max_items=30) == [
        "robotics",
        "AI",
        "climate",
    ]
    assert n.clean_list("a, b", "tags", max_items=30) == ["a", "b"]
    with pytest.raises(ValidationFailed):
        n.clean_list(["x" * 41], "tags", max_items=30)
    with pytest.raises(ValidationFailed):
        n.clean_list([str(i) for i in range(11)], "stage_focus", max_items=10)
    assert n.merge_lists(["AI"], ["ai", "Climate"]) == ["AI", "Climate"]


@pytest.mark.parametrize(
    ("raw", "value"),
    [
        ("$250k", 250_000),
        ("250K", 250_000),
        ("1.5M", 1_500_000),
        ("250,000", 250_000),
        ("€500k", 500_000),
        ("$2mm", 2_000_000),
        (75000, 75_000),
        ("lots", None),
        ("", None),
    ],
)
def test_parse_money(raw: object, value: int | None) -> None:
    assert n.parse_money(raw) == value


@pytest.mark.parametrize(
    ("note", "expected"),
    [
        ("$250k-$1M", (250_000, 1_000_000)),
        ("$250k - $1M, leads", (250_000, 1_000_000)),
        ("250,000 - 1,000,000", (250_000, 1_000_000)),
        ("$100k to $250k", (100_000, 250_000)),
        ("$250k", (250_000, 250_000)),
        ("leads seed rounds", (None, None)),
        ("$1M-$250k", (None, None)),
    ],
)
def test_parse_check_note(note: str, expected: tuple[int | None, int | None]) -> None:
    assert n.parse_check_note(note) == expected


def test_investor_types_and_instruments() -> None:
    assert n.parse_investor_type("VC") == "vc"
    assert n.parse_investor_type("Angel investor") == "angel"
    assert n.parse_investor_type("FO") == "family_office"
    assert n.parse_investor_type("Corporate VC") == "corporate_vc"
    assert n.parse_investor_type("CVC") == "corporate_vc"
    assert n.parse_investor_type(None) == "other"
    with pytest.raises(ValidationFailed):
        n.parse_investor_type("wizard")
    assert n.parse_instrument("post-money SAFE") == "safe"
    assert n.parse_instrument("equity") == "priced"
    assert n.parse_instrument("Convertible") == "convertible_note"


def test_parse_date_loose() -> None:
    assert n.parse_date_loose("2026-10-14") == (date(2026, 10, 14), False)
    assert n.parse_date_loose("10/14/2026") == (date(2026, 10, 14), False)
    assert n.parse_date_loose("03/04/2026") == (date(2026, 3, 4), True)
    assert n.parse_date_loose("14.10.2026") == (date(2026, 10, 14), False)
    assert n.parse_date_loose("Oct 14 2026") == (date(2026, 10, 14), False)
    assert n.parse_date_loose("14 Oct 2026") == (date(2026, 10, 14), False)
    assert n.parse_date_loose("someday") == (None, False)


def test_normalize_investor_input() -> None:
    out = n.normalize_investor_input(
        {
            "name": "  Dana   Whitfield ",
            "firm": "",
            "email": " Dana@Example.COM ",
            "type": "Angel",
            "linkedin_url": "linkedin.com/in/example-dana",
            "x_url": "@example_dana",
            "check_note": "$250k-$1M",
            "tags": ["AI", "ai"],
            "notes": "Line one\n\nLine two  ",
            "unknown": "ignored",
        },
        partial=False,
    )
    assert out == {
        "name": "Dana Whitfield",
        "firm": None,
        "email": "dana@example.com",
        "type": "angel",
        "linkedin_url": "https://linkedin.com/in/example-dana",
        "x_url": "https://x.com/example_dana",
        "check_note": "$250k-$1M",
        "check_min": 250_000,
        "check_max": 1_000_000,
        "tags": ["AI"],
        "notes": "Line one\n\nLine two",
    }
    # Idempotent: normalizing normalized data changes nothing.
    assert n.normalize_investor_input(out, partial=False) == out
    with pytest.raises(ValidationFailed):
        n.normalize_investor_input({"firm": "X"}, partial=False)
    with pytest.raises(ValidationFailed):
        n.normalize_investor_input({"name": "A", "email": "not-an-email"}, partial=False)
    with pytest.raises(ValidationFailed):
        n.normalize_investor_input({"name": "A", "check_min": 5, "check_max": 1}, partial=False)
    assert n.normalize_investor_input({"title": None}, partial=True) == {"title": None}


def test_derived_fields_and_dedupe_keys() -> None:
    fields = {
        "name": "Dana Whitfield",
        "firm": "Harbor Light Ventures",
        "email": "dana@example.com",
        "linkedin_url": "https://www.linkedin.com/in/example-dana",
        "tags": ["Robotics"],
        "notes": "Met at a demo day",
    }
    d = n.derived_fields(fields)
    assert d["linkedin_key"] == "in/example-dana"
    assert d["name_key"] == "dana whitfield|harbor light"
    assert "robotics" in d["search_text"] and "demo day" in d["search_text"]
    keys = n.dedupe_keys(fields)
    assert [m for m, _ in keys.ordered()] == ["email", "linkedin", "name_firm"]


def test_name_refs_and_stage_keys() -> None:
    assert n.split_name_at_firm("Dana Whitfield @ Harbor Light") == (
        "Dana Whitfield",
        "Harbor Light",
    )
    assert n.split_name_at_firm("Dana Whitfield") == ("Dana Whitfield", None)
    assert n.stage_key_from_label("Term sheet!") == "term_sheet"
    assert n.stage_key_from_label("2nd meeting") == "s_2nd_meeting"
