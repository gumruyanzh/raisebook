"""OpenRouter HTTP client (RESEARCH-PLAN §4.2). No SDK: plain ``httpx``.

- ``GET /key`` validates a workspace's key when it is saved (R12).
- ``GET /models`` (public, no key): model ids, prices and capabilities for presets, the
  Advanced picker and estimates.
- ``POST /chat/completions`` (:meth:`OpenRouterClient.chat`): the identity, search, writer and
  prefill calls of the research pipeline. Search runs inside OpenRouter (Perplexity Sonar's
  own search, or the ``web`` plugin for any other model): Raisebook never fetches pages.

Rules:

- Raisebook only ever calls OpenRouter with the **workspace's own key** (R12) and never pays.
- The key lives only in this module's call scope: it becomes an ``Authorization`` header per
  request and is never logged, stored on the client's ``repr`` or put in an error message.
- Error messages never include OpenRouter's response body. They carry a stable ``code`` and
  whether a retry can help (``transient``).
- Tests never reach the network: :func:`set_transport` installs an ``httpx.MockTransport``
  (the test suite installs a refusing transport by default).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx

from raisebook import __version__
from raisebook.config import get_settings

REFERER = "https://raisebook.org"
TITLE = "Raisebook"
MODELS_CACHE_TTL_S = 6 * 3600

_transport: httpx.AsyncBaseTransport | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    """Route every OpenRouter request through ``transport`` (tests), or the network (None)."""
    global _transport
    _transport = transport
    reset_models_cache()


def get_transport() -> httpx.AsyncBaseTransport | None:
    return _transport


class OpenRouterError(Exception):
    """A failed OpenRouter call. ``code`` is safe to store and show; nothing else is kept."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int | None = None,
        transient: bool = False,
        retry_after_s: float | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.transient = transient
        self.retry_after_s = retry_after_s


@dataclass(frozen=True)
class KeyInfo:
    label: str | None
    limit_usd: float | None
    limit_remaining_usd: float | None
    usage_usd: float | None
    is_free_tier: bool


def _price(raw: Any) -> Decimal:
    try:
        value = Decimal(str(raw))
    except (InvalidOperation, ValueError):
        return Decimal(0)
    return value if value > 0 else Decimal(0)


@dataclass(frozen=True)
class ModelInfo:
    """One OpenRouter model. Prices are USD **per token** (``prompt``/``completion``) and
    per call (``web_search``, ``request``), as OpenRouter publishes them."""

    id: str
    name: str
    prompt: Decimal = Decimal(0)
    completion: Decimal = Decimal(0)
    web_search: Decimal = Decimal(0)
    request: Decimal = Decimal(0)
    context_length: int | None = None
    supported_parameters: frozenset[str] = field(default_factory=frozenset)
    input_modalities: frozenset[str] = field(default_factory=frozenset)

    @property
    def supports_structured(self) -> bool:
        return bool({"structured_outputs", "response_format"} & self.supported_parameters)

    @property
    def supports_file(self) -> bool:
        return "file" in self.input_modalities

    @property
    def has_native_search(self) -> bool:
        """Perplexity Sonar style: searches by itself (``web_search_options``)."""
        return "web_search_options" in self.supported_parameters

    @classmethod
    def from_api(cls, raw: dict[str, Any]) -> ModelInfo | None:
        model_id = raw.get("id")
        if not isinstance(model_id, str) or not model_id:
            return None
        pricing = raw.get("pricing") if isinstance(raw.get("pricing"), dict) else {}
        arch = raw.get("architecture") if isinstance(raw.get("architecture"), dict) else {}
        params = raw.get("supported_parameters") or []
        modalities = (arch or {}).get("input_modalities") or []
        ctx = raw.get("context_length")
        return cls(
            id=model_id,
            name=str(raw.get("name") or model_id)[:200],
            prompt=_price((pricing or {}).get("prompt")),
            completion=_price((pricing or {}).get("completion")),
            web_search=_price((pricing or {}).get("web_search")),
            request=_price((pricing or {}).get("request")),
            context_length=ctx if isinstance(ctx, int) else None,
            supported_parameters=frozenset(p for p in params if isinstance(p, str)),
            input_modalities=frozenset(m for m in modalities if isinstance(m, str)),
        )


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if not raw:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        return None


def error_for_status(resp: httpx.Response) -> OpenRouterError:
    """Map an HTTP failure to a safe error (no response body in the message)."""
    status = resp.status_code
    if status in (401, 403):
        return OpenRouterError(
            "openrouter_key_rejected",
            "OpenRouter rejected the workspace's key. An owner can replace it in Settings → "
            "AI research.",
            status=status,
        )
    if status == 402:
        return OpenRouterError(
            "openrouter_out_of_credits",
            "The OpenRouter account behind this key is out of credits. Add credits at "
            "openrouter.ai, then resume.",
            status=status,
        )
    if status in (408, 429) or status >= 500:
        return OpenRouterError(
            "openrouter_unavailable",
            "OpenRouter is busy or did not answer. Raisebook will retry.",
            status=status,
            transient=True,
            retry_after_s=_retry_after(resp),
        )
    return OpenRouterError(
        "openrouter_bad_request",
        "OpenRouter refused the request (a model id may no longer exist). Check the models in "
        "Settings → AI research.",
        status=status,
    )


class OpenRouterClient:
    """One client per use. ``key`` may be None for public endpoints (``/models``)."""

    def __init__(
        self,
        key: str | None = None,
        *,
        base_url: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_s: float | None = None,
    ) -> None:
        settings = get_settings()
        self._key = key
        self._base_url = (base_url or settings.openrouter_base_url).rstrip("/")
        self._transport = transport if transport is not None else _transport
        self._timeout = timeout_s if timeout_s is not None else settings.openrouter_timeout_s

    def __repr__(self) -> str:
        return f"<OpenRouterClient {self._base_url} key={'set' if self._key else 'none'}>"

    def _headers(self, *, auth: bool) -> dict[str, str]:
        headers = {
            "HTTP-Referer": REFERER,
            "X-Title": TITLE,
            "User-Agent": f"raisebook/{__version__}",
            "Accept": "application/json",
        }
        if auth:
            if not self._key:
                raise OpenRouterError("no_ai_key", "This call needs an OpenRouter key.")
            headers["Authorization"] = f"Bearer {self._key}"
        return headers

    async def _request(
        self, method: str, path: str, *, auth: bool, json: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        headers = self._headers(auth=auth)
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=self._timeout, follow_redirects=False
            ) as http:
                resp = await http.request(
                    method, f"{self._base_url}{path}", headers=headers, json=json
                )
        except httpx.TimeoutException as exc:
            raise OpenRouterError(
                "openrouter_unavailable",
                "OpenRouter did not answer in time. Raisebook will retry.",
                transient=True,
            ) from exc
        except httpx.HTTPError as exc:
            raise OpenRouterError(
                "openrouter_unavailable",
                "Could not reach OpenRouter. Raisebook will retry.",
                transient=True,
            ) from exc
        if resp.status_code >= 400:
            raise error_for_status(resp)
        try:
            body = resp.json()
        except ValueError as exc:
            raise OpenRouterError(
                "openrouter_unavailable",
                "OpenRouter sent a malformed answer. Raisebook will retry.",
                status=resp.status_code,
                transient=True,
            ) from exc
        if not isinstance(body, dict):
            raise OpenRouterError(
                "openrouter_unavailable",
                "OpenRouter sent a malformed answer. Raisebook will retry.",
                status=resp.status_code,
                transient=True,
            )
        return body

    async def check_key(self) -> KeyInfo:
        """``GET /key``: is this key valid, and what is its label and limit (R12)."""
        body = await self._request("GET", "/key", auth=True)
        data = body.get("data") if isinstance(body.get("data"), dict) else {}

        def num(name: str) -> float | None:
            v = (data or {}).get(name)
            return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None

        label = (data or {}).get("label")
        return KeyInfo(
            label=label[:200] if isinstance(label, str) and label else None,
            limit_usd=num("limit"),
            limit_remaining_usd=num("limit_remaining"),
            usage_usd=num("usage"),
            is_free_tier=bool((data or {}).get("is_free_tier", False)),
        )

    async def chat(
        self,
        model: str,
        messages: list[dict[str, Any]],
        *,
        max_tokens: int,
        plugins: list[dict[str, Any]] | None = None,
        web_search_options: dict[str, Any] | None = None,
        response_format: dict[str, Any] | None = None,
        temperature: float | None = None,
    ) -> ChatResult:
        """``POST /chat/completions`` (non-streaming) with the workspace's key."""
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": False,
            "usage": {"include": True},
        }
        if plugins:
            payload["plugins"] = plugins
        if web_search_options:
            payload["web_search_options"] = web_search_options
        if response_format:
            payload["response_format"] = response_format
        if temperature is not None:
            payload["temperature"] = temperature
        body = await self._request("POST", "/chat/completions", auth=True, json=payload)
        return parse_chat(body, model)

    async def list_models(self) -> dict[str, ModelInfo]:
        """``GET /models`` (public): every model by id."""
        body = await self._request("GET", "/models", auth=False)
        rows = body.get("data")
        out: dict[str, ModelInfo] = {}
        for raw in rows if isinstance(rows, list) else []:
            if isinstance(raw, dict):
                info = ModelInfo.from_api(raw)
                if info is not None:
                    out[info.id] = info
        return out


@dataclass(frozen=True)
class WebSource:
    """One page a search call cited (from ``url_citation`` annotations)."""

    url: str
    title: str | None = None
    snippet: str | None = None
    published_at: str | None = None


@dataclass(frozen=True)
class CallUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_micros: int | None = None  # None: OpenRouter reported no cost (the caller prices it)


@dataclass(frozen=True)
class ChatResult:
    content: str
    sources: list[WebSource]
    usage: CallUsage
    generation_id: str | None
    model: str


def _str(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:limit] if text else None


def _int(value: Any) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0


def parse_sources(body: dict[str, Any], message: dict[str, Any]) -> list[WebSource]:
    """Cited pages: ``message.annotations[type=url_citation]`` (OpenRouter normalizes these for
    every provider), else a top-level ``search_results`` / ``citations`` list. Deduped by URL."""
    out: list[WebSource] = []
    seen: set[str] = set()

    def add(url: Any, title: Any = None, snippet: Any = None, date: Any = None) -> None:
        u = _str(url, 2000)
        if not u or not u.lower().startswith(("http://", "https://")) or u in seen:
            return
        seen.add(u)
        out.append(WebSource(u, _str(title, 300), _str(snippet, 4000), _str(date, 40)))

    for ann in message.get("annotations") or []:
        if not isinstance(ann, dict) or ann.get("type") != "url_citation":
            continue
        nested = ann.get("url_citation")
        cit: dict[str, Any] = nested if isinstance(nested, dict) else ann
        add(cit.get("url"), cit.get("title"), cit.get("content"), cit.get("date"))
    if out:
        return out
    for item in body.get("search_results") or []:
        if isinstance(item, dict):
            add(item.get("url"), item.get("title"), item.get("snippet"), item.get("date"))
    for item in body.get("citations") or []:
        add(item)
    return out


def _body_error(body: dict[str, Any]) -> OpenRouterError | None:
    """OpenRouter can answer 200 with an ``error`` object (a provider failed mid-request)."""
    err = body.get("error")
    if not isinstance(err, dict):
        return None
    code = err.get("code")
    status = code if isinstance(code, int) else 502
    return error_for_status(httpx.Response(status))


def parse_chat(body: dict[str, Any], model: str) -> ChatResult:
    failure = _body_error(body)
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise failure or OpenRouterError(
            "openrouter_unavailable",
            "OpenRouter sent an answer without a message. Raisebook will retry.",
            transient=True,
        )
    message = choices[0].get("message") if isinstance(choices[0].get("message"), dict) else {}
    content = (message or {}).get("content")
    if isinstance(content, list):  # content parts
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    usage_raw = body.get("usage") if isinstance(body.get("usage"), dict) else {}
    cost = (usage_raw or {}).get("cost")
    cost_micros = (
        round(float(cost) * 1_000_000)
        if isinstance(cost, int | float) and not isinstance(cost, bool) and cost >= 0
        else None
    )
    return ChatResult(
        content=content if isinstance(content, str) else "",
        sources=parse_sources(body, message or {}),
        usage=CallUsage(
            prompt_tokens=_int((usage_raw or {}).get("prompt_tokens")),
            completion_tokens=_int((usage_raw or {}).get("completion_tokens")),
            cost_micros=cost_micros,
        ),
        generation_id=_str(body.get("id"), 200),
        model=_str(body.get("model"), 200) or model,
    )


def is_native_search(model_id: str, info: ModelInfo | None = None) -> bool:
    """Perplexity Sonar models search by themselves; others need the ``web`` plugin."""
    if info is not None and info.has_native_search:
        return True
    return model_id.startswith("perplexity/")


def search_options(
    model_id: str,
    *,
    context_size: str = "medium",
    max_results: int = 8,
    info: ModelInfo | None = None,
) -> dict[str, Any]:
    """Request fields that make ``model_id`` search the web (RESEARCH-PLAN §4.2)."""
    opts: dict[str, Any] = {"web_search_options": {"search_context_size": context_size}}
    if not is_native_search(model_id, info):
        opts["plugins"] = [{"id": "web", "max_results": max_results}]
    return opts


# --- the models cache --------------------------------------------------------------------
_models: dict[str, ModelInfo] | None = None
_models_at: float = 0.0


def reset_models_cache() -> None:
    global _models, _models_at
    _models = None
    _models_at = 0.0


def cached_models() -> dict[str, ModelInfo] | None:
    """The cached models list if it is fresh, without any network call."""
    if _models is not None and time.monotonic() - _models_at < MODELS_CACHE_TTL_S:
        return _models
    return None


async def models(*, refresh: bool = False) -> dict[str, ModelInfo]:
    """The models list, from the 6-hour in-process cache or ``GET /models``."""
    global _models, _models_at
    if not refresh:
        hit = cached_models()
        if hit is not None:
            return hit
    fresh = await OpenRouterClient().list_models()
    _models, _models_at = fresh, time.monotonic()
    return fresh
