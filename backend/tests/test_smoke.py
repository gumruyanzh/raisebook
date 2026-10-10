from __future__ import annotations

from typing import Any

import httpx


async def test_healthz(client: httpx.AsyncClient) -> None:
    r = await client.get("/healthz")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert r.headers["x-request-id"].startswith("req_")


async def test_ready(client: httpx.AsyncClient) -> None:
    r = await client.get("/healthz/ready")
    assert r.status_code == 200


async def test_openapi(client: httpx.AsyncClient) -> None:
    r = await client.get("/v1/openapi.json")
    assert r.status_code == 200
    spec: dict[str, Any] = r.json()
    assert "/v1/auth/magic-link" in spec["paths"]
