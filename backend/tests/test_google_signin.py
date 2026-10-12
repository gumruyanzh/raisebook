"""'Continue with Google': OIDC code flow + PKCE against a mocked Google (token + JWKS).

No network: the outbound client is replaced by an ``httpx.MockTransport`` that plays
Google's token endpoint and JWKS, and the ID tokens are signed with keys made here.
"""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.session import SESSION_COOKIE
from raisebook.config import Settings, reset_settings_cache
from raisebook.core import clock
from raisebook.models.user import User, UserSession
from raisebook.services import google_auth
from tests.factories import make_invite, make_user, make_workspace, owner_of

CLIENT_ID = "test-client.apps.googleusercontent.com"
CLIENT_SECRET = "test-client-secret"
APP = "http://localhost:3000"
CALLBACK = "http://localhost:8000/v1/auth/google/callback"


def _rsa() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


KEY = _rsa()
OTHER_KEY = _rsa()


def _jwk(key: rsa.RSAPrivateKey, kid: str) -> dict[str, Any]:
    d = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    d.update(kid=kid, alg="RS256", use="sig")
    return dict(d)


def _ts() -> int:
    return int(clock.get_now().timestamp())


class FakeGoogle:
    """Serves the token endpoint and JWKS; records every request."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.jwks: dict[str, Any] = {"keys": [_jwk(KEY, "k1")]}
        self.token_status = 200
        self.token_body: dict[str, Any] | None = None
        self.id_token: str | None = None

    def sign(
        self,
        nonce: str | None,
        /,
        *,
        key: rsa.RSAPrivateKey = KEY,
        kid: str = "k1",
        **claims: Any,
    ) -> str:
        now = _ts()
        payload: dict[str, Any] = {
            "iss": "https://accounts.google.com",
            "aud": CLIENT_ID,
            "azp": CLIENT_ID,
            "sub": "google-sub-1",
            "email": "ada@example.com",
            "email_verified": True,
            "name": "Ada Example",
            "iat": now,
            "exp": now + 3600,
            "nonce": nonce,
        }
        payload.update(claims)
        for k in [k for k, v in payload.items() if v is None]:
            del payload[k]
        self.id_token = jwt.encode(payload, key, algorithm="RS256", headers={"kid": kid})
        return self.id_token

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if url == google_auth.JWKS_URL:
            return httpx.Response(200, json=self.jwks)
        if url == google_auth.TOKEN_URL:
            if self.token_body is not None:
                return httpx.Response(self.token_status, json=self.token_body)
            return httpx.Response(
                self.token_status, json={"id_token": self.id_token, "access_token": "at"}
            )
        raise AssertionError(f"unexpected outbound request to {url}")

    def token_requests(self) -> list[dict[str, list[str]]]:
        return [
            parse_qs(r.content.decode())
            for r in self.requests
            if str(r.url) == google_auth.TOKEN_URL
        ]


def _set_env(monkeypatch: pytest.MonkeyPatch, **env: str) -> None:
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    reset_settings_cache()


@pytest.fixture
def google_off(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    _set_env(monkeypatch, RAISEBOOK_GOOGLE_CLIENT_ID="", RAISEBOOK_GOOGLE_CLIENT_SECRET="")
    yield
    monkeypatch.undo()
    reset_settings_cache()


@pytest.fixture
def fake_google(app: Any, monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeGoogle]:
    _set_env(
        monkeypatch,
        RAISEBOOK_GOOGLE_CLIENT_ID=CLIENT_ID,
        RAISEBOOK_GOOGLE_CLIENT_SECRET=CLIENT_SECRET,
    )
    google_auth.reset_jwks_cache()
    fake = FakeGoogle()

    async def _client() -> AsyncIterator[httpx.AsyncClient]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(fake.handle)) as c:
            yield c

    app.dependency_overrides[google_auth.get_google_http] = _client
    yield fake
    app.dependency_overrides.pop(google_auth.get_google_http, None)
    google_auth.reset_jwks_cache()
    monkeypatch.undo()
    reset_settings_cache()


Browser = Callable[[], Awaitable[httpx.AsyncClient]]


@pytest_asyncio.fixture(loop_scope="session")
async def browser(app: Any) -> AsyncIterator[Browser]:
    """``await browser()``: a fresh anonymous client with its own cookie jar."""
    clients: list[httpx.AsyncClient] = []

    async def make() -> httpx.AsyncClient:
        c = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")
        clients.append(c)
        return c

    yield make
    for c in clients:
        await c.aclose()


async def _start(b: httpx.AsyncClient, next_path: str | None = None) -> dict[str, str]:
    params = {"next": next_path} if next_path is not None else {}
    r = await b.get("/v1/auth/google/start", params=params)
    assert r.status_code == 302, r.text
    loc = urlsplit(r.headers["location"])
    assert f"{loc.scheme}://{loc.netloc}{loc.path}" == google_auth.AUTH_URL
    return {k: v[0] for k, v in parse_qs(loc.query).items()}


async def _callback(b: httpx.AsyncClient, **params: str) -> httpx.Response:
    r = await b.get("/v1/auth/google/callback", params=params)
    assert r.status_code == 303, r.text
    return r


def _query(r: httpx.Response) -> dict[str, list[str]]:
    return parse_qs(urlsplit(r.headers["location"]).query)


def _assert_refused(r: httpx.Response, code: str) -> None:
    assert r.headers["location"].startswith(f"{APP}/signin?"), r.headers["location"]
    assert _query(r).get("error") == [code]
    assert not any(c.startswith(f"{SESSION_COOKIE}=") for c in r.headers.get_list("set-cookie"))


async def _login(
    b: httpx.AsyncClient, fake: FakeGoogle, next_path: str | None = None, **claims: Any
) -> httpx.Response:
    q = await _start(b, next_path)
    fake.sign(q["nonce"], **claims)
    return await _callback(b, state=q["state"], code="auth-code-1")


# ------------------------------------------------------------------------- disabled


async def test_disabled_hides_provider_and_refuses(browser: Browser, google_off: None) -> None:
    b = await browser()
    p = await b.get("/v1/auth/providers")
    assert p.status_code == 200 and p.json() == {"magic_link": True, "google": False}

    r = await b.get("/v1/auth/google/start", params={"next": "/app"})
    assert r.status_code == 404
    err = r.json()["error"]
    assert err["code"] == "google_not_configured" and "not configured" in err["message"]

    _assert_refused(await _callback(b, state="x", code="y"), "google_not_configured")


def test_half_configured_is_off() -> None:
    assert google_auth.google_config(Settings(google_client_id="id")) is None
    assert google_auth.google_config(Settings(google_client_secret="s")) is None  # type: ignore[arg-type]
    blank_id = Settings(google_client_id=" ", google_client_secret="s")  # type: ignore[arg-type]
    assert google_auth.google_config(blank_id) is None


def test_redirect_uri_derives_from_public_base_url() -> None:
    s = Settings(
        google_client_id="id",
        google_client_secret="gs-very-private",  # type: ignore[arg-type]
        public_base_url="https://api.raisebook.org/",
    )
    cfg = google_auth.google_config(s)
    assert cfg is not None
    assert cfg.redirect_uri == "https://api.raisebook.org/v1/auth/google/callback"
    assert cfg.client_secret == "gs-very-private"
    assert "gs-very-private" not in repr(s)  # SecretStr never prints


# ------------------------------------------------------------------------- start


async def test_start_redirects_with_pkce_state_nonce(
    browser: Browser, fake_google: FakeGoogle
) -> None:
    b = await browser()
    assert (await b.get("/v1/auth/providers")).json()["google"] is True
    r = await b.get("/v1/auth/google/start", params={"next": "/w/acme"})
    assert r.status_code == 302
    assert r.headers["cache-control"] == "no-store"
    q = parse_qs(urlsplit(r.headers["location"]).query)
    assert q["client_id"] == [CLIENT_ID]
    assert q["redirect_uri"] == [CALLBACK]
    assert q["response_type"] == ["code"] and q["scope"] == ["openid email profile"]
    assert q["code_challenge_method"] == ["S256"] and len(q["code_challenge"][0]) == 43
    assert len(q["state"][0]) >= 40 and len(q["nonce"][0]) >= 40
    assert "client_secret" not in q
    flow_cookie = next(
        c for c in r.headers.get_list("set-cookie") if c.startswith(google_auth.FLOW_COOKIE)
    )
    low = flow_cookie.lower()
    assert "httponly" in low and "samesite=lax" in low
    assert "path=/v1/auth/google" in low and "max-age=600" in low
    # The verifier never leaves the server except inside the signed cookie.
    assert fake_google.requests == []


async def test_flow_cookie_is_secure_in_production_config(
    browser: Browser, fake_google: FakeGoogle, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_env(monkeypatch, RAISEBOOK_SESSION_COOKIE_SECURE="true")
    b = await browser()
    r = await b.get("/v1/auth/google/start")
    flow_cookie = next(
        c for c in r.headers.get_list("set-cookie") if c.startswith(google_auth.FLOW_COOKIE)
    )
    assert "secure" in flow_cookie.lower()


async def test_each_start_gets_fresh_state(browser: Browser, fake_google: FakeGoogle) -> None:
    b = await browser()
    a, c = await _start(b), await _start(b)
    assert a["state"] != c["state"] and a["nonce"] != c["nonce"]
    assert a["code_challenge"] != c["code_challenge"]


# ------------------------------------------------------------------------- happy paths


async def test_new_user_signs_in_and_goes_to_onboarding(
    browser: Browser, fake_google: FakeGoogle, db: AsyncSession
) -> None:
    b = await browser()
    q = await _start(b, "/w/somewhere")
    fake_google.sign(q["nonce"], email="New.Person@Example.com", sub="sub-new")
    r = await _callback(b, state=q["state"], code="the-code")
    assert r.headers["location"] == f"{APP}/onboarding"
    assert r.headers["cache-control"] == "no-store"
    cookies = r.headers.get_list("set-cookie")
    sess = next(c for c in cookies if c.startswith(f"{SESSION_COOKIE}="))
    assert "httponly" in sess.lower() and "samesite=lax" in sess.lower()
    assert any(c.startswith("rb_csrf=") for c in cookies)
    flow_clear = next(c for c in cookies if c.startswith(google_auth.FLOW_COOKIE))
    assert "max-age=0" in flow_clear.lower() or "expires=thu, 01 jan 1970" in flow_clear.lower()

    s = await b.get("/v1/auth/session")
    assert s.status_code == 200
    assert s.json()["user"]["email"] == "new.person@example.com"
    assert s.json()["user"]["name"] == "Ada Example"
    assert s.json()["workspaces"] == []
    user = await db.scalar(select(User).where(User.email == "new.person@example.com"))
    assert user is not None and user.google_sub == "sub-new" and user.last_signin_at is not None

    # The code was exchanged with our client, redirect URI and the PKCE verifier.
    (tok,) = fake_google.token_requests()
    assert tok["grant_type"] == ["authorization_code"] and tok["code"] == ["the-code"]
    assert tok["client_id"] == [CLIENT_ID] and tok["client_secret"] == [CLIENT_SECRET]
    assert tok["redirect_uri"] == [CALLBACK]
    verifier = tok["code_verifier"][0]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
    assert challenge.decode().rstrip("=") == q["code_challenge"]


async def test_existing_magic_link_user_gets_same_account(
    browser: Browser, fake_google: FakeGoogle, db: AsyncSession
) -> None:
    ws = await make_workspace(db, name="Acme Robotics")
    owner = await owner_of(db, ws)
    owner_id, email = owner.id, str(owner.email)
    owner.name = "Existing Name"
    await db.flush()

    b = await browser()
    r = await _login(b, fake_google, "/w/acme?view=table", email=email.upper(), sub="sub-x")
    assert r.headers["location"] == f"{APP}/w/acme?view=table"
    s = (await b.get("/v1/auth/session")).json()
    assert s["user"]["id"] == str(owner_id)
    assert s["user"]["name"] == "Existing Name"  # Google's name never overwrites
    assert [w["slug"] for w in s["workspaces"]] == [ws.slug]
    count = await db.scalar(select(func.count()).select_from(User).where(User.email == email))
    assert count == 1

    # Same Google account again with no next: /app opens the last-used workspace.
    b2 = await browser()
    r2 = await _login(b2, fake_google, email=email, sub="sub-x")
    assert r2.headers["location"] == f"{APP}/app"


async def test_magic_link_still_works_after_google(
    browser: Browser, fake_google: FakeGoogle
) -> None:
    b = await browser()
    await _login(b, fake_google, sub="sub-1")
    link = (await b.post("/v1/auth/magic-link", json={"email": "ada@example.com"})).json()
    token = parse_qs(urlsplit(link["dev_link"]).query)["token"][0]
    other = await browser()
    v = await other.post("/v1/auth/verify", json={"token": token})
    assert v.status_code == 200
    first = (await b.get("/v1/auth/session")).json()["user"]["id"]
    assert v.json()["user"]["id"] == first


async def test_invite_next_survives_for_user_without_workspace(
    browser: Browser, fake_google: FakeGoogle, db: AsyncSession
) -> None:
    ws = await make_workspace(db)
    _invite, token = await make_invite(db, ws, email="ada@example.com")
    b = await browser()
    r = await _login(b, fake_google, f"/invite/{token}")
    assert r.headers["location"] == f"{APP}/invite/{token}"


async def test_google_replaces_a_different_signed_in_account(
    browser: Browser, fake_google: FakeGoogle, db: AsyncSession, session_client: Any
) -> None:
    other = await make_user(db, email="someone.else@example.com")
    b = await session_client(other)
    old_id = b.session_id
    r = await _login(b, fake_google)
    assert r.headers["location"] == f"{APP}/onboarding"
    old = await db.get(UserSession, old_id)
    assert old is not None
    await db.refresh(old)
    assert old.revoked_at is not None
    assert (await b.get("/v1/auth/session")).json()["user"]["email"] == "ada@example.com"


async def test_jwks_is_cached_between_sign_ins(browser: Browser, fake_google: FakeGoogle) -> None:
    for _ in range(2):
        b = await browser()
        assert (await _login(b, fake_google)).headers["location"] == f"{APP}/onboarding"
    jwks_calls = [r for r in fake_google.requests if str(r.url) == google_auth.JWKS_URL]
    assert len(jwks_calls) == 1


async def test_rotated_key_triggers_one_refetch(browser: Browser, fake_google: FakeGoogle) -> None:
    b = await browser()
    await _login(b, fake_google)
    fake_google.jwks = {"keys": [_jwk(OTHER_KEY, "k2")]}
    b2 = await browser()
    r = await _login(b2, fake_google, key=OTHER_KEY, kid="k2")
    assert r.headers["location"] == f"{APP}/onboarding"


# ------------------------------------------------------------------------- state / cookie


async def test_bad_state_is_refused(browser: Browser, fake_google: FakeGoogle) -> None:
    b = await browser()
    q = await _start(b)
    fake_google.sign(q["nonce"])
    _assert_refused(await _callback(b, state="not-the-state", code="c"), "google_state_invalid")
    _assert_refused(await _callback(b, code="c"), "google_state_invalid")
    assert fake_google.token_requests() == []  # never exchanged


async def test_missing_or_tampered_flow_cookie(browser: Browser, fake_google: FakeGoogle) -> None:
    b = await browser()
    q = await _start(b)
    # Another browser (no cookie) replays the state: login CSRF / code injection.
    other = await browser()
    _assert_refused(await _callback(other, state=q["state"], code="c"), "google_state_invalid")

    value = b.cookies.get(google_auth.FLOW_COOKIE)
    assert value
    payload, sig = value.strip('"').split(".")
    forged = await browser()
    forged.cookies.set(
        google_auth.FLOW_COOKIE, f"{payload}.{sig[:-2]}AA", path=google_auth.FLOW_COOKIE_PATH
    )
    _assert_refused(await _callback(forged, state=q["state"], code="c"), "google_state_invalid")
    assert fake_google.token_requests() == []


async def test_expired_flow_cookie(browser: Browser, fake_google: FakeGoogle) -> None:
    b = await browser()
    q = await _start(b)
    clock.freeze(clock.get_now() + timedelta(minutes=11))
    fake_google.sign(q["nonce"])
    _assert_refused(await _callback(b, state=q["state"], code="c"), "google_state_invalid")


async def test_flow_cookie_is_single_use(browser: Browser, fake_google: FakeGoogle) -> None:
    b = await browser()
    q = await _start(b)
    fake_google.sign(q["nonce"])
    r = await _callback(b, state=q["state"], code="c")
    assert r.headers["location"].endswith("/onboarding")
    _assert_refused(await _callback(b, state=q["state"], code="c"), "google_state_invalid")


async def test_user_cancel_at_google(browser: Browser, fake_google: FakeGoogle) -> None:
    b = await browser()
    q = await _start(b, "/w/acme")
    r = await _callback(b, state=q["state"], error="access_denied")
    _assert_refused(r, "google_denied")
    assert _query(r)["next"] == ["/w/acme"]
    q = await _start(b)
    _assert_refused(await _callback(b, state=q["state"], error="server_error"), "google_failed")


# ------------------------------------------------------------------------- ID token checks


@pytest.mark.parametrize(
    "claims",
    [
        {"aud": "someone-else.apps.googleusercontent.com"},
        {"aud": [CLIENT_ID, "other"], "azp": "other"},
        {"iss": "https://evil.example.com"},
        {"exp_offset": -600},
        {"iat_offset": 3600},
        {"sub": None},
        {"key": OTHER_KEY},  # signed by a key that is not Google's
        {"kid": "unknown-kid"},
    ],
    ids=[
        "wrong_aud",
        "azp_mismatch",
        "wrong_iss",
        "expired",
        "future_iat",
        "no_sub",
        "bad_signature",
        "unknown_kid",
    ],
)
async def test_invalid_id_token_is_refused(
    browser: Browser, fake_google: FakeGoogle, claims: dict[str, Any], db: AsyncSession
) -> None:
    claims = dict(claims)
    if "exp_offset" in claims:
        claims["exp"] = _ts() + claims.pop("exp_offset")
    if "iat_offset" in claims:
        claims["iat"] = _ts() + claims.pop("iat_offset")
    b = await browser()
    r = await _login(b, fake_google, **claims)
    _assert_refused(r, "google_token_invalid")
    assert await db.scalar(select(User).where(User.email == "ada@example.com")) is None


async def test_bad_nonce_is_refused(browser: Browser, fake_google: FakeGoogle) -> None:
    b = await browser()
    q = await _start(b)
    fake_google.sign("a-replayed-nonce")
    _assert_refused(await _callback(b, state=q["state"], code="c"), "google_token_invalid")
    q = await _start(b)
    fake_google.sign(None)  # no nonce claim at all
    _assert_refused(await _callback(b, state=q["state"], code="c"), "google_token_invalid")


async def test_alg_none_token_is_refused(browser: Browser, fake_google: FakeGoogle) -> None:
    b = await browser()
    q = await _start(b)
    fake_google.id_token = jwt.encode(
        {
            "iss": "https://accounts.google.com",
            "aud": CLIENT_ID,
            "sub": "s",
            "nonce": q["nonce"],
            "email": "ada@example.com",
            "email_verified": True,
            "iat": _ts(),
            "exp": _ts() + 600,
        },
        key=None,
        algorithm="none",
    )
    _assert_refused(await _callback(b, state=q["state"], code="c"), "google_token_invalid")


@pytest.mark.parametrize("verified", [False, None, "false"])
async def test_unverified_email_is_refused(
    browser: Browser, fake_google: FakeGoogle, verified: Any, db: AsyncSession
) -> None:
    b = await browser()
    _assert_refused(
        await _login(b, fake_google, email_verified=verified), "google_email_unverified"
    )
    assert await db.scalar(select(User).where(User.email == "ada@example.com")) is None


async def test_missing_email_is_refused(browser: Browser, fake_google: FakeGoogle) -> None:
    b = await browser()
    _assert_refused(await _login(b, fake_google, email=None), "google_email_missing")


async def test_token_endpoint_failures(browser: Browser, fake_google: FakeGoogle) -> None:
    b = await browser()
    fake_google.token_status, fake_google.token_body = 400, {"error": "invalid_grant"}
    _assert_refused(await _login(b, fake_google), "google_exchange_failed")
    fake_google.token_status, fake_google.token_body = 200, {"access_token": "only"}
    _assert_refused(await _login(b, fake_google), "google_exchange_failed")
    fake_google.token_status, fake_google.token_body = 503, {"error": "backend"}
    _assert_refused(await _login(b, fake_google), "google_unavailable")


# ------------------------------------------------------------------------- account binding


async def test_sub_mismatch_is_refused(
    browser: Browser, fake_google: FakeGoogle, db: AsyncSession
) -> None:
    b = await browser()
    assert (await _login(b, fake_google, sub="sub-A")).headers["location"].endswith("/onboarding")
    user = await db.scalar(select(User).where(User.email == "ada@example.com"))
    assert user is not None and user.google_sub == "sub-A"

    # A different Google account now claims the same email.
    b2 = await browser()
    _assert_refused(await _login(b2, fake_google, sub="sub-B"), "google_account_mismatch")
    # The bound Google account presents a different email that another account owns.
    await make_user(db, email="someone@example.com")
    b3 = await browser()
    _assert_refused(
        await _login(b3, fake_google, sub="sub-A", email="someone@example.com"),
        "google_account_mismatch",
    )
    # ...or an email nobody has yet: no second account is created for the same Google sub.
    b4 = await browser()
    _assert_refused(
        await _login(b4, fake_google, sub="sub-A", email="brand.new@example.com"),
        "google_account_mismatch",
    )
    assert await db.scalar(select(User).where(User.email == "brand.new@example.com")) is None
    await db.refresh(user)
    assert user.google_sub == "sub-A"


async def test_google_sign_ins_are_rate_limited(
    browser: Browser, fake_google: FakeGoogle, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_env(monkeypatch, RAISEBOOK_GOOGLE_MAX_PER_WINDOW="2")
    for _ in range(2):
        b = await browser()
        assert (await _login(b, fake_google)).headers["location"] == f"{APP}/onboarding"
    b = await browser()
    _assert_refused(await _login(b, fake_google), "rate_limited")


async def test_start_and_callback_are_ip_rate_limited(
    browser: Browser, fake_google: FakeGoogle, monkeypatch: pytest.MonkeyPatch
) -> None:
    from raisebook.core.ratelimit import LIMITS, Limit

    monkeypatch.setitem(LIMITS, "anon_ip", Limit(2, 60))
    b = await browser()
    await _start(b)
    await _start(b)
    r = await b.get("/v1/auth/google/start")
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"


# ------------------------------------------------------------------------- open redirects


@pytest.mark.parametrize(
    "bad",
    [
        "//evil.example.com/x",
        "https://evil.example.com",
        "/\\evil.example.com",
        "javascript:alert(1)",
        "/\r\nSet-Cookie: x=1",
        "/" + "a" * 600,
        "/signin",
        "/auth/verify?token=x",
    ],
)
async def test_open_redirect_attempts_are_dropped(
    browser: Browser, fake_google: FakeGoogle, db: AsyncSession, bad: str
) -> None:
    ws = await make_workspace(db)
    email = str((await owner_of(db, ws)).email)
    b = await browser()
    r = await _login(b, fake_google, bad, email=email)
    assert r.headers["location"] == f"{APP}/app", r.headers["location"]


async def test_refusal_never_echoes_unsafe_next(browser: Browser, fake_google: FakeGoogle) -> None:
    b = await browser()
    q = await _start(b, "//evil.example.com")
    r = await _callback(b, state=q["state"], error="access_denied")
    assert "evil" not in r.headers["location"]
    assert r.headers["location"] == f"{APP}/signin?error=google_denied"
