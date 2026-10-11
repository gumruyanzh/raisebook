"""Sample workspace (SPEC §8.5): fictional, complete, and built through the services."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.activity import Activity
from raisebook.models.investor import Investor
from raisebook.models.round import Round, RoundParticipant, RoundStage
from raisebook.services.normalize import derived_fields
from raisebook.services.sample_data import PEOPLE, SAMPLE_NAME, create_sample_workspace
from tests.factories import make_user


async def test_sample_workspace_shape(db: AsyncSession, frozen_now: Any) -> None:
    user = await make_user(db)
    ws = await create_sample_workspace(db, user=user, now=frozen_now)
    assert ws.is_sandbox and ws.name == SAMPLE_NAME

    rounds = {r.name: r for r in await db.scalars(select(Round).where(Round.workspace_id == ws.id))}
    assert rounds["Pre-seed"].status == "closed" and rounds["Pre-seed"].closed_on is not None
    seed = rounds["Seed"]
    assert seed.status == "open" and seed.target_amount == 2_000_000

    investors = list(await db.scalars(select(Investor).where(Investor.workspace_id == ws.id)))
    assert len(investors) == len(PEOPLE) == 40
    for inv in investors:
        assert inv.email is None or str(inv.email).split("@")[1].endswith("example.com")
        assert inv.linkedin_url is None or "/in/example-" in inv.linkedin_url
        # Derived columns are exactly what the services compute.
        state = {
            f: getattr(inv, f)
            for f in (
                "name",
                "firm",
                "title",
                "email",
                "location",
                "tags",
                "industries",
                "stage_focus",
                "source",
                "warm_intro_by",
                "notes",
                "linkedin_url",
            )
        }
        state["email"] = str(inv.email) if inv.email else None
        assert inv.search_text == derived_fields(state)["search_text"]

    # Seed: every stage used, three commitments, a stale active conversation.
    parts = (
        await db.execute(
            select(RoundParticipant, RoundStage)
            .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
            .where(RoundParticipant.round_id == seed.id)
        )
    ).all()
    assert len(parts) == 40
    assert {st.key for _, st in parts} == {
        "new",
        "research",
        "contacted",
        "replied",
        "meeting",
        "dd",
        "committed",
        "passed",
    }
    won = [p for p, st in parts if st.kind == "won"]
    assert len(won) == 3 and all(p.amount_committed for p in won)
    stale = [
        p
        for p, st in parts
        if st.kind == "active"
        and p.last_activity_at is not None
        and frozen_now - p.last_activity_at >= timedelta(days=14)
    ]
    assert stale
    today = frozen_now.date()
    follows = [p.follow_up_on for p, _ in parts if p.follow_up_on]
    assert any(d < today for d in follows) and any(d == today for d in follows)
    assert any(today < d <= today + timedelta(days=7) for d in follows)

    # Timelines mix user, agent (with model) and system actors.
    kinds = set(
        (
            await db.execute(
                select(Activity.actor_type, Activity.actor_label, Activity.agent_model)
                .where(Activity.workspace_id == ws.id)
                .distinct()
            )
        ).tuples()
    )
    assert ("agent", "claude-code", "claude-opus-4-5") in kinds
    assert ("system", "raisebook", None) in kinds
    assert any(t == "user" for t, _, _ in kinds)
    n_kinds = set(
        await db.scalars(select(Activity.kind).where(Activity.workspace_id == ws.id).distinct())
    )
    assert {
        "investor_created",
        "added_to_round",
        "stage_change",
        "commitment",
        "follow_up_set",
        "email",
        "meeting",
        "note",
    } <= n_kinds
    assert (
        await db.scalar(
            select(func.count()).select_from(Activity).where(Activity.workspace_id == ws.id)
        )
        > 150
    )


async def test_sample_data_reads_like_a_real_raise(db: AsyncSession, frozen_now: Any) -> None:
    """Review fix: plausible soft-circle, varied notes and times, contacts predate history."""
    user = await make_user(db)
    ws = await create_sample_workspace(db, user=user, now=frozen_now)
    seed = await db.scalar(select(Round).where(Round.workspace_id == ws.id, Round.name == "Seed"))
    assert seed is not None
    rows = (
        await db.execute(
            select(RoundParticipant, RoundStage)
            .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
            .where(RoundParticipant.round_id == seed.id)
        )
    ).tuples()
    parts = list(rows)
    soft = sum(p.amount_soft or 0 for p, st in parts if st.kind in ("open", "active"))
    assert 1.5 * seed.target_amount <= soft <= 2.5 * seed.target_amount, soft
    notes = {p.follow_up_note for p, _ in parts if p.follow_up_note}
    assert len(notes) >= 8
    acts = list(await db.scalars(select(Activity).where(Activity.workspace_id == ws.id)))
    times = {a.occurred_at.astimezone().strftime("%H:%M") for a in acts}
    assert len(times) >= 10
    first: dict[Any, Any] = {}
    for a in acts:
        if a.investor_id not in first or a.occurred_at < first[a.investor_id]:
            first[a.investor_id] = a.occurred_at
    for inv in await db.scalars(select(Investor).where(Investor.workspace_id == ws.id)):
        assert inv.created_at <= first[inv.id], inv.name
