"""Shared setup for the API+MCP feature tests (fictional data only)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.activity import Activity
from raisebook.models.investor import Investor
from raisebook.models.round import Round, RoundParticipant
from raisebook.models.user import User
from raisebook.models.workspace import Workspace
from tests.factories import make_api_key, make_investor, make_round, make_workspace, owner_of


@dataclass
class World:
    ws: Workspace
    owner: User
    rnd: Round
    key: str  # read+write key plaintext
    key_id: Any
    reader: str  # read-only key plaintext


async def world(
    db: AsyncSession,
    *,
    name: str = "Tallow Test",
    timezone: str = "UTC",
    round_name: str = "Seed",
    agent_name: str | None = None,
) -> World:
    ws = await make_workspace(db, name=name, timezone=timezone)
    owner = await owner_of(db, ws)
    rnd = await make_round(db, ws, name=round_name, slug=round_name.lower().replace(" ", "-"))
    key, raw = await make_api_key(db, ws, scopes="read,write", agent_name=agent_name)
    _, reader = await make_api_key(db, ws, scopes="read")
    return World(ws, owner, rnd, raw, key.id, reader)


async def activities_of(
    db: AsyncSession, investor: Investor, kind: str | None = None
) -> list[Activity]:
    stmt = select(Activity).where(Activity.investor_id == investor.id)
    if kind:
        stmt = stmt.where(Activity.kind == kind)
    return list(await db.scalars(stmt.order_by(Activity.created_at, Activity.occurred_at)))


async def participant(db: AsyncSession, rnd: Round, inv: Investor) -> RoundParticipant | None:
    row: RoundParticipant | None = await db.scalar(
        select(RoundParticipant).where(
            RoundParticipant.round_id == rnd.id, RoundParticipant.investor_id == inv.id
        )
    )
    if row is not None:
        await db.refresh(row)
    return row


async def dana(db: AsyncSession, ws: Workspace, **fields: Any) -> Investor:
    """A fictional investor with predictable references."""
    return await make_investor(
        db,
        ws,
        name=fields.pop("name", "Dana Whitfield"),
        firm=fields.pop("firm", "Harbor Light Ventures"),
        email=fields.pop("email", "dana@example.com"),
        linkedin_url=fields.pop("linkedin_url", "https://www.linkedin.com/in/example-dana"),
        **fields,
    )
