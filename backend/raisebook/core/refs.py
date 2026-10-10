"""Agent-friendly reference resolution (SPEC §6.2). Owner: API+MCP (AM) replaces this stub.

The only place that turns a user/agent reference into a row:

- investor: UUID, email, LinkedIn URL, ``"Name"`` or ``"Name @ Firm"`` (exact after
  normalization); 0 matches → ``not_found`` with suggestions, >1 → ``ambiguous_reference``.
- round: UUID, slug or name (case-insensitive); when ``required`` and omitted, the single
  open round, else ``round_required`` listing the open rounds.
- stage: a stage key or label (case-insensitive), else ``stage_not_found`` with valid keys.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.models.investor import Investor
from raisebook.models.round import Round, RoundStage


async def resolve_round(
    db: AsyncSession, ws: WorkspaceContext, ref: str | None, *, required: bool
) -> Round | None:
    raise NotImplementedError("core.refs.resolve_round is implemented by the API+MCP phase")


async def resolve_investor(db: AsyncSession, ws: WorkspaceContext, ref: str) -> Investor:
    raise NotImplementedError("core.refs.resolve_investor is implemented by the API+MCP phase")


def resolve_stage(round: Round | Any, ref: str) -> RoundStage:
    raise NotImplementedError("core.refs.resolve_stage is implemented by the API+MCP phase")
