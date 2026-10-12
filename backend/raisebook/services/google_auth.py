"""Continue with Google: OpenID Connect Authorization Code flow with PKCE.

``GET /v1/auth/google/start`` creates a :class:`Flow` (random ``state``, PKCE
``code_verifier`` and ``nonce``, plus the safe ``next`` path), stores it in the
short-lived signed HttpOnly cookie :data:`FLOW_COOKIE` (HMAC with the session key,
10 minutes, path ``/v1/auth/google``) and redirects to Google. The callback checks the
returned ``state`` against the cookie, exchanges the code (with the verifier) at Google's
token endpoint, and verifies the ID token itself: RS256 signature against Google's JWKS
(fetched with httpx, cached for an hour, refetched once on an unknown ``kid``), ``aud`` =
our client id (and ``azp`` when there are several audiences), ``iss``, ``exp``/``iat``
against the injectable clock, ``nonce`` and ``email_verified``.

The user is found or created by the verified email (``users.email`` is CITEXT, so it is
the same account as magic-link sign-in) and the Google ``sub`` is bound on first use. A
different ``sub`` claiming that email later is refused, and so is a bound ``sub`` that
arrives with another account's email. Every failure is a :class:`GoogleAuthError` whose
``code`` the API turns into ``{APP_URL}/signin?error=<code>``; its ``reason`` goes only to
the log, and nothing logged here contains an email address.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.magic_link import normalize_email, safe_redirect_path
from raisebook.auth.principal import user_workspaces
from raisebook.auth.session import session_key
from raisebook.config import Settings, get_settings
from raisebook.core.errors import APIError
from raisebook.models.user import User, UserSession
from raisebook.services.users import clean_name, get_by_email

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("https://accounts.google.com", "accounts.google.com")
SCOPES = "openid email profile"
CALLBACK_PATH = "/v1/auth/google/callback"
FLOW_COOKIE = "rb_google_flow"
FLOW_COOKIE_PATH = "/v1/auth/google"
FLOW_TTL_S = 600
CLOCK_SKEW_S = 60
JWKS_TTL_S = 3600
HTTP_TIMEOUT_S = 10.0
_FLOW_CONTEXT = b"raisebook-google-flow:"

APP_PATH = "/app"  # opens the last-used workspace (web: app/(app)/app/page.tsx)
ONBOARDING_PATH = "/onboarding"
INVITE_PREFIX = "/invite/"


class GoogleAuthError(Exception):
    """A refused Google sign-in. ``code`` goes to the web app; ``reason`` only to the log."""

    def __init__(self, code: str, reason: str = "") -> None:
        super().__init__(f"{code}: {reason}" if reason else code)
        self.code = code
        self.reason = reason


class GoogleNotConfigured(APIError):
    status_code = 404
    code = "google_not_configured"
    default_message = (
        "Google sign-in is not configured on this server. Use the emailed sign-in link "
        "(POST /v1/auth/magic-link)."
    )


@dataclass(frozen=True)
class GoogleConfig:
    client_id: str
    client_secret: str
    redirect_uri: str


def google_config(settings: Settings | None = None) -> GoogleConfig | None:
    """The OAuth client, or None while ``RAISEBOOK_GOOGLE_CLIENT_ID``/``_SECRET`` are unset."""
    s = settings or get_settings()
    client_id = (s.google_client_id or "").strip()
    secret = s.google_client_secret.get_secret_value().strip() if s.google_client_secret else ""
    if not client_id or not secret:
        return None
    return GoogleConfig(
        client_id=client_id,
        client_secret=secret,
        redirect_uri=s.public_base_url.rstrip("/") + CALLBACK_PATH,
    )


async def get_google_http() -> AsyncIterator[httpx.AsyncClient]:
    """FastAPI dependency: the outbound client for Google (tests override it)."""
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S, follow_redirects=False) as client:
        yield client


# --------------------------------------------------------------------------- flow cookie


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def clean_next(raw: str | None) -> str | None:
    """A same-app relative path worth returning to, else None (no open redirects)."""
    path = safe_redirect_path(raw)
    if path is None or path == "/" or path.startswith(("/signin", "/auth/")):
        return None
    return path


@dataclass(frozen=True)
class Flow:
    state: str
    verifier: str
    nonce: str
    next: str | None
    exp: int  # unix seconds


def new_flow(next_path: str | None, *, now: datetime) -> Flow:
    return Flow(
        state=secrets.token_urlsafe(32),
        verifier=secrets.token_urlsafe(64),  # 86 chars, within RFC 7636's 43..128
        nonce=secrets.token_urlsafe(32),
        next=clean_next(next_path),
        exp=int(now.timestamp()) + FLOW_TTL_S,
    )


def _flow_sig(payload: str) -> str:
    return _b64(hmac.new(session_key(), _FLOW_CONTEXT + payload.encode(), hashlib.sha256).digest())


def encode_flow(flow: Flow) -> str:
    payload = _b64(json.dumps(asdict(flow), separators=(",", ":")).encode())
    return f"{payload}.{_flow_sig(payload)}"


def decode_flow(value: str | None, *, now: datetime) -> Flow | None:
    """The flow from a correctly signed, unexpired cookie, else None."""
    if not value or len(value) > 4096 or value.count(".") != 1:
        return None
    payload, sig = value.split(".")
    if not hmac.compare_digest(_flow_sig(payload), sig):
        return None
    try:
        data = json.loads(_unb64(payload))
        flow = Flow(
            state=str(data["state"]),
            verifier=str(data["verifier"]),
            nonce=str(data["nonce"]),
            next=clean_next(data["next"]) if data.get("next") else None,
            exp=int(data["exp"]),
        )
    except (ValueError, KeyError, TypeError):
        return None
    if flow.exp <= int(now.timestamp()):
        return None
    return flow


def pkce_challenge(verifier: str) -> str:
    return _b64(hashlib.sha256(verifier.encode("ascii")).digest())


def authorization_url(cfg: GoogleConfig, flow: Flow) -> str:
    params = {
        "response_type": "code",
        "client_id": cfg.client_id,
        "redirect_uri": cfg.redirect_uri,
        "scope": SCOPES,
        "state": flow.state,
        "nonce": flow.nonce,
        "code_challenge": pkce_challenge(flow.verifier),
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    return f"{AUTH_URL}?{urlencode(params)}"


# --------------------------------------------------------------------------- token + JWKS


async def exchange_code(
    http: httpx.AsyncClient, cfg: GoogleConfig, code: str, verifier: str
) -> str:
    """POST the code to Google's token endpoint; returns the raw ID token."""
    try:
        resp = await http.post(
            TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": cfg.redirect_uri,
                "client_id": cfg.client_id,
                "client_secret": cfg.client_secret,
                "code_verifier": verifier,
            },
            headers={"Accept": "application/json"},
        )
    except httpx.HTTPError as exc:
        raise GoogleAuthError("google_unavailable", type(exc).__name__) from exc
    if resp.status_code >= 500:
        raise GoogleAuthError("google_unavailable", f"token endpoint {resp.status_code}")
    try:
        body = resp.json()
    except ValueError as exc:
        raise GoogleAuthError("google_exchange_failed", "token endpoint sent non-JSON") from exc
    if resp.status_code != 200 or not isinstance(body, dict):
        err = body.get("error") if isinstance(body, dict) else None
        raise GoogleAuthError("google_exchange_failed", f"{resp.status_code} {err}")
    id_token = body.get("id_token")
    if not isinstance(id_token, str) or not id_token:
        raise GoogleAuthError("google_exchange_failed", "no id_token in the response")
    return id_token


class _JwksCache:
    def __init__(self) -> None:
        self.keys: dict[str, dict[str, Any]] = {}
        self.fetched_at: float = 0.0

    def reset(self) -> None:
        self.keys = {}
        self.fetched_at = 0.0

    async def refresh(self, http: httpx.AsyncClient) -> None:
        try:
            resp = await http.get(JWKS_URL, headers={"Accept": "application/json"})
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise GoogleAuthError("google_unavailable", f"jwks: {type(exc).__name__}") from exc
        keys = data.get("keys") if isinstance(data, dict) else None
        if not isinstance(keys, list):
            raise GoogleAuthError("google_unavailable", "jwks: no keys")
        self.keys = {
            str(k["kid"]): k for k in keys if isinstance(k, dict) and isinstance(k.get("kid"), str)
        }
        self.fetched_at = time.monotonic()

    async def get(self, http: httpx.AsyncClient, kid: str) -> dict[str, Any] | None:
        stale = time.monotonic() - self.fetched_at > JWKS_TTL_S
        if stale or kid not in self.keys:
            await self.refresh(http)
        return self.keys.get(kid)


_jwks = _JwksCache()


def reset_jwks_cache() -> None:
    _jwks.reset()


@dataclass(frozen=True)
class GoogleIdentity:
    sub: str
    email: str
    name: str | None


async def verify_id_token(
    http: httpx.AsyncClient, cfg: GoogleConfig, id_token: str, *, nonce: str, now: datetime
) -> GoogleIdentity:
    """Verify signature, audience, issuer, lifetime, nonce and ``email_verified``."""
    try:
        header = jwt.get_unverified_header(id_token)
    except jwt.PyJWTError as exc:
        raise GoogleAuthError("google_token_invalid", "malformed id_token") from exc
    if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
        raise GoogleAuthError("google_token_invalid", f"unexpected alg {header.get('alg')}")
    jwk = await _jwks.get(http, header["kid"])
    if jwk is None:
        raise GoogleAuthError("google_token_invalid", "unknown signing key")
    try:
        key = jwt.PyJWK(jwk, algorithm="RS256")
        claims: dict[str, Any] = jwt.decode(
            id_token,
            key=key.key,
            algorithms=["RS256"],
            audience=cfg.client_id,
            issuer=ISSUERS,
            # The lifetime is checked below against the injectable clock.
            options={
                "require": ["iss", "aud", "sub", "exp", "iat"],
                "verify_exp": False,
                "verify_iat": False,
                "verify_nbf": False,
            },
        )
    except jwt.PyJWTError as exc:
        raise GoogleAuthError("google_token_invalid", type(exc).__name__) from exc
    ts = int(now.timestamp())
    try:
        exp, iat = int(claims["exp"]), int(claims["iat"])
    except (TypeError, ValueError) as exc:
        raise GoogleAuthError("google_token_invalid", "non-numeric exp/iat") from exc
    if exp <= ts - CLOCK_SKEW_S:
        raise GoogleAuthError("google_token_invalid", "expired")
    if iat > ts + CLOCK_SKEW_S:
        raise GoogleAuthError("google_token_invalid", "issued in the future")
    aud = claims.get("aud")
    if isinstance(aud, list) and len(aud) > 1 and claims.get("azp") != cfg.client_id:
        raise GoogleAuthError("google_token_invalid", "azp is not our client")
    got_nonce = claims.get("nonce")
    if not isinstance(got_nonce, str) or not hmac.compare_digest(got_nonce, nonce):
        raise GoogleAuthError("google_token_invalid", "nonce mismatch")
    raw_email = claims.get("email")
    if not isinstance(raw_email, str) or not raw_email:
        raise GoogleAuthError("google_email_missing", "no email claim")
    verified = claims.get("email_verified")
    if verified is not True and verified != "true":
        raise GoogleAuthError("google_email_unverified", "email_verified is not true")
    email = normalize_email(raw_email)
    if email is None:
        raise GoogleAuthError("google_email_missing", "unusable email")
    sub = str(claims["sub"])
    if not sub or len(sub) > 255:
        raise GoogleAuthError("google_token_invalid", "bad sub")
    raw_name = claims.get("name")
    name = " ".join(raw_name.split())[:120] if isinstance(raw_name, str) else ""
    return GoogleIdentity(sub=sub, email=email, name=name or None)


# --------------------------------------------------------------------------- account


def _usable_name(name: str | None) -> str | None:
    """Google's display name, unless it would fail the profile rules (links, length)."""
    if not name:
        return None
    try:
        return clean_name(name)
    except APIError:
        return None


async def sign_in_google_user(db: AsyncSession, identity: GoogleIdentity, *, now: datetime) -> User:
    """Find or create the user for a verified Google identity.

    Refuses with ``google_account_mismatch`` when the email's account is bound to another
    Google ``sub`` or the ``sub`` is bound to another account, and with ``rate_limited``
    after ``google_max_per_window`` sign-ins to one account per window (the caller creates
    the session).
    """
    s = get_settings()
    user = await get_by_email(db, identity.email)
    if user is not None and user.google_sub is not None and user.google_sub != identity.sub:
        raise GoogleAuthError("google_account_mismatch", "email bound to another Google sub")
    owner: User | None = await db.scalar(select(User).where(User.google_sub == identity.sub))
    if owner is not None and (user is None or owner.id != user.id):
        raise GoogleAuthError("google_account_mismatch", "Google sub bound to another email")
    if user is None:
        user = User(email=identity.email, created_at=now, updated_at=now)
        db.add(user)
    else:
        window = timedelta(minutes=s.magic_link_ttl_minutes)
        recent = await db.scalar(
            select(func.count())
            .select_from(UserSession)
            .where(UserSession.user_id == user.id, UserSession.created_at > now - window)
        )
        if int(recent or 0) >= s.google_max_per_window:
            raise GoogleAuthError("rate_limited", "too many sign-ins to this account")
    if user.google_sub is None:
        user.google_sub = identity.sub
    if not user.name:
        name = _usable_name(identity.name)
        if name:
            user.name = name
    user.last_signin_at = now
    user.updated_at = now
    await db.flush()
    return user


async def post_login_path(db: AsyncSession, user: User, next_path: str | None) -> str:
    """Where the web app opens after a Google sign-in.

    A user without a workspace goes to ``/onboarding`` (or to the invite they were
    accepting, which gives them one). Otherwise the requested relative path, or ``/app``,
    which opens the last-used workspace.
    """
    nxt = clean_next(next_path)
    if not await user_workspaces(db, user.id):
        return nxt if nxt and nxt.startswith(INVITE_PREFIX) else ONBOARDING_PATH
    return nxt or APP_PATH
