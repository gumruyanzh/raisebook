import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addDays,
  addMonths,
  dateFieldLabel,
  endOfQuarter,
  monthGrid,
  nextWeekday,
  parseLooseDate,
  quickPicks,
  todayIn,
} from "./dates";

// Monday, Oct 12 2026.
const T = "2026-10-12";

test("relative words and offsets", () => {
  assert.equal(parseLooseDate("today", T), T);
  assert.equal(parseLooseDate("tom", T), "2026-10-13");
  assert.equal(parseLooseDate("yesterday", T), "2026-10-11");
  assert.equal(parseLooseDate("+7", T), "2026-10-19");
  assert.equal(parseLooseDate("7d", T), "2026-10-19");
  assert.equal(parseLooseDate("in 3 days", T), "2026-10-15");
  assert.equal(parseLooseDate("2w", T), "2026-10-26");
  assert.equal(parseLooseDate("+1m", T), "2026-11-12");
  assert.equal(parseLooseDate("-3", T), "2026-10-09");
  assert.equal(parseLooseDate("next week", T), "2026-10-19");
});

test("weekdays are the next one after today", () => {
  assert.equal(parseLooseDate("fri", T), "2026-10-16");
  assert.equal(parseLooseDate("Friday", T), "2026-10-16");
  assert.equal(parseLooseDate("mon", T), "2026-10-19"); // today is Monday → next Monday
  assert.equal(parseLooseDate("next tue", T), "2026-10-13");
  assert.equal(parseLooseDate("thurs", T), "2026-10-15");
});

test("month and day, with the year rolling over", () => {
  assert.equal(parseLooseDate("oct 20", T), "2026-10-20");
  assert.equal(parseLooseDate("October 20th", T), "2026-10-20");
  assert.equal(parseLooseDate("20 oct", T), "2026-10-20");
  assert.equal(parseLooseDate("10/20", T), "2026-10-20");
  assert.equal(parseLooseDate("2026-10-20", T), "2026-10-20");
  assert.equal(parseLooseDate("oct 20 2027", T), "2027-10-20");
  assert.equal(parseLooseDate("10/20/27", T), "2027-10-20");
  // On Dec 30, "jan 3" is next year.
  assert.equal(parseLooseDate("jan 3", "2026-12-30"), "2027-01-03");
  assert.equal(parseLooseDate("1/3", "2026-12-30"), "2027-01-03");
  // A date a few days back stays this year (logging what already happened).
  assert.equal(parseLooseDate("oct 10", T), "2026-10-10");
  assert.equal(parseLooseDate("20", T), "2026-10-20");
  assert.equal(parseLooseDate("5", T), "2026-11-05");
});

test("nonsense and impossible dates are null", () => {
  for (const s of ["", "soon", "2026-02-30", "13/40", "feb 30 2027", "next sometime"]) {
    assert.equal(parseLooseDate(s, T), null, s);
  }
  assert.equal(parseLooseDate("feb 29", "2027-01-10"), "2028-02-29");
});

test("calendar math ignores DST (a US and an EU DST week)", () => {
  // US clocks change Nov 1 2026, EU clocks change Oct 25 2026.
  assert.equal(addDays("2026-10-29", 7), "2026-11-05");
  assert.equal(addDays("2026-10-22", 7), "2026-10-29");
  assert.equal(nextWeekday("2026-10-30", 1), "2026-11-02");
  // todayIn follows the workspace calendar, not the machine's.
  const lateUtc = new Date("2026-11-01T06:30:00Z"); // 23:30 Oct 31 in Los Angeles (PDT)
  assert.equal(todayIn("America/Los_Angeles", lateUtc), "2026-10-31");
  assert.equal(todayIn("Asia/Yerevan", lateUtc), "2026-11-01");
  const afterChange = new Date("2026-11-02T07:30:00Z"); // 23:30 Nov 1 in LA (now PST)
  assert.equal(todayIn("America/Los_Angeles", afterChange), "2026-11-01");
});

test("month math clamps to the last day", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
});

test("quick picks", () => {
  const f = quickPicks("followup", T);
  assert.deepEqual(
    f.map((p) => [p.label, p.iso, p.kbd]),
    [
      ["Today", T, "0"],
      ["Tomorrow", "2026-10-13", "1"],
      ["In 3 days", "2026-10-15", "3"],
      ["Next Monday", "2026-10-19", "m"],
      ["In 1 week", "2026-10-19", "7"],
      ["In 2 weeks", "2026-10-26", "2"],
    ],
  );
  const d = quickPicks("deadline", T);
  assert.equal(d[0]!.iso, "2026-12-31");
  assert.equal(quickPicks("deadline", "2026-12-20")[0]!.iso, "2027-03-31");
  assert.equal(endOfQuarter("2026-02-10"), "2026-03-31");
});

test("labels and the month grid", () => {
  assert.equal(dateFieldLabel("2026-10-16", T), "Oct 16 · in 4d");
  assert.equal(dateFieldLabel(T, T), "Today");
  assert.equal(dateFieldLabel("2026-10-08", T), "Oct 8 · 4d ago");
  assert.equal(dateFieldLabel("2027-01-05", T), "Jan 5, 2027 · in 85d");
  const g = monthGrid("2026-10-12");
  assert.equal(g.length, 42);
  assert.equal(g[0], "2026-09-27"); // Sunday before Oct 1 (a Thursday)
  assert.ok(g.includes("2026-10-31"));
});
