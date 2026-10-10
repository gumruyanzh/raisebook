"""Tool annotations (SPEC §6.1): every tool declares ``read_only(...)`` or ``write(...)``.

The MCP tests assert every registered tool carries annotations from here. No
Raisebook tool is destructive: MCP exposes no deletes. ``openWorldHint`` is False:
tools act only on the caller's own workspace.
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
