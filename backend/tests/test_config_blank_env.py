from raisebook.config import Settings


def test_blank_rate_limit_overrides_mean_unset(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RAISEBOOK_EMAIL_GLOBAL_PER_HOUR", "")
    monkeypatch.setenv("RAISEBOOK_MAGIC_LINKS_PER_IP_HOUR", " ")
    s = Settings()
    assert s.email_global_per_hour is None and s.magic_links_per_ip_hour is None


def test_rate_limit_override_parses(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RAISEBOOK_EMAIL_GLOBAL_PER_HOUR", "1000")
    assert Settings().email_global_per_hour == 1000
