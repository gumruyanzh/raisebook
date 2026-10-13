"""API router registry: every module from SPEC §2.1 is registered here already.

Each listed module exposes ``router: APIRouter`` with its own prefix. Feature
builders replace the stub modules' contents; they never edit this list.

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
    # Investor research (docs/RESEARCH-PLAN.md): settings and company profile (Part 1).
    "raisebook.api.ai_settings",
    "raisebook.api.company_profile",
    # Import-Export+Ops (IE)
    "raisebook.api.imports",
    "raisebook.api.exports",
    # API+MCP (AM)
    "raisebook.api.rounds",
    "raisebook.api.participants",
    "raisebook.api.investors",
    "raisebook.api.activities",
    "raisebook.api.follow_ups",
]


def include_api_routers(app: FastAPI, modules: list[str] | None = None) -> None:
    for name in modules if modules is not None else API_MODULES:
        module = importlib.import_module(name)
        router = getattr(module, "router", None)
        if not isinstance(router, APIRouter):
            raise TypeError(f"{name} must define router: APIRouter")
        app.include_router(router)
