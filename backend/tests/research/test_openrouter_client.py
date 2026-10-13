"""The OpenRouter chat client (services/openrouter.py; RESEARCH-PLAN §4.2). Mocked transport."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from raisebook.schemas.dossier import WriterDoc, response_format
from raisebook.services import openrouter
from tests.research.openrouter_mock import FAKE_KEY
from tests.research.pipeline_mock import chat, page


async def test_search_request_shape_and_annotations(openrouter_mock: Any) -> None:
    openrouter_mock.route(
        "POST",
        "/chat/completions",
        chat(
            "prose",
            annotations=[
                page("https://harborlight.example/a", "A", "snippet a", "2026-01-02"),
                page("https://harborlight.example/a", "dup"),
                {"type": "file_annotation", "url": "https://x.example"},
                page("javascript:alert(1)", "bad"),
            ],
            cost=0.0123456,
            gen_id="gen-1",
            model="perplexity/sonar-pro",
        ),
    )
    client = openrouter.OpenRouterClient(FAKE_KEY)
    opts = openrouter.search_options("perplexity/sonar-pro")
    res = await client.chat(
        "perplexity/sonar-pro", [{"role": "user", "content": "q"}], max_tokens=1200, **opts
    )
    call = openrouter_mock.calls[-1]
    body = json.loads(call.body)
    assert call.path == "/api/v1/chat/completions"
    assert call.headers["authorization"] == f"Bearer {FAKE_KEY}"
    assert call.headers["x-title"] == "Raisebook"
    assert call.headers["http-referer"] == "https://raisebook.org"
    assert body["web_search_options"] == {"search_context_size": "medium"}
    assert "plugins" not in body and body["stream"] is False and body["max_tokens"] == 1200
    assert [s.url for s in res.sources] == ["https://harborlight.example/a"]
    assert res.sources[0].snippet == "snippet a" and res.sources[0].published_at == "2026-01-02"
    assert res.usage.cost_micros == 12346 and res.generation_id == "gen-1"
    assert res.model == "perplexity/sonar-pro"


def test_non_sonar_models_get_the_web_plugin() -> None:
    opts = openrouter.search_options("openai/gpt-5.6-terra", max_results=8)
    assert opts["plugins"] == [{"id": "web", "max_results": 8}]
    assert openrouter.search_options("perplexity/sonar", context_size="low") == {
        "web_search_options": {"search_context_size": "low"}
    }


async def test_writer_request_shape(openrouter_mock: Any) -> None:
    openrouter_mock.route("POST", "/chat/completions", chat("{}", cost=None))
    client = openrouter.OpenRouterClient(FAKE_KEY)
    res = await client.chat(
        "anthropic/claude-opus-5.5",
        [{"role": "user", "content": "x"}],
        max_tokens=6000,
        response_format=response_format("raisebook_dossier_v1", WriterDoc),
        temperature=0.2,
    )
    body = json.loads(openrouter_mock.calls[-1].body)
    assert body["response_format"]["json_schema"]["name"] == "raisebook_dossier_v1"
    assert body["response_format"]["json_schema"]["strict"] is True
    assert body["temperature"] == 0.2 and body["usage"] == {"include": True}
    assert res.usage.cost_micros is None  # the caller prices it and flags it estimated


def test_citations_fallback() -> None:
    body = {
        "choices": [{"message": {"content": "x"}}],
        "citations": ["https://a.example/1", "https://b.example/2", 3],
    }
    res = openrouter.parse_chat(body, "perplexity/sonar")
    assert [s.url for s in res.sources] == ["https://a.example/1", "https://b.example/2"]
    body = {
        "choices": [{"message": {"content": "x"}}],
        "search_results": [{"url": "https://c.example", "title": "C", "date": "2026-02-01"}],
    }
    assert openrouter.parse_chat(body, "m").sources[0].title == "C"


@pytest.mark.parametrize(
    ("status", "code", "transient"),
    [
        (401, "openrouter_key_rejected", False),
        (403, "openrouter_key_rejected", False),
        (402, "openrouter_out_of_credits", False),
        (400, "openrouter_bad_request", False),
        (408, "openrouter_unavailable", True),
        (429, "openrouter_unavailable", True),
        (502, "openrouter_unavailable", True),
    ],
)
async def test_error_mapping(openrouter_mock: Any, status: int, code: str, transient: bool) -> None:
    openrouter_mock.route(
        "POST",
        "/chat/completions",
        httpx.Response(
            status,
            headers={"Retry-After": "30"},
            json={"error": {"message": f"bad key {FAKE_KEY} body text"}},
        ),
    )
    with pytest.raises(openrouter.OpenRouterError) as info:
        await openrouter.OpenRouterClient(FAKE_KEY).chat("m/x", [], max_tokens=10)
    err = info.value
    assert (err.code, err.transient) == (code, transient)
    assert FAKE_KEY not in str(err) and "body text" not in err.message
    if transient and status == 429:
        assert err.retry_after_s == 30.0


async def test_timeouts_and_body_errors_are_transient(openrouter_mock: Any) -> None:
    def boom(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    openrouter_mock.route("POST", "/chat/completions", boom)
    with pytest.raises(openrouter.OpenRouterError) as info:
        await openrouter.OpenRouterClient(FAKE_KEY).chat("m/x", [], max_tokens=10)
    assert info.value.transient
    openrouter_mock.route(
        "POST", "/chat/completions", httpx.Response(200, json={"error": {"code": 402}})
    )
    with pytest.raises(openrouter.OpenRouterError) as info:
        await openrouter.OpenRouterClient(FAKE_KEY).chat("m/x", [], max_tokens=10)
    assert info.value.code == "openrouter_out_of_credits"


def test_client_repr_hides_the_key() -> None:
    assert FAKE_KEY not in repr(openrouter.OpenRouterClient(FAKE_KEY))
