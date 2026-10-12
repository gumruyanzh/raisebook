"""SPEC §4.6 permissions matrix: the API+MCP rows (rounds, stages, participants, investors,
activities, follow-ups), on the shared harness in ``tests/matrix.py``."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.routing import APIRoute
from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import make_activity, make_investor, make_participant, make_round
from tests.matrix import ADMINS, ALL, OWNER_SESSION, PRINCIPALS, WRITERS, Ctx, Row, run_row


async def pipeline(db: AsyncSession, ctx: Ctx) -> dict[str, Any]:
    rnd = await make_round(db, ctx.ws, name="Seed", slug="seed")
    inv = await make_investor(db, ctx.ws, name="Dana Whitfield", email="dana@example.com")
    spare = await make_investor(db, ctx.ws, name="Marcus Ellery", email="marcus@example.com")
    await make_participant(db, rnd, inv, stage="meeting")
    note = await make_activity(db, inv, kind="note", body="Logged by the system")
    return {"round": rnd, "inv": inv, "spare": spare, "note": note}


class p:
    """A path template filled from the setup (``{inv}``, ``{spare}``, ``{note}``)."""

    def __init__(self, template: str) -> None:
        self.template = template

    def __call__(self, c: Ctx, _principal: str) -> str:
        return self.template.format(
            inv=c.extra["inv"].id, spare=c.extra["spare"].id, note=c.extra["note"].id
        )


STAGES = [
    {"key": "new", "label": "New", "color": "slate", "kind": "open"},
    {"key": "meeting", "label": "Meeting", "color": "amber", "kind": "active"},
    {"key": "committed", "label": "Committed", "color": "green", "kind": "won"},
    {"key": "passed", "label": "Passed", "color": "gray", "kind": "lost"},
]
PART = "/v1/rounds/seed/participants/{inv}"

ROWS = [
    Row("list rounds", "GET", "/v1/rounds", ALL, setup=pipeline),
    Row("create round", "POST", "/v1/rounds", WRITERS, body={"name": "Series A"}, setup=pipeline),
    Row("view round", "GET", "/v1/rounds/seed", ALL, setup=pipeline),
    Row(
        "update round",
        "PATCH",
        "/v1/rounds/seed",
        WRITERS,
        body={"target_amount": 1_000_000},
        setup=pipeline,
    ),
    Row(
        "close round",
        "PATCH",
        "/v1/rounds/seed",
        WRITERS,
        body={"status": "closed"},
        setup=pipeline,
    ),
    Row(
        "delete round",
        "DELETE",
        "/v1/rounds/seed",
        ADMINS,
        body={"confirm": "Seed"},
        setup=pipeline,
    ),
    Row(
        "edit stages",
        "PUT",
        "/v1/rounds/seed/stages",
        WRITERS,
        body={"stages": STAGES},
        setup=pipeline,
    ),
    Row("round summary", "GET", "/v1/rounds/seed/summary", ALL, setup=pipeline),
    Row("list participants", "GET", "/v1/rounds/seed/participants", ALL, setup=pipeline),
    Row(
        "add to round",
        "POST",
        "/v1/rounds/seed/participants",
        WRITERS,
        body=lambda c, _p: {"investor_id": str(c.extra["spare"].id)},
        setup=pipeline,
    ),
    Row(
        "bulk add",
        "POST",
        "/v1/rounds/seed/participants/bulk",
        WRITERS,
        body=lambda c, _p: {"investor_ids": [str(c.extra["spare"].id)]},
        setup=pipeline,
    ),
    Row(
        "bulk update",
        "POST",
        "/v1/rounds/seed/participants/bulk-update",
        WRITERS,
        body=lambda c, _p: {"op": "fit", "investor_ids": [str(c.extra["inv"].id)], "fit": 4},
        setup=pipeline,
    ),
    Row("view participant", "GET", p(PART), ALL, setup=pipeline),
    Row("update participant", "PATCH", p(PART), WRITERS, body={"fit": 4}, setup=pipeline),
    Row("move stage", "POST", p(PART + "/stage"), WRITERS, body={"stage": "dd"}, setup=pipeline),
    Row(
        "set follow-up",
        "POST",
        p(PART + "/follow-up"),
        WRITERS,
        body={"in_days": 3},
        setup=pipeline,
    ),
    Row(
        "record commitment",
        "POST",
        p(PART + "/commitment"),
        WRITERS,
        body={"amount": 100_000},
        setup=pipeline,
    ),
    Row("remove from round", "DELETE", p(PART), WRITERS, setup=pipeline),
    Row("due follow-ups", "GET", "/v1/follow-ups", ALL, setup=pipeline),
    Row("list investors", "GET", "/v1/investors", ALL, setup=pipeline),
    Row(
        "add investor",
        "POST",
        "/v1/investors",
        WRITERS,
        body={"name": "Ines Calloway"},
        setup=pipeline,
    ),
    Row(
        "resolve investor",
        "GET",
        "/v1/investors/resolve?ref=dana@example.com",
        ALL,
        setup=pipeline,
    ),
    Row("view investor", "GET", p("/v1/investors/{inv}"), ALL, setup=pipeline),
    Row(
        "update investor",
        "PATCH",
        p("/v1/investors/{inv}"),
        WRITERS,
        body={"title": "Partner"},
        setup=pipeline,
    ),
    Row("delete investor", "DELETE", p("/v1/investors/{spare}"), WRITERS, setup=pipeline),
    Row("list activities", "GET", "/v1/activities", ALL, setup=pipeline),
    Row(
        "log activity",
        "POST",
        "/v1/activities",
        WRITERS,
        body=lambda c, _p: {"investor_id": str(c.extra["inv"].id), "kind": "call", "body": "x"},
        setup=pipeline,
    ),
    # A manual note logged by someone else: only the owner may delete it (editors and keys
    # may delete only their own entries; see test_activities_api for the own-entry paths).
    Row(
        "delete someone's note", "DELETE", p("/v1/activities/{note}"), OWNER_SESSION, setup=pipeline
    ),
]

AM_MODULES = {
    "raisebook.api.rounds",
    "raisebook.api.participants",
    "raisebook.api.investors",
    "raisebook.api.activities",
    "raisebook.api.follow_ups",
}


def _template(row: Row) -> str:
    path = row.path if isinstance(row.path, str) else getattr(row.path, "template", "")
    return path.split("?")[0]


def test_every_feature_route_has_a_row(app: Any) -> None:
    routes = {
        (m, r.path)
        for r in app.routes
        if isinstance(r, APIRoute) and r.endpoint.__module__ in AM_MODULES
        for m in r.methods
        if m != "HEAD"
    }
    covered = set()
    for row in ROWS:
        tpl = _template(row)
        tpl = tpl.replace("{inv}", "{investor_id}").replace("{spare}", "{investor_id}")
        tpl = tpl.replace("{note}", "{activity_id}").replace("/rounds/seed", "/rounds/{round}")
        covered.add((row.method, tpl))
    missing = routes - covered
    assert not missing, f"add matrix rows for: {sorted(missing)}"


@pytest.mark.parametrize("principal", PRINCIPALS)
@pytest.mark.parametrize("row", ROWS, ids=lambda r: r.name)
async def test_matrix(
    row: Row, principal: str, db: AsyncSession, session_client: Any, key_client: Any
) -> None:
    r = await run_row(row, principal, db, session_client, key_client)
    if principal in row.allowed:
        assert r.status_code < 300, (row.name, principal, r.status_code, r.text)
