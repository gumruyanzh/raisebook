import assert from "node:assert/strict";
import { test } from "node:test";

import type { Participant } from "./api/types";
import {
  clock,
  dayOf,
  dayWord,
  durationLabel,
  googleCalendarUrl,
  groupMeetings,
  isLive,
  joinLabel,
  meetingBeatsFollowUp,
  meetingChipText,
  nextSlot,
  parseTime,
  whenLine,
  zonedToUtc,
} from "./meetings";
import { cardSlot } from "./pipeline";

// Monday 2026-10-12, 17:00 UTC = 10:00 in Los Angeles.
const NOW = new Date("2026-10-12T17:00:00Z");
const LA = "America/Los_Angeles";

test("dayOf and clock read the instant in the viewer's zone", () => {
  assert.equal(dayOf("2026-10-13T03:30:00Z", LA), "2026-10-12");
  assert.equal(dayOf("2026-10-13T03:30:00Z", "Europe/Berlin"), "2026-10-13");
  assert.equal(clock("2026-10-12T18:00:00Z", LA), "11:00");
  assert.equal(clock("2026-10-12T18:00:00Z", "Asia/Kolkata"), "23:30");
});

test("meetingChipText: today, tomorrow, weekday, then a date", () => {
  const today = "2026-10-12";
  assert.equal(meetingChipText("2026-10-12T18:00:00Z", today, LA), "Meeting today 11:00");
  assert.equal(meetingChipText("2026-10-13T19:00:00Z", today, LA), "Tomorrow 12:00");
  assert.equal(meetingChipText("2026-10-14T19:00:00Z", today, LA), "Wed 12:00");
  assert.equal(meetingChipText("2026-10-22T19:00:00Z", today, LA), "Oct 22 12:00");
});

test("dayWord and whenLine", () => {
  assert.equal(dayWord("2026-10-11", "2026-10-12"), "Yesterday");
  assert.equal(dayWord("2026-10-16", "2026-10-12"), "Fri");
  assert.equal(whenLine({ starts_at: "2026-10-12T18:00:00Z", ends_at: "2026-10-12T18:30:00Z" }, LA, "2026-10-12"), "Today 11:00–11:30");
  assert.equal(
    whenLine({ starts_at: "2026-10-14T16:00:00Z", ends_at: "2026-10-14T17:00:00Z" }, LA, "2026-10-12"),
    "Wed, Oct 14 · 09:00–10:00",
  );
});

test("a meeting takes the card slot when it comes first and nothing is due", () => {
  const today = "2026-10-12";
  assert.equal(meetingBeatsFollowUp("2026-10-12", "2026-10-01", today), true); // today wins over overdue
  assert.equal(meetingBeatsFollowUp("2026-10-14", "2026-10-10", today), false); // overdue follow-up stays
  assert.equal(meetingBeatsFollowUp("2026-10-14", "2026-10-12", today), false); // due today stays
  assert.equal(meetingBeatsFollowUp("2026-10-14", "2026-10-20", today), true);
  assert.equal(meetingBeatsFollowUp("2026-10-21", "2026-10-20", today), false);
  assert.equal(meetingBeatsFollowUp("2026-10-21", null, today), true);
});

test("cardSlot shows the meeting chip in place of the follow-up", () => {
  const p = {
    follow_up_on: "2026-10-16",
    follow_up_state: "soon",
    amount_soft: null,
    amount_committed: null,
    stage: { key: "meeting", label: "Meeting", kind: "active", color: "amber", position: 4 },
    next_meeting: { id: "m1", title: "Meeting with Dana Whitfield", starts_at: "2026-10-14T19:00:00Z", ends_at: "2026-10-14T19:30:00Z" },
  } as unknown as Participant;
  const slot = cardSlot(p, "2026-10-12", "USD", { timeZone: LA, now: NOW });
  assert.equal(slot?.kind, "meeting");
  assert.equal(slot?.text, "Wed 12:00");
  assert.equal(slot?.kind === "meeting" && slot.today, false);
  // Without a viewer zone (old callers), the follow-up shows as before.
  assert.equal(cardSlot(p, "2026-10-12", "USD")?.kind, "soon");
  const today = { ...p, next_meeting: { ...p.next_meeting!, starts_at: "2026-10-12T18:00:00Z" }, follow_up_state: "overdue", follow_up_on: "2026-10-01" } as Participant;
  const s2 = cardSlot(today, "2026-10-12", "USD", { timeZone: LA, now: NOW });
  assert.equal(s2?.text, "Meeting today 11:00");
  assert.equal(s2?.kind === "meeting" && s2.today, true);
  const due = { ...p, follow_up_state: "overdue", follow_up_on: "2026-10-10" } as Participant;
  assert.equal(cardSlot(due, "2026-10-12", "USD", { timeZone: LA, now: NOW })?.kind, "due");
});

test("groupMeetings: needs an outcome, today, this week, later, past", () => {
  const m = (id: string, starts: string, mins: number, status: "scheduled" | "done" = "scheduled") => ({
    id,
    starts_at: starts,
    ends_at: new Date(Date.parse(starts) + mins * 60_000).toISOString(),
    status,
  });
  const g = groupMeetings(
    [
      m("later", "2026-10-25T17:00:00Z", 30),
      m("week", "2026-10-15T17:00:00Z", 30),
      m("today", "2026-10-12T22:00:00Z", 30),
      m("live", "2026-10-12T16:45:00Z", 30),
      m("needs", "2026-10-11T17:00:00Z", 30),
      m("done", "2026-10-09T17:00:00Z", 30, "done"),
    ],
    NOW,
    LA,
  );
  assert.deepEqual(g.needsOutcome.map((x) => x.id), ["needs"]);
  assert.deepEqual(g.today.map((x) => x.id), ["live", "today"]);
  assert.deepEqual(g.week.map((x) => x.id), ["week"]);
  assert.deepEqual(g.later.map((x) => x.id), ["later"]);
  assert.deepEqual(g.past.map((x) => x.id), ["done"]);
  assert.equal(isLive({ starts_at: "2026-10-12T16:45:00Z", ends_at: "2026-10-12T17:15:00Z" }, NOW), true);
});

test("googleCalendarUrl is a template link with UTC dates", () => {
  const url = new URL(
    googleCalendarUrl({
      title: "Meeting with Dana Whitfield",
      starts_at: "2026-10-14T18:00:00Z",
      ends_at: "2026-10-14T18:30:00Z",
      video_url: "https://meet.example.com/abc",
      agenda: "Pilot metrics",
    }),
  );
  assert.equal(url.hostname, "calendar.google.com");
  assert.equal(url.searchParams.get("action"), "TEMPLATE");
  assert.equal(url.searchParams.get("dates"), "20261014T180000Z/20261014T183000Z");
  assert.equal(url.searchParams.get("location"), "https://meet.example.com/abc");
  assert.match(url.searchParams.get("details") ?? "", /Join: https:\/\/meet\.example\.com\/abc\n\nPilot metrics/);
});

test("joinLabel, durationLabel", () => {
  assert.equal(joinLabel("https://zoom.us/j/1"), "Join Zoom");
  assert.equal(joinLabel("https://meet.google.com/abc"), "Join Meet");
  assert.equal(joinLabel("https://meet.example.com/abc"), "Join call");
  assert.equal(durationLabel(45), "45 min");
  assert.equal(durationLabel(90), "1 h 30");
  assert.equal(durationLabel(60), "1 h");
});

test("parseTime accepts what people type", () => {
  assert.equal(parseTime("11"), "11:00");
  assert.equal(parseTime("9.15"), "09:15");
  assert.equal(parseTime("1130"), "11:30");
  assert.equal(parseTime("3pm"), "15:00");
  assert.equal(parseTime("12 am"), "00:00");
  assert.equal(parseTime("3:30 PM"), "15:30");
  assert.equal(parseTime("25:00"), null);
  assert.equal(parseTime("soon"), null);
});

test("zonedToUtc and nextSlot follow the zone (DST included)", () => {
  assert.equal(zonedToUtc("2026-10-14", "11:00", LA), "2026-10-14T18:00:00.000Z"); // PDT
  assert.equal(zonedToUtc("2026-11-10", "11:00", LA), "2026-11-10T19:00:00.000Z"); // PST
  assert.deepEqual(nextSlot(NOW, LA), { day: "2026-10-12", time: "10:30" });
  assert.deepEqual(nextSlot(new Date("2026-10-12T17:10:00Z"), LA), { day: "2026-10-12", time: "11:00" });
});
