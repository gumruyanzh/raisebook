"""A scripted OpenRouter for the research pipeline (fictional people and pages only).

``Script`` answers ``POST /chat/completions`` like the real API: the identity call (Sonar,
a fenced JSON block plus ``url_citation`` annotations), the three search calls (prose plus
annotations; Raisebook keeps only the citations) and the writer call (structured JSON). The
writer reads the ``<source id=… url=…>`` tags Raisebook sent and cites them by id, so tests
never depend on the order sources were stored in.

The cast: **Dana Whitfield**, Partner at **Harbor Light Ventures** (``harborlight.example``),
LinkedIn ``linkedin.com/in/example-dana-whitfield``. Everything here is made up.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

NAME = "Dana Whitfield"
FIRM = "Harbor Light Ventures"
SITE = "https://harborlight.example"
LINKEDIN = "https://www.linkedin.com/in/example-dana-whitfield"
OTHER_LINKEDIN = "https://www.linkedin.com/in/example-dana-whitfield-chef"

# Per-call costs OpenRouter "reports" (USD): identity, each search, the writer.
COST = {"identity": 0.004, "search": 0.006, "write": 0.09, "prefill": 0.02}


def page(url: str, title: str, content: str = "", date: str | None = None) -> dict[str, Any]:
    cit: dict[str, Any] = {"url": url, "title": title, "content": content}
    if date:
        cit["date"] = date
    return {"type": "url_citation", "url_citation": cit}


# --- search results ---------------------------------------------------------------------------

ACTIVITY_PAGES = [
    page(
        f"{SITE}/news/brightquay-seed?utm_source=x",
        "Harbor Light leads Brightquay's seed",
        "Harbor Light Ventures led the $3M seed round in Brightquay Robotics, with partner "
        "Dana Whitfield joining the board.",
        "2026-08-14",
    ),
    page(
        "https://news.example/2026/kelpline-raise",
        "Dana Whitfield of Harbor Light Ventures backs Kelpline",
        "Dana Whitfield (Harbor Light Ventures) joined Kelpline's pre-seed. Reach her mobile: "
        "+1 (415) 555-0100.",
        "2026-05-02",
    ),
    page(OTHER_LINKEDIN, "Dana Whitfield - Head Chef", "Dana Whitfield, chef in Portland."),
    page("https://www.facebook.com/dana.whitfield.example", "Dana Whitfield", "Family photos"),
    page(
        "https://news.example/2026/someone-else",
        "Marcus Ellery raises a fund",
        "Marcus Ellery of Stonepine Seed closed Fund II.",
    ),
]
THESIS_PAGES = [
    page(
        f"{LINKEDIN}/recent-activity/all/",
        "Dana Whitfield on LinkedIn",
        "Why warehouse robotics is the next decade's infrastructure.",
    ),
    page(
        "https://podcast.example/episodes/42",
        "Episode 42: Dana Whitfield (Harbor Light Ventures) on robotics",
        "Dana Whitfield of Harbor Light Ventures talks about backing robotics founders early.",
        "2026-03-10",
    ),
]
FUND_PAGES = [
    page(
        f"{SITE}/about",
        "About Harbor Light Ventures",
        "Harbor Light Ventures invests $250k to $1M in seed-stage robotics and climate "
        "companies. Fund III closed at $120M in 2025.",
    ),
]

# --- identity ---------------------------------------------------------------------------------

CONFIDENT = [
    {
        "name": NAME,
        "title": "Partner",
        "firm": FIRM,
        "linkedin_url": LINKEDIN,
        "firm_website": SITE,
        "confidence": 0.9,
        "evidence": [1, 2],
    }
]
AMBIGUOUS = [
    {
        "name": NAME,
        "title": "Partner",
        "firm": FIRM,
        "linkedin_url": LINKEDIN,
        "firm_website": SITE,
        "confidence": 0.6,
        "evidence": [1],
    },
    {
        "name": NAME,
        "title": "Principal",
        "firm": "Kelpline Capital",
        "linkedin_url": "https://www.linkedin.com/in/example-dana-whitfield-2",
        "firm_website": "https://kelpline.example",
        "confidence": 0.55,
        "evidence": [2],
    },
]
IDENTITY_PAGES = [
    page(f"{SITE}/team/dana", "Dana Whitfield, Partner", "Dana Whitfield is a Partner at Harbor"),
    page("https://news.example/people/dana", "Dana Whitfield joins Harbor Light", "…"),
]


def chat(
    content: str,
    *,
    annotations: list[dict[str, Any]] | None = None,
    cost: float | None = 0.01,
    gen_id: str = "gen-test",
    model: str = "perplexity/sonar",
    prompt_tokens: int = 1200,
    completion_tokens: int = 400,
) -> httpx.Response:
    usage: dict[str, Any] = {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens}
    if cost is not None:
        usage["cost"] = cost
    body = {
        "id": gen_id,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content,
                    "annotations": annotations or [],
                },
                "finish_reason": "stop",
            }
        ],
        "usage": usage,
    }
    return httpx.Response(200, json=body)


SOURCE_TAG = re.compile(r'<source id="(s\d+)" url="([^"]+)"')


def writer_doc(
    sources: dict[str, str], *, extra_facts: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    """A dossier citing the sources Raisebook sent (url → id), plus traps for the validator."""

    def sid(fragment: str) -> list[str]:
        return [i for i, url in sources.items() if fragment in url][:1]

    facts = [
        {
            "key": "f1",
            "section": "activity",
            "kind": "deal",
            "text": "Led the $3M seed round in Brightquay Robotics and joined the board.",
            "date": "2026-08-14",
            "source_ids": sid("brightquay-seed"),
        },
        {
            "key": "f2",
            "section": "activity",
            "kind": "deal",
            "text": "Joined Kelpline's pre-seed; mobile +1 (415) 555-0100.",
            "date": "2026-05-02",
            "source_ids": sid("kelpline-raise"),
        },
        {
            "key": "f3",
            "section": "thesis",
            "kind": "podcast",
            "text": "Talks about backing robotics founders early (Episode 42).",
            "source_ids": sid("podcast.example"),
        },
        {
            "key": "f4",
            "section": "fit",
            "kind": "check_size",
            "text": "Invests $250k to $1M in seed-stage robotics and climate companies.",
            "source_ids": sid("/about"),
        },
        {
            "key": "f5",
            "section": "profile",
            "kind": "role",
            "text": "Partner at Harbor Light Ventures.",
            "source_ids": sid("recent-activity"),
        },
        # Traps: an uncited claim, a claim citing a rejected page, a private one.
        {
            "key": "f6",
            "section": "red_flags",
            "kind": "reputation",
            "text": "Known to take three weeks to reply.",
            "source_ids": [],
        },
        {
            "key": "f7",
            "section": "profile",
            "kind": "other",
            "text": "Was a head chef before investing.",
            "source_ids": ["s999"],
        },
        {
            "key": "f8",
            "section": "profile",
            "kind": "other",
            "text": "She is married with two kids and lives in Palo Alto.",
            "source_ids": sid("/about"),
        },
        *(extra_facts or []),
    ]
    return {
        "schema_version": 1,
        "identity": {"name": NAME, "firm": FIRM, "linkedin_url": LINKEDIN, "firm_website": SITE},
        "facts": facts,
        "analysis": {
            "brief": {
                "verdict": "strong",
                "why": "Leads seed rounds in robotics at our check size.",
                "best_way_in": "Ask Ines Calloway, who co-invested in Brightquay.",
                "opener": "Saw your Brightquay seed; we automate the same warehouses.",
                "risk": "May see us as competitive with Brightquay.",
                "fact_keys": ["f1", "f4"],
            },
            "fit": {
                "stage": {"text": "Seed is her core stage.", "fact_keys": ["f4"]},
                "sector": {"text": "Robotics focus matches ours.", "fact_keys": ["f3", "f4"]},
                "check": {"text": "Check range covers our ask.", "fact_keys": ["f4"]},
                "deploying": {"text": "Two deals this year.", "fact_keys": ["f1", "f2"]},
                "conflicts": [{"text": "Brightquay is adjacent to us.", "fact_keys": ["f1"]}],
            },
            "ways_in": [
                {
                    "text": "Brightquay's founders know her well.",
                    "basis": "public",
                    "fact_keys": ["f1"],
                },
                {
                    "text": "Her college roommate is our advisor.",
                    "basis": "public",
                    "fact_keys": [],
                },
                {"text": "Intro through Ines Calloway.", "basis": "workspace", "fact_keys": []},
            ],
            "talking_points": [
                {"text": "Lead with our warehouse pilots.", "fact_keys": ["f3"]},
            ],
        },
        "suggestions": {
            "title": {"value": "General Partner", "fact_keys": ["f5"]},
            "check_min": {"value": 250000, "fact_keys": ["f4"]},
            "check_max": {"value": 1000000, "fact_keys": ["f4"]},
            "stage_focus": {"value": ["seed"], "fact_keys": ["f4"]},
            "email": {"value": "dana@harborlight.example", "fact_keys": ["f5"]},
            "location": {"value": "12 Ocean Avenue, Palo Alto", "fact_keys": ["f5"]},
            "industries": {"value": ["robotics"], "fact_keys": []},
        },
        "unverified": [{"section": "profile", "text": "Possibly an MIT alumna."}],
    }


@dataclass
class Script:
    """Configurable answers; ``calls`` lists the step of every chat call in order."""

    identity: list[dict[str, Any]] = field(default_factory=lambda: list(CONFIDENT))
    writer: str = "ok"  # ok | bad | bad_then_ok | fail_402
    search_fail: dict[str, int] = field(default_factory=dict)  # step → HTTP status
    search_cost: float | None = COST["search"]
    identity_cost: float = COST["identity"]
    writer_cost: float = COST["write"]
    extra_pages: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    extra_facts: list[dict[str, Any]] = field(default_factory=list)
    calls: list[str] = field(default_factory=list)
    requests: list[dict[str, Any]] = field(default_factory=list)
    writer_bad_left: int = 0
    on_call: Callable[[str], None] | None = None

    def _step(self, body: dict[str, Any]) -> str:
        system = body["messages"][0]["content"]
        if isinstance(system, str) and system.startswith("You identify investors"):
            return "identity"
        if (
            body.get("response_format", {})
            .get("json_schema", {})
            .get("name", "")
            .endswith("company_profile_v1")
        ):
            return "prefill"
        if body.get("response_format"):
            return "write"
        user = body["messages"][1]["content"]
        if "deals led or joined" in user:
            return "search:activity"
        if "investment thesis" in user:
            return "search:thesis"
        return "search:fund"

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        step = self._step(body)
        self.calls.append(step)
        self.requests.append(body)
        if self.on_call is not None:
            self.on_call(step)
        n = len(self.calls)
        if step == "identity":
            content = "Here is what I found:\n```json\n" + json.dumps(self.identity) + "\n```"
            return chat(
                content, annotations=IDENTITY_PAGES, cost=self.identity_cost, gen_id=f"gen-{n}"
            )
        if step.startswith("search:"):
            key = step.split(":", 1)[1]
            if key in self.search_fail:
                return httpx.Response(self.search_fail[key], json={"error": {"message": "x"}})
            pages = {"activity": ACTIVITY_PAGES, "thesis": THESIS_PAGES, "fund": FUND_PAGES}[key]
            pages = [*pages, *self.extra_pages.get(key, [])]
            return chat(
                "Dana Whitfield is a partner (prose is ignored).",
                annotations=pages,
                cost=self.search_cost,
                gen_id=f"gen-{n}",
                model=body["model"],
            )
        if step == "prefill":
            draft = {
                "pitch": "Kestrel builds autonomous forklifts for mid-size warehouses.",
                "sectors": ["robotics", "logistics"],
                "stage": "seed",
                "location": "Oakland, CA",
                "traction": ["3 paid pilots", "$40k MRR"],
                "wants_lead": "lead",
                "check_min": 250000,
                "check_max": 1000000,
                "strategic_help": None,
            }
            return chat(
                json.dumps(draft), cost=COST["prefill"], gen_id=f"gen-{n}", model=body["model"]
            )
        # The writer.
        if self.writer == "fail_402":
            return httpx.Response(402, json={"error": {"message": "no credits sk-or-v1-xyz"}})
        if self.writer == "bad" or (self.writer == "bad_then_ok" and self.writer_bad_left > 0):
            self.writer_bad_left -= 1
            return chat(
                '{"verdict": "great"}',
                cost=self.writer_cost,
                gen_id=f"gen-{n}",
                model=body["model"],
            )
        user = body["messages"][1]["content"]
        sources = {m.group(1): m.group(2) for m in SOURCE_TAG.finditer(user)}
        doc = writer_doc(sources, extra_facts=self.extra_facts)
        return chat(
            "```json\n" + json.dumps(doc) + "\n```",
            cost=self.writer_cost,
            gen_id=f"gen-{n}",
            model=body["model"],
        )

    def install(self, mock: Any) -> Script:
        mock.route("POST", "/chat/completions", self.handler)
        return self
