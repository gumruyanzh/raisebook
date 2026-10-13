"""Import service (SPEC §8.2, §9.2 item 6): mapping, every dedupe path, within-file
duplicates, error rows, dry run, round columns, prototype JSON, CSV round-trip, limits."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from raisebook.auth.principal import Principal, WorkspaceContext, WorkspaceInfo
from raisebook.auth.scopes import ROLE_SCOPES
from raisebook.core.actor import user_actor
from raisebook.core.errors import ImportInvalid, LimitReached, NotFound
from raisebook.models.activity import Activity
from raisebook.models.enums import ActorType, Role
from raisebook.models.imports import ImportRun
from raisebook.models.investor import Investor
from raisebook.models.round import RoundParticipant, RoundStage
from raisebook.schemas.data import ImportRequest, RoundMapEntry
from raisebook.services import exports, imports
from raisebook.services.workspaces import LIMITS
from tests.factories import (
    add_member,
    make_investor,
    make_participant,
    make_round,
    make_workspace,
    owner_of,
)

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


def ctx_for(ws: Any, user: Any, role: str = "owner") -> WorkspaceContext:
    principal = Principal(
        type=ActorType.USER,
        workspace=WorkspaceInfo.of(ws),
        scopes=ROLE_SCOPES[Role(role)],
        user_id=user.id,
        role=Role(role),
    )
    return WorkspaceContext.build(principal, user_actor(user.id))


async def setup_ws(db: AsyncSession, **kw: Any) -> tuple[Any, Any, WorkspaceContext]:
    ws = await make_workspace(db, **kw)
    owner = await owner_of(db, ws)
    return ws, owner, ctx_for(ws, owner)


async def n_investors(db: AsyncSession, ws: Any) -> int:
    return int(
        await db.scalar(
            select(func.count()).select_from(Investor).where(Investor.workspace_id == ws.id)
        )
        or 0
    )


async def investor_by_email(db: AsyncSession, ws: Any, email: str) -> Investor:
    inv = await db.scalar(
        select(Investor).where(Investor.workspace_id == ws.id, Investor.email == email)
    )
    assert inv is not None, email
    return inv


async def part_of(db: AsyncSession, rnd: Any, inv: Investor) -> tuple[RoundParticipant, str]:
    row = (
        await db.execute(
            select(RoundParticipant, RoundStage.key)
            .join(RoundStage, RoundStage.id == RoundParticipant.stage_id)
            .where(RoundParticipant.round_id == rnd.id, RoundParticipant.investor_id == inv.id)
        )
    ).one()
    return row[0], row[1]


def csv_req(content: str, **kw: Any) -> ImportRequest:
    return ImportRequest(format="csv", content=content, **kw)


# --- preview / dry run ----------------------------------------------------------------------


async def test_preview_auto_maps_and_writes_nothing(db: AsyncSession, frozen_now: Any) -> None:
    ws, _, ctx = await setup_ws(db)
    rnd = await make_round(db, ws, name="Seed")
    content = (FIXTURES / "investors_basic.csv").read_text()
    pv = await imports.preview(db, ctx, csv_req(content, round="Seed"))
    assert pv.mapping["Full Name"] == "name"
    assert pv.mapping["Fund"] == "firm"
    assert pv.mapping["Pipeline Stage"] == "stage"
    assert pv.mapping["Priority"] == "fit"
    assert pv.row_count == 8
    actions = {r.row: r.action for r in pv.rows}
    # rows: 2 Dana, 3 Marcus, 4 Ines, 5 DANA (dup of row 2), 6 no name, 7 bad email,
    # 8 fit 9, 9 Helena. Only the nameless row is an error (P0-6): a bad optional cell is
    # left empty with a warning and the row imports.
    assert actions == {
        2: "create",
        3: "create",
        4: "create",
        5: "skip",
        6: "error",
        7: "create",
        8: "create",
        9: "create",
    }
    assert pv.counts.model_dump() == {
        "create": 6,
        "update": 0,
        "skip": 1,
        "error": 1,
        "add_to_round": 6,
        "cells_left_empty": 2,
    }
    assert pv.warning_kinds == {"email_invalid": 1, "fit_invalid": 1}
    priya = next(r for r in pv.rows if r.row == 7)
    assert "email" not in priya.investor
    assert any(w.startswith("email left empty: 'not-an-email'") for w in priya.warnings)
    tomas = next(r for r in pv.rows if r.row == 8)
    assert tomas.participant is not None and tomas.participant.fit is None
    assert any(w.startswith("fit left empty: '9'") for w in tomas.warnings)
    dup = next(r for r in pv.rows if r.row == 5)
    assert dup.match is not None
    assert dup.match.row == 2 and dup.match.matched_on == "email" and dup.match.investor_id is None
    errs = {r.row: [e.field for e in r.errors] for r in pv.rows if r.errors}
    assert errs == {6: ["name"]}
    dana = next(r for r in pv.rows if r.row == 2)
    assert dana.participant is not None
    assert dana.participant.stage == "meeting" and dana.participant.fit == 5
    assert dana.participant.amount_soft == 1_000_000
    assert dana.investor["check_min"] == 500_000 and dana.investor["check_max"] == 2_000_000
    helena = next(r for r in pv.rows if r.row == 9)
    assert helena.participant is not None and helena.participant.follow_up_on == "2026-03-04"
    assert any("month/day" in w for w in helena.warnings)
    assert pv.samples["Fund"][:2] == ["Harbor Light Ventures", "Juniper Angels"]
    # Nothing written.
    assert await n_investors(db, ws) == 0
    assert await db.scalar(select(func.count()).select_from(ImportRun)) == 0
    _ = rnd


async def test_commit_creates_with_activities_and_run(db: AsyncSession, frozen_now: Any) -> None:
    ws, owner, ctx = await setup_ws(db)
    rnd = await make_round(db, ws, name="Seed")
    content = (FIXTURES / "investors_basic.csv").read_text()
    res = await imports.commit(
        db, ctx, csv_req(content, round="seed", filename="list.csv"), now=frozen_now
    )
    assert res.counts.model_dump() == {
        "rows": 8,
        "created": 6,
        "updated": 0,
        "skipped": 1,
        "errors": 1,
        "added_to_round": 6,
        "cells_left_empty": 2,
    }
    assert {(e.row, e.field) for e in res.errors} == {(6, "name")}
    assert res.warning_kinds == {"email_invalid": 1, "fit_invalid": 1}
    assert res.round == {"id": str(rnd.id), "slug": "seed", "name": "Seed"}
    assert await n_investors(db, ws) == 6

    dana = await investor_by_email(db, ws, "dana@example.com")
    assert dana.firm == "Harbor Light Ventures" and dana.type == "vc"
    assert dana.tags == ["lead", "hardware"]
    assert dana.linkedin_key == "in/example-dana-whitfield"
    part, stage = await part_of(db, rnd, dana)
    assert stage == "meeting" and part.fit == 5 and part.amount_soft == 1_000_000
    assert part.follow_up_on == date(2026, 10, 20)
    marcus = await investor_by_email(db, ws, "marcus@example.com")
    assert marcus.type == "angel"
    part, stage = await part_of(db, rnd, marcus)
    assert stage == "contacted" and part.fit == 4 and part.amount_soft == 25_000

    run = await db.scalar(select(ImportRun).where(ImportRun.id == res.import_run_id))
    assert run is not None
    assert run.workspace_id == ws.id and run.round_id == rnd.id and run.filename == "list.csv"
    assert run.actor_type == "user" and run.actor_user_id == owner.id
    assert run.counts["created"] == 6 and run.options["on_duplicate"] == "skip"
    acts = list(await db.scalars(select(Activity).where(Activity.investor_id == dana.id)))
    kinds = {a.kind for a in acts}
    assert {"investor_created", "added_to_round", "follow_up_set"} <= kinds
    assert all(a.via == "import" and a.import_run_id == run.id for a in acts)
    assert all(a.actor_type == "user" and a.actor_user_id == owner.id for a in acts)

    runs = await imports.list_runs(db, ctx)
    assert [r.id for r in runs] == [run.id]
    assert runs[0].round_name == "Seed" and runs[0].counts["created"] == 6


async def test_semicolon_bom_contacts_only(db: AsyncSession, frozen_now: Any) -> None:
    ws, _, ctx = await setup_ws(db)
    res = await imports.commit(
        db,
        ctx,
        csv_req((FIXTURES / "investors_semicolon.csv").read_text(encoding="utf-8")),
        now=frozen_now,
    )
    assert res.counts.created == 2 and res.counts.added_to_round == 0
    grace = await investor_by_email(db, ws, "grace@example.com")
    assert grace.tags == ["lead", "robotics"]
    assert await db.scalar(select(func.count()).select_from(RoundParticipant)) == 0


async def test_round_columns_ignored_without_round(db: AsyncSession, frozen_now: Any) -> None:
    _ws, _, ctx = await setup_ws(db)
    pv = await imports.preview(
        db, ctx, csv_req("Name,Pipeline stage,Fit\nDana Whitfield,Meeting,5\n")
    )
    assert pv.counts.create == 1 and pv.counts.add_to_round == 0
    assert any("ignored because no round" in w for w in pv.warnings)
    assert pv.rows[0].participant is None


async def test_first_and_last_name_and_source_default(db: AsyncSession, frozen_now: Any) -> None:
    ws, _, ctx = await setup_ws(db)
    await imports.commit(
        db,
        ctx,
        csv_req(
            "First name,Last name,Source\nDana,Whitfield,\nMarcus,Odell,Demo day\n",
            source="SF Tech Week 2026",
        ),
        now=frozen_now,
    )
    rows = {
        i.name: i.source
        for i in await db.scalars(select(Investor).where(Investor.workspace_id == ws.id))
    }
    assert rows == {"Dana Whitfield": "SF Tech Week 2026", "Marcus Odell": "Demo day"}


# --- dedupe ---------------------------------------------------------------------------------


async def test_dedupe_against_existing_every_path(db: AsyncSession, frozen_now: Any) -> None:
    ws, _, ctx = await setup_ws(db)
    by_email = await make_investor(db, ws, name="Dana Whitfield", email="dana@example.com")
    by_li = await make_investor(
        db,
        ws,
        name="Marcus Odell",
        email=None,
        linkedin_url="https://www.linkedin.com/in/example-marcus",
    )
    by_name = await make_investor(
        db, ws, name="Ines Calloway", firm="Brightquay Capital", email=None
    )
    angel = await make_investor(db, ws, name="Tomas Okafor", firm=None, email=None)
    content = (
        "Name,Firm,Email,LinkedIn\n"
        "Dana W.,Other Firm,DANA@EXAMPLE.COM,\n"
        "Marcus O,,,linkedin.com/in/Example-Marcus/?trk=x\n"
        "Inès Calloway,Brightquay,,\n"
        "Tomas Okafor,,,\n"
        "Tomas Okafor,Some Fund,,\n"
    )
    pv = await imports.preview(db, ctx, csv_req(content))
    got = [(r.action, r.match.matched_on if r.match else None) for r in pv.rows]
    assert got == [
        ("skip", "email"),
        ("skip", "linkedin"),
        ("skip", "name_firm"),
        ("skip", "name_firm"),
        ("create", None),  # firm present vs absent: not the same person
    ]
    assert [r.match.investor_id for r in pv.rows[:4] if r.match] == [
        by_email.id,
        by_li.id,
        by_name.id,
        angel.id,
    ]


async def test_other_workspace_never_matches(db: AsyncSession, frozen_now: Any) -> None:
    ws_a, _, ctx_a = await setup_ws(db)
    ws_b = await make_workspace(db)
    await make_investor(db, ws_b, name="Dana Whitfield", email="dana@example.com")
    pv = await imports.preview(db, ctx_a, csv_req("Name,Email\nDana Whitfield,dana@example.com\n"))
    assert pv.rows[0].action == "create" and pv.rows[0].match is None
    _ = ws_a


async def test_fill_empty_and_update_modes(db: AsyncSession, frozen_now: Any) -> None:
    ws, _, ctx = await setup_ws(db)
    rnd = await make_round(db, ws, name="Seed")
    inv = await make_investor(
        db,
        ws,
        name="Dana Whitfield",
        email="dana@example.com",
        firm="Harbor Light Ventures",
        title=None,
        tags=["lead"],
    )
    await make_participant(db, rnd, inv, stage="contacted", fit=3)
    content = (
        "Name,Email,Firm,Title,Tags,Pipeline stage,Fit,Next step\n"
        "Dana Whitfield,dana@example.com,Harbor Light Capital,Partner,hardware,Meeting,5,"
        "Send deck\n"
    )
    pv = await imports.preview(db, ctx, csv_req(content, round="Seed", on_duplicate="fill_empty"))
    assert pv.rows[0].action == "update"
    await imports.commit(
        db, ctx, csv_req(content, round="Seed", on_duplicate="fill_empty"), now=frozen_now
    )
    await db.refresh(inv)
    assert inv.firm == "Harbor Light Ventures"  # not empty: kept
    assert inv.title == "Partner"  # filled
    assert inv.tags == ["lead", "hardware"]  # unioned
    part, stage = await part_of(db, rnd, inv)
    assert stage == "contacted"  # fill_empty never moves the stage
    assert part.fit == 3 and part.next_step == "Send deck"

    res = await imports.commit(
        db, ctx, csv_req(content, round="Seed", on_duplicate="update"), now=frozen_now
    )
    assert res.counts.updated == 1
    await db.refresh(inv)
    assert inv.firm == "Harbor Light Capital" and inv.tags == ["hardware"]
    part, stage = await part_of(db, rnd, inv)
    assert stage == "meeting" and part.fit == 5
    kinds = set(
        await db.scalars(
            select(Activity.kind).where(Activity.investor_id == inv.id, Activity.via == "import")
        )
    )
    assert {"investor_updated", "stage_change", "participant_updated"} <= kinds

    # Same file again in update mode: nothing changes any more.
    pv = await imports.preview(db, ctx, csv_req(content, round="Seed", on_duplicate="update"))
    assert pv.rows[0].action == "skip"


async def test_skip_still_adds_existing_investor_to_round(
    db: AsyncSession, frozen_now: Any
) -> None:
    ws, _, ctx = await setup_ws(db)
    rnd = await make_round(db, ws, name="Seed")
    inv = await make_investor(db, ws, name="Dana Whitfield", email="dana@example.com", title=None)
    content = "Name,Email,Title,Pipeline stage\nDana Whitfield,dana@example.com,Partner,Replied\n"
    pv = await imports.preview(db, ctx, csv_req(content, round="Seed"))
    assert pv.rows[0].action == "skip" and pv.counts.add_to_round == 1
    res = await imports.commit(db, ctx, csv_req(content, round="Seed"), now=frozen_now)
    assert res.counts.skipped == 1 and res.counts.added_to_round == 1
    await db.refresh(inv)
    assert inv.title is None  # skip leaves the contact unchanged
    _, stage = await part_of(db, rnd, inv)
    assert stage == "replied"
    # Again: already in the round, nothing to add.
    pv = await imports.preview(db, ctx, csv_req(content, round="Seed"))
    assert pv.counts.add_to_round == 0 and pv.rows[0].action == "skip"


async def test_update_does_not_steal_another_investors_email(
    db: AsyncSession, frozen_now: Any
) -> None:
    ws, _, ctx = await setup_ws(db)
    await make_investor(db, ws, name="Dana Whitfield", firm="Harbor Light", email=None)
    other = await make_investor(db, ws, name="Marcus Odell", email="marcus@example.com")
    content = "Name,Firm,Email\nDana Whitfield,Harbor Light,marcus@example.com\n"
    pv = await imports.preview(db, ctx, csv_req(content, on_duplicate="update"))
    # Email matches Marcus first (SPEC order), so the row is Marcus's.
    assert pv.rows[0].match is not None and pv.rows[0].match.investor_id == other.id


# --- round fields ---------------------------------------------------------------------------


async def test_default_stage_unknown_stage_and_owner(db: AsyncSession, frozen_now: Any) -> None:
    ws, _, ctx = await setup_ws(db)
    member = await add_member(db, ws, role="editor")
    rnd = await make_round(db, ws, name="Seed")
    content = (
        "Name,Pipeline stage,Owner,Committed,Probability\n"
        f"Dana Whitfield,,{member.email},,\n"
        "Marcus Odell,Term sheet,stranger@example.com,€250k,40%\n"
    )
    pv = await imports.preview(db, ctx, csv_req(content, round="Seed", default_stage="research"))
    dana, marcus = pv.rows
    assert dana.participant is not None and dana.participant.stage == "research"
    assert dana.participant.owner_email == member.email
    assert marcus.participant is not None and marcus.participant.stage == "research"
    assert any("Term sheet" in w for w in marcus.warnings)
    assert any("not a member" in w for w in marcus.warnings)
    assert any("EUR" in w for w in marcus.warnings)
    await imports.commit(
        db, ctx, csv_req(content, round="Seed", default_stage="research"), now=frozen_now
    )
    m = await db.scalar(select(Investor).where(Investor.name == "Marcus Odell"))
    assert m is not None
    part, _ = await part_of(db, rnd, m)
    assert part.amount_committed == 250_000 and part.probability == 40
    assert part.owner_user_id is None


async def test_bad_default_stage_and_unknown_round(db: AsyncSession, frozen_now: Any) -> None:
    ws, _, ctx = await setup_ws(db)
    await make_round(db, ws, name="Seed")
    with pytest.raises(ImportInvalid):
        await imports.preview(db, ctx, csv_req("Name\nDana\n", round="Seed", default_stage="nope"))
    with pytest.raises(NotFound):
        await imports.preview(db, ctx, csv_req("Name\nDana\n", round="Series Z"))


async def test_round_of_other_workspace_is_not_found(db: AsyncSession, frozen_now: Any) -> None:
    _, _, ctx = await setup_ws(db)
    other = await make_workspace(db)
    theirs = await make_round(db, other, name="Theirs")
    for ref in (str(theirs.id), "theirs", "Theirs"):
        with pytest.raises(NotFound):
            await imports.preview(db, ctx, csv_req("Name\nDana\n", round=ref))


async def test_explicit_mapping_overrides(db: AsyncSession, frozen_now: Any) -> None:
    _ws, _, ctx = await setup_ws(db)
    content = "Who,Where,Ignored\nDana Whitfield,Oakland,secret\n"
    pv = await imports.preview(
        db, ctx, csv_req(content, mapping={"Who": "name", "Where": "location", "Ignored": None})
    )
    assert pv.rows[0].investor["name"] == "Dana Whitfield"
    assert pv.rows[0].investor["location"] == "Oakland"
    assert "secret" not in json.dumps(pv.rows[0].investor)
    assert pv.counts.create == 1
    pv = await imports.preview(db, ctx, csv_req(content))
    assert any("No column is mapped to Name" in w for w in pv.warnings)
    assert pv.counts.error == 1


async def test_investor_limit(db: AsyncSession, frozen_now: Any, monkeypatch: Any) -> None:
    ws, _, ctx = await setup_ws(db)
    await make_investor(db, ws)
    monkeypatch.setitem(LIMITS, "investors", 2)
    content = "Name\nA One\nB Two\n"
    pv = await imports.preview(db, ctx, csv_req(content))
    assert any("limit" in w for w in pv.warnings)
    with pytest.raises(LimitReached):
        await imports.commit(db, ctx, csv_req(content), now=frozen_now)
    assert await n_investors(db, ws) == 1


# --- prototype JSON -------------------------------------------------------------------------


async def test_prototype_json(db: AsyncSession, frozen_now: Any) -> None:
    ws, _, ctx = await setup_ws(db, timezone="America/Los_Angeles")
    seed = await make_round(db, ws, name="Seed")
    content = (FIXTURES / "prototype.json").read_text()
    req = ImportRequest(
        format="prototype_json",
        content=content,
        round_map=[RoundMapEntry(source_key="qenzo", round="Seed", fit_field="qFit")],
    )
    pv = await imports.preview(db, ctx, req)
    assert [r.action for r in pv.rows] == ["create", "create", "create", "error"]
    assert pv.counts.add_to_round == 3
    marcus_row = pv.rows[1]
    assert any("search URL" in w for w in marcus_row.warnings)
    assert any("Syndicate" in w for w in pv.rows[2].warnings)

    res = await imports.commit(db, ctx, req, now=frozen_now)
    assert res.counts.created == 3 and res.counts.errors == 1
    dana = await investor_by_email(db, ws, "dana@example.com")
    assert dana.industries == ["Robotics"] and dana.tags == ["lead", "hardware"]
    assert dana.stage_focus == ["Seed", "Series A"]
    assert dana.check_note == "$500k-$2M" and dana.check_min == 500_000
    assert dana.x_url == "https://x.com/example_dana"
    assert dana.website_url == "https://harborlight.example.com"
    assert dana.notes is not None
    for label in ("Summary:", "Bio:", "Research:", "Instagram:", "Events together:"):
        assert label in dana.notes
    part, stage = await part_of(db, seed, dana)
    assert stage == "dd" and part.fit == 5 and part.follow_up_on == date(2026, 10, 15)
    notes = list(
        await db.scalars(
            select(Activity)
            .where(Activity.investor_id == dana.id, Activity.kind == "note")
            .order_by(Activity.occurred_at)
        )
    )
    assert [n.body for n in notes] == [
        "Intro call went well.",
        "Sent the deck.",
        "Wants the data room.",
    ]
    assert all(n.data.get("imported_from") == "prototype" and n.round_id == seed.id for n in notes)
    # log dates become 12:00 local time (Los Angeles = 19:00 UTC in October).
    assert notes[0].occurred_at.isoformat().startswith("2026-10-01T19:00")

    marcus = await db.scalar(select(Investor).where(Investor.name == "Marcus Odell"))
    assert marcus is not None and marcus.linkedin_url is None
    part, stage = await part_of(db, seed, marcus)
    assert stage == "committed" and part.amount_committed == 50_000 and part.fit == 4
    ines = await db.scalar(select(Investor).where(Investor.name == "Ines Calloway"))
    assert ines is not None and ines.type == "other"
    _, stage = await part_of(db, seed, ines)
    assert stage == "meeting"  # label match

    # Re-import (fill_empty): no duplicate investors or notes.
    req2 = req.model_copy(update={"on_duplicate": "fill_empty"})
    res2 = await imports.commit(db, ctx, req2, now=frozen_now)
    assert res2.counts.created == 0
    assert await n_investors(db, ws) == 3
    again = await db.scalar(
        select(func.count())
        .select_from(Activity)
        .where(Activity.investor_id == dana.id, Activity.kind == "note")
    )
    assert again == 3


async def test_prototype_round_shortcut_and_ambiguity(db: AsyncSession, frozen_now: Any) -> None:
    ws, _, ctx = await setup_ws(db)
    await make_round(db, ws, name="Seed")
    one = json.dumps([{"name": "Dana Whitfield", "p": {"qenzo": {"stage": "meeting"}}}])
    pv = await imports.preview(
        db, ctx, ImportRequest(format="prototype_json", content=one, round="Seed")
    )
    assert pv.rows[0].participant is not None and pv.rows[0].participant.stage == "meeting"
    two = json.dumps([{"name": "A", "p": {"x": {}, "y": {}}}])
    with pytest.raises(ImportInvalid) as exc:
        await imports.preview(
            db, ctx, ImportRequest(format="prototype_json", content=two, round="Seed")
        )
    assert exc.value.details == {"source_keys": ["x", "y"]}
    pv = await imports.preview(db, ctx, ImportRequest(format="prototype_json", content=two))
    assert any("round data under 'p'" in w for w in pv.warnings)
    with pytest.raises(ImportInvalid):
        await imports.preview(db, ctx, ImportRequest(format="prototype_json", content="{oops"))
    with pytest.raises(ImportInvalid):
        await imports.preview(db, ctx, ImportRequest(format="prototype_json", content='{"a": 1}'))


# --- round trip and formula guard -----------------------------------------------------------


async def test_csv_round_trip_into_empty_workspace(db: AsyncSession, frozen_now: Any) -> None:
    ws_a, _, ctx_a = await setup_ws(db)
    rnd_a = await make_round(db, ws_a, name="Seed")
    a1 = await make_investor(
        db,
        ws_a,
        name="Dana Whitfield",
        email="dana@example.com",
        title="Partner",
        tags=["lead", "hardware"],
        industries=["robotics"],
        check_min=500_000,
        check_max=2_000_000,
        check_note="$500k-$2M",
        linkedin_url="https://www.linkedin.com/in/example-dana",
        notes="=SUM(A1:A9) is not a formula here",
    )
    a2 = await make_investor(db, ws_a, name="-Marcus Odell", firm=None, email=None)
    await make_participant(
        db,
        rnd_a,
        a1,
        stage="dd",
        fit=5,
        probability=60,
        amount_soft=1_000_000,
        follow_up_on=date(2026, 10, 20),
        follow_up_note="Send the data room",
        next_step="Partner meeting",
    )
    await make_participant(db, rnd_a, a2, stage="committed", fit=4, amount_committed=50_000)
    f = await exports.export_round(db, ctx_a, rnd_a, fmt="csv", now=frozen_now)
    assert "'=SUM" in f.content and "'-Marcus" in f.content

    ws_b, _, ctx_b = await setup_ws(db)
    rnd_b = await make_round(db, ws_b, name="Seed")
    res = await imports.commit(db, ctx_b, csv_req(f.content, round="Seed"), now=frozen_now)
    assert res.counts.created == 2 and res.counts.errors == 0
    b1 = await investor_by_email(db, ws_b, "dana@example.com")
    for fld in (
        "name",
        "firm",
        "title",
        "type",
        "tags",
        "industries",
        "check_min",
        "check_max",
        "check_note",
        "linkedin_url",
        "notes",
    ):
        assert getattr(b1, fld) == getattr(a1, fld), fld
    p1, stage = await part_of(db, rnd_b, b1)
    assert stage == "dd"
    assert (
        p1.fit,
        p1.probability,
        p1.amount_soft,
        p1.follow_up_on,
        p1.follow_up_note,
        p1.next_step,
    ) == (5, 60, 1_000_000, date(2026, 10, 20), "Send the data room", "Partner meeting")
    b2 = await db.scalar(
        select(Investor).where(Investor.workspace_id == ws_b.id, Investor.name == "-Marcus Odell")
    )
    assert b2 is not None
    p2, stage = await part_of(db, rnd_b, b2)
    assert stage == "committed" and p2.amount_committed == 50_000


MESSY = (
    "Name,Firm,Email,LinkedIn,Check min,Check max,Stage,Fit,Next Follow Up,Soft\n"
    "Ada Brightwater,Kestrel Fund,ada@example.com,,100k,50k,Contacted,4,next week,250k\n"
    "Ben Fallowfield,Copperline Partners,not an email,linkedin.com/in/example-ben,,,Meeting,7,"
    "2026-10-20,lots\n"
    "Cleo Marchetti,Saltmarsh Capital,cleo@example.com,,,,Replied,3,soon-ish,\n"
    ",Nameless Ventures,nameless@example.com,,,,New,2,,\n"
)


async def test_bad_optional_cells_never_drop_the_row(db: AsyncSession, frozen_now: Any) -> None:
    """P0-6: only a missing name is an error. An unreadable date, an invalid email, an
    out-of-range fit, a bad amount and min > max are left empty, with a warning per cell."""
    ws, _, ctx = await setup_ws(db)
    rnd = await make_round(db, ws, name="Seed")
    pv = await imports.preview(db, ctx, csv_req(MESSY, round="seed"))
    assert {r.row: r.action for r in pv.rows} == {2: "create", 3: "create", 4: "create", 5: "error"}
    assert pv.counts.error == 1 and pv.counts.cells_left_empty == 6
    assert pv.warning_kinds == {
        "type_guessed": 3,  # no type column: Fund / Partners / Capital read as VC
        "follow_up_unreadable": 2,
        "amount_unreadable": 1,
        "check_size_invalid": 1,
        "email_invalid": 1,
        "fit_invalid": 1,
    }
    ada = next(r for r in pv.rows if r.row == 2)
    assert "follow-up left empty: 'next week' is not a date" in ada.warnings
    assert "check_min" not in ada.investor and "check_max" not in ada.investor

    res = await imports.commit(db, ctx, csv_req(MESSY, round="seed"), now=frozen_now)
    assert res.counts.created == 3 and res.counts.errors == 1
    assert res.counts.cells_left_empty == 6
    ada_inv = await investor_by_email(db, ws, "ada@example.com")
    part, stage = await part_of(db, rnd, ada_inv)
    assert part.follow_up_on is None and part.amount_soft == 250_000 and stage == "contacted"

    # The row without an email still dedupes, by LinkedIn and then by name + firm.
    again = (
        "Name,Firm,Email,LinkedIn\n"
        "Ben Fallowfield,Copperline Partners,still not an email,linkedin.com/in/example-ben\n"
        "Ben Fallowfield,Copperline Partners,,\n"
    )
    pv2 = await imports.preview(db, ctx, csv_req(again))
    assert [r.action for r in pv2.rows] == ["skip", "skip"]
    assert [r.match.matched_on for r in pv2.rows if r.match] == ["linkedin", "name_firm"]


REVIEW = (
    "Name,Firm,Title,Status,Priority,Last contacted,Next Follow Up\n"
    "Ana Quarrington,Tidewell Ventures,Partner,Intro requested,hot,2026-09-30,next week\n"
    "Bo Lindqvist,,Angel investor,Intro requested,4,,\n"
    "Cai Ferreira,Odd Name LLC,Principal,Meeting booked,warm,last spring,\n"
    "Dee Okonkwo,Saltmarsh Capital,GP,Researching,,,\n"
)


async def test_review_helpers_value_map_stats_and_last_contacted(
    db: AsyncSession, frozen_now: Any
) -> None:
    """P1-10: distinct stage/fit values with matches and suggestions, a value map that sends
    'Intro requested' to Contacted, empty/unreadable counts per column, a guessed type, and
    'Last contacted' as a dated note."""
    ws, _, ctx = await setup_ws(db)
    rnd = await make_round(db, ws, name="Seed")
    pv = await imports.preview(db, ctx, csv_req(REVIEW, round="seed"))
    assert pv.mapping["Status"] == "stage" and pv.mapping["Last contacted"] == "last_contacted"
    stage_vals = {v.value: (v.count, v.stage, v.suggestion) for v in pv.values["Status"]}
    assert stage_vals == {
        "Intro requested": (2, None, "contacted"),
        "Meeting booked": (1, None, "meeting"),
        "Researching": (1, "research", None),
    }
    fits = {v.value: v.fit for v in pv.values["Priority"]}
    assert fits["hot"] == 5 and fits["4"] == 4
    assert pv.column_stats["Firm"].empty == 1
    assert pv.column_stats["Last contacted"].unreadable == 1
    assert pv.column_stats["Next Follow Up"].unreadable == 1
    by_row = {r.row: r for r in pv.rows}
    assert by_row[2].investor["type"] == "vc" and by_row[3].investor["type"] == "angel"
    assert by_row[4].investor.get("type", "other") == "other"  # nothing to guess from
    assert by_row[5].participant is not None and by_row[5].participant.stage == "research"
    # An unknown stage falls back to the first stage until it is mapped.
    assert by_row[2].participant is not None and by_row[2].participant.stage == "new"

    mapped = csv_req(REVIEW, round="seed", value_map={"stage": {"Intro requested": "contacted"}})
    pv2 = await imports.preview(db, ctx, mapped)
    stages = {r.row: r.participant.stage for r in pv2.rows if r.participant}
    assert stages[2] == "contacted" and stages[3] == "contacted"

    res = await imports.commit(db, ctx, mapped, now=frozen_now)
    assert res.counts.created == 4
    ana = await db.scalar(select(Investor).where(Investor.name == "Ana Quarrington"))
    assert ana is not None
    notes = list(
        await db.scalars(
            select(Activity).where(Activity.investor_id == ana.id, Activity.kind == "note")
        )
    )
    assert len(notes) == 1 and notes[0].occurred_at.date().isoformat() == "2026-09-30"
    _ = rnd
