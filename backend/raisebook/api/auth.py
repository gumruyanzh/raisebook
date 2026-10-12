"""Sign-in: ``/v1/auth`` (magic link → session cookie), SPEC §4.1, §5.4.

1. ``POST /v1/auth/magic-link {email}`` → always 202 (no account enumeration).
2. The emailed link opens the web page ``/auth/verify?token=…``. It shows the
   masked email (``GET /v1/auth/verify/peek``, which does not spend the token)
   and POSTs the token to ``POST /v1/auth/verify`` only when the person clicks
   Continue; that sets ``rb_session`` (HttpOnly) and ``rb_csrf`` (readable) and
   returns the user, CSRF token and workspaces.
3. Unsafe cookie requests send ``X-CSRF-Token``.

``GET /v1/auth/google/start`` and ``/callback`` are "Continue with Google" (OIDC code flow
with PKCE, ``services/google_auth.py``). They end in the same session cookies, then 303 to
the app. ``GET /v1/auth/providers`` says which sign-in methods this server offers.
"""

from __future__ import annotations

import hmac
from datetime import datetime
from urllib.parse import urlencode

import httpx
import structlog
from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.api._out import workspace_out
from raisebook.api.deps import (
    SessionUser,
    get_email_sender,
    get_now,
    get_session,
    get_session_user,
    rate_limit,
)
from raisebook.auth.principal import user_workspaces
from raisebook.auth.session import (
    SESSION_COOKIE,
    check_csrf,
    clear_session_cookies,
    create_user_session,
    csrf_token_for,
    load_session,
    revoke_session,
    set_session_cookies,
)
from raisebook.config import get_settings
from raisebook.schemas.auth import (
    MagicLinkOut,
    MagicLinkRequest,
    SessionOut,
    UserOut,
    VerifyOut,
    VerifyPeekOut,
    VerifyRequest,
)
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.services import auth as auth_svc
from raisebook.services import google_auth as google
from raisebook.services.email import EmailSender

router = APIRouter(prefix="/v1/auth", tags=["auth"], responses=ERROR_RESPONSES)
NO_STORE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}
log = structlog.get_logger(__name__)


def _ip(request: Request) -> str | None:
    return request.client.host if request.client else None


@router.post(
    "/magic-link",
    status_code=202,
    response_model=MagicLinkOut,
    response_model_exclude_none=True,
    dependencies=[Depends(rate_limit("anon_ip"))],
)
async def request_magic_link(
    body: MagicLinkRequest,
    request: Request,
    db: AsyncSession = Depends(get_session),
    sender: EmailSender = Depends(get_email_sender),
    now: datetime = Depends(get_now),
) -> MagicLinkOut:
    """Email a one-time sign-in link (valid 15 minutes).

    Always 202 ``{"sent": true}``, whether or not an account exists and even when
    rate-limited. In local development the response also carries ``dev_link``.
    Pass ``invite_token`` to accept an invite as part of signing in.
    """
    result = await auth_svc.request_magic_link(
        db,
        sender,
        email=body.email,
        now=now,
        redirect_path=body.redirect_path,
        invite_token=body.invite_token,
        ip=_ip(request),
    )
    return MagicLinkOut(sent=True, dev_link=result.link)


@router.get(
    "/verify/peek",
    response_model=VerifyPeekOut,
    dependencies=[Depends(rate_limit("anon_ip"))],
)
async def verify_peek(
    token: str = Query(..., min_length=1, max_length=200),
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> JSONResponse:
    """Whether a sign-in link is still valid, with a masked email. Does not spend it."""
    res = await auth_svc.peek(db, token, now=now)
    out = VerifyPeekOut(valid=res.valid, email_hint=res.email_hint)
    return JSONResponse(out.model_dump(mode="json"), headers=NO_STORE)


@router.post("/verify", response_model=VerifyOut, dependencies=[Depends(rate_limit("anon_ip"))])
async def verify(
    body: VerifyRequest,
    request: Request,
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> JSONResponse:
    """Spend a sign-in token: sets the session cookies. 400 ``invalid_token`` when the
    token is unknown, used or expired. 409 ``session_conflict`` when this browser is
    signed in as a different user and ``switch_account`` is not true (nothing is spent)."""
    current = await load_session(db, request.cookies.get(SESSION_COOKIE), now=now)
    res = await auth_svc.verify(
        db,
        body.token,
        now=now,
        user_agent=request.headers.get("user-agent"),
        ip=_ip(request),
        signed_in_email=str(current[1].email) if current else None,
        switch_account=body.switch_account,
    )
    if current is not None and current[1].id != res.user.id:
        await revoke_session(db, current[0].id, now=now)
    out = VerifyOut(
        user=UserOut.model_validate(res.user),
        csrf_token=csrf_token_for(res.session.id),
        redirect_path=res.redirect_path,
        workspaces=[workspace_out(ws, role) for ws, role in res.workspaces],
    )
    await db.commit()
    resp = JSONResponse(out.model_dump(mode="json"), headers=NO_STORE)
    set_session_cookies(resp, res.cookie, res.session.id, res.session.expires_at)
    return resp


@router.get("/session", response_model=SessionOut)
async def current_session(
    su: SessionUser = Depends(get_session_user),
    db: AsyncSession = Depends(get_session),
) -> SessionOut:
    """The signed-in user, their workspaces and the CSRF token. 401 ``session_invalid``
    when signed out."""
    mine = await user_workspaces(db, su.user.id)
    return SessionOut(
        user=UserOut.model_validate(su.user),
        csrf_token=csrf_token_for(su.session.id),
        workspaces=[workspace_out(ws, role) for ws, role in mine],
    )


@router.post("/signout", status_code=204, response_class=Response)
async def signout(
    request: Request,
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> Response:
    """Revoke the current session and clear the cookies (CSRF-checked when signed in)."""
    resolved = await load_session(db, request.cookies.get(SESSION_COOKIE), now=now)
    if resolved is not None:
        check_csrf(request, resolved[0].id)
        await revoke_session(db, resolved[0].id, now=now)
    await db.commit()
    resp = Response(status_code=204, headers=NO_STORE)
    clear_session_cookies(resp)
    return resp


# --------------------------------------------------------------------------- Google


class AuthProvidersOut(BaseModel):
    """Sign-in methods this server offers (the web hides what is off)."""

    magic_link: bool = True
    google: bool = False


@router.get("/providers", response_model=AuthProvidersOut)
async def auth_providers() -> AuthProvidersOut:
    """Sign-in methods this server offers: the magic link always, Google when configured."""
    return AuthProvidersOut(google=google.google_config() is not None)


def _set_flow_cookie(resp: Response, value: str) -> None:
    resp.set_cookie(
        google.FLOW_COOKIE,
        value,
        max_age=google.FLOW_TTL_S,
        path=google.FLOW_COOKIE_PATH,
        secure=get_settings().session_cookie_secure,
        httponly=True,
        samesite="lax",
    )


def _clear_flow_cookie(resp: Response) -> None:
    resp.delete_cookie(
        google.FLOW_COOKIE,
        path=google.FLOW_COOKIE_PATH,
        secure=get_settings().session_cookie_secure,
        httponly=True,
        samesite="lax",
    )


def _app_url() -> str:
    return get_settings().app_url.rstrip("/")


def _signin_error(code: str, next_path: str | None = None) -> RedirectResponse:
    """303 to the web sign-in page with ``?error=<code>`` (and the safe ``next``)."""
    q = {"error": code}
    nxt = google.clean_next(next_path)
    if nxt:
        q["next"] = nxt
    resp = RedirectResponse(f"{_app_url()}/signin?{urlencode(q)}", 303, headers=NO_STORE)
    _clear_flow_cookie(resp)
    return resp


@router.get(
    "/google/start",
    status_code=302,
    response_class=RedirectResponse,
    dependencies=[Depends(rate_limit("anon_ip"))],
)
async def google_start(
    next: str | None = Query(None, max_length=2000),
    now: datetime = Depends(get_now),
) -> RedirectResponse:
    """Redirect to Google's account chooser (state, PKCE verifier and nonce go in a signed,
    HttpOnly, 10-minute cookie). ``next`` is kept only when it is a same-app relative path.
    404 ``google_not_configured`` while ``RAISEBOOK_GOOGLE_CLIENT_ID``/``_SECRET`` are unset.
    """
    cfg = google.google_config()
    if cfg is None:
        raise google.GoogleNotConfigured()
    flow = google.new_flow(next, now=now)
    resp = RedirectResponse(google.authorization_url(cfg, flow), 302, headers=NO_STORE)
    _set_flow_cookie(resp, google.encode_flow(flow))
    return resp


@router.get(
    "/google/callback",
    status_code=303,
    response_class=RedirectResponse,
    dependencies=[Depends(rate_limit("anon_ip"))],
)
async def google_callback(
    request: Request,
    state: str | None = Query(None, max_length=500),
    code: str | None = Query(None, max_length=2000),
    error: str | None = Query(None, max_length=200),
    db: AsyncSession = Depends(get_session),
    http: httpx.AsyncClient = Depends(google.get_google_http),
    now: datetime = Depends(get_now),
) -> RedirectResponse:
    """Finish Google sign-in: check the state, exchange the code, verify the ID token, set
    the session cookies and 303 to the app (``/onboarding`` without a workspace, else
    ``next`` or ``/app``). Any failure 303s to ``{APP_URL}/signin?error=<code>``."""
    cfg = google.google_config()
    if cfg is None:
        return _signin_error("google_not_configured")
    flow = google.decode_flow(request.cookies.get(google.FLOW_COOKIE), now=now)
    if flow is None or not state or not hmac.compare_digest(state, flow.state):
        log.warning("google_signin_refused", code="google_state_invalid", has_flow=bool(flow))
        return _signin_error("google_state_invalid")
    if error or not code:
        failed = "google_denied" if error == "access_denied" else "google_failed"
        log.info("google_signin_refused", code=failed, google_error=error)
        return _signin_error(failed, flow.next)
    try:
        id_token = await google.exchange_code(http, cfg, code, flow.verifier)
        identity = await google.verify_id_token(http, cfg, id_token, nonce=flow.nonce, now=now)
        user = await google.sign_in_google_user(db, identity, now=now)
    except google.GoogleAuthError as exc:
        log.warning("google_signin_refused", code=exc.code, reason=exc.reason)
        return _signin_error(exc.code, flow.next)
    # Choosing a Google account here is explicit, so it replaces a different signed-in
    # account in this browser (like ``switch_account`` on the magic link).
    current = await load_session(db, request.cookies.get(SESSION_COOKIE), now=now)
    if current is not None and current[1].id != user.id:
        await revoke_session(db, current[0].id, now=now)
    sess, cookie = await create_user_session(
        db, user, now=now, user_agent=request.headers.get("user-agent"), ip=_ip(request)
    )
    dest = await google.post_login_path(db, user, flow.next)
    await db.commit()
    log.info("google_signin", user_id=str(user.id))
    resp = RedirectResponse(f"{_app_url()}{dest}", 303, headers=NO_STORE)
    set_session_cookies(resp, cookie, sess.id, sess.expires_at)
    _clear_flow_cookie(resp)
    return resp
