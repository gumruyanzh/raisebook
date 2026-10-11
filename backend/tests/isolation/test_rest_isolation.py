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
from raisebook.models.investor import Investor
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
}

B_EMAIL = "blake.quill@example.com"
B_LINKEDIN = "https://www.linkedin.com/in/example-blake-quill"
B_NAME = "Blake Quill"


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
    await db.flush()
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
    )


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
