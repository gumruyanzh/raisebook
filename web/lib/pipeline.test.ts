import assert from "node:assert/strict";
import { test } from "node:test";

import type { Participant, Stage } from "./api/types";
import {
  boardSegments,
  cardSlot,
  cursorAfterMove,
  fitColumns,
  followOptions,
  pressedOption,
  queuePosition,
  segmentTrack,
  defaultView,
  dominantStage,
  formatDuration,
  isHiddenValue,
  isQuiet,
  moneyExists,
  nextCursor,
  nextUpBuckets,
  paceEstimate,
  priorityGroups,
  quietColumns,
  triageTargets,
  visibleIndustries,
} from "./pipeline";

const st = (key: string, kind: Stage["kind"], position: number): Stage => ({
  key,
  label: key[0]!.toUpperCase() + key.slice(1),
  color: "slate",
  kind,
  position,
});
const STAGES: Stage[] = [
  st("new", "open", 0),
  st("research", "open", 1),
  st("contacted", "active", 2),
  st("replied", "active", 3),
  st("meeting", "active", 4),
  st("dd", "active", 5),
  st("committed", "won", 6),
  st("passed", "lost", 7),
];
const S = Object.fromEntries(STAGES.map((s) => [s.key, s])) as Record<string, Stage>;

let seq = 0;
function row(over: Partial<Participant> & { stageKey?: string; name?: string; type?: string } = {}): Participant {
  seq++;
  const { stageKey = "new", name = `Investor ${seq}`, type = "vc", ...rest } = over;
  return {
    round_id: "r",
    round_slug: "seed",
    investor: { id: `i${seq}`, name, type: type as Participant["investor"]["type"], tags: [] },
    stage: S[stageKey]!,
    fit: 0,
    priority: "low",
    stage_changed_at: "2026-10-01T00:00:00Z",
    created_at: `2026-10-01T00:00:${String(seq % 60).padStart(2, "0")}Z`,
    updated_at: "2026-10-01T00:00:00Z",
    ...rest,
  };
}

test("isHiddenValue: Other and other are hidden, real values are not", () => {
  assert.equal(isHiddenValue("Other"), true);
  assert.equal(isHiddenValue(" other "), true);
  assert.equal(isHiddenValue(""), true);
  assert.equal(isHiddenValue("Health"), false);
  assert.deepEqual(visibleIndustries(["Other", "Fintech", "OTHER"]), ["Fintech"]);
});

test("defaultView: URL, then stored, then the auto rule, else board", () => {
  const base = { canWrite: true, hasOpenStage: true, openCount: 411, total: 411 };
  assert.deepEqual(defaultView(base), { view: "triage", auto: true });
  assert.deepEqual(defaultView({ ...base, stored: "board" }), { view: "board", auto: false });
  assert.deepEqual(defaultView({ ...base, stored: "board", url: "table" }), { view: "table", auto: false });
  // Viewers never get Triage, not even from the URL.
  assert.deepEqual(defaultView({ ...base, canWrite: false, url: "triage" }), { view: "board", auto: false });
  // Below the rule: New is 38 of 411 (9%).
  assert.deepEqual(defaultView({ ...base, openCount: 38 }), { view: "board", auto: false });
  // 60% but fewer than 50 investors.
  assert.deepEqual(defaultView({ ...base, openCount: 40, total: 45 }), { view: "board", auto: false });
  // A stored Triage with nothing left in New falls through; a URL Triage stays (done state).
  assert.deepEqual(defaultView({ ...base, openCount: 0, stored: "triage" }), { view: "board", auto: false });
  assert.deepEqual(defaultView({ ...base, openCount: 0, url: "triage" }), { view: "triage", auto: false });
  assert.deepEqual(defaultView({ ...base, url: "nonsense" }), { view: "triage", auto: true });
});

test("dominantStage needs 60% and 50", () => {
  assert.equal(dominantStage({ new: 411 }, 411), "new");
  assert.equal(dominantStage({ new: 318, research: 93 }, 411), "new");
  assert.equal(dominantStage({ new: 38, passed: 230, research: 143 }, 411), null);
  assert.equal(dominantStage({ new: 40 }, 45), null);
});

test("moneyExists: soft, committed or anyone in the won stage", () => {
  assert.equal(moneyExists([row(), row({ stageKey: "contacted" })]), false);
  assert.equal(moneyExists([row({ amount_soft: 50_000 })]), true);
  assert.equal(moneyExists([row({ amount_committed: 1 })]), true);
  assert.equal(moneyExists([row({ stageKey: "committed" })]), true);
});

test("triageTargets: skip New, number in order, primaries are first two + lost", () => {
  const t = triageTargets(STAGES);
  assert.deepEqual(
    t.map((x) => [x.stage.key, x.key, x.primary]),
    [
      ["research", "1", true],
      ["contacted", "2", true],
      ["replied", "3", false],
      ["meeting", "4", false],
      ["dd", "5", false],
      ["committed", "6", false],
      ["passed", "7", true],
    ],
  );
  // Custom stages: more than 9 targets leaves the rest without a key.
  const many = [st("inbox", "open", 0), ...Array.from({ length: 11 }, (_, i) => st(`s${i}`, "active", i + 1))];
  const tm = triageTargets(many);
  assert.equal(tm.length, 11);
  assert.equal(tm[8]!.key, "9");
  assert.equal(tm[9]!.key, null);
});

test("cardSlot: exactly one item, in precedence order", () => {
  const today = "2026-10-12";
  const c = (over: Parameters<typeof row>[0]) => cardSlot(row(over), today, "USD");
  // Overdue beats everything, even money in the won stage.
  assert.deepEqual(
    c({ stageKey: "committed", amount_committed: 250_000, follow_up_on: "2026-10-08", follow_up_state: "overdue" }),
    { kind: "due", text: "Overdue 4d" },
  );
  assert.deepEqual(c({ follow_up_on: today, follow_up_state: "today", amount_soft: 1 }), { kind: "due", text: "Today" });
  assert.deepEqual(c({ stageKey: "committed", amount_committed: 250_000 }), { kind: "money", text: "$250k" });
  assert.deepEqual(c({ amount_soft: 150_000, follow_up_on: "2026-10-14", follow_up_state: "soon" }), {
    kind: "soft",
    text: "$150k soft",
  });
  assert.deepEqual(c({ follow_up_on: "2026-10-14", follow_up_state: "soon" }), { kind: "soon", text: "Oct 14" });
  assert.deepEqual(c({ follow_up_on: "2026-10-24", follow_up_state: "later" }), { kind: "later", text: "Oct 24" });
  // No due date, money or follow-up: the slot stays empty (no "VC" fallback).
  assert.equal(c({ type: "corporate_vc" }), null);
  assert.equal(c({ type: "other" }), null);
});

test("nextUpBuckets: who to contact next first, New in one row, zero rows hidden", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const today = "2026-10-12";
  const old = "2026-09-20T00:00:00Z";
  const rows = [
    row({ fit: 5 }),
    row({ fit: 4 }),
    row({ fit: 2 }),
    row({ stageKey: "research", fit: 3, name: "Rhea" }),
    row({ stageKey: "research", fit: 5, name: "Bram" }),
    row({ stageKey: "contacted", last_activity_at: old }), // quiet + no follow-up
    row({ stageKey: "contacted", last_activity_at: old, follow_up_on: "2026-10-20" }), // not quiet
    row({ stageKey: "replied", last_activity_at: "2026-10-11T00:00:00Z" }), // no follow-up only
    row({ stageKey: "passed", last_activity_at: old }),
  ];
  const b = nextUpBuckets(rows, "new", today, now);
  assert.deepEqual(
    b.map((x) => [x.id, x.count]),
    [
      ["ready", 2],
      ["new", 3],
      ["quiet", 1],
      ["nofollow", 2],
    ],
  );
  const ready = b[0] as Extract<(typeof b)[number], { id: "ready" }>;
  assert.equal(ready.next?.name, "Bram");
  assert.equal(ready.stageKey, "research");
  assert.equal((b[1] as Extract<(typeof b)[number], { id: "new" }>).hw, 2);
  assert.deepEqual(nextUpBuckets([], "new", today, now), []);
  // An overdue follow-up does not keep a quiet investor off the list.
  assert.equal(isQuiet(row({ stageKey: "meeting", last_activity_at: old, follow_up_on: "2026-10-01" }), today, now), true);
});

test("followOptions: three different dates; on a Monday the third becomes In 2 weeks", () => {
  const monday = [
    { label: "Tomorrow", iso: "2026-10-13", kbd: "1" },
    { label: "Next Monday", iso: "2026-10-19", kbd: "m" },
    { label: "In 1 week", iso: "2026-10-19", kbd: "7" },
    { label: "In 2 weeks", iso: "2026-10-26", kbd: "2" },
  ];
  assert.deepEqual(
    followOptions(monday).map((o) => [o.label, o.kbd]),
    [
      ["Tomorrow", "1"],
      ["Next Mon", "m"],
      ["In 2 weeks", "2"],
    ],
  );
  const wednesday = [
    { label: "Tomorrow", iso: "2026-10-15", kbd: "1" },
    { label: "Next Monday", iso: "2026-10-19", kbd: "m" },
    { label: "In 1 week", iso: "2026-10-21", kbd: "7" },
    { label: "In 2 weeks", iso: "2026-10-28", kbd: "2" },
  ];
  assert.deepEqual(
    followOptions(wednesday).map((o) => o.kbd),
    ["1", "m", "7"],
  );
  // One pressed option per value, never two.
  const opts = [{ iso: null }, { iso: "2026-10-19" }, { iso: "2026-10-19" }];
  assert.equal(pressedOption(opts, "2026-10-19"), 1);
  assert.equal(pressedOption(opts, null), 0);
  assert.equal(pressedOption(opts, "2026-12-01"), -1);
});

test("cursorAfterMove: an undecided cursor stays; a moved one goes to the next undecided", () => {
  const order = ["ada", "bram", "cleo", "dana"];
  const done = new Set<string>();
  // Bulk move of bram + cleo while the cursor is on ada: ada stays.
  assert.equal(cursorAfterMove(order, "ada", new Set(["bram", "cleo"]), (id) => done.has(id)), "ada");
  // The cursor itself moved: the next undecided after it.
  assert.equal(cursorAfterMove(order, "bram", new Set(["bram", "cleo"]), (id) => done.has(id)), "dana");
  // Everything after it is done: wrap to the top.
  done.add("dana");
  assert.equal(cursorAfterMove(order, "cleo", new Set(["cleo"]), (id) => done.has(id)), "ada");
  assert.equal(cursorAfterMove(order, null, new Set(), () => false), "ada");
});

test("queuePosition: place among the rows left, not among every row seen", () => {
  const order = ["a", "b", "c", "d", "e"];
  const left = new Set(["b", "d", "e"]);
  assert.deepEqual(queuePosition(order, "d", (id) => left.has(id)), { pos: 2, left: 3 });
  // A decided row has no place; the count still says how many are left.
  assert.deepEqual(queuePosition(order, "a", (id) => left.has(id)), { pos: null, left: 3 });
});

test("boardSegments: runs of 2+ empty stages share one track", () => {
  const cols = (counts: number[]) => counts.map((count, i) => ({ key: `s${i}`, count }));
  // After a first session: New, Researching 1, Contacted 3, four empty, Passed 87.
  const seg = boardSegments(cols([405, 1, 3, 0, 0, 0, 0, 87]));
  assert.deepEqual(
    seg.map((x) => (x.kind === "empty" ? x.keys.join("+") : x.key)),
    ["s0", "s1", "s2", "s3+s4+s5+s6", "s7"],
  );
  // A single empty stage keeps its own narrow column.
  const mature = boardSegments(cols([38, 64, 52, 14, 9, 0, 4, 230]));
  assert.equal(mature.length, 8);
  assert.deepEqual(mature[5], { kind: "stage", key: "s5", empty: true });
  assert.equal(segmentTrack(mature[5]!, null), "minmax(136px, .6fr)");
  assert.equal(segmentTrack(seg[0]!, "s0"), "minmax(352px, 3fr)");
  assert.equal(segmentTrack(seg[3]!, "s0"), "minmax(184px, .7fr)");
  // Everyone in New: New plus one stacked track.
  assert.equal(boardSegments(cols([411, 0, 0, 0, 0, 0, 0, 0])).length, 2);
});

test("priorityGroups: Hot, Warm, Maybe, Low; fit desc, then import order", () => {
  const rows = [
    row({ fit: 0, name: "Zed" }),
    row({ fit: 5, name: "B" }),
    row({ fit: 2, name: "C" }),
    row({ fit: 5, name: "A" }),
    row({ fit: 3, name: "M" }),
  ];
  const g = priorityGroups(rows);
  assert.deepEqual(
    g.map((x) => [x.priority, x.rows.map((r) => r.investor.name)]),
    [
      ["hot", ["B", "A"]],
      ["maybe", ["M"]],
      ["low", ["C", "Zed"]],
    ],
  );
});

test("nextCursor: next undecided, skips done, wraps, null when all done", () => {
  const order = ["a", "b", "c", "d"];
  const done = new Set<string>();
  assert.equal(nextCursor(order, null, (id) => done.has(id)), "a");
  done.add("b");
  assert.equal(nextCursor(order, "a", (id) => done.has(id)), "c");
  done.add("c").add("d");
  // Wraps to the top for the skipped-then-undecided first row.
  assert.equal(nextCursor(order, "d", (id) => done.has(id)), "a");
  done.add("a");
  assert.equal(nextCursor(order, "a", (id) => done.has(id)), null);
  assert.equal(nextCursor([], null, () => false), null);
});

test("paceEstimate: median gap clamped to 8s–120s, from the 5th decision", () => {
  assert.deepEqual(paceEstimate([0, 10_000, 20_000, 30_000]), { sorted: 4, perMs: null });
  // Gaps 10s, 10s, 20s, 600s(→120s): median of [10,10,20,120] = 15s.
  assert.deepEqual(paceEstimate([0, 10_000, 20_000, 40_000, 640_000]), { sorted: 5, perMs: 15_000 });
  // Six quick Passes a second apart are not a 1s pace: each gap counts as 8s.
  assert.deepEqual(paceEstimate([0, 1_000, 2_000, 3_000, 4_000, 5_000]), { sorted: 6, perMs: 8_000 });
  assert.equal(formatDuration(40 * 20_000), "15 min");
  assert.equal(formatDuration(371 * 26_000), "2h 40m");
  assert.equal(formatDuration(1000), "5 min");
});

test("fitColumns: drop the lowest priority until the widths fit; required ones stay", () => {
  const cols = [
    { key: "investor", width: 240, required: true },
    { key: "firm", width: 180 },
    { key: "stage", width: 140 },
    { key: "email", width: 220 },
    { key: "last", width: 112 },
  ] as const;
  assert.deepEqual(fitColumns(cols, ["last", "email", "stage", "investor"], 2000), ["investor", "firm", "stage", "email", "last"]);
  assert.deepEqual(fitColumns(cols, ["last", "email", "stage", "investor"], 600), ["investor", "firm", "stage"]);
  assert.deepEqual(fitColumns(cols, ["last", "email", "stage", "investor", "firm"], 100), ["investor"]);
});

test("quietColumns: all empty, or the same value on 20+ rows", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ stage: "new", soft: null as number | null, firm: `F${i}` }));
  const v = (r: never, k: "stage" | "soft" | "firm") => (r as Record<string, string | number | null>)[k];
  assert.deepEqual([...quietColumns(["stage", "soft", "firm"], rows, v)].sort(), ["soft", "stage"]);
  // A constant column can be kept on purpose, and a short list never counts as constant.
  assert.deepEqual([...quietColumns(["stage", "soft"], rows, v, ["stage"])], ["soft"]);
  assert.deepEqual([...quietColumns(["stage"], rows.slice(0, 5), v)], []);
});
