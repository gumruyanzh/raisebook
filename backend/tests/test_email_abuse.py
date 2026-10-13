"""Launch hardening: one inbox cannot be flooded through aliases, a server-wide email cap,
provider failures answer 503 (not 500), and domain-like names stay out of invite emails."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from raisebook.auth.magic_link import mailbox_key
from raisebook.core.ratelimit import LIMITS, Limit
from raisebook.services.email import invite_email


async def request_link(client: httpx.AsyncClient, email: str) -> httpx.Response:
    return await client.post("/v1/auth/magic-link", json={"email": email})


@pytest.mark.parametrize(
    ("raw", "inbox"),
    [
        ("victim@example.com", "victim@example.com"),
        ("Victim+1@Example.com", "victim@example.com"),
        ("v.ictim+x@gmail.com", "victim@gmail.com"),
        ("victim@googlemail.com", "victim@gmail.com"),
        ("first.last@example.com", "first.last@example.com"),  # dots matter elsewhere
    ],
)
def test_mailbox_key(raw: str, inbox: str) -> None:
    assert mailbox_key(raw) == inbox


async def test_aliases_share_the_inbox_limit(client: httpx.AsyncClient, outbox: list[Any]) -> None:
    for i in range(8):
        r = await request_link(client, f"v.ictim+{i}@gmail.com")
        assert r.status_code == 202
    assert len(outbox) == LIMITS["magic_mailbox"].limit


async def test_global_cap_answers_503(
    client: httpx.AsyncClient, outbox: list[Any], monkeypatch: Any
) -> None:
    monkeypatch.setitem(LIMITS, "email_global", Limit(2, 3600))
    for i in range(2):
        assert (await request_link(client, f"cap{i}@example.com")).status_code == 202
    r = await request_link(client, "cap3@example.com")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "email_unavailable"
    assert len(outbox) == 2


async def test_provider_failure_answers_503(client: httpx.AsyncClient, app: Any) -> None:
    from raisebook.services.email import get_email_sender

    class Broken:
        async def send(self, message: Any) -> None:
            raise OSError("quota exceeded")

    app.dependency_overrides[get_email_sender] = lambda: Broken()
    r = await request_link(client, "fail@example.com")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "email_unavailable"


def test_invite_email_leaves_out_domain_like_names() -> None:
    plain = invite_email(
        "a@example.com", "L", workspace_name="Tallow", inviter="Sam", role="editor", ttl_days=7
    )
    assert 'the workspace "Tallow"' in plain.text and '"Sam"' in plain.text
    linky = invite_email(
        "a@example.com",
        "L",
        workspace_name="Visit evil.com",
        inviter="pay.example.co now",
        role="editor",
        ttl_days=7,
    )
    assert "evil.com" not in linky.text and "example.co" not in linky.text
    assert "A teammate invited you to join a workspace" in linky.text


async def test_web_import_note_names_the_web_choice(
    db: Any, session_client: Any, frozen_now: Any
) -> None:
    """The review note for an existing investor speaks the web UI's words, not REST params."""
    from tests.factories import (
        make_investor,
        make_participant,
        make_round,
        make_workspace,
        owner_of,
    )

    ws = await make_workspace(db)
    rnd = await make_round(db, ws, name="Seed", slug="seed")
    dana = await make_investor(db, ws, name="Dana Whitfield", email="dana@example.com")
    await make_participant(db, rnd, dana, stage="contacted")
    c = await session_client(await owner_of(db, ws), ws)
    r = await c.post(
        "/v1/imports/preview",
        json={"content": "Name,Email,Fit\nDana Whitfield,dana@example.com,5\n", "round": "seed"},
    )
    assert r.status_code == 200, r.text
    text = r.text
    assert "Choose 'Update existing'" in text
    assert "on_duplicate" not in text
