"""Envelope encryption (core/secrets.py; RESEARCH-PLAN §2, R12)."""

from __future__ import annotations

import base64
import logging
import os
import uuid
from dataclasses import replace

import pytest

from raisebook.config import Settings
from raisebook.core import secrets
from raisebook.core.logging import redact_secrets, redact_text
from tests.research.openrouter_mock import FAKE_KEY


def kek(kek_id: str = "k1") -> secrets.Kek:
    return secrets.Kek(kek_id, os.urandom(32))


def ring(kek_id: str = "k1") -> secrets.Keyring:
    return secrets.Keyring(kek(kek_id))


def flip(b: bytes, i: int = 0) -> bytes:
    return b[:i] + bytes([b[i] ^ 0x01]) + b[i + 1 :]


def test_seal_open_round_trip() -> None:
    r = ring()
    aad = secrets.openrouter_aad(uuid.uuid4())
    sealed = secrets.seal(FAKE_KEY, aad=aad, ring=r)
    assert sealed.kek_id == "k1"
    assert FAKE_KEY.encode() not in sealed.ciphertext
    assert secrets.open_sealed(sealed, aad=aad, ring=r) == FAKE_KEY


def test_ciphertext_bound_to_its_workspace() -> None:
    r = ring()
    sealed = secrets.seal(FAKE_KEY, aad=secrets.openrouter_aad(uuid.uuid4()), ring=r)
    with pytest.raises(secrets.SecretUnavailable):
        secrets.open_sealed(sealed, aad=secrets.openrouter_aad(uuid.uuid4()), ring=r)


@pytest.mark.parametrize("part", ["ciphertext", "nonce", "dek_wrapped", "dek_nonce"])
def test_tampering_fails(part: str) -> None:
    r = ring()
    aad = secrets.openrouter_aad(uuid.uuid4())
    sealed = secrets.seal(FAKE_KEY, aad=aad, ring=r)
    bad = replace(sealed, **{part: flip(getattr(sealed, part))})
    with pytest.raises(secrets.SecretUnavailable):
        secrets.open_sealed(bad, aad=aad, ring=r)
    # the GCM tag (last 16 bytes of the ciphertext) too
    tag_bad = replace(sealed, ciphertext=flip(sealed.ciphertext, len(sealed.ciphertext) - 1))
    with pytest.raises(secrets.SecretUnavailable):
        secrets.open_sealed(tag_bad, aad=aad, ring=r)


def test_wrong_kek_and_unknown_kek_id_fail() -> None:
    aad = secrets.openrouter_aad(uuid.uuid4())
    sealed = secrets.seal(FAKE_KEY, aad=aad, ring=ring("k1"))
    with pytest.raises(secrets.SecretUnavailable):
        secrets.open_sealed(sealed, aad=aad, ring=ring("k1"))  # same id, other bytes
    with pytest.raises(secrets.SecretUnavailable):
        secrets.open_sealed(sealed, aad=aad, ring=ring("k2"))


def test_nonces_and_deks_are_unique() -> None:
    r = ring()
    aad = secrets.openrouter_aad(uuid.uuid4())
    seen_nonces: set[bytes] = set()
    seen_wrapped: set[bytes] = set()
    for _ in range(1000):
        s = secrets.seal(FAKE_KEY, aad=aad, ring=r)
        seen_nonces.update((s.nonce, s.dek_nonce))
        seen_wrapped.add(s.dek_wrapped)
    assert len(seen_nonces) == 2000
    assert len(seen_wrapped) == 1000


def test_rotation_opens_with_previous_and_rewraps() -> None:
    old = kek("k1")
    aad = secrets.openrouter_aad(uuid.uuid4())
    sealed = secrets.seal(FAKE_KEY, aad=aad, ring=secrets.Keyring(old))
    rotated = secrets.Keyring(kek("k2"), previous=old)
    assert secrets.open_sealed(sealed, aad=aad, ring=rotated) == FAKE_KEY
    fresh = secrets.rewrap(sealed, aad=aad, ring=rotated)
    assert fresh.kek_id == "k2"
    assert fresh.ciphertext == sealed.ciphertext and fresh.nonce == sealed.nonce
    # After rotation the old KEK can be dropped entirely.
    assert secrets.open_sealed(fresh, aad=aad, ring=secrets.Keyring(rotated.current)) == FAKE_KEY
    assert secrets.rewrap(fresh, aad=aad, ring=rotated) is fresh  # already current


def test_parse_kek_formats_and_errors() -> None:
    raw = base64.urlsafe_b64encode(os.urandom(32)).decode()
    assert secrets.parse_kek(f"prod-2026:{raw}").id == "prod-2026"
    assert secrets.parse_kek(raw.rstrip("=")).id == "k1"  # bare, unpadded
    short = base64.urlsafe_b64encode(os.urandom(16)).decode()
    with pytest.raises(secrets.SecretsConfigError, match="32 bytes"):
        secrets.parse_kek(f"k1:{short}")
    with pytest.raises(secrets.SecretsConfigError):
        secrets.parse_kek("bad id!:" + raw)
    with pytest.raises(secrets.SecretsConfigError) as err:
        secrets.parse_kek("k1:@@@not-base64@@@")
    assert "@@@" not in str(err.value)


def test_keyring_from_settings() -> None:
    line = secrets.gen_kek_line()
    assert line.startswith("k1:")
    assert secrets.keyring_from(Settings(secrets_kek=None)) is None
    assert secrets.keyring_from(Settings(secrets_kek="")) is None  # compose's empty default
    ring_ = secrets.keyring_from(
        Settings(secrets_kek=secrets.gen_kek_line("k2"), secrets_kek_previous=line)
    )
    assert ring_ is not None and ring_.current.id == "k2" and ring_.previous is not None
    with pytest.raises(secrets.SecretsConfigError, match="different KEK id"):
        secrets.keyring_from(Settings(secrets_kek=line, secrets_kek_previous=line))
    with pytest.raises(secrets.SecretsConfigError):
        secrets.keyring_from(Settings(secrets_kek="k1:dG9vLXNob3J0"))


def test_malformed_kek_fails_app_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    from raisebook.main import create_app

    with pytest.raises(secrets.SecretsConfigError):
        create_app(Settings(secrets_kek="k1:dG9vLXNob3J0"))


def test_key_material_never_in_repr() -> None:
    k = kek()
    r = secrets.Keyring(k)
    sealed = secrets.seal(FAKE_KEY, aad=b"x", ring=r)
    assert k.key.hex() not in repr(k) and repr(k.key) not in repr(r)
    assert repr(sealed.ciphertext) not in repr(sealed)
    assert FAKE_KEY not in repr(sealed)
    assert FAKE_KEY not in str(secrets.SecretUnavailable())


def test_openrouter_keys_redacted_from_logs(caplog: pytest.LogCaptureFixture) -> None:
    assert FAKE_KEY not in redact_text(f"calling with {FAKE_KEY} now")
    assert "sk-or-[REDACTED]" in redact_text(f"Authorization: x {FAKE_KEY}")
    assert redact_text("sk-or-short") == "sk-or-short"  # too short to be a key
    event = redact_secrets(
        None,
        "info",
        {
            "event": f"oops {FAKE_KEY}",
            "openrouter_key": "anything",
            "nested": {"detail": [f"key={FAKE_KEY}"], "kek": "k1:abc"},
        },
    )
    flat = repr(event)
    assert FAKE_KEY not in flat and "k1:abc" not in flat
    assert event["openrouter_key"] == "[REDACTED]"
    with caplog.at_level(logging.WARNING):
        logging.getLogger("raisebook.test").warning("no key here")
    assert FAKE_KEY not in caplog.text
