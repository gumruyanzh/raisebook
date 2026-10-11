"""``rbctl``: the Raisebook operator CLI.

Commands: ``user create``, ``workspace create|list``, ``apikey create|list|revoke``,
``seed-demo``, ``housekeeping``. Output is JSON on stdout (one object per line) so
scripts can parse it. API key secrets are printed once, on creation only.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Annotated, Any
from uuid import UUID

import typer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.magic_link import normalize_email
from raisebook.core.clock import get_now
from raisebook.core.database import dispose_engine, get_sessionmaker
from raisebook.core.errors import APIError
from raisebook.models.user import User
from raisebook.models.workspace import ApiKey, Membership, Workspace
from raisebook.services import api_keys as keys_svc
from raisebook.services import workspaces as ws_svc
from raisebook.services.users import get_or_create_user

app = typer.Typer(help="Raisebook operator CLI", no_args_is_help=True)
user_app = typer.Typer(help="Users", no_args_is_help=True)
ws_app = typer.Typer(help="Workspaces", no_args_is_help=True)
key_app = typer.Typer(help="API keys", no_args_is_help=True)
app.add_typer(user_app, name="user")
app.add_typer(ws_app, name="workspace")
app.add_typer(key_app, name="apikey")


def _run[T](fn: Callable[[AsyncSession], Awaitable[T]]) -> T:
    async def go() -> T:
        try:
            async with get_sessionmaker()() as session:
                return await fn(session)
        finally:
            await dispose_engine()

    try:
        return asyncio.run(go())
    except APIError as exc:
        typer.secho(f"error: {exc.message}", fg=typer.colors.RED, err=True)
        raise typer.Exit(2) from exc


def _emit(obj: dict[str, Any]) -> None:
    typer.echo(json.dumps(obj, default=str))


def _email(raw: str) -> str:
    email = normalize_email(raw)
    if email is None:
        typer.secho(f"error: {raw!r} is not a valid email", fg=typer.colors.RED, err=True)
        raise typer.Exit(2)
    return email


async def _workspace(s: AsyncSession, ref: str) -> Workspace:
    ws = await ws_svc.get_by_slug(s, ref)
    if ws is None:
        try:
            ws = await s.get(Workspace, UUID(ref))
        except ValueError:
            ws = None
    if ws is None:
        typer.secho(f"error: workspace {ref!r} not found", fg=typer.colors.RED, err=True)
        raise typer.Exit(2)
    return ws


@user_app.command("create")
def user_create(
    email: Annotated[str, typer.Option(help="Email address")],
    name: Annotated[str | None, typer.Option(help="Display name")] = None,
) -> None:
    """Create a user (or return the existing one)."""
    addr = _email(email)

    async def go(s: AsyncSession) -> tuple[User, bool]:
        user, created = await get_or_create_user(s, addr, now=get_now())
        if name:
            user.name = name.strip()
        await s.commit()
        return user, created

    user, created = _run(go)
    _emit({"id": user.id, "email": user.email, "name": user.name, "created": created})


@ws_app.command("create")
def workspace_create(
    name: Annotated[str, typer.Option(help="Workspace (company) name")],
    owner_email: Annotated[str, typer.Option("--owner-email", help="Owner (created if new)")],
    timezone: Annotated[str, typer.Option(help="IANA timezone")] = "UTC",
    currency: Annotated[str, typer.Option(help="Default currency (ISO 4217)")] = "USD",
) -> None:
    """Create a workspace owned by ``--owner-email``."""
    addr = _email(owner_email)

    async def go(s: AsyncSession) -> Workspace:
        now = get_now()
        user, _ = await get_or_create_user(s, addr, now=now)
        ws = await ws_svc.create_workspace(
            s, user=user, name=name, now=now, timezone=timezone, default_currency=currency
        )
        await s.commit()
        return ws

    ws = _run(go)
    _emit({"id": ws.id, "slug": ws.slug, "name": ws.name, "is_sandbox": ws.is_sandbox})


@ws_app.command("list")
def workspace_list() -> None:
    """List workspaces with member counts (no workspace data)."""

    async def go(s: AsyncSession) -> list[tuple[Workspace, int]]:
        rows = list((await s.execute(select(Workspace).order_by(Workspace.created_at))).scalars())
        return [(w, await ws_svc.member_count(s, w.id)) for w in rows]

    for ws, members in _run(go):
        _emit({"id": ws.id, "slug": ws.slug, "name": ws.name, "members": members})


@key_app.command("create")
def apikey_create(
    workspace: Annotated[str, typer.Option(help="Workspace slug or id")],
    name: Annotated[str, typer.Option(help="Key name, e.g. 'Claude Code laptop'")],
    scopes: Annotated[str, typer.Option(help="Comma-separated: read,write,admin")] = "read,write",
    agent_name: Annotated[str | None, typer.Option(help="Agent name, e.g. claude-code")] = None,
) -> None:
    """Create an API key. The secret is printed once."""

    async def go(s: AsyncSession) -> keys_svc.CreatedKey:
        ws = await _workspace(s, workspace)
        created = await keys_svc.create_api_key(
            s,
            workspace_id=ws.id,
            is_sandbox=ws.is_sandbox,
            name=name,
            scopes=scopes,
            agent_name=agent_name,
            now=get_now(),
        )
        await s.commit()
        return created

    created = _run(go)
    _emit(
        {
            "id": created.key.id,
            "key_prefix": created.key.key_prefix,
            "scopes": created.key.scopes,
            "secret": created.secret,
        }
    )


@key_app.command("list")
def apikey_list(workspace: Annotated[str, typer.Option(help="Workspace slug or id")]) -> None:
    """List a workspace's keys (prefixes only)."""

    async def go(s: AsyncSession) -> list[ApiKey]:
        ws = await _workspace(s, workspace)
        return list(
            await s.scalars(
                select(ApiKey).where(ApiKey.workspace_id == ws.id).order_by(ApiKey.created_at)
            )
        )

    for k in _run(go):
        _emit(
            {
                "id": k.id,
                "name": k.name,
                "key_prefix": k.key_prefix,
                "scopes": k.scopes,
                "revoked_at": k.revoked_at,
            }
        )


@key_app.command("revoke")
def apikey_revoke(key_id: Annotated[str, typer.Option("--id", help="API key id")]) -> None:
    """Revoke an API key immediately."""

    async def go(s: AsyncSession) -> ApiKey:
        key = await s.get(ApiKey, UUID(key_id))
        if key is None:
            typer.secho("error: API key not found", fg=typer.colors.RED, err=True)
            raise typer.Exit(2)
        out = await keys_svc.revoke_api_key(s, key.workspace_id, key.id, now=get_now())
        await s.commit()
        return out

    key = _run(go)
    _emit({"id": key.id, "revoked_at": key.revoked_at})


@app.command("seed-demo")
def seed_demo(
    email: Annotated[str, typer.Option(help="Owner email (created if new)")],
    with_key: Annotated[
        bool, typer.Option("--with-key", help="Also create an rb_test_ key for MCP")
    ] = False,
) -> None:
    """Create the fictional sandbox workspace "Kestrel Robotics (sample)" for ``--email``."""
    addr = _email(email)

    async def go(s: AsyncSession) -> tuple[Workspace, str | None]:
        now = get_now()
        user, _ = await get_or_create_user(s, addr, now=now)
        ws = await ws_svc.create_workspace(s, user=user, name="", now=now, sample=True)
        secret = None
        if with_key:
            created = await keys_svc.create_api_key(
                s,
                workspace_id=ws.id,
                is_sandbox=ws.is_sandbox,
                name="Demo agent",
                scopes="read,write",
                agent_name="claude-code",
                now=now,
                created_by_user_id=user.id,
            )
            secret = created.secret
        await s.commit()
        return ws, secret

    ws, secret = _run(go)
    out: dict[str, Any] = {"id": ws.id, "slug": ws.slug, "name": ws.name, "url": f"/w/{ws.slug}"}
    if secret:
        out["api_key"] = secret
    _emit(out)


@app.command("housekeeping")
def housekeeping() -> None:
    """Delete expired sign-in tokens and sessions, revoked or long-expired invites, and
    rate-limit windows older than a day."""
    from raisebook.core.ratelimit import delete_old_windows
    from raisebook.services.housekeeping import purge

    async def go(s: AsyncSession) -> dict[str, int]:
        now = get_now()
        counts = await purge(s, now=now)
        await s.commit()
        counts["rate_limit_windows"] = await delete_old_windows(now - timedelta(days=1))
        return counts

    _emit({"deleted": _run(go)})


@app.command("members")
def members(workspace: Annotated[str, typer.Option(help="Workspace slug or id")]) -> None:
    """List a workspace's members (email and role)."""

    async def go(s: AsyncSession) -> list[tuple[str, str]]:
        ws = await _workspace(s, workspace)
        rows = await s.execute(
            select(User.email, Membership.role)
            .join(Membership, Membership.user_id == User.id)
            .where(Membership.workspace_id == ws.id)
            .order_by(Membership.created_at)
        )
        return [(str(e), r) for e, r in rows.tuples()]

    for email, role in _run(go):
        _emit({"email": email, "role": role})
