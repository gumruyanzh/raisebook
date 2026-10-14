/**
 * Pure rules for meetings (docs/SPEC.md §5.9): which day and time a meeting shows at in the
 * viewer's timezone, the board chip ("Meeting today 11:00", "Wed 12:00"), whether a meeting
 * beats the follow-up chip, the Meetings view groups, the Google Calendar link and the
 * schedule form's local time. No React, so `npm run test:unit` covers it.
 *
 * Times are entered in the **workspace** timezone (the form says which) and shown in the
 * **viewer's** timezone. Clock times are 24-hour ("11:00"), short enough for a card.
 */

import { addDays, weekday } from "./dates";
import { daysBetween, formatDate, todayIn } from "./format";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The browser's timezone (falls back to UTC). */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** `YYYY-MM-DD` of an instant in `timeZone`. */
export function dayOf(ts: string, timeZone: string): string {
  const t = new Date(ts);
  return Number.isNaN(t.getTime()) ? "" : todayIn(timeZone, t);
}

/** 24-hour clock time of an instant in `timeZone`: "09:30", "14:00". */
export function clock(ts: string, timeZone: string): string {
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(t);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

/** "Today", "Tomorrow", "Wed" (within the week), else "Oct 22" (with the year when needed). */
export function dayWord(day: string, today: string): string {
  const d = daysBetween(today, day);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  if (d > 1 && d < 7) return WEEKDAYS[weekday(day)]!;
  return formatDate(day, today);
}

/** "Today 11:00–11:30", "Wed, Oct 14 · 11:00–12:00": a meeting's when-line for lists. */
export function whenLine(m: { starts_at: string; ends_at: string }, timeZone: string, today: string): string {
  const day = dayOf(m.starts_at, timeZone);
  const span = `${clock(m.starts_at, timeZone)}–${clock(m.ends_at, timeZone)}`;
  const d = daysBetween(today, day);
  if (d >= -1 && d <= 1) return `${dayWord(day, today)} ${span}`;
  return `${WEEKDAYS[weekday(day)]}, ${formatDate(day, today)} · ${span}`;
}

/**
 * The board and Triage chip for a meeting: "Meeting today 11:00", "Tomorrow 11:00",
 * "Wed 12:00", "Oct 22 12:00". `today` is the viewer's today.
 */
export function meetingChipText(startsAt: string, today: string, timeZone: string): string {
  const day = dayOf(startsAt, timeZone);
  const time = clock(startsAt, timeZone);
  const d = daysBetween(today, day);
  if (d <= 0) return `Meeting today ${time}`;
  if (d === 1) return `Tomorrow ${time}`;
  if (d < 7) return `${WEEKDAYS[weekday(day)]} ${time}`;
  return `${formatDate(day, today)} ${time}`;
}

/**
 * Does the meeting take the card's slot instead of the follow-up? Yes when it is today, or
 * when it is no later than the follow-up date and the follow-up is not already due (an
 * overdue or due-today follow-up stays: the founder owes them something now).
 */
export function meetingBeatsFollowUp(
  meetingDay: string,
  followUpOn: string | null | undefined,
  today: string,
): boolean {
  if (meetingDay <= today) return true;
  if (!followUpOn) return true;
  if (followUpOn <= today) return false;
  return meetingDay <= followUpOn;
}

/* ---------- the Meetings view ---------- */

export interface MeetingLike {
  id: string;
  starts_at: string;
  ends_at: string;
  status: "scheduled" | "done" | "cancelled" | "no_show";
  needs_outcome?: boolean;
}

export interface MeetingGroups<T> {
  /** Over, still scheduled, no outcome: needs a quick note. Latest first. */
  needsOutcome: T[];
  /** Starting today (viewer's day), not yet over. */
  today: T[];
  /** The next 6 days. */
  week: T[];
  later: T[];
  /** Done, cancelled or no-show (latest first). */
  past: T[];
}

export function groupMeetings<T extends MeetingLike>(list: readonly T[], now: Date, timeZone: string): MeetingGroups<T> {
  const today = todayIn(timeZone, now);
  const weekEnd = addDays(today, 7);
  const out: MeetingGroups<T> = { needsOutcome: [], today: [], week: [], later: [], past: [] };
  for (const m of list) {
    if (m.status !== "scheduled") {
      out.past.push(m);
      continue;
    }
    if (Date.parse(m.ends_at) <= now.getTime()) {
      out.needsOutcome.push(m);
      continue;
    }
    const day = dayOf(m.starts_at, timeZone);
    if (day <= today) out.today.push(m);
    else if (day < weekEnd) out.week.push(m);
    else out.later.push(m);
  }
  const asc = (a: T, b: T) => a.starts_at.localeCompare(b.starts_at);
  const desc = (a: T, b: T) => b.starts_at.localeCompare(a.starts_at);
  out.today.sort(asc);
  out.week.sort(asc);
  out.later.sort(asc);
  out.needsOutcome.sort(desc);
  out.past.sort(desc);
  return out;
}

/** Is the meeting on now (started, not ended)? */
export function isLive(m: { starts_at: string; ends_at: string }, now: Date): boolean {
  const t = now.getTime();
  return Date.parse(m.starts_at) <= t && t < Date.parse(m.ends_at);
}

/* ---------- calendar links ---------- */

function gcalStamp(ts: string): string {
  return new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** "Add to Google Calendar": a link the founder clicks (nothing is sent until they do). */
export function googleCalendarUrl(m: {
  title: string;
  starts_at: string;
  ends_at: string;
  location?: string | null;
  video_url?: string | null;
  agenda?: string | null;
  details?: string;
}): string {
  const details = [m.video_url ? `Join: ${m.video_url}` : "", m.agenda ?? "", m.details ?? ""].filter(Boolean).join("\n\n");
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: m.title,
    dates: `${gcalStamp(m.starts_at)}/${gcalStamp(m.ends_at)}`,
  });
  if (details) q.set("details", details);
  const where = m.location || m.video_url;
  if (where) q.set("location", where);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

/** "Join Zoom", "Join Meet", "Join Teams", else "Join call". */
export function joinLabel(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("zoom.")) return "Join Zoom";
  if (u.includes("meet.google.")) return "Join Meet";
  if (u.includes("teams.microsoft") || u.includes("teams.live")) return "Join Teams";
  return "Join call";
}

/* ---------- the schedule form ---------- */

/** The form's local value (`YYYY-MM-DDTHH:MM`, workspace time) the API reads as workspace time. */
export function localValue(day: string, time: string): string {
  return `${day}T${time}`;
}

/** Split an instant into the form's day and time in `timeZone`. */
export function splitLocal(ts: string, timeZone: string): { day: string; time: string } {
  return { day: dayOf(ts, timeZone), time: clock(ts, timeZone) };
}

/**
 * "HH:MM" from what someone typed: "11", "11:30", "1130", "9.15", "3pm", "3:30 pm". null when
 * it is not a time.
 */
export function parseTime(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3];
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap.startsWith("p") && h !== 12) h += 12;
    if (ap.startsWith("a") && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** The next half hour from now, at least 30 minutes away, as "HH:MM" in `timeZone`. */
export function nextSlot(now: Date, timeZone: string): { day: string; time: string } {
  const t = new Date(now.getTime() + 30 * 60_000);
  const { day, time } = splitLocal(t.toISOString(), timeZone);
  const [h, m] = time.split(":").map(Number) as [number, number];
  const up = m === 0 || m === 30 ? m : m < 30 ? 30 : 60;
  if (up === 60) {
    if (h === 23) return { day: addDays(day, 1), time: "00:00" };
    return { day, time: `${String(h + 1).padStart(2, "0")}:00` };
  }
  return { day, time: `${String(h).padStart(2, "0")}:${String(up).padStart(2, "0")}` };
}

/** Minutes offered in the form. */
export const DURATIONS = [15, 30, 45, 60, 90] as const;

/** "30 min", "1 h", "1 h 30". */
export function durationLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `${h} h ${r}` : `${h} h`;
}

/** Timeline wording for the meeting kinds (the Timeline adds the actor in front). */
export function meetingSentence(kind: string, data: Record<string, unknown>, timeZone: string, today: string): string {
  const at = (v: unknown) => (typeof v === "string" && v ? whenLine({ starts_at: v, ends_at: v }, timeZone, today).replace(/–\d\d:\d\d$/, "") : "");
  if (kind === "meeting_scheduled") return `scheduled a meeting for ${at(data.starts_at)}`.trim();
  switch (data.change) {
    case "rescheduled":
      return `moved the meeting to ${at(data.to_starts_at)}`.trim();
    case "cancelled":
      return "cancelled the meeting";
    case "no_show":
      return "marked the meeting a no-show";
    case "reopened":
      return "reopened the meeting";
    case "deleted":
      return "deleted a meeting";
    default:
      return "edited the meeting";
  }
}

/** The UTC instant of a wall-clock time in `timeZone` (two passes cover DST shifts). */
export function zonedToUtc(day: string, time: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || !t) return null;
  const want = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]));
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const s = splitLocal(new Date(guess).toISOString(), timeZone);
    const [y, mo, d] = s.day.split("-").map(Number) as [number, number, number];
    const [h, mi] = s.time.split(":").map(Number) as [number, number];
    const shown = Date.UTC(y, mo - 1, d, h, mi);
    guess += want - shown;
  }
  return new Date(guess).toISOString();
}
