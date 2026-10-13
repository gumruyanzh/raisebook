"""Settings → AI research over REST (RESEARCH-PLAN §6.1; R4, R9, R12). OpenRouter is mocked."""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.config import reset_settings_cache
from raisebook.core import ratelimit, secrets
from raisebook.core.errors import NoAiKey
from raisebook.models.ai import WorkspaceAiSettings
from raisebook.services import ai_settings as ai_svc
from raisebook.services import jobs as jobs_svc
from tests.factories import add_member, make_api_key, make_investor, make_workspace, owner_of
from tests.research.fixtures_models import PRESET_IDS
from tests.research.openrouter_mock import FAKE_KEY, OTHER_FAKE_KEY, OpenRouterMock

KEY_COLUMNS = (
    "key_ciphertext",
    "key_nonce",
    "key_dek_wrapped",
    "key_dek_nonce",
    "key_kek_id",
    "key_last4",
    "key_label",
    "key_set_at",
    "key_validated_at",
)


@contextmanager
def kek_env(current: str | None, previous: str | None = None) -> Iterator[None]:
    """Swap the server KEK for the duration (settings are cached: reset around it)."""
    saved = {
        k: os.environ.get(k) for k in ("RAISEBOOK_SECRETS_KEK", "RAISEBOOK_SECRETS_KEK_PREVIOUS")
    }
    try:
        for k, v in (
            ("RAISEBOOK_SECRETS_KEK", current),
            ("RAISEBOOK_SECRETS_KEK_PREVIOUS", previous),
        ):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        reset_settings_cache()
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        reset_settings_cache()


async def owner_client(db: AsyncSession, session_client: Any) -> tuple[Any, httpx.AsyncClient]:
    ws = await make_workspace(db)
    owner = await owner_of(db, ws)
    return ws, await session_client(owner, ws)


async def settings_row(db: AsyncSession, ws: Any) -> WorkspaceAiSettings | None:
    workspace_id = ws.id
    row: WorkspaceAiSettings | None = await db.scalar(
        select(WorkspaceAiSettings)
        .where(WorkspaceAiSettings.workspace_id == workspace_id)
        .execution_options(populate_existing=True)
    )
    return row


async def test_defaults_before_anything_is_saved(
    db: AsyncSession, session_client: Any, frozen_now: Any
) -> None:
    _, c = await owner_client(db, session_client)
    r = await c.get("/v1/workspace/ai-settings")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["preset"] == "best"
    assert (body["identity_model"], body["search_model"], body["writer_model"]) == PRESET_IDS[
        "best"
    ]
    assert body["monthly_cap_usd"] == 25.0
    assert body["has_key"] is False and body["key_status"] == "none"
    assert body["key_last4"] is None
    assert body["kek_configured"] is True and body["research_available"] is False
    assert body["can_manage_key"] is True and body["can_edit"] is True
    assert body["usage"] == {
        "month": "2026-10",
        "spent_usd": 0.0,
        "reserved_usd": 0.0,
        "remaining_usd": 25.0,
        "calls": 0,
        "dossiers": 0,
        "matches": 0,
        "cap_reached": False,
    }
    est = body["estimates"]
    # Snapshot prices (no network on GET): Best ≈ $0.21, Balanced ≈ $0.09, Budget ≈ $0.05.
    assert 0.18 < est["best"] < 0.24 and est["current"] == est["best"]
    assert 0.07 < est["balanced"] < 0.11
    assert 0.03 < est["budget"] < 0.07
    assert est["identity"] == pytest.approx(0.007)
    assert [p["id"] for p in body["presets"]] == ["best", "balanced", "budget"]


async def test_save_key_validates_seals_and_shows_last4_only(
    db: AsyncSession, session_client: Any, openrouter_mock: OpenRouterMock, frozen_now: Any
) -> None:
    ws, c = await owner_client(db, session_client)
    r = await c.put("/v1/workspace/ai-settings/key", json={"key": f"  {FAKE_KEY}  "})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["has_key"] is True and body["key_status"] == "ok"
    assert body["key_last4"] == "9z8y" and body["key_label"] == "Harbor test key"
    assert body["research_available"] is True
    assert FAKE_KEY not in r.text and FAKE_KEY[:20] not in r.text
    # OpenRouter checked the key with it as a bearer token, then the models list.
    key_call = next(call for call in openrouter_mock.calls if call.path.endswith("/key"))
    assert key_call.headers["authorization"] == f"Bearer {FAKE_KEY}"
    assert key_call.headers["x-title"] == "Raisebook"
    models_call = next(call for call in openrouter_mock.calls if call.path.endswith("/models"))
    assert "authorization" not in models_call.headers  # the public list needs no key
    row = await settings_row(db, ws)
    assert row is not None and row.key_ciphertext is not None
    assert FAKE_KEY.encode() not in row.key_ciphertext
    assert row.key_kek_id == "k1" and row.models_verified_at is not None
    assert await ai_svc.open_key(db, ws.id) == FAKE_KEY
    # Reading back never returns it.
    r = await c.get("/v1/workspace/ai-settings")
    assert FAKE_KEY not in r.text and r.json()["key_last4"] == "9z8y"


async def test_rejected_key_stores_nothing(
    db: AsyncSession, session_client: Any, openrouter_mock: OpenRouterMock
) -> None:
    ws, c = await owner_client(db, session_client)
    openrouter_mock.route(
        "GET", "/key", httpx.Response(401, json={"error": {"message": f"bad {FAKE_KEY}"}})
    )
    r = await c.put("/v1/workspace/ai-settings/key", json={"key": FAKE_KEY})
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "invalid_openrouter_key"
    assert FAKE_KEY not in r.text
    row = await settings_row(db, ws)
    assert row is None or row.key_ciphertext is None


async def test_openrouter_down_is_a_503(
    db: AsyncSession, session_client: Any, openrouter_mock: OpenRouterMock
) -> None:
    _, c = await owner_client(db, session_client)
    openrouter_mock.route("GET", "/key", httpx.Response(503, text="upstream trouble"))
    r = await c.put("/v1/workspace/ai-settings/key", json={"key": FAKE_KEY})
    assert r.status_code == 503 and r.json()["error"]["code"] == "openrouter_unavailable"

    def boom(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    openrouter_mock.route("GET", "/key", boom)
    r = await c.put("/v1/workspace/ai-settings/key", json={"key": FAKE_KEY})
    assert r.status_code == 503


async def test_malformed_key_is_refused_before_any_call(
    db: AsyncSession, session_client: Any, openrouter_mock: OpenRouterMock
) -> None:
    _, c = await owner_client(db, session_client)
    for bad in ("short", "sk-or-v1-has spaces in it 123456789"):
        r = await c.put("/v1/workspace/ai-settings/key", json={"key": bad})
        assert r.status_code == 422, r.text
        assert bad not in r.text
    assert openrouter_mock.calls == []


async def test_missing_preset_model_is_refused(
    db: AsyncSession, session_client: Any, openrouter_mock: OpenRouterMock
) -> None:
    ws, c = await owner_client(db, session_client)
    models = json.loads(
        openrouter_mock.routes[("GET", "/api/v1/models")](
            httpx.Request("GET", "https://x/api/v1/models")
        ).content
    )
    models["data"] = [m for m in models["data"] if m["id"] != "anthropic/claude-opus-5.5"]
    openrouter_mock.route("GET", "/models", httpx.Response(200, json=models))
    r = await c.put("/v1/workspace/ai-settings/key", json={"key": FAKE_KEY})
    assert r.status_code == 422, r.text
    err = r.json()["error"]
    assert err["code"] == "model_unavailable" and "anthropic/claude-opus-5.5" in err["message"]
    row = await settings_row(db, ws)
    assert row is None or row.key_ciphertext is None


async def test_only_an_owner_session_sets_or_removes_the_key(
    db: AsyncSession,
    session_client: Any,
    key_client: Any,
    openrouter_mock: OpenRouterMock,
) -> None:
    ws = await make_workspace(db)
    editor = await add_member(db, ws, role="editor")
    _, admin_key = await make_api_key(db, ws, scopes="read,write,admin")
    ce = await session_client(editor, ws)
    ck = key_client(admin_key)
    for c, code in ((ce, "forbidden_role"), (ck, "insufficient_scope")):
        r = await c.put("/v1/workspace/ai-settings/key", json={"key": FAKE_KEY})
        assert r.status_code == 403 and r.json()["error"]["code"] == code, r.text
        r = await c.delete("/v1/workspace/ai-settings/key")
        assert r.status_code == 403
    assert openrouter_mock.calls == []
    r = await ce.get("/v1/workspace/ai-settings")
    assert r.json()["can_manage_key"] is False and r.json()["can_edit"] is False


async def test_remove_key_nulls_everything_and_cancels_queued_research(
    db: AsyncSession, session_client: Any, openrouter_mock: OpenRouterMock, frozen_now: Any
) -> None:
    ws, c = await owner_client(db, session_client)
    assert (await c.put("/v1/workspace/ai-settings/key", json={"key": FAKE_KEY})).status_code == 200
    inv = await make_investor(db, ws)
    owner = await owner_of(db, ws)
    run_id = (
        await db.execute(
            text(
                "INSERT INTO research_runs (workspace_id, investor_id, kind, status, actor_type,"
                " actor_user_id, via) VALUES (:ws, :inv, 'dossier', 'queued', 'user', :u, 'web')"
                " RETURNING id"
            ),
            {"ws": ws.id, "inv": inv.id, "u": owner.id},
        )
    ).scalar_one()
    job_id, _ = await jobs_svc.enqueue(
        db,
        kind=jobs_svc.KIND_RESEARCH_RUN,
        now=frozen_now,
        workspace_id=ws.id,
        payload={"run_id": str(run_id)},
        dedupe_key=f"run:{run_id}",
    )
    r = await c.delete("/v1/workspace/ai-settings/key")
    assert r.status_code == 204, r.text
    row = await settings_row(db, ws)
    assert row is not None
    for col in KEY_COLUMNS:
        assert getattr(row, col) is None, col
    status, code = (
        await db.execute(
            text("SELECT status, error_code FROM research_runs WHERE id = :id"), {"id": run_id}
        )
    ).one()
    assert (status, code) == ("cancelled", "no_key")
    job_status = (
        await db.execute(text("SELECT status FROM jobs WHERE id = :id"), {"id": job_id})
    ).scalar_one()
    assert job_status == "cancelled"
    assert (await c.get("/v1/workspace/ai-settings")).json()["has_key"] is False
    with pytest.raises(NoAiKey):
        await ai_svc.open_key(db, ws.id)


async def test_key_table_check_refuses_half_a_key(db: AsyncSession) -> None:
    from sqlalchemy.exc import IntegrityError

    ws = await make_workspace(db)
    async with db.begin_nested() as sp:
        with pytest.raises(IntegrityError):
            await db.execute(
                text(
                    "INSERT INTO workspace_ai_settings (workspace_id, key_ciphertext)"
                    " VALUES (:ws, '\\x00')"
                ),
                {"ws": ws.id},
            )
        await sp.rollback()


async def test_patch_presets_advanced_and_cap(
    db: AsyncSession, session_client: Any, openrouter_mock: OpenRouterMock
) -> None:
    _, c = await owner_client(db, session_client)
    r = await c.patch("/v1/workspace/ai-settings", json={"preset": "balanced"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["preset"] == "balanced"
    assert (body["identity_model"], body["search_model"], body["writer_model"]) == PRESET_IDS[
        "balanced"
    ]
    assert openrouter_mock.calls == []  # no key yet: nothing to verify against
    r = await c.patch("/v1/workspace/ai-settings", json={"writer_model": "openai/gpt-5.6-terra"})
    assert r.json()["preset"] == "custom" and r.json()["writer_model"] == "openai/gpt-5.6-terra"
    r = await c.patch("/v1/workspace/ai-settings", json={"writer_model": "google/gemini-3.8-flash"})
    assert r.json()["preset"] == "budget"  # matches a preset again
    r = await c.patch("/v1/workspace/ai-settings", json={"preset": "custom"})
    assert r.json()["preset"] == "custom"
    r = await c.patch("/v1/workspace/ai-settings", json={"monthly_cap_usd": 40.5})
    assert r.json()["monthly_cap_usd"] == 40.5
    for bad in ({"monthly_cap_usd": 10_001}, {"monthly_cap_usd": 1.234}, {"monthly_cap_usd": -1}):
        r = await c.patch("/v1/workspace/ai-settings", json=bad)
        assert r.status_code == 422, (bad, r.text)
    r = await c.patch("/v1/workspace/ai-settings", json={"search_model": "not a model id"})
    assert r.status_code == 422
    r = await c.patch("/v1/workspace/ai-settings", json={"preset": "turbo"})
    assert r.status_code == 422


async def test_patch_verifies_models_once_a_key_exists(
    db: AsyncSession, session_client: Any, openrouter_mock: OpenRouterMock
) -> None:
    _, c = await owner_client(db, session_client)
    assert (await c.put("/v1/workspace/ai-settings/key", json={"key": FAKE_KEY})).status_code == 200
    r = await c.patch("/v1/workspace/ai-settings", json={"writer_model": "perplexity/sonar"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "model_unavailable"
    assert "structured JSON" in r.json()["error"]["message"]
    r = await c.patch("/v1/workspace/ai-settings", json={"search_model": "example/gone-model"})
    assert r.status_code == 422 and "example/gone-model" in r.json()["error"]["message"]
    r = await c.patch("/v1/workspace/ai-settings", json={"preset": "budget"})
    assert r.status_code == 200 and r.json()["preset"] == "budget"
    assert openrouter_mock.count("GET", "/models") == 1  # cached for 6 hours


async def test_patch_needs_admin(db: AsyncSession, session_client: Any, key_client: Any) -> None:
    ws = await make_workspace(db)
    editor = await add_member(db, ws, role="editor")
    viewer = await add_member(db, ws, role="viewer")
    _, write_key = await make_api_key(db, ws, scopes="read,write")
    _, admin_key = await make_api_key(db, ws, scopes="read,write,admin")
    for c in (await session_client(editor, ws), await session_client(viewer, ws)):
        r = await c.patch("/v1/workspace/ai-settings", json={"monthly_cap_usd": 5})
        assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden_role"
        assert (await c.get("/v1/workspace/ai-settings")).status_code == 200
    r = await key_client(write_key).patch("/v1/workspace/ai-settings", json={"preset": "budget"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "insufficient_scope"
    r = await key_client(admin_key).patch("/v1/workspace/ai-settings", json={"preset": "budget"})
    assert r.status_code == 200


async def test_key_save_is_rate_limited(
    db: AsyncSession,
    session_client: Any,
    openrouter_mock: OpenRouterMock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(ratelimit.LIMITS, "ai_key", ratelimit.Limit(2, 3600))
    _, c = await owner_client(db, session_client)
    for _ in range(2):
        assert (
            await c.put("/v1/workspace/ai-settings/key", json={"key": FAKE_KEY})
        ).status_code == 200
    r = await c.put("/v1/workspace/ai-settings/key", json={"key": OTHER_FAKE_KEY})
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"
    assert openrouter_mock.count("GET", "/key") == 2


async def test_without_a_kek_research_is_unavailable(
    db: AsyncSession, session_client: Any, openrouter_mock: OpenRouterMock
) -> None:
    _, c = await owner_client(db, session_client)
    with kek_env(None):
        r = await c.put("/v1/workspace/ai-settings/key", json={"key": FAKE_KEY})
        assert r.status_code == 503 and r.json()["error"]["code"] == "research_unavailable"
        body = (await c.get("/v1/workspace/ai-settings")).json()
        assert body["kek_configured"] is False and body["research_available"] is False
    assert openrouter_mock.calls == []


async def test_lost_kek_makes_the_key_unreadable_and_rotation_rewraps(
    db: AsyncSession, session_client: Any, openrouter_mock: OpenRouterMock
) -> None:
    ws, c = await owner_client(db, session_client)
    first = secrets.gen_kek_line("k1")
    with kek_env(first):
        assert (
            await c.put("/v1/workspace/ai-settings/key", json={"key": FAKE_KEY})
        ).status_code == 200
    second = secrets.gen_kek_line("k2")
    with kek_env(second):
        body = (await c.get("/v1/workspace/ai-settings")).json()
        assert body["key_status"] == "unreadable" and body["research_available"] is False
        with pytest.raises(NoAiKey):
            await ai_svc.open_key(db, ws.id)
    with kek_env(second, previous=first):
        assert await ai_svc.open_key(db, ws.id) == FAKE_KEY
        counts = await ai_svc.rotate_all(db)
        assert counts["rewrapped"] >= 1 and FAKE_KEY not in json.dumps(counts)
    with kek_env(second):  # the old KEK can go now
        assert await ai_svc.open_key(db, ws.id) == FAKE_KEY
        assert (await c.get("/v1/workspace/ai-settings")).json()["key_status"] == "ok"


async def test_models_endpoint_lists_capabilities(
    db: AsyncSession, session_client: Any, openrouter_mock: OpenRouterMock
) -> None:
    ws = await make_workspace(db)
    viewer = await add_member(db, ws, role="viewer")
    c = await session_client(viewer, ws)
    r = await c.get("/v1/research/models")
    assert r.status_code == 200, r.text
    by_id = {m["id"]: m for m in r.json()["data"]}
    assert by_id["perplexity/sonar"]["native_search"] is True
    assert by_id["perplexity/sonar"]["supports_structured"] is False
    opus = by_id["anthropic/claude-opus-5.5"]
    assert opus["supports_structured"] and opus["supports_file"]
    assert opus["prompt_per_mtok_usd"] == pytest.approx(4.0)
    assert opus["completion_per_mtok_usd"] == pytest.approx(20.0)
    await c.get("/v1/research/models")
    assert openrouter_mock.count("GET", "/models") == 1
    # After the cache warms, GET ai-settings estimates use live prices (still no extra call).
    assert (await c.get("/v1/workspace/ai-settings")).json()["estimates"]["best"] > 0
    assert openrouter_mock.count("GET", "/models") == 1


async def test_models_endpoint_when_openrouter_is_down(
    db: AsyncSession, session_client: Any, openrouter_mock: OpenRouterMock
) -> None:
    _, c = await owner_client(db, session_client)
    openrouter_mock.route("GET", "/models", httpx.Response(502))
    r = await c.get("/v1/research/models")
    assert r.status_code == 503 and r.json()["error"]["code"] == "openrouter_unavailable"
