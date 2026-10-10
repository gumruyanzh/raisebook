"""MCP tools: add_to_round, move_stage, log_activity, set_follow_up, list_due_follow_ups,
record_commitment (SPEC §6.4).

Owner: API+MCP (AM) replaces this stub. Use ``tool_call`` from ``_common`` and the
``read_only`` / ``write`` annotations from ``raisebook.mcp.annotations``.
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP


def register(server: FastMCP) -> None:
    pass
