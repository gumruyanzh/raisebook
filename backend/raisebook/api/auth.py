"""Sign-in: ``/v1/auth`` (magic link → session cookie), SPEC §4.1, §5.4.

1. ``POST /v1/auth/magic-link {email}`` → always 202 (no account enumeration).
2. The emailed link opens the web page ``/auth/verify?token=…``, which POSTs the
   token to ``POST /v1/auth/verify``; that sets ``rb_session`` (HttpOnly) and
   ``rb_csrf`` (readable) and returns the user, CSRF token and workspaces.
3. Unsafe cookie requests send ``X-CSRF-Token``.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
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
    csrf_token_for,
    load_session,
    revoke_session,
    set_session_cookies,
)
from raisebook.schemas.auth import (
    MagicLinkOut,
    MagicLinkRequest,
    SessionOut,
    UserOut,
    VerifyOut,
    VerifyRequest,
)
from raisebook.schemas.common import ERROR_RESPONSES
from raisebook.services import auth as auth_svc
from raisebook.services.email import EmailSender

router = APIRouter(prefix="/v1/auth", tags=["auth"], responses=ERROR_RESPONSES)
NO_STORE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}


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


@router.post("/verify", response_model=VerifyOut, dependencies=[Depends(rate_limit("anon_ip"))])
async def verify(
    body: VerifyRequest,
    request: Request,
    db: AsyncSession = Depends(get_session),
    now: datetime = Depends(get_now),
) -> JSONResponse:
    """Spend a sign-in token: sets the session cookies. 400 ``invalid_token`` when the
    token is unknown, used or expired."""
    res = await auth_svc.verify(
        db, body.token, now=now, user_agent=request.headers.get("user-agent"), ip=_ip(request)
    )
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
