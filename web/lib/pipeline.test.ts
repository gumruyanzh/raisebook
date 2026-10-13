import assert from "node:assert/strict";
import { test } from "node:test";

import type { Participant, Stage } from "./api/types";
import {
  cardSlot,
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
  assert.deepEqual(c({ type: "corporate_vc" }), { kind: "type", text: "CVC" });
  assert.equal(c({ type: "other" }), null);
});

test("nextUpBuckets: counts, zero buckets hidden, 'still New' only when it differs", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const today = "2026-10-12";
  const old = "2026-09-20T00:00:00Z";
  const rows = [
    row({ fit: 5 }),
    row({ fit: 4 }),
    row({ fit: 2 }),
    row({ stageKey: "contacted", last_activity_at: old }), // quiet + no follow-up
    row({ stageKey: "contacted", last_activity_at: old, follow_up_on: "2026-10-20" }), // not quiet
    row({ stageKey: "replied", last_activity_at: "2026-10-11T00:00:00Z" }), // no follow-up only
    row({ stageKey: "passed", last_activity_at: old }),
  ];
  assert.deepEqual(nextUpBuckets(rows, "new", today, now), [
    { id: "hw", count: 2 },
    { id: "quiet", count: 1 },
    { id: "nofollow", count: 2 },
    { id: "new", count: 3 },
  ]);
  // All of New is Hot or Warm: no separate "still New" bucket.
  assert.deepEqual(nextUpBuckets([row({ fit: 5 })], "new", today, now), [{ id: "hw", count: 1 }]);
  assert.deepEqual(nextUpBuckets([], "new", today, now), []);
  // An overdue follow-up does not keep a quiet investor off the list.
  assert.equal(isQuiet(row({ stageKey: "meeting", last_activity_at: old, follow_up_on: "2026-10-01" }), today, now), true);
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

test("paceEstimate: median gap capped at 120s, from the 5th decision", () => {
  assert.deepEqual(paceEstimate([0, 10_000, 20_000, 30_000]), { sorted: 4, perMs: null });
  // Gaps 10s, 10s, 20s, 600s(→120s): median of [10,10,20,120] = 15s.
  assert.deepEqual(paceEstimate([0, 10_000, 20_000, 40_000, 640_000]), { sorted: 5, perMs: 15_000 });
  assert.equal(formatDuration(40 * 20_000), "15 min");
  assert.equal(formatDuration(371 * 26_000), "2h 40m");
  assert.equal(formatDuration(1000), "5 min");
});
