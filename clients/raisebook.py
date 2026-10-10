"""A tiny Raisebook REST client (Python 3.10+, standard library only).

Copy this file into your project, or run it to see your workspace:

    export RAISEBOOK_API_KEY=rb_live_...           # Settings → API keys
    export RAISEBOOK_API_URL=http://localhost:8000  # default: https://api.raisebook.org
    python clients/raisebook.py

Usage:

    from raisebook import Raisebook

    rb = Raisebook(agent_name="my-script")
    seed = rb.rounds(status="open")[0]
    added = rb.add_investor("Dana Whitfield", firm="Harbor Light Ventures",
                            email="dana@example.com")            # dedupes; safe to repeat
    inv = added["investor"]
    rb.add_to_round(seed["slug"], inv["id"], stage="contacted", fit=4)
    rb.log_activity(inv["id"], "email", "Sent the deck.", round=seed["slug"],
                    idempotency_key="msg-123")                 # retries are safe
    rb.set_follow_up(seed["slug"], inv["id"], in_days=3, note="Nudge on the deck")
    print(rb.follow_ups(within_days=7))

Every write is recorded on the investor's timeline under ``agent_name`` (the
``X-Agent-Name`` header). Errors raise :class:`RaisebookError` with the API's ``code``,
``message`` (it says what to do next) and ``details``. Use only fictional data in tests.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_URL = "https://api.raisebook.org"


class RaisebookError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.details = details


class Raisebook:
    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        agent_name: str | None = None,
        agent_model: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.api_key = api_key or os.environ.get("RAISEBOOK_API_KEY", "")
        if not self.api_key:
            raise ValueError("Pass api_key or set RAISEBOOK_API_KEY (rb_live_… or rb_test_…).")
        self.base_url = (base_url or os.environ.get("RAISEBOOK_API_URL") or DEFAULT_URL).rstrip("/")
        self.headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            "User-Agent": "raisebook-python-client/1",
        }
        if agent_name:
            self.headers["X-Agent-Name"] = agent_name
        if agent_model:
            self.headers["X-Agent-Model"] = agent_model
        self.timeout = timeout

    # --- transport -------------------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: Any = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        url = self.base_url + path
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            url += "?" + urllib.parse.urlencode(clean, doseq=True)
        data = None
        hdrs = dict(self.headers, **(headers or {}))
        if body is not None:
            data = json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)  # noqa: S310
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310
                raw = resp.read()
                ctype = resp.headers.get("Content-Type", "")
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                err = json.loads(raw)["error"]
            except (ValueError, KeyError, TypeError):
                raise RaisebookError(exc.code, "http_error", raw.decode(errors="replace")) from None
            raise RaisebookError(
                exc.code, err.get("code", "error"), err.get("message", ""), err.get("details")
            ) from None
        if not raw:
            return None
        if "json" in ctype:
            return json.loads(raw)
        return raw.decode()

    # --- workspace and rounds --------------------------------------------------------

    def workspace(self) -> dict[str, Any]:
        return self.request("GET", "/v1/workspace")  # type: ignore[no-any-return]

    def rounds(self, status: str = "all") -> list[dict[str, Any]]:
        return self.request("GET", "/v1/rounds", params={"status": status})["data"]  # type: ignore[no-any-return]

    def create_round(self, name: str, **fields: Any) -> dict[str, Any]:
        """409 ``duplicate`` (with ``details.existing``) when the name exists."""
        return self.request("POST", "/v1/rounds", body={"name": name, **fields})  # type: ignore[no-any-return]

    def summary(self, round: str) -> dict[str, Any]:
        return self.request("GET", f"/v1/rounds/{_q(round)}/summary")  # type: ignore[no-any-return]

    # --- investors -------------------------------------------------------------------

    def investors(self, q: str | None = None, **filters: Any) -> dict[str, Any]:
        return self.request("GET", "/v1/investors", params={"q": q, **filters})  # type: ignore[no-any-return]

    def resolve(self, ref: str) -> dict[str, Any]:
        """By id, email, LinkedIn URL, "Name" or "Name @ Firm"."""
        return self.request("GET", "/v1/investors/resolve", params={"ref": ref})["investor"]  # type: ignore[no-any-return]

    def add_investor(
        self, name: str, *, on_duplicate: str = "return_existing", **fields: Any
    ) -> dict[str, Any]:
        """Create, or return the duplicate (``created: false`` + ``matched_on``)."""
        body = {"name": name, "on_duplicate": on_duplicate, **fields}
        return self.request("POST", "/v1/investors", body=body)  # type: ignore[no-any-return]

    def update_investor(self, investor_id: str, **changes: Any) -> dict[str, Any]:
        return self.request("PATCH", f"/v1/investors/{investor_id}", body=changes)  # type: ignore[no-any-return]

    # --- pipeline --------------------------------------------------------------------

    def participants(self, round: str, **filters: Any) -> dict[str, Any]:
        return self.request("GET", f"/v1/rounds/{_q(round)}/participants", params=filters)  # type: ignore[no-any-return]

    def add_to_round(self, round: str, investor_id: str, **fields: Any) -> dict[str, Any]:
        body = {"investor_id": investor_id, **fields}
        return self.request("POST", f"/v1/rounds/{_q(round)}/participants", body=body)  # type: ignore[no-any-return]

    def move_stage(
        self, round: str, investor_id: str, stage: str, note: str | None = None
    ) -> dict[str, Any]:
        path = f"/v1/rounds/{_q(round)}/participants/{investor_id}/stage"
        return self.request("POST", path, body={"stage": stage, "note": note})  # type: ignore[no-any-return]

    def set_follow_up(self, round: str, investor_id: str, **when: Any) -> dict[str, Any]:
        """Exactly one of ``on="YYYY-MM-DD"``, ``in_days=3`` or ``clear=True`` (+ ``note``)."""
        path = f"/v1/rounds/{_q(round)}/participants/{investor_id}/follow-up"
        return self.request("POST", path, body=when)  # type: ignore[no-any-return]

    def record_commitment(
        self, round: str, investor_id: str, amount: int, **fields: Any
    ) -> dict[str, Any]:
        """``amount`` replaces any earlier amount (0 clears); moves to won by default."""
        path = f"/v1/rounds/{_q(round)}/participants/{investor_id}/commitment"
        return self.request("POST", path, body={"amount": amount, **fields})  # type: ignore[no-any-return]

    def follow_ups(self, round: str | None = None, within_days: int = 0) -> dict[str, Any]:
        params = {"round": round, "within_days": within_days}
        return self.request("GET", "/v1/follow-ups", params=params)  # type: ignore[no-any-return]

    # --- timeline --------------------------------------------------------------------

    def log_activity(
        self,
        investor_id: str,
        kind: str,
        body: str,
        *,
        round: str | None = None,
        occurred_at: str | None = None,
        direction: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """kind: note | email | call | meeting. A repeated idempotency_key is a no-op."""
        payload = {
            "investor_id": investor_id,
            "kind": kind,
            "body": body,
            "round": round,
            "occurred_at": occurred_at,
            "direction": direction,
            "idempotency_key": idempotency_key,
        }
        payload = {k: v for k, v in payload.items() if v is not None}
        return self.request("POST", "/v1/activities", body=payload)  # type: ignore[no-any-return]

    def activities(self, **filters: Any) -> dict[str, Any]:
        return self.request("GET", "/v1/activities", params=filters)  # type: ignore[no-any-return]


def _q(ref: str) -> str:
    return urllib.parse.quote(ref, safe="")


def main() -> int:
    rb = Raisebook(agent_name="raisebook-py")
    ws = rb.workspace()
    print(f"{ws['name']} ({ws['slug']}) · you: {ws['you']['type']} {ws['you']['scopes']}")
    for r in rb.rounds():
        print(
            f"  {r['slug']:<20} {r['status']:<6} {r['committed_amount']:>12,} / "
            f"{r['target_amount']:,} {r['currency']} · {r['participant_count']} investors"
        )
    due = rb.follow_ups(within_days=7)
    print(f"Follow-ups (today {due['today']}): {due['counts']}")
    for item in due["data"][:10]:
        inv = item["investor"]
        print(f"  {item['follow_up_on']} {item['follow_up_state']:<8} {inv['name']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RaisebookError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
