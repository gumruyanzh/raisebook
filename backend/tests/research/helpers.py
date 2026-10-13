"""Shared setup for the research pipeline tests (fictional data, mocked OpenRouter)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook import worker
from raisebook.core import secrets
from raisebook.core.clock import get_now
from raisebook.models.ai import CompanyProfile, WorkspaceAiSettings
from raisebook.models.investor import Investor
from raisebook.models.research import ResearchRun
from raisebook.models.round import Round
from raisebook.models.user import User
from raisebook.models.workspace import Workspace
from raisebook.services import ai_settings as ai_svc
from raisebook.services import research_jobs  # noqa: F401 (registers the handlers)
from tests.factories import (
    add_member,
    make_api_key,
    make_investor,
    make_participant,
    make_round,
    make_workspace,
    owner_of,
)
from tests.research.openrouter_mock import FAKE_KEY
from tests.research.pipeline_mock import FIRM, LINKEDIN, NAME, SITE


async def set_key(db: AsyncSession, ws: Workspace, *, cap_usd: float | None = None) -> None:
    """Store the fictional key sealed, as ``PUT …/key`` would (no ``GET /key`` call)."""
    ring = secrets.get_keyring()
    assert ring is not None
    now = get_now()
    row = await db.scalar(
        select(WorkspaceAiSettings).where(WorkspaceAiSettings.workspace_id == ws.id)
    )
    if row is None:
        row = ai_svc.default_row(ws.id)
        row.created_at = now
        db.add(row)
    sealed = secrets.seal(FAKE_KEY, aad=secrets.openrouter_aad(ws.id), ring=ring)
    row.key_ciphertext = sealed.ciphertext
    row.key_nonce = sealed.nonce
    row.key_dek_wrapped = sealed.dek_wrapped
    row.key_dek_nonce = sealed.dek_nonce
    row.key_kek_id = sealed.kek_id
    row.key_last4 = secrets.last4(FAKE_KEY)
    row.key_set_at = now
    row.updated_at = now
    if cap_usd is not None:
        row.monthly_cap_micros = round(cap_usd * 1_000_000)
    await db.flush()


@asynccontextmanager
async def _same_session(db: AsyncSession) -> AsyncIterator[AsyncSession]:
    try:
        yield db
    except BaseException:
        await db.rollback()  # back to the last savepoint, like a fresh worker session
        raise


async def run_jobs(db: AsyncSession, *, max_jobs: int = 50) -> list[str]:
    """Run queued jobs in-process on the test session (RESEARCH-PLAN §3.4)."""

    def session() -> Any:
        return _same_session(db)

    w = worker.Worker(
        session,
        handlers=dict(worker.HANDLERS),
        recovery_hooks=dict(worker.RECOVERY_HOOKS),
        lease_s=3600,  # the heartbeat never fires mid-test (it would share the session)
        worker_id="test-worker",
    )
    statuses: list[str] = []
    for _ in range(max_jobs):
        job = await w._claim("test-worker:1")
        if job is None:
            break
        statuses.append(await w.run_job(job))
    return statuses


@dataclass
class RW:
    ws: Workspace
    owner: User
    editor: User
    viewer: User
    rnd: Round
    inv: Investor
    key: str  # read+write API key
    reader: str


async def research_world(
    db: AsyncSession,
    *,
    with_key: bool = True,
    cap_usd: float | None = None,
    firm: str | None = FIRM,
    profile: bool = True,
    **investor_fields: Any,
) -> RW:
    ws = await make_workspace(db, name="Kestrel Robotics")
    owner = await owner_of(db, ws)
    editor = await add_member(db, ws, role="editor")
    viewer = await add_member(db, ws, role="viewer")
    rnd = await make_round(db, ws, name="Seed", slug="seed")
    investor_fields.setdefault("title", "Partner")
    inv = await make_investor(db, ws, name=NAME, firm=firm, **investor_fields)
    await make_participant(db, rnd, inv)
    _, key = await make_api_key(db, ws, scopes="read,write", agent_name="claude-code")
    _, reader = await make_api_key(db, ws, scopes="read")
    if with_key:
        await set_key(db, ws, cap_usd=cap_usd)
    if profile:
        db.add(
            CompanyProfile(
                workspace_id=ws.id,
                pitch="Kestrel builds autonomous forklifts for mid-size warehouses.",
                sectors=["robotics", "logistics"],
                stage="seed",
                traction=["3 paid pilots"],
                wants_lead="lead",
                check_min=250_000,
                check_max=1_000_000,
                created_at=get_now(),
                updated_at=get_now(),
            )
        )
        await db.flush()
    return RW(ws, owner, editor, viewer, rnd, inv, key, reader)


async def run_of(db: AsyncSession, run_id: Any) -> ResearchRun:
    row = await db.scalar(
        select(ResearchRun)
        .where(ResearchRun.id == run_id)
        .execution_options(populate_existing=True)
    )
    assert row is not None
    return row


async def reload(db: AsyncSession, obj: Any) -> Any:
    await db.refresh(obj)
    return obj


async def ledger(db: AsyncSession, ws: Workspace) -> tuple[int, int, int]:
    row = (
        await db.execute(
            text(
                "SELECT coalesce(sum(spent_micros), 0), coalesce(sum(reserved_micros), 0),"
                " coalesce(sum(calls), 0) FROM ai_usage_months WHERE workspace_id = :ws"
            ),
            {"ws": ws.id},
        )
    ).one()
    return int(row[0]), int(row[1]), int(row[2])


AGENT = {"X-Agent-Name": "claude-code", "X-Agent-Model": "claude-opus-5-5"}


def agent_doc(**over: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "schema_version": 1,
        "identity": {"name": NAME, "firm": FIRM, "linkedin_url": LINKEDIN, "firm_website": SITE},
        "sources": [
            {
                "id": "a1",
                "url": f"{SITE}/team/dana",
                "title": "Dana Whitfield, Partner",
                "fetched_at": "2026-10-12T10:00:00Z",
            },
            {
                "id": "a2",
                "url": "https://news.example/2026/kelpline",
                "title": "Dana Whitfield of Harbor Light Ventures backs Kelpline",
                "snippet": "Her cell: (415) 555-0142.",
                "published_at": "2026-05-02",
            },
            {"id": "a3", "url": "https://www.instagram.com/danaw.example", "title": "Dana"},
            {"id": "a4", "url": "https://news.example/other", "title": "Someone else's raise"},
        ],
        "facts": [
            {
                "key": "f1",
                "section": "profile",
                "kind": "role",
                "text": "Partner at Harbor Light.",
                "source_ids": ["a1"],
            },
            {
                "key": "f2",
                "section": "activity",
                "kind": "deal",
                "text": "Joined Kelpline's pre-seed; cell (415) 555-0142.",
                "date": "2026-05-02",
                "source_ids": ["a2"],
            },
            {
                "key": "f3",
                "section": "thesis",
                "kind": "post",
                "text": "Posts about robotics.",
                "source_ids": ["a3"],
            },
            {
                "key": "f4",
                "section": "red_flags",
                "kind": "reputation",
                "text": "Slow to reply.",
                "source_ids": [],
            },
            {
                "key": "f5",
                "section": "profile",
                "kind": "other",
                "text": "Her husband is a doctor.",
                "source_ids": ["a1"],
            },
        ],
        "analysis": {
            "brief": {
                "verdict": "possible",
                "why": "Seed robotics, smaller checks.",
                "best_way_in": "Kelpline's founders.",
                "opener": "Hi Dana",
                "risk": "Slow.",
                "fact_keys": ["f1", "f2"],
            },
            "ways_in": [
                {"text": "Kelpline's founders.", "basis": "public", "fact_keys": ["f2"]},
                {"text": "Our advisor.", "basis": "workspace", "fact_keys": []},
            ],
        },
        "suggestions": {"title": {"value": "General Partner", "fact_keys": ["f1"]}},
    }
    doc.update(over)
    return doc
