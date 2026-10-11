"""Settings parsing (integration fixes)."""

from __future__ import annotations

import pytest

from raisebook.config import Settings


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", []),
        ("[]", []),
        ("http://localhost:3100", ["http://localhost:3100"]),
        ("http://a.test, http://b.test", ["http://a.test", "http://b.test"]),
        ('["http://a.test","http://b.test"]', ["http://a.test", "http://b.test"]),
    ],
)
def test_cors_origins_accepts_comma_list_and_json(
    monkeypatch: pytest.MonkeyPatch, raw: str, expected: list[str]
) -> None:
    monkeypatch.setenv("RAISEBOOK_CORS_ORIGINS", raw)
    assert Settings().cors_origins == expected
