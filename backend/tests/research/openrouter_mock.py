"""A fake OpenRouter for tests (``httpx.MockTransport``): no request ever leaves the process.

``OpenRouterMock`` answers ``GET /models`` from the recorded fixture and ``GET /key`` with a
fictional key label. Override a route with ``mock.route("GET", "/key", handler_or_response)``;
every request is kept in ``mock.calls`` (method, path, headers) for assertions.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

FIXTURES = Path(__file__).parent / "fixtures"
FAKE_KEY = "sk-or-v1-" + "a1b2c3d4e5f6" * 5 + "9z8y"  # fictional; 69 chars, ends in 9z8y
OTHER_FAKE_KEY = "sk-or-v1-" + "0f1e2d3c4b5a" * 5 + "q7w8"


def models_fixture() -> dict[str, Any]:
    doc: dict[str, Any] = json.loads((FIXTURES / "openrouter_models.json").read_text())
    return {"data": doc["data"]}


Handler = Callable[[httpx.Request], httpx.Response]


@dataclass
class Call:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes


@dataclass
class OpenRouterMock:
    routes: dict[tuple[str, str], Handler] = field(default_factory=dict)
    calls: list[Call] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.route("GET", "/api/v1/models", httpx.Response(200, json=models_fixture()))
        self.route(
            "GET",
            "/api/v1/key",
            httpx.Response(
                200,
                json={
                    "data": {
                        "label": "Harbor test key",
                        "limit": 50.0,
                        "limit_remaining": 48.5,
                        "usage": 1.5,
                        "is_free_tier": False,
                    }
                },
            ),
        )

    def route(self, method: str, path: str, answer: Handler | httpx.Response) -> None:
        if not path.startswith("/api/v1"):
            path = "/api/v1" + path
        if isinstance(answer, httpx.Response):
            fixed = answer

            def handler(_: httpx.Request) -> httpx.Response:
                return httpx.Response(
                    fixed.status_code, headers=fixed.headers, content=fixed.content
                )

            self.routes[(method, path)] = handler
        else:
            self.routes[(method, path)] = answer

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(
            Call(request.method, request.url.path, dict(request.headers), request.content)
        )
        handler = self.routes.get((request.method, request.url.path))
        if handler is None:
            raise AssertionError(f"unexpected OpenRouter call {request.method} {request.url.path}")
        return handler(request)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def count(self, method: str, path: str) -> int:
        if not path.startswith("/api/v1"):
            path = "/api/v1" + path
        return sum(1 for c in self.calls if (c.method, c.path) == (method, path))


def refusing_transport(attempts: list[str]) -> httpx.MockTransport:
    """Installed for every test: any OpenRouter request not mocked fails the test."""

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(f"{request.method} {request.url.path}")
        raise AssertionError(
            f"Test tried to reach OpenRouter ({request.method} {request.url.path}) without "
            "the openrouter_mock fixture. Tests never spend real money."
        )

    return httpx.MockTransport(handler)
