"""Envelope encryption for secrets Raisebook must use but never show (RESEARCH-PLAN §2).

Today that is one secret per workspace: its OpenRouter key (R12).

- **KEK** (key-encryption key): ``RAISEBOOK_SECRETS_KEK``, 32 random bytes, written
  ``<kek_id>:<base64url>`` (or bare base64url, id ``k1``). It never touches the database.
  ``RAISEBOOK_SECRETS_KEK_PREVIOUS`` (same format) opens rows sealed before a rotation.
- **DEK** (data key): 32 fresh random bytes per sealed secret. The secret is encrypted with
  AES-256-GCM under the DEK; the DEK is encrypted (wrapped) with AES-256-GCM under the KEK.
  Every nonce is 96 random bits.
- **AAD** binds a ciphertext to its row (``openrouter_aad(workspace_id)``): a sealed value
  copied to another workspace's row does not open. The wrap is bound to the KEK id too.

:func:`open_sealed` raises :class:`SecretUnavailable` on any failure, with no detail. Nothing
here logs, and no ``repr`` shows key bytes. The plaintext secret only exists in the caller's
scope (``services/openrouter.py`` builds the ``Authorization`` header per request).
"""

from __future__ import annotations

import base64
import binascii
import os
import re
from dataclasses import dataclass, field, replace
from uuid import UUID

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from raisebook.config import Settings, get_settings

KEY_BYTES = 32
NONCE_BYTES = 12
DEFAULT_KEK_ID = "k1"
_KEK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


class SecretsConfigError(ValueError):
    """``RAISEBOOK_SECRETS_KEK`` (or ``_PREVIOUS``) is malformed. The message has no key bytes."""


class SecretUnavailable(Exception):
    """A sealed secret could not be opened (wrong KEK, wrong row, tampered, unknown KEK id)."""

    def __init__(self) -> None:
        super().__init__("The stored secret could not be opened.")


@dataclass(frozen=True)
class Kek:
    id: str
    key: bytes = field(repr=False)


@dataclass(frozen=True)
class Keyring:
    """The current KEK (seals and wraps) and an optional previous one (opens only)."""

    current: Kek
    previous: Kek | None = None

    def get(self, kek_id: str) -> Kek | None:
        if kek_id == self.current.id:
            return self.current
        if self.previous is not None and kek_id == self.previous.id:
            return self.previous
        return None


@dataclass(frozen=True)
class Sealed:
    """What a row stores. None of these fields is secret on its own without the KEK."""

    ciphertext: bytes = field(repr=False)
    nonce: bytes = field(repr=False)
    dek_wrapped: bytes = field(repr=False)
    dek_nonce: bytes = field(repr=False)
    kek_id: str


def _b64decode(raw: str) -> bytes:
    padded = raw + "=" * (-len(raw) % 4)
    try:
        return base64.urlsafe_b64decode(padded.encode("ascii"))
    except (binascii.Error, ValueError, UnicodeEncodeError) as exc:
        raise SecretsConfigError("The KEK is not valid base64url.") from exc


def parse_kek(raw: str, *, name: str = "RAISEBOOK_SECRETS_KEK") -> Kek:
    """``k1:<base64url 32 bytes>`` or bare base64url (id ``k1``)."""
    value = raw.strip()
    kek_id, sep, encoded = value.partition(":")
    if not sep:
        kek_id, encoded = DEFAULT_KEK_ID, value
    if not _KEK_ID_RE.match(kek_id):
        raise SecretsConfigError(f"{name}: the KEK id must be 1-32 letters, digits, - or _.")
    try:
        key = _b64decode(encoded)
    except SecretsConfigError as exc:
        raise SecretsConfigError(f"{name}: the key is not valid base64url.") from exc
    if len(key) != KEY_BYTES:
        raise SecretsConfigError(
            f"{name}: the key must be {KEY_BYTES} bytes (got {len(key)}). Generate one with "
            "`rbctl secrets gen-kek`."
        )
    return Kek(kek_id, key)


def keyring_from(settings: Settings) -> Keyring | None:
    """The configured keyring, or None when no KEK is set. Malformed values raise."""
    if settings.secrets_kek is None:
        return None
    current = parse_kek(settings.secrets_kek.get_secret_value())
    previous = None
    if settings.secrets_kek_previous is not None:
        previous = parse_kek(
            settings.secrets_kek_previous.get_secret_value(),
            name="RAISEBOOK_SECRETS_KEK_PREVIOUS",
        )
        if previous.id == current.id:
            raise SecretsConfigError(
                "RAISEBOOK_SECRETS_KEK_PREVIOUS must have a different KEK id than the current KEK."
            )
    return Keyring(current, previous)


def get_keyring() -> Keyring | None:
    return keyring_from(get_settings())


def gen_kek_line(kek_id: str = DEFAULT_KEK_ID) -> str:
    """A new ``RAISEBOOK_SECRETS_KEK`` value."""
    if not _KEK_ID_RE.match(kek_id):
        raise SecretsConfigError("The KEK id must be 1-32 letters, digits, - or _.")
    return f"{kek_id}:{base64.urlsafe_b64encode(os.urandom(KEY_BYTES)).decode('ascii')}"


def openrouter_aad(workspace_id: UUID) -> bytes:
    """Binds a sealed OpenRouter key to its workspace row."""
    return b"rb:openrouter:" + workspace_id.bytes


def _wrap_aad(kek_id: str, aad: bytes) -> bytes:
    return b"rb:dek:" + kek_id.encode("ascii") + b":" + aad


def seal(plaintext: str, *, aad: bytes, ring: Keyring) -> Sealed:
    dek = AESGCM.generate_key(bit_length=KEY_BYTES * 8)
    nonce = os.urandom(NONCE_BYTES)
    ciphertext = AESGCM(dek).encrypt(nonce, plaintext.encode("utf-8"), aad)
    kek = ring.current
    dek_nonce = os.urandom(NONCE_BYTES)
    dek_wrapped = AESGCM(kek.key).encrypt(dek_nonce, dek, _wrap_aad(kek.id, aad))
    return Sealed(ciphertext, nonce, dek_wrapped, dek_nonce, kek.id)


def _unwrap(sealed: Sealed, *, aad: bytes, ring: Keyring) -> bytes:
    kek = ring.get(sealed.kek_id)
    if kek is None:
        raise SecretUnavailable()
    try:
        return AESGCM(kek.key).decrypt(sealed.dek_nonce, sealed.dek_wrapped, _wrap_aad(kek.id, aad))
    except (InvalidTag, ValueError) as exc:
        raise SecretUnavailable() from exc


def open_sealed(sealed: Sealed, *, aad: bytes, ring: Keyring) -> str:
    dek = _unwrap(sealed, aad=aad, ring=ring)
    try:
        return AESGCM(dek).decrypt(sealed.nonce, sealed.ciphertext, aad).decode("utf-8")
    except (InvalidTag, ValueError, UnicodeDecodeError) as exc:
        raise SecretUnavailable() from exc


def rewrap(sealed: Sealed, *, aad: bytes, ring: Keyring) -> Sealed:
    """Re-wrap the DEK under the current KEK; the ciphertext and DEK stay the same."""
    if sealed.kek_id == ring.current.id:
        return sealed
    dek = _unwrap(sealed, aad=aad, ring=ring)
    dek_nonce = os.urandom(NONCE_BYTES)
    wrapped = AESGCM(ring.current.key).encrypt(dek_nonce, dek, _wrap_aad(ring.current.id, aad))
    return replace(sealed, dek_wrapped=wrapped, dek_nonce=dek_nonce, kek_id=ring.current.id)


def last4(secret: str) -> str:
    """The only part of a secret that is ever shown."""
    return secret.strip()[-4:]
