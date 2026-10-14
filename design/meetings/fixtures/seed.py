"""Fictional fixtures for the meetings screenshots, built through the public API.

    uv run --project backend python design/meetings/fixtures/seed.py \
        --api http://localhost:8260 --app http://localhost:3260 --email founder@example.com

Against a dev API (sign-in links come back as ``dev_link``) it creates, for ``--email``:

- the sample workspace "Kestrel Robotics (sample)" (it ships with meetings: two today, one
  tomorrow, more this week and one from yesterday that needs an outcome), plus one more
  meeting scheduled by an agent (``X-Agent-Name: claude-code``) for later today;
- "Northwind Labs" / Seed with three investors and a meeting today, so Today shows meetings
  from two companies.

Every person, firm and email is made up (example.com). Prints one JSON line per workspace.
"""

from __future__ import annotations

import argparse
import json
import urllib.parse
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx


class Api:
    def __init__(self, api: str, app: str, email: str) -> None:
        self.http = httpx.Client(base_url=api, headers={"Origin": app}, timeout=120)
        r = self.http.post("/v1/auth/magic-link", json={"email": email})
        r.raise_for_status()
        link = r.json()["dev_link"]
        token = urllib.parse.parse_qs(urllib.parse.urlparse(link).query)["token"][0]
        r = self.http.post("/v1/auth/verify", json={"token": token, "switch_account": True})
        r.raise_for_status()
        self.http.headers["X-CSRF-Token"] = r.json()["csrf_token"]

    def call(self, method: str, path: str, ws: str | None = None, **kw: object) -> dict:
        headers = {"X-Workspace": ws} if ws else {}
        r = self.http.request(method, path, headers=headers, **kw)  # type: ignore[arg-type]
        if r.status_code >= 400:
            raise SystemExit(f"{method} {path}: {r.status_code} {r.text}")
        return r.json() if r.content else {}


def local(tz: str, days: int, hour: int, minute: int = 0) -> str:
    """A workspace-local time string (``YYYY-MM-DDTHH:MM``) the API reads in that zone."""
    d = datetime.now(ZoneInfo(tz)).date() + timedelta(days=days)
    return f"{d.isoformat()}T{hour:02d}:{minute:02d}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True)
    ap.add_argument("--app", required=True)
    ap.add_argument("--email", required=True)
    a = ap.parse_args()
    api = Api(a.api, a.app, a.email)
    api.call("PATCH", "/v1/me", json={"name": "Rowan Vale"})

    sample = api.call("POST", "/v1/workspaces", json={"sample": True, "name": "Kestrel Robotics (sample)"})
    ws = sample["slug"]
    tz = sample["timezone"]
    # An agent books one more meeting late today (it shows "by claude-code").
    key = api.call(
        "POST",
        "/v1/api-keys",
        ws,
        json={"name": "Claude Code", "agent_name": "claude-code", "scopes": ["raisebook:read", "raisebook:write"]},
    )["secret"]
    agent = httpx.Client(
        base_url=a.api,
        headers={"Authorization": f"Bearer {key}", "X-Agent-Name": "claude-code", "X-Agent-Model": "claude-opus-5-5"},
        timeout=60,
    )
    parts = api.call("GET", "/v1/rounds/seed/participants", ws, params={"stage": "replied", "limit": 5})["data"]
    if parts:
        r = agent.post(
            "/v1/meetings",
            json={
                "investor_id": parts[0]["investor"]["id"],
                "starts_at": local(tz, 0, 17, 30),
                "duration_minutes": 30,
                "video_url": "https://meet.example.com/kestrel-intro",
                "agenda": "First call: the pilot with a regional 3PL and the Seed terms.",
                "source": "email",
            },
        )
        r.raise_for_status()
    print(json.dumps({"workspace": ws, "timezone": tz}))

    nw = api.call("POST", "/v1/workspaces", json={"name": "Northwind Labs", "timezone": "America/New_York"})
    slug = nw["slug"]
    api.call("POST", "/v1/rounds", slug, json={"name": "Seed", "target_amount": 1_500_000})
    people = [
        ("Odile Fairbanks", "Saltmarsh Ventures", "odile@example.com", "contacted"),
        ("Perrin Achterberg", "Saltmarsh Ventures", "perrin@example.com", "contacted"),
        ("Tamsin Oakhurst", "Bluestem Capital", "tamsin@example.com", "replied"),
    ]
    ids = []
    for name, firm, email, stage in people:
        inv = api.call("POST", "/v1/investors", slug, json={"name": name, "firm": firm, "email": email, "type": "vc"})
        iid = inv["investor"]["id"]
        ids.append(iid)
        api.call("POST", "/v1/rounds/seed/participants", slug, json={"investor_id": iid, "stage": stage, "fit": 4})
    api.call(
        "POST",
        "/v1/meetings",
        slug,
        json={
            "investor_id": ids[0],
            "guest_ids": [ids[1]],
            "starts_at": local("America/New_York", 0, 16, 0),
            "duration_minutes": 45,
            "location": "Saltmarsh Ventures, 210 Pier Street",
            "agenda": "Partner meeting prep: metrics, the lead question.",
        },
    )
    api.call(
        "POST",
        "/v1/meetings",
        slug,
        json={"investor_id": ids[2], "starts_at": local("America/New_York", 2, 11, 0), "video_url": "https://zoom.example.com/j/123"},
    )
    print(json.dumps({"workspace": slug, "timezone": "America/New_York"}))


if __name__ == "__main__":
    main()
