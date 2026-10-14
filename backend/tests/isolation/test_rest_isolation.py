"""Workspace isolation over REST (SPEC §8.4, §9.2.3). Owner: API+MCP (AM).

Two workspaces, A and B, both with data. For **every** ``/v1`` route (enumerated from
``app.routes``, so a new route without a case here fails :func:`test_every_route_is_covered`),
a principal of A (owner session and admin API key) addressing B's ids, slugs or references
gets 404 ``not_found`` (or ``workspace_not_found``), lists never contain B's rows, searches
for B's names find nothing, creates land in A, and B's data is unchanged afterwards.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date
from typing import Any

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.models.activity import Activity
from raisebook.models.ai import CompanyProfile, WorkspaceAiSettings
from raisebook.models.investor import Investor
from raisebook.models.meeting import Meeting
from raisebook.models.research import (
    Dossier,
    DossierFacts,
    FieldSuggestion,
    InvestorIdentity,
    InvestorIdentityCandidate,
    ResearchBatch,
    ResearchRun,
    ResearchSource,
)
from raisebook.models.round import Round, RoundParticipant, RoundStage
from raisebook.models.workspace import ApiKey, Invite, Membership, Workspace
from tests.factories import (
    add_member,
    make_activity,
    make_api_key,
    make_investor,
    make_invite,
    make_participant,
    make_round,
    make_workspace,
    owner_of,
)

# Routes that are not workspace-scoped (anonymous, or the caller's own account).
ORGLESS = {
    ("GET", "/healthz"),
    ("GET", "/healthz/ready"),
    ("POST", "/v1/auth/magic-link"),
    ("POST", "/v1/auth/verify"),
    ("GET", "/v1/auth/verify/peek"),
    ("GET", "/v1/auth/providers"),
    ("GET", "/v1/auth/google/start"),
    ("GET", "/v1/auth/google/callback"),
    ("GET", "/v1/me/sessions"),
    ("DELETE", "/v1/me/sessions/{session_id}"),
    ("POST", "/v1/me/sessions/revoke-others"),
    ("GET", "/v1/auth/session"),
    ("POST", "/v1/auth/signout"),
    ("GET", "/v1/me"),
    ("PATCH", "/v1/me"),
    ("DELETE", "/v1/me"),
    ("GET", "/v1/workspaces"),
    ("POST", "/v1/workspaces"),
    ("GET", "/v1/invites/lookup"),
    ("POST", "/v1/invites/accept"),
    # The Research Policy's public removal process (anonymous; R13).
    ("POST", "/v1/research-policy/removal-requests"),
    ("POST", "/v1/research-policy/removal-requests/verify"),
    # The caller's own calendar feed (session only), and the feed itself (its token is the
    # credential; it covers only the token owner's memberships: tests/test_meetings.py).
    ("GET", "/v1/me/calendar-feed"),
    ("POST", "/v1/me/calendar-feed"),
    ("DELETE", "/v1/me/calendar-feed"),
    ("GET", "/v1/calendar/{token}.ics"),
}

B_EMAIL = "blake.quill@example.com"
B_LINKEDIN = "https://www.linkedin.com/in/example-blake-quill"
B_NAME = "Blake Quill"
B_PITCH = "Bravo secret pitch for quill robots"
B_DOSSIER = "Bravo secret dossier verdict line"
B_SOURCE = "https://quill.example/bravo-secret-source"
B_MEETING = "Bravo secret partner meeting"


@dataclass
class Ref:
    id: Any
    slug: str = ""
    name: str = ""


@dataclass
class Two:
    """Plain ids and names (no ORM objects, so nothing lazy-loads after a request)."""

    a: Ref
    b: Ref
    a_owner: Any  # User, used once to open the session client
    a_owner_id: Any
    a_key: str  # read+write+admin
    a_round: Ref
    a_inv: Ref
    b_owner: Ref
    b_member: Ref
    b_round: Ref
    b_inv: Ref
    b_activity: Ref
    b_invite: Ref
    b_key: Ref
    b_run: Ref
    b_batch: Ref
    b_suggestion: Ref
    b_candidate: Ref
    b_meeting: Ref


async def two_workspaces(db: AsyncSession) -> Two:
    a = await make_workspace(db, name="Alpha Robotics")
    b = await make_workspace(db, name="Bravo Labs")
    a_owner = await owner_of(db, a)
    _, a_key = await make_api_key(db, a, scopes="read,write,admin")
    a_round = await make_round(db, a, name="Seed", slug="seed")
    a_inv = await make_investor(db, a, name="Avery Lane", firm="Alpha Partners")
    await make_participant(db, a_round, a_inv)
    b_owner = await owner_of(db, b)
    b_member = await add_member(db, b, role="editor")
    b_round = await make_round(db, b, name="Bravo Seed", slug="bravo-seed")
    b_inv = await make_investor(
        db,
        b,
        name=B_NAME,
        firm="Quill Ventures",
        email=B_EMAIL,
        linkedin_url=B_LINKEDIN,
        tags=["secret-tag"],
        notes="B's private notes",
    )
    b_inv.search_text = "blake quill quill ventures secret-tag b's private notes"
    await make_participant(
        db, b_round, b_inv, stage="meeting", fit=5, follow_up_on=date(2026, 1, 1)
    )
    b_activity = await make_activity(db, b_inv, rnd=b_round, body="B's call notes")
    b_invite, _ = await make_invite(db, b)
    b_key, _ = await make_api_key(db, b)
    db.add(CompanyProfile(workspace_id=b.id, pitch=B_PITCH, sectors=["bravo-sector"]))
    db.add(
        WorkspaceAiSettings(
            workspace_id=b.id,
            preset="budget",
            identity_model="perplexity/sonar",
            search_model="perplexity/sonar",
            writer_model="google/gemini-3.8-flash",
            monthly_cap_micros=77_000_000,
        )
    )
    await db.flush()
    b_research = await _b_research(db, b, b_inv, b_round)
    b_meeting = await _b_meeting(db, b, b_inv, b_round)
    return Two(
        a=Ref(a.id, str(a.slug), a.name),
        b=Ref(b.id, str(b.slug), b.name),
        a_owner=a_owner,
        a_owner_id=a_owner.id,
        a_key=a_key,
        a_round=Ref(a_round.id, str(a_round.slug), a_round.name),
        a_inv=Ref(a_inv.id, name=a_inv.name),
        b_owner=Ref(b_owner.id),
        b_member=Ref(b_member.id),
        b_round=Ref(b_round.id, str(b_round.slug), b_round.name),
        b_inv=Ref(b_inv.id, name=b_inv.name),
        b_activity=Ref(b_activity.id),
        b_invite=Ref(b_invite.id),
        b_key=Ref(b_key.id),
        b_meeting=b_meeting,
        **b_research,
    )


async def _b_meeting(db: AsyncSession, b: Any, b_inv: Any, b_round: Any) -> Ref:
    from datetime import UTC, datetime

    from raisebook.models.meeting import Meeting

    m = Meeting(
        workspace_id=b.id,
        investor_id=b_inv.id,
        round_id=b_round.id,
        title=B_MEETING,
        starts_at=datetime(2026, 10, 13, 18, 0, tzinfo=UTC),
        ends_at=datetime(2026, 10, 13, 18, 30, tzinfo=UTC),
        timezone="UTC",
        location="Bravo HQ",
        actor_type="system",
        actor_label="raisebook",
        via="system",
    )
    db.add(m)
    await db.flush()
    return Ref(m.id)


async def _b_research(db: AsyncSession, b: Any, b_inv: Any, b_round: Any) -> dict[str, Ref]:
    """B's research rows: a batch, a finished run, a dossier, a source, a pending suggestion
    and identity candidates (what A must never see or change)."""
    actor = {"actor_type": "system", "via": "system", "actor_label": "raisebook"}
    batch = ResearchBatch(workspace_id=b.id, kind="dossier", total=1, **actor)
    db.add(batch)
    await db.flush()
    run = ResearchRun(
        workspace_id=b.id,
        investor_id=b_inv.id,
        batch_id=batch.id,
        kind="dossier",
        status="partial",
        error_code="invalid_dossier",
        **actor,
    )
    db.add(run)
    await db.flush()
    src = ResearchSource(
        workspace_id=b.id,
        run_id=run.id,
        investor_id=b_inv.id,
        url=B_SOURCE,
        url_key=B_SOURCE,
        domain="quill.example",
        title="Bravo source",
        fetched_at=run.created_at,
        matched_anchor="firm_domain",
        accepted=True,
    )
    db.add(src)
    dossier = Dossier(
        workspace_id=b.id,
        investor_id=b_inv.id,
        run_id=run.id,
        version=1,
        author_kind="model",
        author_label="anthropic/claude-opus-5.5",
        verdict="strong",
        analysis={"brief": {"verdict": "strong", "why": B_DOSSIER, "fact_keys": []}},
        **actor,
    )
    db.add(dossier)
    await db.flush()
    db.add(
        DossierFacts(
            dossier_id=dossier.id,
            workspace_id=b.id,
            investor_id=b_inv.id,
            facts=[
                {
                    "key": "f1",
                    "section": "profile",
                    "kind": "role",
                    "text": B_DOSSIER,
                    "source_ids": [str(src.id)],
                }
            ],
            as_of=run.created_at.date(),
        )
    )
    sug = FieldSuggestion(
        workspace_id=b.id,
        investor_id=b_inv.id,
        dossier_id=dossier.id,
        field="title",
        current_value=None,
        suggested_value="Bravo GP",
    )
    db.add(sug)
    db.add(InvestorIdentity(workspace_id=b.id, investor_id=b_inv.id, status="needs_pick"))
    cand = InvestorIdentityCandidate(
        workspace_id=b.id,
        investor_id=b_inv.id,
        run_id=run.id,
        rank=1,
        name=B_NAME,
        linkedin_url=B_LINKEDIN,
        confidence=0.6,
    )
    db.add(cand)
    await db.flush()
    return {
        "b_run": Ref(run.id),
        "b_batch": Ref(batch.id),
        "b_suggestion": Ref(sug.id),
        "b_candidate": Ref(cand.id),
    }


async def snapshot_b(db: AsyncSession, t: Two) -> dict[str, Any]:
    """Everything of B that a leak or a cross-workspace write could change."""
    wid = t.b.id

    async def rows(stmt: Any) -> list[Any]:
        return [tuple(r) for r in (await db.execute(stmt)).all()]

    return {
        "workspace": await rows(
            select(Workspace.name, Workspace.timezone).where(Workspace.id == wid)
        ),
        "members": await rows(
            select(Membership.user_id, Membership.role)
            .where(Membership.workspace_id == wid)
            .order_by(Membership.user_id)
        ),
        "invites": await rows(
            select(Invite.id, Invite.revoked_at)
            .where(Invite.workspace_id == wid)
            .order_by(Invite.id)
        ),
        "keys": await rows(
            select(ApiKey.id, ApiKey.revoked_at)
            .where(ApiKey.workspace_id == wid)
            .order_by(ApiKey.id)
        ),
        "rounds": await rows(
            select(Round.id, Round.name, Round.slug, Round.status, Round.updated_at)
            .where(Round.workspace_id == wid)
            .order_by(Round.id)
        ),
        "stages": await rows(
            select(
                RoundStage.id,
                RoundStage.key,
                RoundStage.label,
                RoundStage.kind,
                RoundStage.position,
            )
            .where(RoundStage.workspace_id == wid)
            .order_by(RoundStage.id)
        ),
        "investors": await rows(
            select(
                Investor.id,
                Investor.name,
                Investor.title,
                Investor.email,
                Investor.tags,
                Investor.notes,
                Investor.updated_at,
            )
            .where(Investor.workspace_id == wid)
            .order_by(Investor.id)
        ),
        "participants": await rows(
            select(
                RoundParticipant.id,
                RoundParticipant.stage_id,
                RoundParticipant.fit,
                RoundParticipant.follow_up_on,
                RoundParticipant.amount_committed,
                RoundParticipant.updated_at,
            )
            .where(RoundParticipant.workspace_id == wid)
            .order_by(RoundParticipant.id)
        ),
        "activities": await rows(
            select(Activity.id).where(Activity.workspace_id == wid).order_by(Activity.id)
        ),
        "company_profile": await rows(
            select(CompanyProfile.pitch, CompanyProfile.sectors, CompanyProfile.updated_at).where(
                CompanyProfile.workspace_id == wid
            )
        ),
        "research": await rows(
            select(ResearchRun.id, ResearchRun.status, ResearchRun.updated_at)
            .where(ResearchRun.workspace_id == wid)
            .order_by(ResearchRun.id)
        )
        + await rows(
            select(Dossier.id, Dossier.version, Dossier.verdict)
            .where(Dossier.workspace_id == wid)
            .order_by(Dossier.id)
        )
        + await rows(
            select(FieldSuggestion.id, FieldSuggestion.status)
            .where(FieldSuggestion.workspace_id == wid)
            .order_by(FieldSuggestion.id)
        )
        + await rows(
            select(InvestorIdentity.status, InvestorIdentity.linkedin_url).where(
                InvestorIdentity.workspace_id == wid
            )
        ),
        "meetings": await rows(
            select(
                Meeting.id,
                Meeting.title,
                Meeting.status,
                Meeting.starts_at,
                Meeting.outcome,
                Meeting.updated_at,
            )
            .where(Meeting.workspace_id == wid)
            .order_by(Meeting.id)
        ),
        "ai_settings": await rows(
            select(
                WorkspaceAiSettings.preset,
                WorkspaceAiSettings.writer_model,
                WorkspaceAiSettings.monthly_cap_micros,
                WorkspaceAiSettings.key_last4,
                WorkspaceAiSettings.updated_at,
            ).where(WorkspaceAiSettings.workspace_id == wid)
        ),
    }


def no_b(text: str, t: Two) -> None:
    """A response body never mentions B's rows."""
    for marker in (
        str(t.b.id),
        str(t.b_inv.id),
        str(t.b_round.id),
        str(t.b_activity.id),
        str(t.b_key.id),
        str(t.b_invite.id),
        B_NAME,
        B_EMAIL,
        "Bravo Seed",
        "secret-tag",
        "B's call notes",
        B_PITCH,
        "bravo-sector",
        B_DOSSIER,
        B_SOURCE,
        str(t.b_run.id),
        str(t.b_batch.id),
        str(t.b_suggestion.id),
        str(t.b_candidate.id),
        "Bravo GP",
        B_MEETING,
        str(t.b_meeting.id),
    ):
        assert marker not in text, f"leaked {marker!r}: {text[:300]}"


def is_404(r: Any) -> None:
    assert r.status_code == 404, (r.status_code, r.text)
    assert r.json()["error"]["code"] in ("not_found", "workspace_not_found"), r.text


Case = Callable[[Any, Two, str], Awaitable[None]]
CASES: dict[tuple[str, str], Case] = {}


def case(method: str, path: str) -> Callable[[Case], Case]:
    def deco(fn: Case) -> Case:
        CASES[(method, path)] = fn
        return fn

    return deco


# --- workspace, members, invites, API keys (Foundation routes) ---------------------------


@case("GET", "/v1/workspace")
async def _ws_get(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/workspace", headers={"X-Workspace": t.b.slug} if who == "key" else {})
    assert r.json()["id"] == str(t.a.id)
    if who == "session":
        is_404(await c.get("/v1/workspace", headers={"X-Workspace": t.b.slug}))


@case("PATCH", "/v1/workspace")
async def _ws_patch(c: Any, t: Two, who: str) -> None:
    if who == "session":
        is_404(
            await c.patch("/v1/workspace", json={"name": "X"}, headers={"X-Workspace": str(t.b.id)})
        )
    else:
        r = await c.patch(
            "/v1/workspace", json={"name": "Alpha 2"}, headers={"X-Workspace": t.b.slug}
        )
        assert r.json()["id"] == str(t.a.id)


@case("DELETE", "/v1/workspace")
async def _ws_delete(c: Any, t: Two, who: str) -> None:
    r = await c.request(
        "DELETE", "/v1/workspace", json={"confirm": t.b.slug}, headers={"X-Workspace": t.b.slug}
    )
    if who == "session":
        is_404(r)
    else:
        assert r.status_code == 403  # keys can never delete a workspace


@case("GET", "/v1/members")
async def _members(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/members")
    assert r.status_code == 200
    assert {m["user_id"] for m in r.json()["data"]} == {str(t.a_owner_id)}
    assert str(t.b_member.id) not in r.text and str(t.b_owner.id) not in r.text


@case("PATCH", "/v1/members/{user_id}")
async def _member_patch(c: Any, t: Two, who: str) -> None:
    r = await c.patch(f"/v1/members/{t.b_member.id}", json={"role": "viewer"})
    is_404(r) if who == "session" else None
    assert r.status_code in (403, 404)


@case("DELETE", "/v1/members/{user_id}")
async def _member_delete(c: Any, t: Two, who: str) -> None:
    r = await c.delete(f"/v1/members/{t.b_member.id}")
    is_404(r) if who == "session" else None
    assert r.status_code in (403, 404)


@case("GET", "/v1/invites")
async def _invites(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/invites")
    assert r.status_code == 200
    no_b(r.text, t)


@case("POST", "/v1/invites")
async def _invite_create(c: Any, t: Two, who: str) -> None:
    r = await c.post("/v1/invites", json={"email": "new.person@example.com", "role": "viewer"})
    assert r.status_code in (201, 403)
    no_b(r.text, t)


@case("DELETE", "/v1/invites/{invite_id}")
async def _invite_delete(c: Any, t: Two, who: str) -> None:
    r = await c.delete(f"/v1/invites/{t.b_invite.id}")
    is_404(r) if who == "session" else None
    assert r.status_code in (403, 404)


@case("GET", "/v1/api-keys")
async def _keys(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/api-keys")
    assert r.status_code == 200
    no_b(r.text, t)


@case("POST", "/v1/api-keys")
async def _key_create(c: Any, t: Two, who: str) -> None:
    r = await c.post("/v1/api-keys", json={"name": "x", "scopes": ["raisebook:read"]})
    assert r.status_code in (201, 403)
    no_b(r.text, t)


@case("DELETE", "/v1/api-keys/{key_id}")
async def _key_delete(c: Any, t: Two, who: str) -> None:
    r = await c.delete(f"/v1/api-keys/{t.b_key.id}")
    is_404(r) if who == "session" else None
    assert r.status_code in (403, 404)


# --- rounds ------------------------------------------------------------------------------


def b_round_refs(t: Two) -> list[str]:
    return [str(t.b_round.slug), str(t.b_round.id), t.b_round.name]


@case("GET", "/v1/rounds")
async def _rounds(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/rounds", params={"status": "all"})
    assert [x["slug"] for x in r.json()["data"]] == ["seed"]
    no_b(r.text, t)


@case("POST", "/v1/rounds")
async def _round_create(c: Any, t: Two, who: str) -> None:
    # B's round name is free in A: no duplicate leak.
    r = await c.post("/v1/rounds", json={"name": t.b_round.name})
    assert r.status_code == 201, r.text
    assert r.json()["slug"] == "bravo-seed" and r.json()["id"] != str(t.b_round.id)


@case("GET", "/v1/rounds/{round}")
async def _round_get(c: Any, t: Two, who: str) -> None:
    for ref in b_round_refs(t):
        is_404(await c.get(f"/v1/rounds/{ref}"))


@case("PATCH", "/v1/rounds/{round}")
async def _round_patch(c: Any, t: Two, who: str) -> None:
    for ref in b_round_refs(t):
        is_404(await c.patch(f"/v1/rounds/{ref}", json={"status": "closed", "name": "Hacked"}))


@case("DELETE", "/v1/rounds/{round}")
async def _round_delete(c: Any, t: Two, who: str) -> None:
    for ref in b_round_refs(t):
        is_404(await c.request("DELETE", f"/v1/rounds/{ref}", json={"confirm": t.b_round.name}))


@case("PUT", "/v1/rounds/{round}/stages")
async def _stages(c: Any, t: Two, who: str) -> None:
    stages = [
        {"label": "A", "color": "slate", "kind": "open"},
        {"label": "W", "color": "green", "kind": "won"},
        {"label": "L", "color": "gray", "kind": "lost"},
    ]
    is_404(await c.put(f"/v1/rounds/{t.b_round.slug}/stages", json={"stages": stages}))


@case("GET", "/v1/rounds/{round}/summary")
async def _summary(c: Any, t: Two, who: str) -> None:
    is_404(await c.get(f"/v1/rounds/{t.b_round.id}/summary"))
    r = await c.get("/v1/rounds/seed/summary")
    assert r.status_code == 200
    no_b(r.text, t)


@case("GET", "/v1/rounds/{round}/export")
async def _round_export(c: Any, t: Two, who: str) -> None:
    for fmt in ("csv", "json"):
        is_404(await c.get(f"/v1/rounds/{t.b_round.slug}/export", params={"format": fmt}))
    r = await c.get("/v1/rounds/seed/export", params={"format": "json"})
    assert r.status_code == 200
    no_b(r.text, t)


# --- participants ------------------------------------------------------------------------


def part_paths(t: Two, suffix: str = "") -> list[str]:
    """A's round with B's investor, and B's round with A's/B's investor."""
    return [
        f"/v1/rounds/seed/participants/{t.b_inv.id}{suffix}",
        f"/v1/rounds/{t.b_round.slug}/participants/{t.a_inv.id}{suffix}",
        f"/v1/rounds/{t.b_round.id}/participants/{t.b_inv.id}{suffix}",
    ]


@case("GET", "/v1/rounds/{round}/participants")
async def _parts(c: Any, t: Two, who: str) -> None:
    is_404(await c.get(f"/v1/rounds/{t.b_round.slug}/participants"))
    r = await c.get("/v1/rounds/seed/participants", params={"q": "blake"})
    assert r.json()["total"] == 0


@case("POST", "/v1/rounds/{round}/participants")
async def _part_add(c: Any, t: Two, who: str) -> None:
    is_404(await c.post("/v1/rounds/seed/participants", json={"investor_id": str(t.b_inv.id)}))
    is_404(
        await c.post(
            f"/v1/rounds/{t.b_round.slug}/participants", json={"investor_id": str(t.a_inv.id)}
        )
    )
    # B's member as owner of an A participant is refused without leaking.
    r = await c.post(
        "/v1/rounds/seed/participants",
        json={"investor_id": str(t.a_inv.id), "owner_user_id": str(t.b_member.id)},
    )
    assert r.status_code == 422


@case("POST", "/v1/rounds/{round}/participants/bulk")
async def _part_bulk(c: Any, t: Two, who: str) -> None:
    is_404(
        await c.post("/v1/rounds/seed/participants/bulk", json={"investor_ids": [str(t.b_inv.id)]})
    )
    is_404(
        await c.post(
            f"/v1/rounds/{t.b_round.slug}/participants/bulk",
            json={"investor_ids": [str(t.a_inv.id)]},
        )
    )


@case("POST", "/v1/rounds/{round}/participants/bulk-update")
async def _part_bulk_update(c: Any, t: Two, who: str) -> None:
    url = "/v1/rounds/seed/participants/bulk-update"
    # B's investor (alone, or mixed with A's) is 404 for the whole request.
    for ids in ([str(t.b_inv.id)], [str(t.a_inv.id), str(t.b_inv.id)]):
        is_404(await c.post(url, json={"op": "stage", "investor_ids": ids, "stage": "passed"}))
        is_404(await c.post(url, json={"op": "add_tag", "investor_ids": ids, "tag": "x"}))
        is_404(await c.post(url, json={"op": "remove", "investor_ids": ids}))
    is_404(
        await c.post(
            url, json={"op": "restore", "items": [{"investor_id": str(t.b_inv.id), "fit": 1}]}
        )
    )
    # B's round with A's investor, by slug and by id.
    for rnd in (t.b_round.slug, t.b_round.id):
        is_404(
            await c.post(
                f"/v1/rounds/{rnd}/participants/bulk-update",
                json={"op": "fit", "investor_ids": [str(t.a_inv.id)], "fit": 1},
            )
        )
    # B's member as the owner is refused without leaking, and A's row is unchanged.
    r = await c.post(
        url,
        json={
            "op": "owner",
            "investor_ids": [str(t.a_inv.id)],
            "owner_user_id": str(t.b_member.id),
        },
    )
    assert r.status_code == 422
    no_b(r.text, t)


@case("GET", "/v1/rounds/{round}/participants/{investor_id}")
async def _part_get(c: Any, t: Two, who: str) -> None:
    for p in part_paths(t):
        is_404(await c.get(p))


@case("PATCH", "/v1/rounds/{round}/participants/{investor_id}")
async def _part_patch(c: Any, t: Two, who: str) -> None:
    for p in part_paths(t):
        is_404(await c.patch(p, json={"fit": 1, "stage": "passed"}))


@case("DELETE", "/v1/rounds/{round}/participants/{investor_id}")
async def _part_delete(c: Any, t: Two, who: str) -> None:
    for p in part_paths(t):
        is_404(await c.delete(p))


@case("POST", "/v1/rounds/{round}/participants/{investor_id}/stage")
async def _part_stage(c: Any, t: Two, who: str) -> None:
    for p in part_paths(t, "/stage"):
        is_404(await c.post(p, json={"stage": "passed"}))


@case("POST", "/v1/rounds/{round}/participants/{investor_id}/follow-up")
async def _part_fu(c: Any, t: Two, who: str) -> None:
    for p in part_paths(t, "/follow-up"):
        is_404(await c.post(p, json={"clear": True}))


@case("POST", "/v1/rounds/{round}/participants/{investor_id}/commitment")
async def _part_commit(c: Any, t: Two, who: str) -> None:
    for p in part_paths(t, "/commitment"):
        is_404(await c.post(p, json={"amount": 1}))


@case("GET", "/v1/follow-ups")
async def _follow_ups(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/follow-ups", params={"within_days": 60})
    assert r.status_code == 200
    no_b(r.text, t)
    is_404(await c.get("/v1/follow-ups", params={"round": t.b_round.slug}))


# --- investors ---------------------------------------------------------------------------


@case("GET", "/v1/investors")
async def _investors(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/investors")
    assert [x["id"] for x in r.json()["data"]] == [str(t.a_inv.id)]
    no_b(r.text, t)
    for q in ("Blake", "quill", "secret-tag", "private notes", B_EMAIL):
        assert (await c.get("/v1/investors", params={"q": q})).json()["total"] == 0
    assert (await c.get("/v1/investors", params={"tag": "secret-tag"})).json()["total"] == 0
    is_404(await c.get("/v1/investors", params={"round": t.b_round.slug}))
    is_404(await c.get("/v1/investors", params={"not_in_round": str(t.b_round.id)}))


@case("POST", "/v1/investors")
async def _investor_create(c: Any, t: Two, who: str) -> None:
    # B's email/LinkedIn are not duplicates in A: no match against B, a new A contact.
    r = await c.post(
        "/v1/investors", json={"name": B_NAME, "email": B_EMAIL, "linkedin_url": B_LINKEDIN}
    )
    assert r.status_code == 201, r.text
    assert r.json()["created"] is True and r.json()["investor"]["id"] != str(t.b_inv.id)


@case("GET", "/v1/investors/resolve")
async def _resolve(c: Any, t: Two, who: str) -> None:
    for ref in (str(t.b_inv.id), B_EMAIL, B_LINKEDIN, B_NAME, f"{B_NAME} @ Quill"):
        r = await c.get("/v1/investors/resolve", params={"ref": ref})
        is_404(r)
        # The error echoes the reference; suggestions come from A only.
        sugg = r.json()["error"]["details"].get("suggestions", [])
        assert {x["id"] for x in sugg} <= {str(t.a_inv.id)}, sugg


@case("GET", "/v1/investors/{investor_id}")
async def _investor_get(c: Any, t: Two, who: str) -> None:
    is_404(await c.get(f"/v1/investors/{t.b_inv.id}"))


@case("PATCH", "/v1/investors/{investor_id}")
async def _investor_patch(c: Any, t: Two, who: str) -> None:
    is_404(await c.patch(f"/v1/investors/{t.b_inv.id}", json={"title": "Hacked"}))
    # Taking B's email in A is allowed (A has no such contact): no cross-workspace conflict.
    r = await c.patch(f"/v1/investors/{t.a_inv.id}", json={"email": B_EMAIL})
    assert r.status_code == 200, r.text


@case("DELETE", "/v1/investors/{investor_id}")
async def _investor_delete(c: Any, t: Two, who: str) -> None:
    is_404(await c.delete(f"/v1/investors/{t.b_inv.id}"))


@case("GET", "/v1/investors/export")
async def _investors_export(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/investors/export")
    assert r.status_code == 200
    no_b(r.text, t)
    r = await c.get("/v1/investors/export", params={"ids": [str(t.b_inv.id)]})
    assert r.status_code in (200, 404)
    no_b(r.text, t)


@case("GET", "/v1/export")
async def _workspace_export(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/export", params={"format": "json"})
    assert r.status_code == 200
    no_b(r.text, t)


# --- activities --------------------------------------------------------------------------


@case("GET", "/v1/activities")
async def _activities(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/activities")
    assert r.status_code == 200
    no_b(r.text, t)
    is_404(await c.get("/v1/activities", params={"investor_id": str(t.b_inv.id)}))
    is_404(await c.get("/v1/activities", params={"round": t.b_round.slug}))


@case("POST", "/v1/activities")
async def _activity_create(c: Any, t: Two, who: str) -> None:
    is_404(
        await c.post(
            "/v1/activities", json={"investor_id": str(t.b_inv.id), "kind": "note", "body": "x"}
        )
    )
    is_404(
        await c.post(
            "/v1/activities",
            json={
                "investor_id": str(t.a_inv.id),
                "kind": "note",
                "body": "x",
                "round": t.b_round.slug,
            },
        )
    )


@case("DELETE", "/v1/activities/{activity_id}")
async def _activity_delete(c: Any, t: Two, who: str) -> None:
    is_404(await c.delete(f"/v1/activities/{t.b_activity.id}"))


# --- imports -----------------------------------------------------------------------------


def csv_with_b() -> str:
    return f"Name,Email,LinkedIn\n{B_NAME},{B_EMAIL},{B_LINKEDIN}\n"


@case("POST", "/v1/imports/preview")
async def _import_preview(c: Any, t: Two, who: str) -> None:
    r = await c.post("/v1/imports/preview", json={"format": "csv", "content": csv_with_b()})
    assert r.status_code == 200, r.text
    assert r.json()["counts"]["create"] == 1  # B's contact is not a match in A
    no_b(r.text.replace(B_NAME, "").replace(B_EMAIL, "").replace("example-blake-quill", ""), t)
    is_404(
        await c.post(
            "/v1/imports/preview",
            json={"format": "csv", "content": csv_with_b(), "round": t.b_round.slug},
        )
    )


@case("POST", "/v1/imports")
async def _import_commit(c: Any, t: Two, who: str) -> None:
    is_404(
        await c.post(
            "/v1/imports", json={"format": "csv", "content": csv_with_b(), "round": t.b_round.slug}
        )
    )
    r = await c.post("/v1/imports", json={"format": "csv", "content": csv_with_b()})
    assert r.status_code == 200, r.text
    assert r.json()["counts"]["created"] == 1


@case("GET", "/v1/imports")
async def _import_runs(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/imports")
    assert r.status_code == 200
    no_b(r.text, t)


# --- investor research: AI settings and company profile (Part 1) ------------------------


def _mock_openrouter() -> None:
    from raisebook.services import openrouter
    from tests.research.openrouter_mock import OpenRouterMock

    openrouter.set_transport(OpenRouterMock().transport)  # reset by the autouse guard


@case("GET", "/v1/workspace/ai-settings")
async def _ai_get(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/workspace/ai-settings")
    assert r.status_code == 200, r.text
    assert r.json()["monthly_cap_usd"] == 25.0 and r.json()["preset"] == "best"
    no_b(r.text, t)
    if who == "session":
        is_404(await c.get("/v1/workspace/ai-settings", headers={"X-Workspace": t.b.slug}))


@case("PATCH", "/v1/workspace/ai-settings")
async def _ai_patch(c: Any, t: Two, who: str) -> None:
    if who == "session":
        is_404(
            await c.patch(
                "/v1/workspace/ai-settings",
                json={"monthly_cap_usd": 1},
                headers={"X-Workspace": t.b.slug},
            )
        )
    r = await c.patch("/v1/workspace/ai-settings", json={"monthly_cap_usd": 12})
    assert r.status_code == 200 and r.json()["monthly_cap_usd"] == 12.0, r.text
    no_b(r.text, t)


@case("PUT", "/v1/workspace/ai-settings/key")
async def _ai_key_put(c: Any, t: Two, who: str) -> None:
    from tests.research.openrouter_mock import FAKE_KEY

    _mock_openrouter()
    if who == "session":
        is_404(
            await c.put(
                "/v1/workspace/ai-settings/key",
                json={"key": FAKE_KEY},
                headers={"X-Workspace": t.b.slug},
            )
        )
    r = await c.put("/v1/workspace/ai-settings/key", json={"key": FAKE_KEY})
    if who == "session":
        assert r.status_code == 200 and r.json()["key_last4"] == FAKE_KEY[-4:], r.text
    else:
        assert r.status_code == 403  # only an owner signed in to the web sets the key
    assert FAKE_KEY not in r.text
    no_b(r.text, t)


@case("DELETE", "/v1/workspace/ai-settings/key")
async def _ai_key_delete(c: Any, t: Two, who: str) -> None:
    if who == "session":
        is_404(await c.delete("/v1/workspace/ai-settings/key", headers={"X-Workspace": t.b.slug}))
    r = await c.delete("/v1/workspace/ai-settings/key")
    assert r.status_code == (204 if who == "session" else 403), r.text


@case("GET", "/v1/research/models")
async def _research_models(c: Any, t: Two, who: str) -> None:
    _mock_openrouter()
    r = await c.get("/v1/research/models")
    assert r.status_code == 200, r.text
    no_b(r.text, t)


@case("GET", "/v1/workspace/company-profile")
async def _profile_get(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/workspace/company-profile")
    assert r.status_code == 200 and r.json()["is_empty"] is True, r.text
    no_b(r.text, t)
    if who == "session":
        is_404(await c.get("/v1/workspace/company-profile", headers={"X-Workspace": t.b.slug}))


@case("PUT", "/v1/workspace/company-profile")
async def _profile_put(c: Any, t: Two, who: str) -> None:
    body = {"pitch": "Alpha builds warehouse robots", "sectors": ["robotics"]}
    if who == "session":
        is_404(
            await c.put(
                "/v1/workspace/company-profile", json=body, headers={"X-Workspace": t.b.slug}
            )
        )
    r = await c.put("/v1/workspace/company-profile", json=body)
    assert r.status_code == 200 and r.json()["pitch"] == body["pitch"], r.text
    no_b(r.text, t)


# --- investor research: runs, identities, dossiers, suggestions (Part 2) ------------------


def b_inv_paths(t: Two, suffix: str) -> list[str]:
    return [f"/v1/investors/{t.b_inv.id}{suffix}"]


@case("POST", "/v1/investors/{investor_id}/research")
async def _research_start(c: Any, t: Two, who: str) -> None:
    for kind in ("identity", "dossier", "refresh"):
        is_404(await c.post(f"/v1/investors/{t.b_inv.id}/research", json={"kind": kind}))
    is_404(await c.post(f"/v1/investors/{t.a_inv.id}/research", json={"round": t.b_round.slug}))


@case("GET", "/v1/research/runs")
async def _runs(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/research/runs")
    assert r.status_code == 200 and r.json()["data"] == [], r.text
    no_b(r.text, t)
    is_404(await c.get("/v1/research/runs", params={"investor_id": str(t.b_inv.id)}))
    is_404(await c.get("/v1/research/runs", params={"batch_id": str(t.b_batch.id)}))


@case("GET", "/v1/research/runs/{run_id}")
async def _run_get(c: Any, t: Two, who: str) -> None:
    is_404(await c.get(f"/v1/research/runs/{t.b_run.id}"))


@case("POST", "/v1/research/runs/{run_id}/cancel")
async def _run_cancel(c: Any, t: Two, who: str) -> None:
    is_404(await c.post(f"/v1/research/runs/{t.b_run.id}/cancel"))


@case("POST", "/v1/research/runs/{run_id}/resume")
async def _run_resume(c: Any, t: Two, who: str) -> None:
    is_404(await c.post(f"/v1/research/runs/{t.b_run.id}/resume"))


@case("GET", "/v1/research/usage")
async def _usage(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/research/usage")
    assert r.status_code == 200 and r.json()["by_kind"] == {}, r.text
    no_b(r.text, t)


@case("POST", "/v1/research/estimate")
async def _estimate(c: Any, t: Two, who: str) -> None:
    is_404(await c.post("/v1/research/estimate", json={"investor_ids": [str(t.b_inv.id)]}))
    is_404(
        await c.post(
            "/v1/research/estimate", json={"investor_ids": [str(t.a_inv.id), str(t.b_inv.id)]}
        )
    )
    is_404(await c.post("/v1/research/estimate", json={"round": t.b_round.slug}))
    r = await c.post("/v1/research/estimate", json={"round": "seed"})
    assert r.status_code == 200 and r.json()["count"] == 1, r.text


@case("POST", "/v1/research/batches")
async def _batches(c: Any, t: Two, who: str) -> None:
    body = {"investor_ids": [str(t.b_inv.id)], "confirm_usd": 100}
    is_404(await c.post("/v1/research/batches", json=body))
    is_404(
        await c.post("/v1/research/batches", json={"round": str(t.b_round.id), "confirm_usd": 9})
    )


@case("GET", "/v1/research/batches/{batch_id}")
async def _batch_get(c: Any, t: Two, who: str) -> None:
    is_404(await c.get(f"/v1/research/batches/{t.b_batch.id}"))


@case("POST", "/v1/research/batches/{batch_id}/cancel")
async def _batch_cancel(c: Any, t: Two, who: str) -> None:
    is_404(await c.post(f"/v1/research/batches/{t.b_batch.id}/cancel"))


@case("GET", "/v1/investors/{investor_id}/identity")
async def _identity_get(c: Any, t: Two, who: str) -> None:
    is_404(await c.get(f"/v1/investors/{t.b_inv.id}/identity"))
    r = await c.get(f"/v1/investors/{t.a_inv.id}/identity")
    assert r.status_code == 200 and r.json()["status"] == "none"
    no_b(r.text, t)


@case("POST", "/v1/investors/{investor_id}/identity")
async def _identity_pick(c: Any, t: Two, who: str) -> None:
    is_404(await c.post(f"/v1/investors/{t.b_inv.id}/identity", json={"rank": 1}))
    is_404(await c.post(f"/v1/investors/{t.b_inv.id}/identity", json={"none": True}))
    # B's candidate cannot be picked for A's investor.
    is_404(
        await c.post(
            f"/v1/investors/{t.a_inv.id}/identity", json={"candidate_id": str(t.b_candidate.id)}
        )
    )


@case("GET", "/v1/investors/{investor_id}/dossier")
async def _dossier_get(c: Any, t: Two, who: str) -> None:
    is_404(await c.get(f"/v1/investors/{t.b_inv.id}/dossier"))
    r = await c.get(f"/v1/investors/{t.a_inv.id}/dossier")
    assert r.status_code == 404 and r.json()["error"]["code"] == "no_dossier"


@case("GET", "/v1/investors/{investor_id}/dossiers")
async def _dossiers(c: Any, t: Two, who: str) -> None:
    is_404(await c.get(f"/v1/investors/{t.b_inv.id}/dossiers"))


@case("POST", "/v1/investors/{investor_id}/dossier")
async def _dossier_save(c: Any, t: Two, who: str) -> None:
    doc = {
        "identity": {"name": B_NAME},
        "sources": [{"id": "s1", "url": B_SOURCE, "title": f"{B_NAME} of Quill Ventures"}],
        "facts": [
            {"key": "f1", "section": "profile", "kind": "role", "text": "x", "source_ids": ["s1"]}
        ],
        "analysis": {"brief": {"verdict": "poor", "why": "x"}},
    }
    is_404(await c.post(f"/v1/investors/{t.b_inv.id}/dossier", json={"dossier": doc}))
    is_404(
        await c.post(
            f"/v1/investors/{t.a_inv.id}/dossier", json={"dossier": doc, "round": t.b_round.slug}
        )
    )


@case("GET", "/v1/research/suggestions")
async def _suggestions(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/research/suggestions")
    assert r.status_code == 200 and r.json()["data"] == []
    no_b(r.text, t)
    is_404(await c.get("/v1/research/suggestions", params={"investor_id": str(t.b_inv.id)}))
    is_404(await c.get("/v1/research/suggestions", params={"round": t.b_round.slug}))


@case("POST", "/v1/research/suggestions/{suggestion_id}/accept")
async def _sug_accept(c: Any, t: Two, who: str) -> None:
    is_404(await c.post(f"/v1/research/suggestions/{t.b_suggestion.id}/accept"))


@case("POST", "/v1/research/suggestions/{suggestion_id}/ignore")
async def _sug_ignore(c: Any, t: Two, who: str) -> None:
    is_404(await c.post(f"/v1/research/suggestions/{t.b_suggestion.id}/ignore"))


@case("POST", "/v1/research/suggestions/accept-all")
async def _sug_accept_all(c: Any, t: Two, who: str) -> None:
    is_404(
        await c.post(
            "/v1/research/suggestions/accept-all", json={"investor_ids": [str(t.b_inv.id)]}
        )
    )
    is_404(await c.post("/v1/research/suggestions/accept-all", json={"round": t.b_round.slug}))


@case("GET", "/v1/rounds/{round}/research")
async def _round_research(c: Any, t: Two, who: str) -> None:
    for ref in b_round_refs(t):
        is_404(await c.get(f"/v1/rounds/{ref}/research"))
    r = await c.get("/v1/rounds/seed/research")
    assert r.status_code == 200 and len(r.json()["data"]) == 1
    no_b(r.text, t)


@case("POST", "/v1/workspace/company-profile/prefill")
async def _prefill(c: Any, t: Two, who: str) -> None:
    if who == "session":
        is_404(
            await c.post(
                "/v1/workspace/company-profile/prefill",
                data={"website_url": "alpha.example"},
                headers={"X-Workspace": t.b.slug},
            )
        )
    r = await c.post("/v1/workspace/company-profile/prefill", data={"website_url": "a.example"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "no_ai_key"  # A has no key
    no_b(r.text, t)


# --- meetings ----------------------------------------------------------------------------


@case("GET", "/v1/meetings")
async def _meetings(c: Any, t: Two, who: str) -> None:
    r = await c.get("/v1/meetings")
    assert r.status_code == 200 and r.json()["data"] == [], r.text
    no_b(r.text, t)
    is_404(await c.get("/v1/meetings", params={"investor_id": str(t.b_inv.id)}))
    is_404(await c.get("/v1/meetings", params={"round": t.b_round.slug}))


@case("POST", "/v1/meetings")
async def _meeting_create(c: Any, t: Two, who: str) -> None:
    body = {"investor_id": str(t.b_inv.id), "starts_at": "2026-10-20T11:00"}
    is_404(await c.post("/v1/meetings", json=body))
    a_body = {"investor_id": str(t.a_inv.id), "starts_at": "2026-10-20T11:00"}
    is_404(await c.post("/v1/meetings", json={**a_body, "round": t.b_round.slug}))
    is_404(await c.post("/v1/meetings", json={**a_body, "guest_ids": [str(t.b_inv.id)]}))


@case("GET", "/v1/meetings/{meeting_id}")
async def _meeting_get(c: Any, t: Two, who: str) -> None:
    is_404(await c.get(f"/v1/meetings/{t.b_meeting.id}"))


@case("PATCH", "/v1/meetings/{meeting_id}")
async def _meeting_patch(c: Any, t: Two, who: str) -> None:
    is_404(await c.patch(f"/v1/meetings/{t.b_meeting.id}", json={"status": "cancelled"}))
    is_404(await c.patch(f"/v1/meetings/{t.b_meeting.id}", json={"starts_at": "2026-10-21T11:00"}))


@case("POST", "/v1/meetings/{meeting_id}/complete")
async def _meeting_complete(c: Any, t: Two, who: str) -> None:
    is_404(await c.post(f"/v1/meetings/{t.b_meeting.id}/complete", json={"outcome": "x"}))


@case("DELETE", "/v1/meetings/{meeting_id}")
async def _meeting_delete(c: Any, t: Two, who: str) -> None:
    is_404(await c.delete(f"/v1/meetings/{t.b_meeting.id}"))


@case("GET", "/v1/meetings/{meeting_id}/ics")
async def _meeting_ics(c: Any, t: Two, who: str) -> None:
    is_404(await c.get(f"/v1/meetings/{t.b_meeting.id}/ics"))


# --- the tests ---------------------------------------------------------------------------


def workspace_routes(app: Any) -> set[tuple[str, str]]:
    return {
        (m, r.path)
        for r in app.routes
        if isinstance(r, APIRoute) and r.path.startswith(("/v1", "/healthz"))
        for m in r.methods
        if m != "HEAD"
    } - ORGLESS


def test_every_route_is_covered(app: Any) -> None:
    """A new /v1 route must get an isolation case here (or be declared org-less)."""
    missing = workspace_routes(app) - set(CASES)
    assert not missing, f"add isolation cases for: {sorted(missing)}"


@pytest.mark.parametrize("who", ["session", "key"])
@pytest.mark.parametrize("route", sorted(CASES), ids=lambda r: f"{r[0]} {r[1]}")
async def test_a_cannot_reach_b(
    route: tuple[str, str],
    who: str,
    app: Any,
    db: AsyncSession,
    session_client: Any,
    key_client: Any,
    frozen_now: Any,
) -> None:
    if route not in workspace_routes(app):
        pytest.skip("route not registered in this build")
    t = await two_workspaces(db)
    before = await snapshot_b(db, t)
    if who == "session":
        c = await session_client(t.a_owner, t.a)
    else:
        c = key_client(t.a_key, headers={"X-Workspace": t.b.slug})  # ignored for keys
    await CASES[route](c, t, who)
    assert await snapshot_b(db, t) == before
