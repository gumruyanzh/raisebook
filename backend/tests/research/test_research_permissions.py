"""SPEC §4.6 permissions matrix rows for AI settings and the company profile (§6.7)."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import make_investor, make_participant, make_round
from tests.matrix import ADMINS, ALL, OWNER_SESSION, PRINCIPALS, WRITERS, Ctx, Row, run_row
from tests.research.helpers import agent_doc, set_key
from tests.research.openrouter_mock import FAKE_KEY


async def with_investor(db: AsyncSession, ctx: Ctx) -> dict[str, Any]:
    """A keyed workspace with a round and the (fictional) investor Dana Whitfield."""
    await set_key(db, ctx.ws)
    rnd = await make_round(db, ctx.ws, name="Seed", slug="seed")
    inv = await make_investor(db, ctx.ws, name="Dana Whitfield", firm="Harbor Light Ventures")
    await make_participant(db, rnd, inv)
    return {"inv": inv}


def inv_path(suffix: str) -> Any:
    return lambda c, _p: f"/v1/investors/{c.extra['inv'].id}{suffix}"


ROWS = [
    Row("read ai settings", "GET", "/v1/workspace/ai-settings", ALL),
    Row("list research models", "GET", "/v1/research/models", ALL),
    Row(
        "change ai settings",
        "PATCH",
        "/v1/workspace/ai-settings",
        ADMINS,
        body={"preset": "budget"},
    ),
    Row(
        "set openrouter key",
        "PUT",
        "/v1/workspace/ai-settings/key",
        OWNER_SESSION,
        body={"key": FAKE_KEY},
    ),
    Row("remove openrouter key", "DELETE", "/v1/workspace/ai-settings/key", OWNER_SESSION),
    Row("read company profile", "GET", "/v1/workspace/company-profile", ALL),
    Row(
        "replace company profile",
        "PUT",
        "/v1/workspace/company-profile",
        WRITERS,
        body={"pitch": "Fictional pitch"},
    ),
    # Part 2: research. Viewers read; editors and write keys run research (R12).
    Row("list research runs", "GET", "/v1/research/runs", ALL),
    Row("research usage", "GET", "/v1/research/usage", ALL),
    Row("list suggestions", "GET", "/v1/research/suggestions", ALL),
    Row("estimate research", "POST", "/v1/research/estimate", ALL, body={"investor_ids": []}),
    Row("read identity", "GET", inv_path("/identity"), ALL, setup=with_investor),
    Row("list dossiers", "GET", inv_path("/dossiers"), ALL, setup=with_investor),
    Row("round research", "GET", "/v1/rounds/seed/research", ALL, setup=with_investor),
    Row(
        "research an investor",
        "POST",
        inv_path("/research"),
        WRITERS,
        body={"kind": "dossier"},
        setup=with_investor,
    ),
    Row(
        "pick an identity",
        "POST",
        inv_path("/identity"),
        WRITERS,
        body={"linkedin_url": "https://www.linkedin.com/in/example-dana-whitfield"},
        setup=with_investor,
    ),
    Row(
        "save a dossier",
        "POST",
        inv_path("/dossier"),
        WRITERS,
        body={"dossier": agent_doc()},
        setup=with_investor,
    ),
    Row(
        "accept all suggestions",
        "POST",
        "/v1/research/suggestions/accept-all",
        WRITERS,
        body={"investor_ids": []},
    ),
]


@pytest.mark.parametrize("principal", PRINCIPALS)
@pytest.mark.parametrize("row", ROWS, ids=lambda r: r.name)
async def test_matrix(
    row: Row,
    principal: str,
    db: AsyncSession,
    session_client: Any,
    key_client: Any,
    openrouter_mock: Any,
) -> None:
    r = await run_row(row, principal, db, session_client, key_client)
    if principal in row.allowed:
        assert r.status_code < 300, (row.name, principal, r.status_code, r.text)
