"""MCP smoke test for a running Raisebook API (Python 3.10+, standard library only).

    export RAISEBOOK_API_KEY=rb_test_...            # a key for a sample (sandbox) workspace
    python clients/mcp_smoke.py --url http://localhost:8000/mcp
    python clients/mcp_smoke.py --url http://localhost:8000/mcp --write   # also exercise writes

It speaks JSON-RPC to ``/mcp`` exactly like an MCP client (initialize, tools/list,
tools/call) and checks:

- the server name, the instructions and the 15 tools with their annotations;
- read tools: get_workspace, list_rounds, get_round_summary, search_investors,
  list_due_follow_ups, export_round;
- with ``--write`` (sandbox keys only, ``rb_test_``): add_investor twice (dedupe),
  add_to_round, move_stage (and the no-op repeat), log_activity with an idempotency key
  (twice), set_follow_up, record_commitment, get_investor (the agent shows on the
  timeline), update_investor. Writes use a fictional investor on ``example.com``.

Exit code 0 when every check passes. Never point ``--write`` at a real workspace.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from typing import Any

EXPECTED_TOOLS = {
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


class Smoke:
    def __init__(self, url: str, key: str, agent: str) -> None:
        self.url = url
        self.headers = {
            "Authorization": f"Bearer {key}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "X-Agent-Name": agent,
            "X-Agent-Model": "mcp-smoke",
        }
        self.n = 0
        self.failures = 0

    def rpc(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.n += 1
        body = json.dumps(
            {"jsonrpc": "2.0", "id": self.n, "method": method, "params": params or {}}
        ).encode()
        req = urllib.request.Request(  # noqa: S310
            self.url, data=body, method="POST", headers=self.headers
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
                raw = resp.read().decode()
                ctype = resp.headers.get("Content-Type", "")
        except urllib.error.HTTPError as exc:
            raise SystemExit(
                f"HTTP {exc.code} from {self.url}: {exc.read().decode()[:500]}"
            ) from None
        if "text/event-stream" in ctype:  # tolerate SSE framing
            data = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")]
            raw = data[-1] if data else "{}"
        msg = json.loads(raw)
        if "error" in msg:
            raise SystemExit(f"JSON-RPC error for {method}: {msg['error']}")
        return msg["result"]  # type: ignore[no-any-return]

    def call(self, tool: str, args: dict[str, Any] | None = None) -> tuple[bool, Any, str]:
        result = self.rpc("tools/call", {"name": tool, "arguments": args or {}})
        text = " ".join(c.get("text", "") for c in result.get("content", []))
        data = result.get("structuredContent")
        if data is None and text and not result.get("isError"):
            try:
                data = json.loads(text)
            except ValueError:
                data = text
        return not result.get("isError"), data, text

    def check(self, ok: bool, label: str, detail: Any = "") -> None:
        mark = "ok  " if ok else "FAIL"
        print(f"  [{mark}] {label}" + (f"  ({detail})" if detail and not ok else ""))
        if not ok:
            self.failures += 1

    def tool(self, tool: str, args: dict[str, Any] | None = None) -> Any:
        ok, data, text = self.call(tool, args)
        self.check(ok, f"{tool} {json.dumps(args or {})[:80]}", text[:300])
        return data if ok else {}


def run(url: str, key: str, write: bool) -> int:
    s = Smoke(url, key, agent="mcp-smoke")
    print(f"MCP smoke against {url}")

    init = s.rpc(
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "raisebook-mcp-smoke", "version": "1"},
        },
    )
    s.check(init.get("serverInfo", {}).get("name") == "raisebook", "server name is raisebook")
    s.check("get_workspace" in (init.get("instructions") or ""), "server instructions present")

    tools = {t["name"]: t for t in s.rpc("tools/list")["tools"]}
    s.check(set(tools) == EXPECTED_TOOLS, "15 tools listed", sorted(set(tools) ^ EXPECTED_TOOLS))
    for name, t in sorted(tools.items()):
        ann = t.get("annotations") or {}
        s.check(
            ann.get("readOnlyHint") is (name in READ_ONLY) and ann.get("destructiveHint") is False,
            f"annotations: {name}",
            ann,
        )

    ws = s.tool("get_workspace")
    info = ws.get("workspace", {})
    print(f"  workspace: {info.get('name')} · today {info.get('today')}")
    rounds = s.tool("list_rounds", {"status": "all"}).get("rounds", [])
    open_rounds = [r for r in rounds if r.get("status") == "open"]
    round_ref = open_rounds[0]["slug"] if open_rounds else None
    if round_ref:
        summary = s.tool("get_round_summary", {"round": round_ref})
        money = summary.get("money", {})
        committed, target = money.get("committed"), money.get("target")
        print(f"  {round_ref}: {committed} / {target} {money.get('currency')}")
        s.tool("search_investors", {"round": round_ref, "limit": 5})
        s.tool("export_round", {"round": round_ref, "format": "csv"})
    s.tool("search_investors", {"query": "a", "limit": 5})
    s.tool("list_due_follow_ups", {"within_days": 7})

    if write:
        if not key.startswith("rb_test_"):
            print("  --write needs a sandbox key (rb_test_…); skipping writes.")
        elif not round_ref:
            print("  --write needs an open round; skipping writes.")
        else:
            tag = uuid.uuid4().hex[:8]
            email = f"smoke.{tag}@example.com"
            first = s.tool(
                "add_investor",
                {"name": f"Smoke Test {tag}", "firm": "Fictional Ventures", "email": email},
            )
            again = s.tool("add_investor", {"name": "Someone Else", "email": email})
            s.check(first.get("created") is True, "add_investor created")
            s.check(again.get("matched_on") == "email", "add_investor deduped by email")
            ref = {"investor": email, "round": round_ref}
            s.tool("add_to_round", {**ref, "fit": 3})
            moved = s.tool("move_stage", {**ref, "stage": "contacted", "note": "smoke"})
            s.check(moved.get("changed") is True, "move_stage changed")
            same = s.tool("move_stage", {**ref, "stage": "contacted"})
            s.check(same.get("changed") is False, "move_stage repeat is a no-op")
            log = {
                **ref,
                "kind": "note",
                "body": "MCP smoke note",
                "idempotency_key": f"smoke-{tag}",
            }
            s.tool("log_activity", log)
            dup = s.tool("log_activity", log)
            s.check(dup.get("duplicate") is True, "log_activity idempotency key")
            s.tool("set_follow_up", {**ref, "in_days": 2, "note": "smoke follow-up"})
            commit = s.tool("record_commitment", {**ref, "amount": 1000})
            s.check(commit.get("moved_stage") is True, "record_commitment moved to won")
            inv = s.tool("get_investor", {"investor": email, "timeline_limit": 5})
            labels = {a.get("actor", {}).get("label") for a in inv.get("timeline", [])}
            s.check("mcp-smoke" in labels, "agent name on the timeline", labels)
            s.tool("update_investor", {"investor": email, "add_tags": ["smoke-test"]})

    print(f"{'PASS' if not s.failures else 'FAIL'}: {s.failures} failure(s)")
    return 1 if s.failures else 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument(
        "--url", default=os.environ.get("RAISEBOOK_MCP_URL", "http://localhost:8000/mcp")
    )
    p.add_argument("--key", default=os.environ.get("RAISEBOOK_API_KEY", ""))
    p.add_argument("--write", action="store_true", help="also run writes (sandbox keys only)")
    args = p.parse_args()
    if not args.key:
        print("Set RAISEBOOK_API_KEY or pass --key.", file=sys.stderr)
        return 2
    return run(args.url, args.key, args.write)


if __name__ == "__main__":
    sys.exit(main())
