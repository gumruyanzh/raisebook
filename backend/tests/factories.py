"""Row builders for every model (fictional data only: example.com, made-up names).

They write rows directly (bypassing feature services) so any test can set up state.
All take the test's ``db`` session first and use the injectable clock.
"""

from __future__ import annotations

import itertools
import re
import unicodedata
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.magic_link import new_token
from raisebook.core.actor import Actor
from raisebook.core.clock import get_now
from raisebook.models.activity import Activity
from raisebook.models.enums import ActorType, Role, Via
from raisebook.models.investor import Investor
from raisebook.models.round import DEFAULT_STAGES, Round, RoundParticipant, RoundStage
from raisebook.models.user import User
from raisebook.models.workspace import ApiKey, Invite, Membership, Workspace
from raisebook.services.api_keys import create_api_key
from raisebook.services.workspaces import create_workspace_row, slugify

_seq = itertools.count(1)

FIRST = ("Dana", "Marcus", "Ines", "Tomas", "Helena", "Jonah", "Priya", "Rafael", "Grace")
LAST = ("Whitfield", "Ellery", "Calloway", "Okafor", "Strand", "Pell", "Montoya", "Holloway")
FIRMS = ("Harbor Light Ventures", "Kelpline Ventures", "Brightquay Capital", "Stonepine Seed")


def n() -> int:
    return next(_seq)


def _norm(s: str | None) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return " ".join(re.findall(r"[a-z0-9]+", s.replace("&", " and ")))


def name_key(name: str, firm: str | None) -> str:
    words = _norm(firm).split()
    while words and words[-1] in ("capital", "ventures", "partners", "vc", "fund", "llc", "lp"):
        words.pop()
    return f"{_norm(name)}|{' '.join(words)}"


async def make_user(db: AsyncSession, *, email: str | None = None, name: str | None = None) -> User:
    i = n()
    now = get_now()
    user = User(
        email=email or f"user{i}@example.com",
        name=name if name is not None else f"{FIRST[i % len(FIRST)]} Tester{i}",
        created_at=now,
        updated_at=now,
    )
    db.add(user)
    await db.flush()
    return user


async def make_workspace(
    db: AsyncSession,
    *,
    owner: User | None = None,
    name: str | None = None,
    sandbox: bool = False,
    timezone: str = "UTC",
    currency: str = "USD",
) -> Workspace:
    owner = owner or await make_user(db)
    return await create_workspace_row(
        db,
        user=owner,
        name=name or f"Startup {n()}",
        now=get_now(),
        timezone=timezone,
        default_currency=currency,
        is_sandbox=sandbox,
    )


async def owner_of(db: AsyncSession, ws: Workspace) -> User:
    user = await db.scalar(
        select(User)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.workspace_id == ws.id, Membership.role == Role.OWNER.value)
        .order_by(Membership.created_at)
        .limit(1)
    )
    assert user is not None
    return user


async def add_member(
    db: AsyncSession, ws: Workspace, *, user: User | None = None, role: str = "editor"
) -> User:
    user = user or await make_user(db)
    db.add(Membership(workspace_id=ws.id, user_id=user.id, role=role, created_at=get_now()))
    await db.flush()
    return user


async def make_invite(
    db: AsyncSession,
    ws: Workspace,
    *,
    email: str | None = None,
    role: str = "editor",
    invited_by: User | None = None,
    expires_in: timedelta = timedelta(days=7),
) -> tuple[Invite, str]:
    raw, digest = new_token()
    now = get_now()
    inv = Invite(
        workspace_id=ws.id,
        email=email or f"invitee{n()}@example.com",
        role=role,
        token_hash=digest,
        invited_by_user_id=invited_by.id if invited_by else None,
        created_at=now,
        expires_at=now + expires_in,
    )
    db.add(inv)
    await db.flush()
    return inv, raw


async def make_api_key(
    db: AsyncSession,
    ws: Workspace,
    *,
    scopes: str | list[str] = "read,write",
    name: str | None = None,
    agent_name: str | None = None,
    expires_at: datetime | None = None,
    revoked: bool = False,
) -> tuple[ApiKey, str]:
    """``(ApiKey, plaintext)``. Mode follows the workspace (sandbox → ``rb_test_``)."""
    created = await create_api_key(
        db,
        workspace_id=ws.id,
        is_sandbox=ws.is_sandbox,
        name=name or f"key {n()}",
        scopes=scopes,
        now=get_now(),
        agent_name=agent_name,
    )
    if expires_at is not None:
        created.key.expires_at = expires_at
    if revoked:
        created.key.revoked_at = get_now()
    await db.flush()
    return created.key, created.secret


async def make_round(
    db: AsyncSession,
    ws: Workspace,
    *,
    name: str | None = None,
    status: str = "open",
    target_amount: int = 2_000_000,
    currency: str | None = None,
    **fields: Any,
) -> Round:
    """A round with the 8 default stages (SPEC §3.3)."""
    i = n()
    rname = name or f"Round {i}"
    now = get_now()
    rnd = Round(
        workspace_id=ws.id,
        slug=fields.pop("slug", None) or slugify(rname)[:40] or f"round-{i}",
        name=rname,
        status=status,
        currency=currency or ws.default_currency,
        target_amount=target_amount,
        created_at=now,
        updated_at=now,
        **fields,
    )
    db.add(rnd)
    await db.flush()
    for pos, st in enumerate(DEFAULT_STAGES):
        db.add(
            RoundStage(
                workspace_id=ws.id,
                round_id=rnd.id,
                key=st.key,
                label=st.label,
                color=str(st.color),
                kind=str(st.kind),
                position=pos,
            )
        )
    await db.flush()
    return rnd


async def stages_of(db: AsyncSession, rnd: Round) -> dict[str, RoundStage]:
    rows = await db.scalars(
        select(RoundStage).where(RoundStage.round_id == rnd.id).order_by(RoundStage.position)
    )
    return {s.key: s for s in rows}


async def make_investor(
    db: AsyncSession,
    ws: Workspace,
    *,
    name: str | None = None,
    firm: str | None = "__default__",
    email: str | None = "__default__",
    **fields: Any,
) -> Investor:
    i = n()
    iname = name or f"{FIRST[i % len(FIRST)]} {LAST[i % len(LAST)]} {i}"
    ifirm = FIRMS[i % len(FIRMS)] if firm == "__default__" else firm
    iemail = f"investor{i}@example.com" if email == "__default__" else email
    now = get_now()
    linkedin = fields.get("linkedin_url")
    m = re.search(r"linkedin\.com/in/([^/?#]+)", linkedin or "")
    inv = Investor(
        workspace_id=ws.id,
        name=iname,
        firm=ifirm,
        email=iemail,
        type=fields.pop("type", "vc"),
        linkedin_key=f"in/{m.group(1).lower()}" if m else None,
        name_key=name_key(iname, ifirm),
        search_text=" ".join(p for p in (iname, ifirm, iemail) if p).lower(),
        created_at=now,
        updated_at=now,
        **fields,
    )
    db.add(inv)
    await db.flush()
    return inv


async def make_participant(
    db: AsyncSession,
    rnd: Round,
    investor: Investor,
    *,
    stage: str = "new",
    **fields: Any,
) -> RoundParticipant:
    stages = await stages_of(db, rnd)
    now = get_now()
    part = RoundParticipant(
        workspace_id=rnd.workspace_id,
        round_id=rnd.id,
        investor_id=investor.id,
        stage_id=stages[stage].id,
        stage_changed_at=now,
        created_at=now,
        updated_at=now,
        **fields,
    )
    db.add(part)
    await db.flush()
    return part


async def make_activity(
    db: AsyncSession,
    investor: Investor,
    *,
    kind: str = "note",
    rnd: Round | None = None,
    actor: Actor | None = None,
    body: str | None = "Called and talked about the pilot.",
    **fields: Any,
) -> Activity:
    act = actor or Actor(ActorType.SYSTEM, Via.SYSTEM, label="raisebook")
    now = get_now()
    row = Activity(
        workspace_id=investor.workspace_id,
        investor_id=investor.id,
        round_id=rnd.id if rnd else None,
        kind=kind,
        occurred_at=fields.pop("occurred_at", now),
        body=body,
        data=fields.pop("data", {}),
        created_at=now,
        **act.activity_fields(),
        **fields,
    )
    db.add(row)
    await db.flush()
    return row
