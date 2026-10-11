"""Workspace isolation over MCP (SPEC §8.4, §9.2.3). Owner: API+MCP (AM).

For **every** tool in ``tools/list`` (a new tool without a case here fails
:func:`test_every_tool_is_covered`), A's API key addressing B's investors (by id, email,
LinkedIn URL, name, "Name @ Firm") or rounds (by id, slug, name) gets ``not_found``;
searches and lists never show B's rows; creates land in A; and B is unchanged.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.isolation.test_rest_isolation import (
    B_EMAIL,
    B_LINKEDIN,
    B_NAME,
    Two,
    no_b,
    snapshot_b,
    two_workspaces,
)

Call = Callable[..., Awaitable[Any]]
Case = Callable[[Call, Two], Awaitable[None]]
CASES: dict[str, Case] = {}


def case(name: str) -> Callable[[Case], Case]:
    def deco(fn: Case) -> Case:
        CASES[name] = fn
        return fn

    return deco


def b_investor_refs(t: Two) -> list[str]:
    return [str(t.b_inv.id), B_EMAIL, B_LINKEDIN, B_NAME, f"{B_NAME} @ Quill Ventures"]


def b_round_refs(t: Two) -> list[str]:
    return [str(t.b_round.id), t.b_round.slug, t.b_round.name]


def not_found(res: Any) -> None:
    assert not res.ok, res.data
    assert res.code == "not_found", res.text


def clean(res: Any, t: Two) -> None:
    assert res.ok, res.text
    no_b(json.dumps(res.data), t)


@case("get_workspace")
async def _ws(call: Call, t: Two) -> None:
    res = await call("get_workspace")
    clean(res, t)
    assert res.data["workspace"]["id"] == str(t.a.id)


@case("list_rounds")
async def _rounds(call: Call, t: Two) -> None:
    clean(await call("list_rounds", {"status": "all"}), t)


@case("get_round_summary")
async def _summary(call: Call, t: Two) -> None:
    for ref in b_round_refs(t):
        not_found(await call("get_round_summary", {"round": ref}))
    clean(await call("get_round_summary"), t)  # the single open round is A's


@case("search_investors")
async def _search(call: Call, t: Two) -> None:
    for q in ("Blake", "quill", "secret-tag", "private notes", B_EMAIL):
        res = await call("search_investors", {"query": q})
        clean(res, t)
        assert res.data["total"] == 0
    res = await call("search_investors", {"tags": ["secret-tag"]})
    assert res.data["total"] == 0
    not_found(await call("search_investors", {"round": t.b_round.slug}))
    clean(await call("search_investors", {"fit_min": 0}), t)


@case("get_investor")
async def _get(call: Call, t: Two) -> None:
    for ref in b_investor_refs(t):
        res = await call("get_investor", {"investor": ref})
        not_found(res)
        assert str(t.b_inv.id) not in res.text.replace(ref, "")


@case("add_investor")
async def _add(call: Call, t: Two) -> None:
    res = await call("add_investor", {"name": B_NAME, "email": B_EMAIL, "linkedin": B_LINKEDIN})
    assert res.ok and res.data["created"] is True, res.text
    assert res.data["investor"]["id"] != str(t.b_inv.id)
    not_found(await call("add_investor", {"name": "Someone New", "round": t.b_round.slug}))


@case("add_investors")
async def _add_many(call: Call, t: Two) -> None:
    items = [{"name": B_NAME, "email": B_EMAIL}, {"name": "Someone Else"}]
    res = await call("add_investors", {"items": items})
    assert res.ok, res.text
    assert [r["created"] for r in res.data["results"]] == [True, True]
    assert str(t.b_inv.id) not in json.dumps(res.data)
    res = await call("add_investors", {"items": [{"name": "Other"}], "round": t.b_round.slug})
    assert res.ok and res.data["results"][0]["error"].startswith("not_found"), res.text


@case("create_round")
async def _create_round(call: Call, t: Two) -> None:
    res = await call("create_round", {"name": t.b_round.name})
    assert res.ok and res.data["created"] is True, res.text  # B's round name is free in A
    assert res.data["round"]["id"] != str(t.b_round.id)


@case("update_investor")
async def _update(call: Call, t: Two) -> None:
    for ref in b_investor_refs(t):
        not_found(await call("update_investor", {"investor": ref, "set": {"title": "Hacked"}}))


@case("add_to_round")
async def _add_to_round(call: Call, t: Two) -> None:
    for ref in b_investor_refs(t):
        not_found(await call("add_to_round", {"investor": ref, "round": "seed"}))
    for ref in b_round_refs(t):
        not_found(await call("add_to_round", {"investor": str(t.a_inv.id), "round": ref}))


@case("move_stage")
async def _move(call: Call, t: Two) -> None:
    for ref in b_investor_refs(t):
        not_found(await call("move_stage", {"investor": ref, "stage": "passed", "round": "seed"}))
    for ref in b_round_refs(t):
        not_found(
            await call("move_stage", {"investor": str(t.a_inv.id), "stage": "passed", "round": ref})
        )


@case("log_activity")
async def _log(call: Call, t: Two) -> None:
    for ref in b_investor_refs(t):
        not_found(await call("log_activity", {"investor": ref, "kind": "note", "body": "x"}))
    not_found(
        await call(
            "log_activity",
            {"investor": str(t.a_inv.id), "kind": "note", "body": "x", "round": t.b_round.slug},
        )
    )


@case("set_follow_up")
async def _follow(call: Call, t: Two) -> None:
    for ref in b_investor_refs(t):
        not_found(await call("set_follow_up", {"investor": ref, "clear": True, "round": "seed"}))
    not_found(
        await call(
            "set_follow_up", {"investor": str(t.a_inv.id), "clear": True, "round": t.b_round.name}
        )
    )


@case("list_due_follow_ups")
async def _due(call: Call, t: Two) -> None:
    clean(await call("list_due_follow_ups", {"within_days": 60}), t)
    not_found(await call("list_due_follow_ups", {"round": t.b_round.slug}))


@case("record_commitment")
async def _commit(call: Call, t: Two) -> None:
    for ref in b_investor_refs(t):
        not_found(await call("record_commitment", {"investor": ref, "amount": 1, "round": "seed"}))
    not_found(
        await call(
            "record_commitment",
            {"investor": str(t.a_inv.id), "amount": 1, "round": str(t.b_round.id)},
        )
    )


@case("import_investors_csv")
async def _import(call: Call, t: Two) -> None:
    csv = f"Name,Email,LinkedIn\n{B_NAME},{B_EMAIL},{B_LINKEDIN}\n"
    res = await call("import_investors_csv", {"csv": csv})
    assert res.ok, res.text
    assert res.data["counts"]["create"] == 1  # no match against B
    not_found(await call("import_investors_csv", {"csv": csv, "round": t.b_round.slug}))


@case("export_round")
async def _export(call: Call, t: Two) -> None:
    for ref in b_round_refs(t):
        not_found(await call("export_round", {"round": ref}))
    res = await call("export_round", {"format": "json", "include_activities": True})
    clean(res, t)


async def test_every_tool_is_covered(db: AsyncSession, mcp_rpc: Any) -> None:
    t = await two_workspaces(db)
    r = await mcp_rpc(t.a_key, "tools/list", {})
    names = {tool["name"] for tool in r.json()["result"]["tools"]}
    missing = names - set(CASES)
    assert not missing, f"add MCP isolation cases for: {sorted(missing)}"


@pytest.mark.parametrize("tool", sorted(CASES))
async def test_a_key_cannot_reach_b(
    tool: str, db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    t = await two_workspaces(db)
    before = await snapshot_b(db, t)

    async def call(name: str, args: dict[str, Any] | None = None) -> Any:
        return await mcp_call(t.a_key, name, args or {}, headers={"X-Workspace": t.b.slug})

    await CASES[tool](call, t)
    assert await snapshot_b(db, t) == before
