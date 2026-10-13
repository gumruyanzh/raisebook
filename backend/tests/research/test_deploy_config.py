"""The compose stack runs the worker and passes the KEK through (RESEARCH-PLAN §3.3)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

DEPLOY = Path(__file__).resolve().parents[3] / "deploy"


def compose() -> dict[str, Any]:
    doc: dict[str, Any] = yaml.safe_load((DEPLOY / "docker-compose.yml").read_text())
    return doc


def test_worker_service_reuses_the_api_image() -> None:
    services = compose()["services"]
    worker = services["worker"]
    assert worker["image"] == services["api"]["image"] == "raisebook-api:local"
    assert worker["command"] == ["rbctl", "worker"]
    assert worker["depends_on"]["migrate"]["condition"] == "service_completed_successfully"
    assert worker["restart"] == "unless-stopped"
    assert "ports" not in worker
    assert worker["networks"] == ["internal"]
    # Longer than RAISEBOOK_WORKER_GRACE_S (50 s) so running jobs can hand themselves back.
    assert worker["stop_grace_period"] == "60s"
    assert worker["environment"] == services["api"]["environment"]


def test_kek_reaches_api_and_worker_and_is_documented() -> None:
    env = compose()["services"]["api"]["environment"]
    assert env["RAISEBOOK_SECRETS_KEK"] == "${RAISEBOOK_SECRETS_KEK:-}"
    assert env["RAISEBOOK_SECRETS_KEK_PREVIOUS"] == "${RAISEBOOK_SECRETS_KEK_PREVIOUS:-}"
    example = (DEPLOY / ".env.example").read_text()
    assert "\nRAISEBOOK_SECRETS_KEK=\n" in example  # empty: never a real value in the repo
    # Research is unreleased: the example keeps it off, and compose defaults it off.
    assert "\nRAISEBOOK_RESEARCH_ENABLED=false\n" in example
    assert env["RAISEBOOK_RESEARCH_ENABLED"] == "${RAISEBOOK_RESEARCH_ENABLED:-false}"


def test_every_service_caps_its_logs_and_the_worker_has_no_http_check() -> None:
    services = compose()["services"]
    for name, svc in services.items():
        assert svc["logging"]["options"]["max-size"], name
    assert services["worker"]["healthcheck"] == {"disable": True}
