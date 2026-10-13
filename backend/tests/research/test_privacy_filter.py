"""The professional-only output filter (services/privacy_filter.py; R13). Table-driven, pure."""

from __future__ import annotations

import pytest

from raisebook.services.privacy_filter import (
    REMOVED,
    is_sensitive,
    scrub,
    scrub_source_text,
    strip_contacts,
)

STRIPPED = [
    # Phones: international, North American, cue words.
    ("Call +44 20 7946 0958 for the partners desk.", "+44 20 7946 0958"),
    ("Office line (415) 555-0100 during the week.", "(415) 555-0100"),
    ("Office line 415.555.0100 during the week.", "415.555.0100"),
    ("Reach the fund on WhatsApp: 07700 900 123 anytime.", "07700 900 123"),
    ("Investor relations, tel. 030 1234 5678, for LPs.", "030 1234 5678"),
    # Addresses: street suffixes, units, PO boxes, postcodes next to an address.
    ("Fund office at 221 Baker Street, London NW1 6XE.", "221 Baker Street"),
    ("Moved to 500 Market St, Suite 300 last year.", "500 Market St"),
    ("Moved to 500 Market St, Suite 300 last year.", "Suite 300"),
    ("Mail LP letters to PO Box 4410 at the firm.", "PO Box 4410"),
    ("Mail to 1 Harbor Way, Oakland CA 94607 please.", "94607"),
    # Consumer email addresses.
    ("Pitch decks to dana.w@gmail.com for a fast reply.", "dana.w@gmail.com"),
    ("Older address dana@hotmail.co.uk still works.", "dana@hotmail.co.uk"),
]


@pytest.mark.parametrize(("text", "gone"), STRIPPED)
def test_contact_details_are_stripped(text: str, gone: str) -> None:
    out, n = strip_contacts(text)
    assert gone not in out and REMOVED in out and n >= 1


KEPT = [
    "Led the seed round in Brightquay Robotics in 2026.",
    "Partner at a healthcare fund focused on digital health.",
    "Raised Fund III of $120M; checks of $250k to $1M.",
    "Backs family offices' first direct deals in climate.",
    "Wrote 3 essays in 2025 on warehouse robotics.",
    "Work email dana@harborlight.example is listed on the firm site.",
    "Portfolio: 12 companies across 4 countries, 2019-2026.",
]


@pytest.mark.parametrize("text", KEPT)
def test_professional_text_passes(text: str) -> None:
    res = scrub(text)
    assert res.text == text and res.removed == 0


DROPPED = [
    "She is married to a fellow investor.",
    "Has two kids at a school in Palo Alto.",
    "Recently diagnosed with cancer, on leave.",
    "Voted for the Republican candidate in 2024.",
    "Donated to the Smith campaign last cycle.",
    "Attends church every Sunday.",
    "Lives in Pacific Heights with her family.",
    "Bought a house in Tahoe.",
    "Her daughter founded a startup.",
]


@pytest.mark.parametrize("text", DROPPED)
def test_private_topics_drop_the_claim(text: str) -> None:
    assert is_sensitive(text)
    res = scrub(text)
    assert res.text is None and res.removed == 1


def test_a_claim_that_is_mostly_contact_details_is_dropped() -> None:
    assert scrub("Phone: +1 (415) 555-0100").text is None
    # A claim that carried a contact detail goes whole: no "mobile [removed]" half-sentence.
    gone = scrub("Joined Kelpline's pre-seed; mobile +1 (415) 555-0100.")
    assert gone.text is None and gone.removed == 1


BYPASSES = [
    # verify-security: each of these was stored through the agent save path.
    "She is a devout Catholic and attends mass weekly.",
    "He is a vocal Trump supporter and GOP donor.",
    "Recovering from a stroke in 2025.",
    "Her father and mother live on Elm Street in Palo Alto.",
    "Reach her on 07700 900123 any evening.",
    "Her husb\u200band is a surgeon.",
    # verify-correctness: the street went, the home city stayed.
    "She lives at 1234 Elm Street, Springfield, IL 62704.",
]


@pytest.mark.parametrize("text", BYPASSES)
def test_known_bypasses_are_dropped(text: str) -> None:
    assert scrub(text).text is None


STILL_KEPT = [
    "Christian Hansen led the round.",
    "Invests $250,000 to $1,000,000 alongside a sister fund.",
    "Conservative investor who prefers revenue.",
    "The firm is recovering from a down round.",
    "Filed on 2026-05-02; Fund III closed at $120M in 2025.",
    "Lehman Brothers alumni run the fund.",
]


@pytest.mark.parametrize("text", STILL_KEPT)
def test_professional_lookalikes_pass(text: str) -> None:
    assert scrub(text).text == text


def test_source_titles_and_snippets() -> None:
    text, n = scrub_source_text("Dana Whitfield, Harbor Light. Cell 415-555-0199.")
    assert text is not None and "555-0199" not in text and n == 1
    assert scrub_source_text("Dana and her husband at the gala") == (None, 1)
    assert scrub_source_text(None) == (None, 0)


def test_counts_only_never_text() -> None:
    res = scrub("Call +1 (415) 555-0100 or +1 (415) 555-0101 about the fund.")
    assert res.removed == 2
    assert "555" not in (res.text or "")
