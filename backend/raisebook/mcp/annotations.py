"""Tool annotation helpers (SPEC §6.1).

Tools spell out all four hints as a literal ``ToolAnnotations(...)`` in their decorator, so
static scanners and MCP directories can read them without running the server; the MCP tests
assert the values. No Raisebook tool is destructive: MCP exposes no deletes.
``openWorldHint`` is False except for research_investor and match_identity, which reach the
public web through the workspace's OpenRouter key. These helpers remain for test probes.
"""

from __future__ import annotations

from mcp.types import ToolAnnotations


def read_only(title: str) -> ToolAnnotations:
    """A tool that only reads. Safe to call speculatively and to retry."""
    return ToolAnnotations(
        title=title,
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )


def write(title: str, *, idempotent: bool = True) -> ToolAnnotations:
    """A tool that changes the workspace. ``idempotent=False`` means calling twice does
    something twice (for example log_activity without an idempotency_key)."""
    return ToolAnnotations(
        title=title,
        readOnlyHint=False,
        destructiveHint=False,
        idempotentHint=idempotent,
        openWorldHint=False,
    )
