"""API router registry: every module from SPEC §2.1 is registered here already.

Each listed module exposes ``router: APIRouter`` with its own prefix. Feature
builders replace the stub modules' contents.

Order matters where paths overlap: ``exports`` (``/v1/investors/export``,
``/v1/rounds/{round}/export``) and ``imports`` come before ``investors`` and
``rounds`` so their literal paths win over ``/v1/investors/{investor_id}``.
"""

from __future__ import annotations

import importlib

from fastapi import APIRouter, FastAPI

API_MODULES: list[str] = [
    "raisebook.api.health",
    "raisebook.api.auth",
    "raisebook.api.me",
    "raisebook.api.workspaces",
    "raisebook.api.members",
    "raisebook.api.invites",
    "raisebook.api.api_keys",
    # Import-Export+Ops (IE)
    "raisebook.api.imports",
    "raisebook.api.exports",
    # API+MCP (AM)
    "raisebook.api.rounds",
    "raisebook.api.participants",
    "raisebook.api.investors",
    "raisebook.api.activities",
    "raisebook.api.follow_ups",
    # Meetings and the calendar feed
    "raisebook.api.meetings",
    "raisebook.api.calendar",
]

# Investor research (docs/RESEARCH-PLAN.md), served only with ``RAISEBOOK_RESEARCH_ENABLED``:
# settings and company profile (Part 1); runs, identities, dossiers, suggestions and the
# Research Policy (Part 2).
RESEARCH_API_MODULES: list[str] = [
    "raisebook.api.ai_settings",
    "raisebook.api.company_profile",
    "raisebook.api.research",
    "raisebook.api.research_policy",
]


def enabled_api_modules() -> list[str]:
    from raisebook.config import get_settings

    if get_settings().research_enabled:
        # Before imports/investors, as before: literal paths win over ``{investor_id}``.
        return API_MODULES[:7] + RESEARCH_API_MODULES + API_MODULES[7:]
    return list(API_MODULES)


def include_api_routers(app: FastAPI, modules: list[str] | None = None) -> None:
    for name in modules if modules is not None else enabled_api_modules():
        module = importlib.import_module(name)
        router = getattr(module, "router", None)
        if not isinstance(router, APIRouter):
            raise TypeError(f"{name} must define router: APIRouter")
        app.include_router(router)
