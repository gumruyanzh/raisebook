"""MCP transport (SPEC §6.1): /mcp auth, protocol, instructions, tool_call plumbing,
agent attribution headers and workspace isolation at the transport level."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core.ratelimit import LIMITS, Limit
from raisebook.mcp.server import SERVER_INSTRUCTIONS
from raisebook.mcp.tools import TOOL_MODULES
from tests.factories import make_api_key, make_investor, make_workspace

INIT = {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {"name": "pytest", "version": "0"},
}


@pytest.fixture
def probe(monkeypatch: Any) -> None:
    monkeypatch.setattr("raisebook.mcp.tools.TOOL_MODULES", [*TOOL_MODULES, "tests.mcp_probe"])


async def test_requires_api_key(mcp_rpc: Any) -> None:
    r = await mcp_rpc(None, "initialize", INIT)
    assert r.status_code == 401 and "Bearer" in r.headers["www-authenticate"]
    r = await mcp_rpc("rb_live_" + "a" * 32, "initialize", INIT)
    assert r.status_code == 401


async def test_session_cookie_is_not_accepted(
    db: AsyncSession, app: Any, session_client: Any
) -> None:
    import httpx

    from tests.factories import owner_of

    ws = await make_workspace(db)
    c = await session_client(await owner_of(db, ws), ws)
    r = await c.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": INIT},
        headers={"accept": "application/json, text/event-stream"},
    )
    assert r.status_code == 401
    assert isinstance(c, httpx.AsyncClient)


async def test_initialize_and_instructions(db: AsyncSession, mcp_rpc: Any) -> None:
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws, scopes="read")
    r = await mcp_rpc(raw, "initialize", INIT)
    assert r.status_code == 200, r.text
    result = r.json()["result"]
    assert result["serverInfo"]["name"] == "raisebook"
    assert result["instructions"] == SERVER_INSTRUCTIONS
    assert result["instructions"].startswith("Raisebook is the founder's fundraising CRM")
    assert "import_investors_csv defaults to dry_run=true" in result["instructions"]


async def test_tools_list_has_annotations(db: AsyncSession, mcp_rpc: Any, probe: None) -> None:
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws, scopes="read")
    r = await mcp_rpc(raw, "tools/list", {})
    tools = {t["name"]: t for t in r.json()["result"]["tools"]}
    assert {"probe_whoami", "probe_write"} <= set(tools)
    assert tools["probe_whoami"]["annotations"]["readOnlyHint"] is True
    assert tools["probe_write"]["annotations"]["readOnlyHint"] is False
    assert tools["probe_write"]["annotations"]["destructiveHint"] is False
    assert "ctx" not in tools["probe_write"]["inputSchema"].get("properties", {})


async def test_tool_call_context_and_agent_attribution(
    db: AsyncSession, mcp_call: Any, probe: None, frozen_now: Any
) -> None:
    ws = await make_workspace(db, timezone="Europe/Berlin", currency="EUR")
    key, raw = await make_api_key(db, ws, name="Laptop", agent_name="codex")
    res = await mcp_call(raw, "probe_whoami")
    assert res.ok, res.text
    assert res.data["workspace_id"] == str(ws.id) and res.data["slug"] == ws.slug
    assert res.data["timezone"] == "Europe/Berlin" and res.data["currency"] == "EUR"
    assert res.data["actor"] == {
        "type": "agent",
        "via": "mcp",
        "label": "codex",  # the key's agent_name
        "model": None,
        "api_key_id": str(key.id),
    }
    assert res.data["now"] == frozen_now.isoformat()
    res = await mcp_call(
        raw,
        "probe_whoami",
        headers={"X-Agent-Name": "claude-code", "X-Agent-Model": "claude-opus-5-5"},
    )
    assert res.data["actor"]["label"] == "claude-code"
    assert res.data["actor"]["model"] == "claude-opus-5-5"
    res = await mcp_call(raw, "probe_whoami", headers={"X-Agent-Name": "<script>"})
    assert res.data["actor"]["label"] == "codex"  # invalid header values are ignored
    _, unnamed = await make_api_key(db, ws, name="Plain key")
    res = await mcp_call(unnamed, "probe_whoami")
    assert res.data["actor"]["label"] == "Plain key"


async def test_write_tool_needs_write_scope(db: AsyncSession, mcp_call: Any, probe: None) -> None:
    ws = await make_workspace(db)
    inv = await make_investor(db, ws)
    _, reader = await make_api_key(db, ws, scopes="read")
    res = await mcp_call(reader, "probe_write", {"investor_id": str(inv.id)})
    assert not res.ok and res.code == "insufficient_scope"
    assert "raisebook:write" in res.text
    _, writer = await make_api_key(db, ws, scopes="read,write")
    res = await mcp_call(writer, "probe_write", {"investor_id": str(inv.id)})
    assert res.ok, res.text
    await db.refresh(inv)
    assert inv.title == "Probed"


async def test_tool_errors_roll_back_and_map_codes(
    db: AsyncSession, mcp_call: Any, probe: None
) -> None:
    a = await make_workspace(db)
    b = await make_workspace(db)
    inv_b = await make_investor(db, b)
    _, raw_a = await make_api_key(db, a)
    res = await mcp_call(raw_a, "probe_write", {"investor_id": str(inv_b.id)})
    assert not res.ok and res.code == "not_found"
    await db.refresh(inv_b)
    assert inv_b.title is None


async def test_revoked_key_is_rejected(db: AsyncSession, mcp_rpc: Any) -> None:
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws, revoked=True)
    assert (await mcp_rpc(raw, "tools/list", {})).status_code == 401


async def test_protocol_rate_limit(db: AsyncSession, mcp_rpc: Any, monkeypatch: Any) -> None:
    monkeypatch.setitem(LIMITS, "mcp_protocol", Limit(2, 60))
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws)
    assert (await mcp_rpc(raw, "tools/list", {})).status_code == 200
    assert (await mcp_rpc(raw, "tools/list", {})).status_code == 200
    r = await mcp_rpc(raw, "tools/list", {})
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"


async def test_tool_rate_limit_is_a_tool_error(
    db: AsyncSession, mcp_call: Any, monkeypatch: Any, probe: None
) -> None:
    monkeypatch.setitem(LIMITS, "key_read", Limit(1, 60))
    ws = await make_workspace(db)
    _, raw = await make_api_key(db, ws)
    assert (await mcp_call(raw, "probe_whoami")).ok
    res = await mcp_call(raw, "probe_whoami")
    assert not res.ok and res.code == "rate_limited" and "retry after" in res.text


async def test_exact_path_does_not_redirect(client: Any) -> None:
    r = await client.post("/mcp", json={}, headers={"accept": "application/json"})
    assert r.status_code == 401  # auth runs at /mcp itself: no 307 to /mcp/
