"""Per-investor research summaries for lists, the board, Triage and ``InvestorOut``
(RESEARCH-PLAN §6.4): identity status, verdict, dossier date and freshness, pending
suggestions and the active run, in a few queries for many investors."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import WorkspaceContext
from raisebook.models.enums import IdentityStatus, SuggestionStatus
from raisebook.models.research import Dossier, FieldSuggestion, InvestorIdentity, ResearchRun

STALE_DAYS = 90
MEETING_REFRESH_DAYS = 30


async def summaries(
    db: AsyncSession,
    ws: WorkspaceContext,
    investor_ids: Sequence[UUID],
    *,
    now: datetime,
    stage_keys: Mapping[UUID, str] | None = None,
) -> dict[UUID, dict[str, Any]]:
    ids = list(dict.fromkeys(investor_ids))
    out: dict[UUID, dict[str, Any]] = {
        i: {
            "identity_status": IdentityStatus.NONE.value,
            "verdict": None,
            "dossier_at": None,
            "dossier_author": None,
            "stale": False,
            "pending_suggestions": 0,
            "active_run": None,
            "refresh_offer": False,
        }
        for i in ids
    }
    if not ids:
        return out
    for inv_id, status in (
        await db.execute(
            select(InvestorIdentity.investor_id, InvestorIdentity.status).where(
                InvestorIdentity.workspace_id == ws.workspace_id,
                InvestorIdentity.investor_id.in_(ids),
            )
        )
    ).tuples():
        out[inv_id]["identity_status"] = status
    latest = (
        select(
            Dossier.investor_id,
            Dossier.verdict,
            Dossier.created_at,
            Dossier.author_kind,
            Dossier.author_label,
        )
        .where(Dossier.workspace_id == ws.workspace_id, Dossier.investor_id.in_(ids))
        .distinct(Dossier.investor_id)
        .order_by(Dossier.investor_id, Dossier.version.desc())
    )
    for inv_id, verdict, created, kind, label in (await db.execute(latest)).tuples():
        age = (now - created).days
        row = out[inv_id]
        row["verdict"] = verdict
        row["dossier_at"] = created
        row["dossier_author"] = {"kind": kind, "label": label}
        row["stale"] = age > STALE_DAYS
        if stage_keys is not None:
            row["refresh_offer"] = (
                stage_keys.get(inv_id) == "meeting" and age > MEETING_REFRESH_DAYS
            )
    for inv_id, n in (
        await db.execute(
            select(FieldSuggestion.investor_id, func.count())
            .where(
                FieldSuggestion.workspace_id == ws.workspace_id,
                FieldSuggestion.investor_id.in_(ids),
                FieldSuggestion.status == SuggestionStatus.PENDING.value,
            )
            .group_by(FieldSuggestion.investor_id)
        )
    ).tuples():
        out[inv_id]["pending_suggestions"] = int(n)
    for run_id, run_inv, kind, status in (
        await db.execute(
            select(ResearchRun.id, ResearchRun.investor_id, ResearchRun.kind, ResearchRun.status)
            .where(
                ResearchRun.workspace_id == ws.workspace_id,
                ResearchRun.investor_id.in_(ids),
                ResearchRun.status.in_(("queued", "running")),
            )
            .order_by(ResearchRun.created_at)
        )
    ).tuples():
        if run_inv is not None:
            out[run_inv]["active_run"] = {"id": run_id, "kind": kind, "status": status}
    return out
