"""The MCP tool registry: every tool module from SPEC §6.4 is registered here already.

Each module defines ``register(server: FastMCP) -> None``. Feature builders fill
their modules; they never edit this list.
"""

from __future__ import annotations

import importlib

from mcp.server.fastmcp import FastMCP

TOOL_MODULES: list[str] = [
    "raisebook.mcp.tools.workspace",  # AM: get_workspace
    "raisebook.mcp.tools.rounds",  # AM: list_rounds, get_round_summary
    "raisebook.mcp.tools.investors",  # AM: search_investors, get_investor, add/update_investor
    "raisebook.mcp.tools.pipeline",  # AM: add_to_round, move_stage, log_activity, …
    "raisebook.mcp.tools.data",  # IE: import_investors_csv, export_round
    # Investor research (RESEARCH-PLAN §7): get_dossier, list_research_runs,
    # research_investor, match_identity, save_dossier
    "raisebook.mcp.tools.research",
]


def register_tools(server: FastMCP) -> None:
    for name in TOOL_MODULES:
        module = importlib.import_module(name)
        register = getattr(module, "register", None)
        if not callable(register):
            raise TypeError(f"{name} must define register(server: FastMCP) -> None")
        register(server)
