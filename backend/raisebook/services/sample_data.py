"""Sample (sandbox) workspace with fictional data (SPEC §8.5). Owner: Import-Export+Ops (IE).

"Kestrel Robotics (sample)" has a closed "Pre-seed" round (fully committed) and an open
"Seed" round (target 2,000,000 USD, SAFE, cap 16,000,000, closing 8 weeks out) with 40
investors across every stage, follow-ups (overdue, today, next week), three commitments,
notes, stale conversations, and timelines mixing user, agent (``claude-code`` /
``claude-opus-4-5``) and system actors.

Every investor and participant write goes through the feature services
(``services.rounds``, ``services.investors``, ``services.participants``,
``services.activities``) with a back-dated ``now``, so derived fields, activities and
``last_activity_at`` are exactly what real use would produce.

Everything here is made up: people, firms (no real firm names), ``example.com`` emails and
``linkedin.com/in/example-…`` URLs.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import Principal, WorkspaceContext, WorkspaceInfo
from raisebook.auth.scopes import ROLE_SCOPES
from raisebook.core.actor import SYSTEM_ACTOR, Actor, user_actor
from raisebook.models.enums import ActorType, Role, Via
from raisebook.models.investor import Investor
from raisebook.models.round import RoundStage
from raisebook.models.user import User
from raisebook.models.workspace import Workspace
from raisebook.services.normalize import norm
from raisebook.services.workspaces import create_workspace_row

SAMPLE_NAME = "Kestrel Robotics (sample)"
SAMPLE_TIMEZONE = "America/Los_Angeles"
AGENT = Actor(ActorType.AGENT, Via.MCP, label="claude-code", model="claude-opus-4-5")


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
    ("dd", 5, -2, 250_000, 60, None),
    ("meeting", 4, 0, 375_000, 40, None),
    ("committed", 4, None, None, None, 50_000),
    ("meeting", 4, 3, 200_000, 35, None),
    ("replied", 3, 1, 125_000, 25, None),
    ("contacted", 3, 5, 25_000, 20, None),
    ("contacted", 4, -1, 125_000, 20, None),
    ("dd", 5, 2, 375_000, 70, None),
    ("research", 3, 7, None, None, None),
    ("replied", 4, 0, 200_000, 30, None),
    ("new", 2, None, None, None, None),
    ("committed", 4, None, None, None, 25_000),
    ("meeting", 5, -4, 250_000, 45, None),
    ("contacted", 3, 6, 25_000, 15, None),
    ("passed", 2, None, None, None, None),
    ("research", 4, 4, None, None, None),
    ("new", 3, None, None, None, None),
    ("contacted", 5, -6, 500_000, 20, None),
    ("new", 1, None, None, None, None),
    ("replied", 3, 9, 125_000, 25, None),
    ("research", 3, None, None, None, None),
    ("passed", 3, None, None, None, None),
    ("meeting", 4, 1, 250_000, 40, None),
    ("new", 2, None, None, None, None),
    ("contacted", 2, 12, 50_000, 10, None),
    ("research", 3, None, None, None, None),
    ("replied", 4, -3, 25_000, 30, None),
    ("dd", 4, 0, 250_000, 55, None),
    ("new", 3, None, None, None, None),
    ("contacted", 4, 6, 250_000, 15, None),
    ("passed", 4, None, None, None, None),
    ("research", 2, None, None, None, None),
    ("new", 2, None, None, None, None),
    ("contacted", 3, 2, 125_000, 15, None),
    ("meeting", 4, 8, 250_000, 35, None),
    ("new", 1, None, None, None, None),
    ("research", 3, 10, None, None, None),
    ("replied", 4, 5, 125_000, 30, None),
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


NOTES = (
    "Met at SF Tech Week 2026. Interested in warehouse robotics; asked for the deck.",
    "Prefers to co-invest behind a lead. Ask about their pro-rata in follow-on rounds.",
    "Portfolio overlap with two of our customers. Could make customer intros.",
    "Wants to see 3 more months of pilot data before committing.",
    "Strong technical background; asked detailed questions about the gripper design.",
)
SOURCES = ("SF Tech Week 2026", "Warm intro", "Demo day", "Cold outreach", "Angel list")
FOLLOW_NOTES = (
    "Send the updated deck and pilot metrics",
    "Share the 3PL pilot results once the October numbers are in",
    "Ask whether they will lead or only follow",
    "Book a partner meeting for next week",
    "Send the data room link",
    "Answer their question on gross margin per robot",
    "Check in after their Monday partner meeting",
    "Intro them to our design partner at the 3PL",
    "Send the customer reference list",
    "Confirm the allocation they asked for",
    "Follow up on the term sheet questions",
)
NEXT_STEPS = (
    "Schedule partner meeting",
    "Customer reference calls",
    "Technical deep dive with our CTO",
    "Send financial model",
    "Site visit at the pilot warehouse",
    "Confirm allocation and sign the SAFE",
)


def _work_hours(at: datetime, i: int) -> datetime:
    """``at`` moved to a plausible working-hours time (local), never later than ``at``'s day
    allows: 8:40 to 17:55 in the sample timezone, varied by ``i``."""
    tz = ZoneInfo(SAMPLE_TIMEZONE)
    local = at.astimezone(tz)
    minutes = 8 * 60 + 40 + (i * 97) % (9 * 60 + 15)
    moved = local.replace(hour=minutes // 60, minute=minutes % 60, second=0, microsecond=0)
    return moved.astimezone(at.tzinfo or tz)


def _past(at: datetime, now: datetime) -> datetime:
    return min(at, now - timedelta(minutes=5))


def _slug(name: str) -> str:
    return "-".join(norm(name).split())


def _context(ws: Workspace, user: User) -> WorkspaceContext:
    """A workspace context for the seeding: the owner's principal, system actor by default."""
    principal = Principal(
        type=ActorType.USER,
        workspace=WorkspaceInfo.of(ws),
        scopes=ROLE_SCOPES[Role.OWNER],
        user_id=user.id,
        role=Role.OWNER,
    )
    return WorkspaceContext.build(principal, SYSTEM_ACTOR)


def _stage_map(stages: list[RoundStage]) -> dict[str, RoundStage]:
    return {s.key: s for s in stages}


def _contact(i: int, p: Person) -> dict[str, Any]:
    local = ".".join(norm(p.name).split())
    domain = f"{_slug(p.firm).replace('-', '')}.example.com" if p.firm else "example.com"
    return {
        "name": p.name,
        "firm": p.firm,
        "title": p.title,
        "type": p.type,
        "check_note": p.check,
        "check_min": p.check_min,
        "check_max": p.check_max,
        "location": p.location,
        "industries": [i.upper() if i in ("ai", "saas") else i.capitalize() for i in p.industries],
        "tags": list(p.tags),
        "stage_focus": ["pre-seed", "seed"] if p.type in ("angel", "scout") else ["seed"],
        "email": f"{local}@{domain}",
        "linkedin_url": f"https://www.linkedin.com/in/example-{_slug(p.name)}",
        "source": SOURCES[i % len(SOURCES)],
        "notes": NOTES[i % len(NOTES)] if i % 3 != 2 else None,
        "warm_intro_by": "Tomas Okafor" if i in (2, 8, 13) else None,
    }


async def create_sample_workspace(db: AsyncSession, *, user: User, now: datetime) -> Workspace:
    """Create "Kestrel Robotics (sample)" (``is_sandbox=True``) owned by ``user``."""
    from raisebook.services import activities, investors, participants, rounds, stages

    ws_row = await create_workspace_row(
        db,
        user=user,
        name=SAMPLE_NAME,
        now=now,
        timezone=SAMPLE_TIMEZONE,
        default_currency="USD",
        is_sandbox=True,
    )
    ws = _context(ws_row, user)
    today: date = now.astimezone(ZoneInfo(SAMPLE_TIMEZONE)).date()
    me = user_actor(user.id)

    preseed = await rounds.create_round(
        db,
        ws,
        {
            "name": "Pre-seed",
            "instrument": "safe",
            "currency": "USD",
            "target_amount": 250_000,
            "valuation_cap": 8_000_000,
            "target_close_on": today - timedelta(days=250),
            "notes": "Friends, angels and one accelerator. Closed oversubscribed.",
        },
        now=now - timedelta(days=330),
    )
    seed = await rounds.create_round(
        db,
        ws,
        {
            "name": "Seed",
            "instrument": "safe",
            "currency": "USD",
            "target_amount": 2_000_000,
            "valuation_cap": 16_000_000,
            "target_close_on": today + timedelta(weeks=8),
            "notes": "Post-money SAFE. Looking for a lead with robotics or industrial depth.",
        },
        now=now - timedelta(days=45),
    )
    pre_list = await stages.stages_for(db, ws, preseed.id)
    seed_list = await stages.stages_for(db, ws, seed.id)
    pre_st, seed_st = _stage_map(pre_list), _stage_map(seed_list)

    people: list[Investor] = []
    in_preseed = set(PRESEED_COMMITTED) | set(PRESEED_PASSED)
    for i, p in enumerate(PEOPLE):
        # Every contact exists before its first timeline entry.
        days = 335 - (i % 5) if i in in_preseed else 60 - (i % 20)
        created = _past(_work_hours(now - timedelta(days=days), i), now)
        people.append(
            await investors.create(
                db, ws, _contact(i, p), now=created, actor=AGENT if i % 4 == 0 else SYSTEM_ACTOR
            )
        )

    # Pre-seed (closed): five commitments and two passes.
    for i, amount in PRESEED_COMMITTED.items():
        at = _work_hours(now - timedelta(days=245), i)
        await participants.upsert(
            db,
            ws,
            preseed,
            people[i],
            {"fit": 4},
            now=_work_hours(now - timedelta(days=320), i + 1),
            actor=me,
            stages=pre_list,
        )
        await participants.upsert(
            db,
            ws,
            preseed,
            people[i],
            {
                "stage": pre_st["committed"],
                "amount_committed": amount,
                "committed_on": today - timedelta(days=245),
            },
            now=at,
            actor=me,
            stages=pre_list,
        )
    for i in PRESEED_PASSED:
        await participants.upsert(
            db,
            ws,
            preseed,
            people[i],
            {"fit": 2},
            now=_work_hours(now - timedelta(days=320), i + 1),
            actor=me,
            stages=pre_list,
        )
        await participants.upsert(
            db,
            ws,
            preseed,
            people[i],
            {"stage": pre_st["passed"]},
            now=_work_hours(now - timedelta(days=280), i + 2),
            actor=me,
            stages=pre_list,
        )
    await rounds.update_round(
        db,
        ws,
        preseed,
        {"status": "closed", "closed_on": today - timedelta(days=240)},
        now=now - timedelta(days=240),
    )

    # Seed (open): every investor, spread across all stages.
    for i, (inv, plan) in enumerate(zip(people, SEED_PLAN, strict=True)):
        key, fit, follow, soft, prob, committed = plan
        st = seed_st[key]
        stale = st.kind == "active" and i % 7 == 0
        changed = _past(
            _work_hours(now - timedelta(days=(17 + i % 4) if stale else ((i * 3) % 21 + 1)), i),
            now,
        )
        added = _past(_work_hours(now - timedelta(days=40 - (i % 10)), i + 3), now)
        actor = AGENT if i % 3 == 0 else me
        initial: dict[str, Any] = {"fit": fit}
        if soft is not None:
            initial["amount_soft"] = soft
        if prob is not None:
            initial["probability"] = prob
        if i % 2 == 0:
            initial["owner_user_id"] = user.id
        await participants.upsert(
            db, ws, seed, inv, initial, now=added, actor=actor, stages=seed_list
        )
        if key in ("contacted", "replied", "meeting", "dd", "committed"):
            await activities.log_manual(
                db,
                ws,
                investor=inv,
                kind="email",
                body="Sent the Seed deck and a two-line update on the pilot with a 3PL.",
                now=_work_hours(changed - timedelta(days=2), i + 5),
                round_id=seed.id,
                direction="outbound",
                actor=AGENT if i % 2 else me,
            )
        if key in ("meeting", "dd", "committed"):
            await activities.log_manual(
                db,
                ws,
                investor=inv,
                kind="meeting",
                body="45-minute call. Walked through unit economics and the pilot pipeline.",
                now=_work_hours(changed - timedelta(days=1), i + 11),
                round_id=seed.id,
                actor=me,
            )
        if i % 5 == 1:
            await activities.log_manual(
                db,
                ws,
                investor=inv,
                kind="note",
                body="Researched recent investments: two warehouse-automation deals in 2026.",
                now=_work_hours(changed - timedelta(days=1), i + 17),
                round_id=seed.id,
                actor=AGENT,
            )
        if committed:
            await participants.upsert(
                db,
                ws,
                seed,
                inv,
                {
                    "stage": st,
                    "amount_committed": committed,
                    "committed_on": today - timedelta(days=i % 9 + 1),
                },
                now=changed,
                actor=me,
                stages=seed_list,
                note="Signed the SAFE.",
            )
        elif key != "new":
            await participants.upsert(
                db, ws, seed, inv, {"stage": st}, now=changed, actor=actor, stages=seed_list
            )
        extra: dict[str, Any] = {}
        if follow is not None:
            extra["follow_up_on"] = today + timedelta(days=follow)
            extra["follow_up_note"] = FOLLOW_NOTES[i % len(FOLLOW_NOTES)]
        if key in ("meeting", "dd", "replied"):
            extra["next_step"] = NEXT_STEPS[i % len(NEXT_STEPS)]
        if extra:
            await participants.upsert(
                db,
                ws,
                seed,
                inv,
                extra,
                now=changed,
                actor=AGENT if i % 2 == 0 else me,
                stages=seed_list,
            )
    await db.flush()
    return ws_row
