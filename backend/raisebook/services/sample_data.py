"""Sample (sandbox) workspace with fictional data (SPEC §8.5).

Owner: Import-Export+Ops (IE). This is the Foundation-backend baseline so that
``rbctl seed-demo`` and ``POST /v1/workspaces {sample: true}`` work from day one;
IE may extend or replace it (and should route investor/participant writes through
``services.investors`` / ``services.participants`` / ``services.activities`` once
those land).

Everything here is made up: people, firms (no real firm names), ``example.com``
emails and ``linkedin.com/in/example-…`` URLs. The workspace "Kestrel Robotics
(sample)" has a closed "Pre-seed" round (fully committed) and an open "Seed" round
(target 2,000,000 USD, SAFE, cap 16,000,000, closing 8 weeks out) with 40 investors
across every stage, follow-ups (overdue, today, next week), three commitments,
notes, and timelines mixing user, agent (``claude-code`` / ``claude-opus-4-5``) and
system actors.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.core.actor import SYSTEM_ACTOR, Actor
from raisebook.models.activity import Activity
from raisebook.models.enums import ActorType, RoundStatus, Via
from raisebook.models.investor import Investor
from raisebook.models.round import DEFAULT_STAGES, Round, RoundParticipant, RoundStage
from raisebook.models.user import User
from raisebook.models.workspace import Workspace
from raisebook.services.workspaces import create_workspace_row

SAMPLE_NAME = "Kestrel Robotics (sample)"
SAMPLE_TIMEZONE = "America/Los_Angeles"
AGENT = Actor(ActorType.AGENT, Via.MCP, label="claude-code", model="claude-opus-4-5")

_FIRM_SUFFIXES = ("capital", "ventures", "partners", "vc", "fund", "llc", "lp", "inc")


def _norm(s: str | None) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " and ")
    return " ".join(re.findall(r"[a-z0-9]+", s))


def _name_key(name: str, firm: str | None) -> str:
    words = _norm(firm).split()
    while words and words[-1] in _FIRM_SUFFIXES:
        words.pop()
    return f"{_norm(name)}|{' '.join(words)}"


def _search_text(inv: dict[str, Any]) -> str:
    parts = [
        inv.get("name"),
        inv.get("firm"),
        inv.get("title"),
        inv.get("email"),
        inv.get("location"),
        " ".join(inv.get("tags", [])),
        " ".join(inv.get("industries", [])),
        inv.get("source"),
        (inv.get("notes") or "")[:2000],
    ]
    return " ".join(p for p in parts if p).lower()


@dataclass(frozen=True)
class Person:
    name: str
    firm: str | None
    title: str
    type: str
    check: str
    check_min: int
    check_max: int
    location: str
    industries: tuple[str, ...]
    tags: tuple[str, ...]


# 40 fictional investors. Firms are invented names; angels have no firm.
PEOPLE: tuple[Person, ...] = (
    Person(
        "Dana Whitfield",
        "Harbor Light Ventures",
        "Partner",
        "vc",
        "$500k-$2M, leads",
        500_000,
        2_000_000,
        "San Francisco, CA",
        ("robotics", "industrial"),
        ("lead", "hardware"),
    ),
    Person(
        "Marcus Ellery",
        "Kelpline Ventures",
        "Principal",
        "vc",
        "$250k-$1M",
        250_000,
        1_000_000,
        "Oakland, CA",
        ("robotics",),
        ("hardware",),
    ),
    Person(
        "Priya Ramaswamy",
        "Brightquay Capital",
        "General Partner",
        "vc",
        "$1M-$3M, leads",
        1_000_000,
        3_000_000,
        "Palo Alto, CA",
        ("manufacturing", "ai"),
        ("lead",),
    ),
    Person(
        "Tomas Okafor",
        None,
        "Angel, ex-founder",
        "angel",
        "$25k-$50k",
        25_000,
        50_000,
        "Seattle, WA",
        ("robotics", "logistics"),
        ("operator",),
    ),
    Person(
        "Helena Strand",
        "Fernhollow Partners",
        "Partner",
        "vc",
        "$500k-$1.5M",
        500_000,
        1_500_000,
        "Boston, MA",
        ("industrial",),
        ("deep-tech",),
    ),
    Person(
        "Jonah Pell",
        "Driftmark Ventures",
        "Associate",
        "vc",
        "$250k-$750k",
        250_000,
        750_000,
        "New York, NY",
        ("ai", "robotics"),
        (),
    ),
    Person(
        "Ines Calloway",
        None,
        "Angel",
        "angel",
        "$10k-$25k",
        10_000,
        25_000,
        "Austin, TX",
        ("hardware",),
        ("operator",),
    ),
    Person(
        "Rafael Montoya",
        "Stonepine Seed",
        "Managing Partner",
        "vc",
        "$300k-$800k",
        300_000,
        800_000,
        "Denver, CO",
        ("logistics",),
        ("warm",),
    ),
    Person(
        "Grace Holloway",
        "Larkspur Hill Capital",
        "Partner",
        "vc",
        "$1M-$2M, leads",
        1_000_000,
        2_000_000,
        "San Francisco, CA",
        ("robotics", "manufacturing"),
        ("lead", "hardware"),
    ),
    Person(
        "Wendell Ashby",
        "Copperwick Family Office",
        "Director",
        "family_office",
        "$250k-$1M",
        250_000,
        1_000_000,
        "Chicago, IL",
        ("industrial",),
        (),
    ),
    Person(
        "Mei Lin Zhao",
        "Quiet Orbit Ventures",
        "Partner",
        "vc",
        "$500k-$1M",
        500_000,
        1_000_000,
        "Los Angeles, CA",
        ("ai",),
        ("deep-tech",),
    ),
    Person(
        "Oskar Lindqvist",
        "Halcyon Reef Capital",
        "Principal",
        "vc",
        "$250k-$1M",
        250_000,
        1_000_000,
        "Stockholm, SE",
        ("robotics", "climate"),
        (),
    ),
    Person(
        "Amara Nwosu",
        None,
        "Angel, robotics engineer",
        "angel",
        "$25k",
        25_000,
        25_000,
        "Pittsburgh, PA",
        ("robotics",),
        ("technical",),
    ),
    Person(
        "Caleb Fenwick",
        "Ninebark Ventures",
        "Partner",
        "vc",
        "$750k-$2M",
        750_000,
        2_000_000,
        "Menlo Park, CA",
        ("industrial", "ai"),
        ("lead",),
    ),
    Person(
        "Sofia Brennan",
        "Wrenfield Angels",
        "Syndicate lead",
        "angel",
        "$50k-$200k",
        50_000,
        200_000,
        "Portland, OR",
        ("hardware",),
        ("syndicate",),
    ),
    Person(
        "Theo Marchetti",
        "Pebblecourt Partners",
        "Venture Partner",
        "vc",
        "$250k-$500k",
        250_000,
        500_000,
        "Miami, FL",
        ("logistics",),
        (),
    ),
    Person(
        "Nadia Haddad",
        "Saltmarsh Corporate Ventures",
        "Investment Director",
        "corporate_vc",
        "$500k-$2M",
        500_000,
        2_000_000,
        "Detroit, MI",
        ("manufacturing", "automotive"),
        ("strategic",),
    ),
    Person(
        "Victor Lam",
        "Mossgrove Accelerator",
        "Program Director",
        "accelerator",
        "$125k",
        125_000,
        125_000,
        "San Jose, CA",
        ("robotics",),
        ("accelerator",),
    ),
    Person(
        "Elise Dumont",
        "Glasshollow Ventures",
        "Partner",
        "vc",
        "$1M-$4M, leads",
        1_000_000,
        4_000_000,
        "Paris, FR",
        ("ai", "industrial"),
        ("lead",),
    ),
    Person(
        "Isaac Thornbury",
        None,
        "Scout",
        "scout",
        "$10k-$50k",
        10_000,
        50_000,
        "Brooklyn, NY",
        ("robotics",),
        ("scout",),
    ),
    Person(
        "Lucia Ferrante",
        "Bramblewood Ventures",
        "Principal",
        "vc",
        "$250k-$1M",
        250_000,
        1_000_000,
        "San Diego, CA",
        ("logistics", "ai"),
        (),
    ),
    Person(
        "Hugo Varga",
        "Otterbank Capital",
        "Partner",
        "vc",
        "$500k-$1.5M",
        500_000,
        1_500_000,
        "Toronto, CA",
        ("industrial",),
        ("hardware",),
    ),
    Person(
        "Ruth Abernathy",
        None,
        "Angel, ex-COO",
        "angel",
        "$50k",
        50_000,
        50_000,
        "Raleigh, NC",
        ("manufacturing",),
        ("operator",),
    ),
    Person(
        "Kenji Mori",
        "Lanternfish Partners",
        "General Partner",
        "vc",
        "$1M-$2.5M",
        1_000_000,
        2_500_000,
        "Tokyo, JP",
        ("robotics",),
        ("lead", "hardware"),
    ),
    Person(
        "Beatrix Quell",
        "Quillfeather Capital",
        "Associate",
        "vc",
        "$250k-$500k",
        250_000,
        500_000,
        "London, UK",
        ("ai",),
        (),
    ),
    Person(
        "Desmond Achterberg",
        "Tinroof Ventures",
        "Partner",
        "vc",
        "$500k-$1M",
        500_000,
        1_000_000,
        "Amsterdam, NL",
        ("logistics",),
        (),
    ),
    Person(
        "Farah Siddiqui",
        "Cobblestone Family Office",
        "Principal",
        "family_office",
        "$250k-$750k",
        250_000,
        750_000,
        "Dallas, TX",
        ("industrial",),
        (),
    ),
    Person(
        "Gideon Ash",
        None,
        "Angel",
        "angel",
        "$25k-$100k",
        25_000,
        100_000,
        "Salt Lake City, UT",
        ("hardware", "robotics"),
        ("operator",),
    ),
    Person(
        "Imogen Castellane",
        "Vellum Point Ventures",
        "Partner",
        "vc",
        "$750k-$1.5M",
        750_000,
        1_500_000,
        "San Francisco, CA",
        ("ai", "robotics"),
        ("deep-tech",),
    ),
    Person(
        "Julian Oyelaran",
        "Marrowstone Capital",
        "Principal",
        "vc",
        "$250k-$1M",
        250_000,
        1_000_000,
        "Atlanta, GA",
        ("manufacturing",),
        (),
    ),
    Person(
        "Katya Volkonsky",
        "Ironleaf Corporate Ventures",
        "Director",
        "corporate_vc",
        "$1M-$3M",
        1_000_000,
        3_000_000,
        "Houston, TX",
        ("industrial", "energy"),
        ("strategic",),
    ),
    Person(
        "Leon Ravel",
        None,
        "Angel, robotics founder",
        "angel",
        "$50k-$100k",
        50_000,
        100_000,
        "Cambridge, MA",
        ("robotics",),
        ("technical", "operator"),
    ),
    Person(
        "Maren Solberg",
        "Northwick Seed",
        "Partner",
        "vc",
        "$300k-$600k",
        300_000,
        600_000,
        "Oslo, NO",
        ("climate", "robotics"),
        (),
    ),
    Person(
        "Nikhil Bhatnagar",
        "Silverlark Ventures",
        "Associate",
        "vc",
        "$250k-$750k",
        250_000,
        750_000,
        "Bangalore, IN",
        ("ai",),
        (),
    ),
    Person(
        "Odette Fairbanks",
        "Cinderwell Partners",
        "Venture Partner",
        "vc",
        "$500k-$1M",
        500_000,
        1_000_000,
        "Philadelphia, PA",
        ("logistics",),
        ("warm",),
    ),
    Person(
        "Pavel Dragomir",
        "Blue Heron Hollow Capital",
        "Partner",
        "vc",
        "$1M-$2M",
        1_000_000,
        2_000_000,
        "Berlin, DE",
        ("industrial", "robotics"),
        ("lead",),
    ),
    Person(
        "Quinn Hargreave",
        None,
        "Angel",
        "angel",
        "$25k",
        25_000,
        25_000,
        "Minneapolis, MN",
        ("hardware",),
        (),
    ),
    Person(
        "Rosalind Achebe",
        "Gilded Fern Ventures",
        "Principal",
        "vc",
        "$250k-$1M",
        250_000,
        1_000_000,
        "Washington, DC",
        ("ai", "manufacturing"),
        (),
    ),
    Person(
        "Sebastian Kroll",
        "Thistledown Capital",
        "Partner",
        "vc",
        "$500k-$1.5M",
        500_000,
        1_500_000,
        "Zurich, CH",
        ("robotics",),
        ("hardware",),
    ),
    Person(
        "Talia Brightwater",
        "Moonrake Accelerator",
        "Managing Director",
        "accelerator",
        "$150k",
        150_000,
        150_000,
        "Boulder, CO",
        ("robotics", "climate"),
        ("accelerator",),
    ),
)

# Seed round placement: (stage key, fit, follow-up offset in days or None, amount_soft,
# probability, amount_committed). Index-aligned with PEOPLE.
SEED_PLAN: tuple[tuple[str, int, int | None, int | None, int | None, int | None], ...] = (
    ("committed", 5, None, None, None, 750_000),
    ("dd", 5, -2, 1_000_000, 60, None),
    ("meeting", 4, 0, 1_500_000, 40, None),
    ("committed", 4, None, None, None, 50_000),
    ("meeting", 4, 3, 750_000, 35, None),
    ("replied", 3, 1, 500_000, 25, None),
    ("contacted", 3, 5, 25_000, 20, None),
    ("contacted", 4, -1, 500_000, 20, None),
    ("dd", 5, 2, 1_500_000, 70, None),
    ("research", 3, 7, None, None, None),
    ("replied", 4, 0, 750_000, 30, None),
    ("new", 2, None, None, None, None),
    ("committed", 4, None, None, None, 25_000),
    ("meeting", 5, -4, 1_000_000, 45, None),
    ("contacted", 3, 6, 100_000, 15, None),
    ("passed", 2, None, None, None, None),
    ("research", 4, 4, None, None, None),
    ("new", 3, None, None, None, None),
    ("contacted", 5, -6, 2_000_000, 20, None),
    ("new", 1, None, None, None, None),
    ("replied", 3, 9, 500_000, 25, None),
    ("research", 3, None, None, None, None),
    ("passed", 3, None, None, None, None),
    ("meeting", 4, 1, 1_000_000, 40, None),
    ("new", 2, None, None, None, None),
    ("contacted", 2, 12, 250_000, 10, None),
    ("research", 3, None, None, None, None),
    ("replied", 4, -3, 75_000, 30, None),
    ("dd", 4, 0, 1_000_000, 55, None),
    ("new", 3, None, None, None, None),
    ("contacted", 4, 6, 1_000_000, 15, None),
    ("passed", 4, None, None, None, None),
    ("research", 2, None, None, None, None),
    ("new", 2, None, None, None, None),
    ("contacted", 3, 2, 500_000, 15, None),
    ("meeting", 4, 8, 1_000_000, 35, None),
    ("new", 1, None, None, None, None),
    ("research", 3, 10, None, None, None),
    ("replied", 4, 5, 500_000, 30, None),
    ("passed", 3, None, None, None, None),
)

# Pre-seed (closed): index into PEOPLE → committed amount.
PRESEED_COMMITTED: dict[int, int] = {3: 50_000, 6: 25_000, 12: 25_000, 17: 125_000, 22: 50_000}
PRESEED_PASSED: tuple[int, ...] = (1, 9)

NOTES = (
    "Met at SF Tech Week 2026. Interested in warehouse robotics; asked for the deck.",
    "Prefers to co-invest behind a lead. Ask about their pro-rata in follow-on rounds.",
    "Portfolio overlap with two of our customers. Could make customer intros.",
    "Wants to see 3 more months of pilot data before committing.",
    "Strong technical background; asked detailed questions about the gripper design.",
)
SOURCES = ("SF Tech Week 2026", "Warm intro", "Demo day", "Cold outreach", "Angel list")


def _slug(name: str) -> str:
    return "-".join(_norm(name).split())


async def _stages(db: AsyncSession, ws: Workspace, rnd: Round) -> dict[str, RoundStage]:
    out: dict[str, RoundStage] = {}
    for pos, st in enumerate(DEFAULT_STAGES):
        row = RoundStage(
            workspace_id=ws.id,
            round_id=rnd.id,
            key=st.key,
            label=st.label,
            color=str(st.color),
            kind=str(st.kind),
            position=pos,
        )
        db.add(row)
        out[st.key] = row
    await db.flush()
    return out


def _activity(
    ws: Workspace,
    inv: Investor,
    kind: str,
    actor: Actor,
    at: datetime,
    *,
    round_id: UUID | None = None,
    body: str | None = None,
    data: dict[str, Any] | None = None,
) -> Activity:
    return Activity(
        workspace_id=ws.id,
        investor_id=inv.id,
        round_id=round_id,
        kind=kind,
        occurred_at=at,
        body=body,
        data=data or {},
        created_at=at,
        **actor.activity_fields(),
    )


async def create_sample_workspace(db: AsyncSession, *, user: User, now: datetime) -> Workspace:
    """Create "Kestrel Robotics (sample)" (``is_sandbox=True``) owned by ``user``."""
    from zoneinfo import ZoneInfo

    ws = await create_workspace_row(
        db,
        user=user,
        name=SAMPLE_NAME,
        now=now,
        timezone=SAMPLE_TIMEZONE,
        default_currency="USD",
        is_sandbox=True,
    )
    today: date = now.astimezone(ZoneInfo(SAMPLE_TIMEZONE)).date()
    me = Actor(ActorType.USER, Via.WEB, user_id=user.id)

    preseed = Round(
        workspace_id=ws.id,
        slug="pre-seed",
        name="Pre-seed",
        status=RoundStatus.CLOSED.value,
        instrument="safe",
        currency="USD",
        target_amount=250_000,
        valuation_cap=8_000_000,
        target_close_on=today - timedelta(days=250),
        closed_on=today - timedelta(days=240),
        notes="Friends, angels and one accelerator. Closed oversubscribed.",
        created_at=now - timedelta(days=330),
        updated_at=now - timedelta(days=240),
    )
    seed = Round(
        workspace_id=ws.id,
        slug="seed",
        name="Seed",
        status=RoundStatus.OPEN.value,
        instrument="safe",
        currency="USD",
        target_amount=2_000_000,
        valuation_cap=16_000_000,
        target_close_on=today + timedelta(weeks=8),
        notes="Post-money SAFE. Looking for a lead with robotics or industrial depth.",
        created_at=now - timedelta(days=45),
        updated_at=now - timedelta(days=1),
    )
    db.add_all([preseed, seed])
    await db.flush()
    pre_stages = await _stages(db, ws, preseed)
    seed_stages = await _stages(db, ws, seed)

    investors: list[Investor] = []
    for i, p in enumerate(PEOPLE):
        first = p.name.split()[0].lower()
        fields: dict[str, Any] = {
            "name": p.name,
            "firm": p.firm,
            "title": p.title,
            "type": p.type,
            "check_note": p.check,
            "check_min": p.check_min,
            "check_max": p.check_max,
            "location": p.location,
            "industries": list(p.industries),
            "tags": list(p.tags),
            "stage_focus": ["pre-seed", "seed"] if p.type in ("angel", "scout") else ["seed"],
            "email": f"{first}.{i + 1}@example.com",
            "linkedin_url": f"https://www.linkedin.com/in/example-{_slug(p.name)}",
            "source": SOURCES[i % len(SOURCES)],
            "notes": NOTES[i % len(NOTES)] if i % 3 != 2 else None,
            "warm_intro_by": "Tomas Okafor" if i in (2, 8, 13) else None,
        }
        created = now - timedelta(days=60 - (i % 20))
        inv = Investor(
            workspace_id=ws.id,
            **fields,
            linkedin_key=f"in/example-{_slug(p.name)}",
            name_key=_name_key(p.name, p.firm),
            search_text=_search_text(fields),
            created_at=created,
            updated_at=created,
        )
        db.add(inv)
        investors.append(inv)
    await db.flush()

    activities: list[Activity] = []
    for i, inv in enumerate(investors):
        created = inv.created_at
        importer = AGENT if i % 4 == 0 else SYSTEM_ACTOR
        activities.append(
            _activity(ws, inv, "investor_created", importer, created, data={"sample": True})
        )

    # Pre-seed: committed and passed participants.
    for i, amount in PRESEED_COMMITTED.items():
        inv = investors[i]
        st = pre_stages["committed"]
        at = now - timedelta(days=245)
        db.add(
            RoundParticipant(
                workspace_id=ws.id,
                round_id=preseed.id,
                investor_id=inv.id,
                stage_id=st.id,
                fit=4,
                amount_committed=amount,
                committed_on=today - timedelta(days=245),
                stage_changed_at=at,
                last_activity_at=at,
                created_at=now - timedelta(days=320),
                updated_at=at,
            )
        )
        activities.append(
            _activity(
                ws,
                inv,
                "commitment",
                me,
                at,
                round_id=preseed.id,
                data={
                    "amount": amount,
                    "currency": "USD",
                    "committed_on": (today - timedelta(days=245)).isoformat(),
                },
            )
        )
    for i in PRESEED_PASSED:
        inv = investors[i]
        at = now - timedelta(days=280)
        db.add(
            RoundParticipant(
                workspace_id=ws.id,
                round_id=preseed.id,
                investor_id=inv.id,
                stage_id=pre_stages["passed"].id,
                fit=2,
                stage_changed_at=at,
                last_activity_at=at,
                created_at=now - timedelta(days=320),
                updated_at=at,
            )
        )

    # Seed: every investor, spread across all stages.
    for i, (inv, plan) in enumerate(zip(investors, SEED_PLAN, strict=True)):
        key, fit, follow, soft, prob, committed = plan
        st = seed_stages[key]
        changed = now - timedelta(days=(i * 3) % 21 + 1)
        stale = st.kind == "active" and i % 7 == 0
        last = changed - timedelta(days=16) if stale else changed
        part = RoundParticipant(
            workspace_id=ws.id,
            round_id=seed.id,
            investor_id=inv.id,
            stage_id=st.id,
            fit=fit,
            probability=prob,
            amount_soft=soft,
            amount_committed=committed,
            committed_on=(today - timedelta(days=i % 9 + 1)) if committed else None,
            follow_up_on=(today + timedelta(days=follow)) if follow is not None else None,
            follow_up_note=(
                "Send the updated deck and pilot metrics" if follow is not None else None
            ),
            next_step=("Schedule partner meeting" if key in ("meeting", "dd") else None),
            owner_user_id=user.id if i % 2 == 0 else None,
            stage_changed_at=changed,
            last_activity_at=last,
            created_at=now - timedelta(days=40 - (i % 10)),
            updated_at=changed,
        )
        db.add(part)
        added_at = now - timedelta(days=40 - (i % 10))
        actor = AGENT if i % 3 == 0 else me
        activities.append(
            _activity(
                ws,
                inv,
                "added_to_round",
                actor,
                added_at,
                round_id=seed.id,
                data={"stage": {"key": "new", "label": "New"}},
            )
        )
        if key != "new":
            activities.append(
                _activity(
                    ws,
                    inv,
                    "stage_change",
                    actor,
                    changed,
                    round_id=seed.id,
                    data={
                        "from": {"key": "new", "label": "New"},
                        "to": {"key": st.key, "label": st.label},
                    },
                )
            )
        if key in ("contacted", "replied", "meeting", "dd", "committed"):
            activities.append(
                _activity(
                    ws,
                    inv,
                    "email",
                    AGENT if i % 2 else me,
                    changed - timedelta(days=2),
                    round_id=seed.id,
                    body="Sent the Seed deck and a two-line update on the pilot with a 3PL.",
                    data={"direction": "outbound"},
                )
            )
        if key in ("meeting", "dd", "committed"):
            activities.append(
                _activity(
                    ws,
                    inv,
                    "meeting",
                    me,
                    changed - timedelta(hours=20),
                    round_id=seed.id,
                    body="45-minute call. Walked through unit economics and the pilot pipeline.",
                )
            )
        if follow is not None:
            activities.append(
                _activity(
                    ws,
                    inv,
                    "follow_up_set",
                    AGENT if i % 2 == 0 else me,
                    changed,
                    round_id=seed.id,
                    data={
                        "to": (today + timedelta(days=follow)).isoformat(),
                        "note": "Send the updated deck and pilot metrics",
                    },
                )
            )
        if committed:
            activities.append(
                _activity(
                    ws,
                    inv,
                    "commitment",
                    me,
                    changed,
                    round_id=seed.id,
                    body="Signed the SAFE.",
                    data={
                        "amount": committed,
                        "currency": "USD",
                        "committed_on": (today - timedelta(days=i % 9 + 1)).isoformat(),
                    },
                )
            )
        if i % 5 == 1:
            activities.append(
                _activity(
                    ws,
                    inv,
                    "note",
                    AGENT,
                    changed - timedelta(days=1),
                    round_id=seed.id,
                    body="Researched recent investments: two warehouse-automation deals in 2026.",
                )
            )
    db.add_all(activities)
    await db.flush()
    return ws
