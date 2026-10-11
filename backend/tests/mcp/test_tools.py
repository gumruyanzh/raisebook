"""MCP tools over the real ``/mcp`` route (SPEC §6, §9.2.5): tool list and annotations,
every AM tool's happy path, reference resolution, idempotency and agent attribution.

The import/export tools (IE) are covered in ``tests/mcp/test_data_tools.py``.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.api.helpers import activities_of, dana, participant, world
from tests.factories import make_api_key, make_investor, make_participant, make_round

ALL_TOOLS = {
    "get_workspace",
    "list_rounds",
    "get_round_summary",
    "search_investors",
    "get_investor",
    "add_investor",
    "update_investor",
    "add_to_round",
    "move_stage",
    "log_activity",
    "set_follow_up",
    "list_due_follow_ups",
    "record_commitment",
    "import_investors_csv",
    "export_round",
    "add_investors",
    "create_round",
}
READ_ONLY = {
    "get_workspace",
    "list_rounds",
    "get_round_summary",
    "search_investors",
    "get_investor",
    "list_due_follow_ups",
    "export_round",
}
WRITE_IDEMPOTENT = {
    "add_investor",
    "add_investors",
    "create_round",
    "add_to_round",
    "move_stage",
    "set_follow_up",
    "record_commitment",
}
WRITE_NOT_IDEMPOTENT = {"update_investor", "log_activity", "import_investors_csv"}
AGENT = {"X-Agent-Name": "claude-code", "X-Agent-Model": "claude-opus-5-5"}

# SPEC §6.4 binding descriptions: a distinctive sentence from each AM tool.
DESCRIPTION_SNIPPETS = {
    "get_workspace": "Who am I and what's here",
    "list_rounds": "Use the slug or name as `round` in other tools.",
    "get_round_summary": "what should I do today",
    "search_investors": "(all words must match)",
    "get_investor": "including agent actions",
    "add_investor": "email/LinkedIn duplicates are never created",
    "update_investor": "append_notes to add a dated paragraph",
    "add_to_round": "Safe to repeat.",
    "move_stage": "use record_commitment instead of moving to the won stage",
    "log_activity": "to make retries safe",
    "set_follow_up": "Give exactly one of `on` (YYYY-MM-DD)",
    "list_due_follow_ups": "plan the founder's outreach for the day",
    "record_commitment": "it replaces any earlier amount; it is not added to it",
}


async def test_tool_list_annotations_and_descriptions(db: AsyncSession, mcp_rpc: Any) -> None:
    w = await world(db)
    r = await mcp_rpc(w.key, "tools/list", {})
    tools = {t["name"]: t for t in r.json()["result"]["tools"]}
    assert set(tools) == ALL_TOOLS
    assert r.json()["result"]["tools"][0].get("outputSchema") is None
    # A read-only key only sees the read tools (writes would fail with insufficient_scope).
    r = await mcp_rpc(w.reader, "tools/list", {})
    assert {t["name"] for t in r.json()["result"]["tools"]} == READ_ONLY
    for name, t in tools.items():
        ann = t["annotations"]
        assert ann["destructiveHint"] is False, name
        assert ann["openWorldHint"] is False, name
        assert ann["readOnlyHint"] is (name in READ_ONLY), name
        if name in WRITE_IDEMPOTENT:
            assert ann["idempotentHint"] is True, name
        if name in WRITE_NOT_IDEMPOTENT:
            assert ann["idempotentHint"] is False, name
        assert "ctx" not in t["inputSchema"].get("properties", {}), name
    for name, snippet in DESCRIPTION_SNIPPETS.items():
        assert snippet in tools[name]["description"], name
    props = tools["add_investor"]["inputSchema"]["properties"]
    assert {"name", "linkedin", "website", "x", "on_duplicate", "round", "stage", "fit"} <= set(
        props
    )
    assert tools["add_investor"]["inputSchema"]["required"] == ["name"]
    assert tools["record_commitment"]["inputSchema"]["required"] == ["investor", "amount"]


async def test_get_workspace_and_list_rounds(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db, timezone="America/Los_Angeles", agent_name="codex")
    await make_round(db, w.ws, name="Pre-seed", slug="pre-seed", status="closed")
    inv = await make_investor(db, w.ws)
    await make_participant(db, w.rnd, inv, stage="committed", amount_committed=100_000)
    res = await mcp_call(w.key, "get_workspace")
    assert res.ok, res.text
    d = res.data
    assert d["workspace"]["today"] == "2026-10-12" and d["workspace"]["timezone"] == (
        "America/Los_Angeles"
    )
    assert d["you"]["agent_name"] == "codex"
    assert d["you"]["scopes"] == ["raisebook:read", "raisebook:write"]
    assert {r["slug"] for r in d["rounds"]} == {"seed", "pre-seed"}
    seed = next(r for r in d["rounds"] if r["slug"] == "seed")
    assert seed["stages"][0] == {"key": "new", "label": "New", "kind": "open"}
    assert "family_office" in d["investor_types"]
    assert d["loggable_activity_kinds"] == ["note", "email", "call", "meeting"]
    res = await mcp_call(w.key, "get_workspace", headers={"X-Agent-Name": "cursor"})
    assert res.data["you"]["agent_name"] == "cursor"

    res = await mcp_call(w.key, "list_rounds")
    assert [r["slug"] for r in res.data["rounds"]] == ["seed"]
    r0 = res.data["rounds"][0]
    assert r0["committed_amount"] == 100_000 and r0["counts"]["won"] == 1
    res = await mcp_call(w.key, "list_rounds", {"status": "all"})
    assert len(res.data["rounds"]) == 2


async def test_round_summary_and_round_required(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db)
    inv = await make_investor(db, w.ws)
    await make_participant(db, w.rnd, inv, stage="committed", amount_committed=500_000)
    res = await mcp_call(w.reader, "get_round_summary")
    assert res.ok, res.text
    assert res.data["money"]["committed"] == 500_000
    assert res.data["money"]["pct_of_target"] == 25.0
    assert "stages" not in res.data["round"]
    assert res.data["funnel"][0] == {"key": "new", "label": "New", "kind": "open"}
    await make_round(db, w.ws, name="Bridge", slug="bridge")
    res = await mcp_call(w.reader, "get_round_summary")
    assert not res.ok and res.code == "round_required"
    assert "seed" in res.text and "bridge" in res.text
    res = await mcp_call(w.reader, "get_round_summary", {"round": "Bridge"})
    assert res.ok and res.data["round"]["slug"] == "bridge"
    res = await mcp_call(w.reader, "get_round_summary", {"round": "nope"})
    assert not res.ok and res.code == "not_found"


async def test_add_investor_dedupes_and_attributes(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db)
    args = {
        "name": "Dana Whitfield",
        "firm": "Harbor Light Ventures",
        "email": "dana@example.com",
        "linkedin": "https://www.linkedin.com/in/example-dana",
        "x": "@example_dana",
        "tags": ["robotics"],
        "round": "seed",
        "stage": "contacted",
        "fit": 4,
    }
    res = await mcp_call(w.key, "add_investor", args, headers=AGENT)
    assert res.ok, res.text
    d = res.data
    assert d["created"] is True and "matched_on" not in d
    assert d["investor"]["linkedin_url"] == "https://www.linkedin.com/in/example-dana"
    assert d["investor"]["x_url"] == "https://x.com/example_dana"
    assert d["participant"]["stage"]["key"] == "contacted" and d["participant"]["fit"] == 4
    inv_id = d["investor"]["id"]

    again = await mcp_call(w.key, "add_investor", args, headers=AGENT)
    assert again.ok and again.data["created"] is False
    assert again.data["matched_on"] == "email" and again.data["investor"]["id"] == inv_id
    by_name = await mcp_call(
        w.key, "add_investor", {"name": "dana whitfield", "firm": "Harbor Light"}
    )
    assert by_name.data["matched_on"] == "name_firm"
    filled = await mcp_call(
        w.key,
        "add_investor",
        {
            "name": "Dana Whitfield",
            "email": "dana@example.com",
            "location": "Oakland, CA",
            "on_duplicate": "fill_empty",
        },
    )
    assert filled.data["filled_fields"] == ["location"]

    from raisebook.models.investor import Investor

    inv = await db.get(Investor, inv_id)
    assert inv is not None
    acts = await activities_of(db, inv)
    assert [a.kind for a in acts] == [
        "investor_created",
        "added_to_round",  # initial stage and fit ride on this entry
        "investor_updated",
    ]
    for a in acts:
        assert a.actor_type == "agent" and a.via == "mcp"
    assert acts[0].actor_label == "claude-code" and acts[0].agent_model == "claude-opus-5-5"
    assert acts[0].api_key_id == w.key_id


async def test_update_investor(db: AsyncSession, mcp_call: Any, frozen_now: Any) -> None:
    w = await world(db, agent_name="codex")
    inv = await dana(db, w.ws, tags=["robotics"], notes="Met at demo day.")
    res = await mcp_call(
        w.key,
        "update_investor",
        {
            "investor": "dana@example.com",
            "set": {"title": "Partner", "website": "harborlight.example.com", "firm": None},
            "add_tags": ["AI"],
            "remove_tags": ["Robotics"],
            "append_notes": "Prefers email over calls.",
        },
    )
    assert res.ok, res.text
    d = res.data
    assert sorted(d["changed_fields"]) == ["firm", "notes", "tags", "title", "website_url"]
    assert d["investor"]["website_url"] == "https://harborlight.example.com"
    assert "firm" not in d["investor"]
    assert d["investor"]["notes"].endswith("[2026-10-12, codex] Prefers email over calls.")
    res = await mcp_call(w.key, "update_investor", {"investor": str(inv.id), "set": {}})
    assert res.ok and res.data["changed_fields"] == []
    res = await mcp_call(
        w.key, "update_investor", {"investor": str(inv.id), "set": {"surprise": 1}}
    )
    assert not res.ok


async def test_search_investors(db: AsyncSession, mcp_call: Any, frozen_now: Any) -> None:
    w = await world(db)
    a = await dana(db, w.ws, tags=["robotics"])
    a.search_text = "dana whitfield harbor light robotics warehouse"
    b = await make_investor(db, w.ws, name="Tomas Pell", firm="Kelpline Ventures")
    await make_participant(db, w.rnd, a, stage="meeting", fit=5)
    await db.flush()
    res = await mcp_call(w.reader, "search_investors", {"query": "warehouse robotics"})
    assert res.ok, res.text
    assert [r["name"] for r in res.data["results"]] == ["Dana Whitfield"]
    assert res.data["results"][0]["rounds"] == [
        {"round_slug": "seed", "stage_key": "meeting", "fit": 5}
    ]
    assert "round" not in res.data
    res = await mcp_call(w.reader, "search_investors", {})
    assert res.data["total"] == 2
    res = await mcp_call(w.reader, "search_investors", {"fit_min": 4})
    assert res.data["round"] == {"slug": "seed", "name": "Seed"}
    assert [r["id"] for r in res.data["results"]] == [str(a.id)]
    assert res.data["results"][0]["stage"] == "meeting"
    assert res.data["results"][0]["priority"] == "hot"
    res = await mcp_call(w.reader, "search_investors", {"stage": ["Meeting", "new"]})
    assert res.data["total"] == 1
    res = await mcp_call(w.reader, "search_investors", {"stage": "bogus"})
    assert not res.ok and res.code == "stage_not_found"
    _ = b


async def test_get_investor_timeline_and_truncation(
    db: AsyncSession, mcp_call: Any, key_client: Any, frozen_now: Any
) -> None:
    w = await world(db)
    inv = await dana(db, w.ws, notes="x " * 5000)
    await make_participant(db, w.rnd, inv, stage="meeting")
    c = key_client(w.key, headers=AGENT)
    for i in range(3):
        await c.post(
            "/v1/activities",
            json={"investor_id": str(inv.id), "kind": "note", "body": f"n{i} " + "y" * 1500},
        )
    res = await mcp_call(
        w.reader, "get_investor", {"investor": "Dana Whitfield", "timeline_limit": 2}
    )
    assert res.ok, res.text
    d = res.data
    assert d["investor"]["notes_truncated"] is True
    assert d["investor"]["notes"].endswith("… [truncated]")
    assert len(d["investor"]["notes"]) <= 8_000 + 20
    assert len(d["timeline"]) == 2 and d["timeline_truncated"] is True
    assert d["timeline"][0]["body_truncated"] is True
    assert d["timeline"][0]["by"] == "claude-code · claude-opus-5-5 (agent via api)"
    assert "investor_id" not in d["timeline"][0] and "investor" not in d["timeline"][0]
    assert d["participations"][0]["stage"]["key"] == "meeting"


async def test_reference_errors(db: AsyncSession, mcp_call: Any) -> None:
    w = await world(db)
    await make_investor(db, w.ws, name="Sam Okafor", firm="Kelpline Ventures")
    await make_investor(db, w.ws, name="Sam Okafor", firm="Brightquay Capital")
    res = await mcp_call(w.reader, "get_investor", {"investor": "Sam Okafor"})
    assert not res.ok and res.code == "ambiguous_reference"
    assert "Kelpline" in res.text and "Brightquay" in res.text
    res = await mcp_call(w.reader, "get_investor", {"investor": "Sam Okafor @ Brightquay"})
    assert res.ok
    res = await mcp_call(w.reader, "get_investor", {"investor": "Sam Okafur"})
    assert not res.ok and res.code == "not_found" and "Did you mean" in res.text
    res = await mcp_call(w.reader, "get_investor", {"investor": "nobody@example.com"})
    assert not res.ok and res.code == "not_found"


async def test_pipeline_tools_and_idempotency(
    db: AsyncSession, mcp_call: Any, frozen_now: Any
) -> None:
    w = await world(db)
    inv = await dana(db, w.ws)
    ref = {"investor": "dana@example.com"}

    res = await mcp_call(w.key, "add_to_round", {**ref, "fit": 3, "amount_soft": 250_000})
    assert res.ok, res.text
    assert res.data["created"] is True and res.data["participant"]["stage"]["key"] == "new"
    res = await mcp_call(w.key, "add_to_round", {**ref, "fit": 3, "amount_soft": 250_000})
    assert res.data["created"] is False and res.data["changed"] == []
    n0 = len(await activities_of(db, inv))

    res = await mcp_call(w.key, "move_stage", {**ref, "stage": "Contacted", "note": "Intro sent"})
    assert res.data["changed"] is True and res.data["from"]["key"] == "new"
    assert res.data["to"]["key"] == "contacted"
    res = await mcp_call(w.key, "move_stage", {**ref, "stage": "contacted"})
    assert res.data["changed"] is False
    res = await mcp_call(w.key, "move_stage", {**ref, "stage": "nowhere"})
    assert not res.ok and res.code == "stage_not_found" and "contacted" in res.text

    res = await mcp_call(w.key, "set_follow_up", {**ref, "in_days": 4, "note": "Nudge"})
    assert res.data["changed"] is True
    assert res.data["participant"]["follow_up_on"] == "2026-10-16"
    res = await mcp_call(w.key, "set_follow_up", {**ref, "on": "2026-10-16"})
    assert res.data["changed"] is False
    res = await mcp_call(w.key, "set_follow_up", {**ref})
    assert not res.ok and res.code == "validation_error"
    res = await mcp_call(w.key, "set_follow_up", {**ref, "on": "16/10/2026"})
    assert not res.ok and res.code == "validation_error"

    log = {**ref, "kind": "email", "body": "Sent deck", "idempotency_key": "m-1"}
    res = await mcp_call(w.key, "log_activity", log)
    assert res.ok and res.data["duplicate"] is False
    first_id = res.data["activity"]["id"]
    res = await mcp_call(w.key, "log_activity", log)
    assert res.data["duplicate"] is True and res.data["activity"]["id"] == first_id

    res = await mcp_call(w.key, "record_commitment", {**ref, "amount": 200_000})
    assert res.ok, res.text
    d = res.data
    assert d["moved_stage"] is True and d["round_committed_total"] == 200_000
    assert d["participant"]["stage"]["key"] == "committed" and "previous_amount" not in d
    res = await mcp_call(w.key, "record_commitment", {**ref, "amount": 200_000})
    assert res.data["moved_stage"] is False and res.data["previous_amount"] == 200_000
    res = await mcp_call(w.key, "record_commitment", {**ref, "amount": 0})
    assert res.data["round_committed_total"] == 0

    kinds = [a.kind for a in (await activities_of(db, inv))[n0:]]
    assert kinds == [
        "stage_change",
        "follow_up_set",
        "email",
        "stage_change",
        "commitment",
        "commitment",
    ]

    res = await mcp_call(w.reader, "list_due_follow_ups", {"within_days": 7})
    assert res.ok and res.data["today"] == "2026-10-12"
    assert res.data["counts"] == {
        "overdue": 0,
        "today": 0,
        "upcoming": 1,
        "next_7_days": 1,
        "next_due_on": "2026-10-16",
    }
    assert res.data["items"][0]["stage"] == {"key": "committed", "label": "Committed"}
    # The default (overdue + today) is empty but still says a follow-up is coming.
    res = await mcp_call(w.reader, "list_due_follow_ups")
    assert res.data["items"] == []
    assert res.data["counts"]["next_7_days"] == 1


async def test_add_to_round_owner_and_not_in_round(db: AsyncSession, mcp_call: Any) -> None:
    w = await world(db)
    owner_email = str(w.owner.email)
    await dana(db, w.ws)
    res = await mcp_call(w.key, "move_stage", {"investor": "Dana Whitfield", "stage": "dd"})
    assert not res.ok and res.code == "not_in_round" and "add_to_round" in res.text
    res = await mcp_call(
        w.key,
        "add_to_round",
        {"investor": "Dana Whitfield", "owner_email": owner_email},
    )
    assert res.ok and res.data["participant"]["owner"]["email"] == owner_email
    res = await mcp_call(
        w.key, "add_to_round", {"investor": "Dana Whitfield", "owner_email": "x@example.com"}
    )
    assert not res.ok and res.code == "validation_error"


@pytest.mark.parametrize(
    ("tool", "args"),
    [
        ("add_investor", {"name": "Someone"}),
        ("update_investor", {"investor": "dana@example.com", "set": {"title": "x"}}),
        ("add_to_round", {"investor": "dana@example.com"}),
        ("move_stage", {"investor": "dana@example.com", "stage": "dd"}),
        ("log_activity", {"investor": "dana@example.com", "kind": "note", "body": "x"}),
        ("set_follow_up", {"investor": "dana@example.com", "in_days": 1}),
        ("record_commitment", {"investor": "dana@example.com", "amount": 1}),
    ],
)
async def test_write_tools_need_write_scope(
    db: AsyncSession, mcp_call: Any, tool: str, args: dict[str, Any]
) -> None:
    w = await world(db)
    inv = await dana(db, w.ws)
    await make_participant(db, w.rnd, inv)
    before = len(await activities_of(db, inv))
    res = await mcp_call(w.reader, tool, args)
    assert not res.ok and res.code == "insufficient_scope", res.text
    assert len(await activities_of(db, inv)) == before
    p = await participant(db, w.rnd, inv)
    assert p is not None and p.stage_id is not None


async def test_sandbox_test_key_works(db: AsyncSession, mcp_call: Any) -> None:
    from tests.factories import make_workspace

    ws = await make_workspace(db, sandbox=True)
    await make_round(db, ws, name="Seed", slug="seed")
    _, raw = await make_api_key(db, ws, scopes="read,write")
    assert raw.startswith("rb_test_")
    res = await mcp_call(raw, "add_investor", {"name": "Fictional Person", "round": "seed"})
    assert res.ok, res.text
