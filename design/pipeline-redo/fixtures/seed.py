"""Fictional fixtures for the pipeline redo (DECISION.md §8), built through the public API.

    uv run --project backend python design/pipeline-redo/fixtures/seed.py \
        --api http://localhost:8150 --app http://localhost:3150 --email owner@example.com

Creates two workspaces owned by ``--email`` (a dev API, so sign-in links come back as
``dev_link``):

- "Lumen Grid" / Seed: 411 investors imported from ``sf-tech-week-411.csv``, all in New,
  fit 5: 12, 4: 28, 3: 95, 0-2: 276 (86 at 0), about 30% industry "Other", mixed types
  including "other", no notes or check sizes. $2M target, closes in 95 days.
- "Harbor Robotics" / Seed: the mature pipeline (New 38, Researching 64, Contacted 52,
  Replied 14, Meeting 9, Diligence 0, Committed 4 for $650k, Passed 230), $400k soft,
  2 overdue follow-ups, 1 due today, and 1 agent move in the last 24 hours. Most investors
  have a stage focus and about two thirds a check range (the board cards show them).

Every person, firm and email is made up (example.com). Prints one JSON line per workspace.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import random
import urllib.parse
from datetime import date, timedelta

import httpx

FIRST = (
    "Ada Bram Cleo Dana Dov Edda Emeric Faye Fenn Finn Flora Frankie Gia Hale Hana Indy Isolde Ivo "
    "Kai Kira Lane Mara Nell Nico Orin Pella Quill Reed Rhea Silas Tove Ugo Ulla Vesna Wren Yara "
    "Zane Zeke Thea Juno Odile Perrin Sable Tamsin Vale Wynn Xan Yorick Briar Calla Dorian Esme"
).split()
LAST = (
    "Prentice Keel Northcott Underhill Irvine Calloway Voss Sutter Fenwick Moss Everly Corwin "
    "Yardley Bellweather Draycott Fairbanks Lindqvist Ostrowski Montclair Ingram Tremaine Ashgrove "
    "Westbrook Kowalczyk Halloway Quillen Stellan Achterberg Zielinski Merriman Ravensworth "
    "Thistlewood Penhallow Marchetti Oakhurst Brightwater Fennimore Hartwell Galloway Sorensen"
).split()
FIRM_A = (
    "Redwood Meridian Juniper Harbor Copperline Summit Basalt Ember Lantern Saltmarsh Halcyon "
    "Granite Kettle Thistle Westerly Quarry Tidewater Bluestem Cinder Wildfern Brightfork "
    "Sablewood Halyard Pinecrest Riverstone Lodestar Ironwood Fieldstone Gannet Oakmoor Vantage"
).split()
FIRM_B = (
    "Fund Labs Ventures Collective Capital Partners Angels Holdings Growth Seed Fund".split()
)
TITLES = (
    "General Partner",
    "Partner",
    "Principal",
    "Venture Partner",
    "Associate",
    "Managing Director",
    "Angel investor",
    "Scout",
    "",
)
INDUSTRIES = ("Health", "Fintech", "Climate", "Dev tools", "AI infra", "Robotics", "Consumer")
TYPES = ("VC", "VC", "VC", "VC", "Angel", "Angel", "Corporate VC", "Family office", "Scout", "")


def people(n: int, rng: random.Random) -> list[tuple[str, str, str]]:
    seen: set[str] = set()
    out: list[tuple[str, str, str]] = []
    while len(out) < n:
        name = f"{rng.choice(FIRST)} {rng.choice(LAST)}"
        if name in seen:
            continue
        seen.add(name)
        firm = f"{rng.choice(FIRM_A)} {rng.choice(FIRM_B)}".replace(" ", " ")
        out.append((name, firm, rng.choice(TITLES)))
    return out


def fits_411(rng: random.Random) -> list[int]:
    fits = [5] * 12 + [4] * 28 + [3] * 95 + [0] * 86 + [1] * 90 + [2] * 100
    assert len(fits) == 411
    rng.shuffle(fits)
    return fits


def industry(rng: random.Random) -> str:
    if rng.random() < 0.3:
        return "Other"
    k = rng.choice((1, 1, 2))
    return "; ".join(rng.sample(INDUSTRIES, k))


FOCUS = ("Pre-seed; Seed", "Seed", "Seed; Series A", "Seed", "Series A", "")
CHECKS = ((25_000, 100_000), (50_000, 250_000), (100_000, 500_000), (250_000, 1_000_000), (500_000, 2_000_000))


def card_facts(rng: random.Random) -> list[object]:
    """Stage focus and a check range for most investors (the board card shows them)."""
    focus = rng.choice(FOCUS)
    if rng.random() < 0.65:
        lo, hi = rng.choice(CHECKS)
        return [focus, lo, hi]
    return [focus, "", ""]


def slug(s: str) -> str:
    return "".join(c for c in s.lower() if c.isalnum())


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


def make_round(api: Api, ws: str, close_in: int, today: date) -> dict:
    return api.call(
        "POST",
        "/v1/rounds",
        ws,
        json={
            "name": "Seed",
            "target_amount": 2_000_000,
            "currency": "USD",
            "instrument": "safe",
            "valuation_cap": 16_000_000,
            "target_close_on": (today + timedelta(days=close_in)).isoformat(),
        },
    )


def import_csv(api: Api, ws: str, rnd: str, filename: str, header: list[str], rows: list[list]) -> None:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    res = api.call(
        "POST",
        "/v1/imports",
        ws,
        json={"content": buf.getvalue(), "filename": filename, "round": rnd, "default_stage": "new"},
    )
    if res.get("errors"):
        raise SystemExit(f"import errors: {res['errors'][:3]}")


def seed_411(api: Api, today: date) -> dict:
    ws = api.call("POST", "/v1/workspaces", json={"name": "Lumen Grid", "timezone": "America/Los_Angeles"})
    rnd = make_round(api, ws["slug"], 95, today)
    rng = random.Random(411)
    fits = fits_411(rng)
    rows = []
    for (name, firm, title), fit in zip(people(411, rng), fits, strict=True):
        email = f"{slug(name)}@{slug(firm)}.example.com" if rng.random() < 0.6 else ""
        linkedin = f"https://www.linkedin.com/in/{slug(name)}-example" if rng.random() < 0.45 else ""
        typ = rng.choice(TYPES)
        rows.append([name, firm, title, typ, email, linkedin, industry(rng), fit, "SF Tech Week"])
    header = ["Name", "Firm", "Title", "Type", "Email", "LinkedIn", "Industry", "Fit", "Source"]
    import_csv(api, ws["slug"], rnd["id"], "sf-tech-week-411.csv", header, rows)
    return {"workspace": ws["slug"], "round": rnd["slug"]}


MATURE = (
    ("new", 38),
    ("research", 64),
    ("contacted", 52),
    ("replied", 14),
    ("meeting", 9),
    ("committed", 4),
    ("passed", 230),
)
NEXT_STEPS = (
    "Send the deck and the pilot numbers",
    "Ask Harper for an intro to their partner",
    "Book a second call with the GP",
    "Share the data room link",
    "Follow up on the reference calls",
)


def seed_mature(api: Api, today: date) -> dict:
    ws = api.call("POST", "/v1/workspaces", json={"name": "Harbor Robotics", "timezone": "America/Los_Angeles"})
    rnd = make_round(api, ws["slug"], 41, today)
    rng = random.Random(650)
    # Card facts (stage focus, check size) draw from their own generator, so adding them left
    # every earlier fixture value (fits, follow-ups, amounts) unchanged.
    facts = random.Random(651)
    who = people(411, rng)
    rows = []
    i = 0
    committed = [250_000, 200_000, 100_000, 100_000]
    soft = {"meeting": [150_000, 100_000], "replied": [100_000, 50_000]}
    for stage, n in MATURE:
        for k in range(n):
            name, firm, title = who[i]
            i += 1
            fit = {
                "new": rng.choice((1, 2, 2, 3, 3, 4, 5)),
                "research": rng.choice((3, 3, 4, 4, 5)),
                "contacted": rng.choice((3, 4, 4, 5)),
                "replied": rng.choice((4, 4, 5)),
                "meeting": rng.choice((4, 5, 5)),
                "committed": 5,
                "passed": rng.choice((0, 1, 2, 2, 3, 3, 4)),
            }[stage]
            follow = ""
            if stage in ("contacted", "replied", "meeting") and rng.random() < 0.35:
                follow = (today + timedelta(days=rng.choice((2, 3, 5, 9, 12, 16)))).isoformat()
            amount_soft = soft.get(stage, [])[k] if k < len(soft.get(stage, [])) else ""
            amount_committed = committed[k] if stage == "committed" else ""
            next_step = rng.choice(NEXT_STEPS) if stage in ("replied", "meeting") and rng.random() < 0.6 else ""
            rows.append(
                [
                    name,
                    firm,
                    title,
                    rng.choice(TYPES),
                    f"{slug(name)}@{slug(firm)}.example.com",
                    industry(rng),
                    fit,
                    stage,
                    follow,
                    amount_soft,
                    amount_committed,
                    next_step,
                    "Warm intro list",
                    *card_facts(facts),
                ]
            )
    header = [
        "Name",
        "Firm",
        "Title",
        "Type",
        "Email",
        "Industry",
        "Fit",
        "Pipeline stage",
        "Follow up on",
        "Soft amount",
        "Committed amount",
        "Next step",
        "Source",
        "Stage focus",
        "Check min",
        "Check max",
    ]
    import_csv(api, ws["slug"], rnd["id"], "warm-list.csv", header, rows)
    parts = api.call("GET", f"/v1/rounds/{rnd['id']}/participants", ws["slug"], params={"limit": 1000})["data"]
    by_stage: dict[str, list[dict]] = {}
    for p in parts:
        by_stage.setdefault(p["stage"]["key"], []).append(p)
    # 2 overdue + 1 due today (set directly; the API accepts past dates).
    due = [(by_stage["replied"][0], -4), (by_stage["contacted"][0], -2), (by_stage["meeting"][0], 0)]
    for p, d in due:
        api.call(
            "PATCH",
            f"/v1/rounds/{rnd['id']}/participants/{p['investor']['id']}",
            ws["slug"],
            json={"follow_up_on": (today + timedelta(days=d)).isoformat(), "next_step": "Send the updated deck"},
        )
    # Soft amounts to $400k in total (the import set $400k already).
    # One agent move in the last 24 hours, through an API key.
    key = api.call(
        "POST",
        "/v1/api-keys",
        ws["slug"],
        json={"name": "Research agent", "agent_name": "research-agent", "scopes": ["raisebook:read", "raisebook:write"]},
    )
    secret = key.get("secret") or key.get("key")
    p = by_stage["research"][1]
    r = httpx.post(
        f"{api.http.base_url}/v1/rounds/{rnd['id']}/participants/{p['investor']['id']}/stage",
        headers={"Authorization": f"Bearer {secret}", "X-Agent-Name": "research-agent"},
        json={"stage": "contacted", "note": "Sent the intro email"},
        timeout=30,
    )
    r.raise_for_status()
    return {"workspace": ws["slug"], "round": rnd["slug"]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8150")
    ap.add_argument("--app", default="http://localhost:3150")
    ap.add_argument("--email", default="owner@example.com")
    ap.add_argument("--only", choices=("import411", "mature"), default=None)
    ap.add_argument("--name", default="Rowan Avery")
    a = ap.parse_args()
    api = Api(a.api, a.app, a.email)
    api.call("PATCH", "/v1/me", json={"name": a.name})
    today = date.today()
    if a.only in (None, "import411"):
        print(json.dumps({"preset": "import411", **seed_411(api, today)}))
    if a.only in (None, "mature"):
        print(json.dumps({"preset": "mature", **seed_mature(api, today)}))


if __name__ == "__main__":
    main()
