"""Investor search and listing (SPEC §5.7 ``GET /v1/investors``, MCP ``search_investors``).

``q`` matches name, firm, title, email, location, tags, industries, source and notes
through ``investors.search_text``; every word must match. Every query is filtered by the
caller's workspace: searching for another workspace's names returns nothing. Owner: AM.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Select, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.core.errors import ValidationFailed
from raisebook.models.investor import Investor
from raisebook.models.round import RoundParticipant
from raisebook.schemas.common import decode_cursor, encode_cursor

INVESTOR_SORTS = ("name", "firm", "updated", "created", "relevance")


def _escape_like(word: str) -> str:
    return word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def word_conditions(q: str) -> list[ColumnElement[bool]]:
    """One ``search_text LIKE %word%`` per word (all must match)."""
    words = [w for w in q.lower().split() if w][:12]
    return [Investor.search_text.like(f"%{_escape_like(w)}%", escape="\\") for w in words]


def array_has_ci(col: Any, value: str) -> ColumnElement[bool]:
    """Case-insensitive membership of ``value`` in a ``text[]`` column."""
    tv = func.unnest(col).table_valued("v").render_derived()
    return select(1).select_from(tv).where(func.lower(tv.c.v) == value.strip().lower()).exists()


def investors_query(
    ws: WorkspaceContext,
    *,
    q: str | None = None,
    type_: str | None = None,
    tags: Sequence[str] | None = None,
    industries: Sequence[str] | None = None,
    in_round: UUID | None = None,
    not_in_round: UUID | None = None,
    sort: str = "name",
    order: str | None = None,
) -> Select[tuple[Investor]]:
    stmt = select(Investor).where(Investor.workspace_id == ws.workspace_id)
    if q:
        stmt = stmt.where(*word_conditions(q))
    if type_:
        stmt = stmt.where(Investor.type == type_)
    for t in tags or []:
        stmt = stmt.where(array_has_ci(Investor.tags, t))
    if industries:
        stmt = stmt.where(or_(*[array_has_ci(Investor.industries, i) for i in industries]))
    member = select(RoundParticipant.id).where(
        RoundParticipant.workspace_id == ws.workspace_id,
        RoundParticipant.investor_id == Investor.id,
    )
    if in_round is not None:
        stmt = stmt.where(member.where(RoundParticipant.round_id == in_round).exists())
    if not_in_round is not None:
        stmt = stmt.where(~member.where(RoundParticipant.round_id == not_in_round).exists())
    if sort not in INVESTOR_SORTS:
        raise ValidationFailed(
            ["query", "sort"], f"sort must be one of: {', '.join(INVESTOR_SORTS)}."
        )
    if sort == "relevance":
        # The palette's ranking: name starts with the query, then a word of the name does,
        # then the firm does, then everything else that matched; ties by name.
        qq = _escape_like((q or "").strip().lower())
        if qq:
            name = func.lower(Investor.name)
            firm = func.lower(func.coalesce(Investor.firm, ""))
            rank = case(
                (name.like(f"{qq}%", escape="\\"), 0),
                (name.like(f"% {qq}%", escape="\\"), 1),
                (firm.like(f"{qq}%", escape="\\"), 2),
                else_=3,
            )
            return stmt.order_by(rank, name, Investor.id)
        sort = "name"
    desc = (order or ("desc" if sort in ("updated", "created") else "asc")) == "desc"
    col: Any = {
        "name": func.lower(Investor.name),
        "firm": func.lower(Investor.firm),
        "updated": Investor.updated_at,
        "created": Investor.created_at,
    }[sort]
    key = col.desc().nulls_last() if desc else col.asc().nulls_last()
    return stmt.order_by(key, func.lower(Investor.name), Investor.id)


async def list_investors(
    db: AsyncSession,
    ws: WorkspaceContext,
    *,
    limit: int = 50,
    cursor: str | None = None,
    **filters: Any,
) -> tuple[list[Investor], str | None, int]:
    stmt = investors_query(ws, **filters)
    total = int(
        await db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
    )
    offset = int((decode_cursor(cursor) or {}).get("o", 0))
    rows = list(await db.scalars(stmt.offset(offset).limit(limit + 1)))
    more = len(rows) > limit
    return rows[:limit], encode_cursor({"o": offset + limit}) if more else None, total
