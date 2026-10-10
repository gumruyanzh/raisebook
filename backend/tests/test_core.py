"""Cross-cutting behaviour: error envelope, body limits, request ids, CORS, no-PII logs."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
import structlog
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core.actor import clean_agent_model, clean_agent_name
from raisebook.core.logging import hash_email, redact_secrets, redact_text
from tests.factories import make_user


async def test_validation_error_envelope(client: httpx.AsyncClient) -> None:
    r = await client.post("/v1/auth/magic-link", json={"emial": "x@example.com"})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "validation_error"
    assert err["request_id"] == r.headers["x-request-id"]
    locs = [d["loc"] for d in err["details"]]
    assert ["body", "email"] in locs and ["body", "emial"] in locs


async def test_unknown_route_envelope(client: httpx.AsyncClient) -> None:
    r = await client.get("/v1/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


async def test_request_id_is_echoed_when_valid(client: httpx.AsyncClient) -> None:
    r = await client.get("/healthz", headers={"X-Request-ID": "req_abc-123"})
    assert r.headers["x-request-id"] == "req_abc-123"
    r = await client.get("/healthz", headers={"X-Request-ID": "bad id with spaces"})
    assert r.headers["x-request-id"].startswith("req_")


async def test_body_limit(client: httpx.AsyncClient) -> None:
    big = "x" * (1024 * 1024 + 10)
    r = await client.post(
        "/v1/auth/magic-link", content=big, headers={"content-type": "application/json"}
    )
    assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"
    # Imports allow up to 6 MB (route not built yet: the limit still lets it through).
    r = await client.post(
        "/v1/imports/preview", content=big, headers={"content-type": "application/json"}
    )
    assert r.status_code != 413


async def test_internal_error_hides_details(app: FastAPI, client: httpx.AsyncClient) -> None:
    @app.get("/v1/_boom")
    async def boom() -> None:
        raise RuntimeError("secret detail dana@example.com")

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        r = await c.get("/v1/_boom")
    assert r.status_code == 500
    err = r.json()["error"]
    assert err["code"] == "internal_error"
    assert err["message"] == f"Unexpected error. Reference {r.headers['x-request-id']}."
    assert "secret" not in r.text


async def test_cors_preflight_for_web_app(client: httpx.AsyncClient) -> None:
    r = await client.options(
        "/v1/workspace",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "PATCH",
            "Access-Control-Request-Headers": "x-csrf-token, x-workspace, content-type",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert r.headers["access-control-allow-credentials"] == "true"
    r = await client.options(
        "/v1/workspace",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert "access-control-allow-origin" not in r.headers


def test_redaction() -> None:
    event = redact_secrets(
        None,
        "info",
        {
            "event": "x Bearer rb_live_abcdefghijklmnop and a@example.com",
            "token": "t",
            "email": "dana@example.com",
            "authorization": "Bearer x",
            "nested": {"api_key": "k", "ok": "fine", "note": "private"},
            "count": 3,
        },
    )
    assert "rb_live_abcdef" not in event["event"] and "a@example.com" not in event["event"]
    assert event["token"] == "[REDACTED]" and event["email"] == "[REDACTED]"
    assert event["nested"] == {"api_key": "[REDACTED]", "ok": "fine", "note": "[REDACTED]"}
    assert event["count"] == 3
    assert "token=[REDACTED]" in redact_text("https://x/auth/verify?token=abc")
    assert len(hash_email("A@Example.com")) == 16 and hash_email("a@example.com") == hash_email(
        " A@EXAMPLE.COM "
    )


async def test_access_log_has_no_pii(
    db: AsyncSession, session_client: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    import logging

    from raisebook.core.logging import configure_logging

    configure_logging("INFO", json=True)
    structlog.reset_defaults()
    configure_logging("INFO", json=True)
    try:
        user = await make_user(db, email="private.person@example.com", name="Private Person")
        c = await session_client(user)
        await c.patch("/v1/me?secret=1", json={"name": "Very Private Name"})
        out = capsys.readouterr().out
        assert '"route": "/v1/me"' in out
        assert "private.person" not in out and "Very Private Name" not in out
        assert "secret=1" not in out
    finally:
        configure_logging("WARNING", json=False)
        logging.getLogger().setLevel("WARNING")


def test_agent_header_cleaning() -> None:
    assert clean_agent_name(" claude-code ") == "claude-code"
    assert clean_agent_name("Cursor Agent 1.2") == "Cursor Agent 1.2"
    for bad in ("", "-x", "a" * 61, "evil<script>", "new\nline"):
        assert clean_agent_name(bad) is None, bad
    assert clean_agent_model("claude-opus-5-5") == "claude-opus-5-5"
    assert clean_agent_model("x" * 81) is None and clean_agent_model("bad\x00") is None
