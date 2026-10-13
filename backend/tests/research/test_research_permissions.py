"""SPEC §4.6 permissions matrix rows for AI settings and the company profile (§6.7)."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.matrix import ADMINS, ALL, OWNER_SESSION, PRINCIPALS, WRITERS, Row, run_row
from tests.research.openrouter_mock import FAKE_KEY

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
