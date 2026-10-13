/**
 * Calendar-date helpers for DateField (UX pass 1, P1-5a). Dates are ISO `YYYY-MM-DD` strings in
 * the **workspace** timezone; arithmetic is on calendar days (UTC math), so DST never shifts a
 * date. Pure, so `node --test` covers it.
 */

import { daysBetween, formatDate, todayIn as todayInZone } from "./format";

export type QuickPickKind = "followup" | "deadline";

export interface QuickPick {
  label: string;
  iso: string;
  /** Single key that applies the pick while the DateField popover is open. */
  kbd?: string;
}

/** Today's ISO date in a timezone (the workspace calendar). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return todayInZone(timeZone, now);
}

function parts(iso: string): [number, number, number] {
  return [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
}

function iso(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.toISOString().slice(0, 10);
}

/** `iso` plus `n` calendar days. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return iso(y, m, d + n);
}

/** `iso` plus `n` months, clamped to the month's last day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = parts(date);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return iso(y, m + n, Math.min(d, last));
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The next `day` (0–6) strictly after `date`. */
export function nextWeekday(date: string, day: number): string {
  const diff = (day - weekday(date) + 7) % 7 || 7;
  return addDays(date, diff);
}

/** Last day of the month that `date` is in. */
export function endOfMonth(date: string): string {
  const [y, m] = parts(date);
  return iso(y, m + 1, 0);
}

/** Last day of the calendar quarter that `date` is in (Mar 31, Jun 30, Sep 30, Dec 31). */
export function endOfQuarter(date: string): string {
  const [y, m] = parts(date);
  const qEnd = Math.ceil(m / 3) * 3;
  return iso(y, qEnd + 1, 0);
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = parts(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Quick picks for the DateField popover. Clear (⌫) is added by the component. */
export function quickPicks(kind: QuickPickKind, today: string): QuickPick[] {
  if (kind === "deadline") {
    const eoq = endOfQuarter(today);
    // Within two weeks of the quarter's end, "End of quarter" means the next one.
    const quarter = daysBetween(today, eoq) < 14 ? endOfQuarter(addMonths(eoq, 1)) : eoq;
    return [
      { label: "End of quarter", iso: quarter, kbd: "q" },
      { label: "In 30 days", iso: addDays(today, 30), kbd: "3" },
      { label: "In 60 days", iso: addDays(today, 60), kbd: "6" },
      { label: "In 90 days", iso: addDays(today, 90), kbd: "9" },
      { label: "End of year", iso: iso(Number(today.slice(0, 4)), 12, 31), kbd: "y" },
    ];
  }
  return [
    { label: "Today", iso: today, kbd: "0" },
    { label: "Tomorrow", iso: addDays(today, 1), kbd: "1" },
    { label: "In 3 days", iso: addDays(today, 3), kbd: "3" },
    { label: "Next Monday", iso: nextWeekday(today, 1), kbd: "m" },
    { label: "In 1 week", iso: addDays(today, 7), kbd: "7" },
    { label: "In 2 weeks", iso: addDays(today, 14), kbd: "2" },
  ];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return -1;
  return MONTHS.findIndex((m) => w.startsWith(m) && (w.length === 3 || "january february march april may june july august september october november december sept".includes(w)));
}

function dayIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 2) return -1;
  const full = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const i = full.findIndex((d) => d.startsWith(w));
  if (i >= 0) return i;
  // tues, thur, thurs, weds
  return { tues: 2, weds: 3, thur: 4, thurs: 4 }[w] ?? DAYS.indexOf(w);
}

/**
 * A month/day without a year: this year's date, unless that was more than 14 days ago, in
 * which case next year's (on Dec 30, "jan 3" is next January; on Oct 12, "oct 10" stays).
 */
function nearYear(today: string, m: number, d: number): string | null {
  const y = Number(today.slice(0, 4));
  const thisYear = iso(y, m, d);
  if (!isIsoDate(thisYear) || Number(thisYear.slice(8, 10)) !== d) {
    // Feb 29 outside a leap year: try next year.
    const next = iso(y + 1, m, d);
    return isIsoDate(next) && Number(next.slice(8, 10)) === d ? next : null;
  }
  return daysBetween(thisYear, today) > 14 ? iso(y + 1, m, d) : thisYear;
}

function valid(y: number, m: number, d: number): string | null {
  const s = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isIsoDate(s) ? s : null;
}

/**
 * Read what people type into a date box, relative to `today` (ISO, workspace calendar):
 * `today`, `tomorrow`, `yesterday`, `fri` / `next fri`, `next week` (Monday), `+7`, `7d`,
 * `in 3 days`, `2w`, `+1m`, `oct 20`, `20 oct`, `October 20 2027`, `10/20`, `10/20/27`,
 * `2026-10-20`, and a bare day of the month (`20` → the next 20th). Returns null when unsure.
 */
export function parseLooseDate(input: string, today: string): string | null {
  const s = input.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!s) return null;

  if (/^(tod|today|now)$/.test(s)) return today;
  if (/^(tom|tmr|tmrw|tomorrow)$/.test(s)) return addDays(today, 1);
  if (/^(yday|yesterday)$/.test(s)) return addDays(today, -1);
  if (s === "next week") return nextWeekday(today, 1);
  if (s === "next month") return addMonths(today, 1);

  // ISO
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));

  // Relative: +7, 7d, +2w, 1m, in 3 days, in 2 weeks, -3
  m = /^(?:in )?([+-])?\s*(\d{1,3})\s*(d|day|days|w|wk|wks|week|weeks|m|mo|mos|month|months)?$/.exec(s);
  if (m && (m[1] || m[3] || s.startsWith("in "))) {
    const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
    const unit = m[3] ?? "d";
    if (unit.startsWith("w")) return addDays(today, n * 7);
    if (unit.startsWith("m")) return addMonths(today, n);
    return addDays(today, n);
  }

  // Weekdays: fri, friday, next fri, this fri
  m = /^(?:(next|this) )?([a-z]+)\.?$/.exec(s);
  if (m) {
    const wd = dayIndex(m[2]!);
    if (wd >= 0) return nextWeekday(today, wd);
  }

  // US numeric: 10/20, 10/20/27, 10/20/2027
  m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return valid(y, mo, d);
    }
    return mo >= 1 && mo <= 12 ? nearYear(today, mo, d) : null;
  }

  // oct 20 [2027] / october 20th / 20 oct [2027]
  m = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(s) ?? null;
  let mo = -1;
  let d = 0;
  let y: number | null = null;
  if (m) {
    mo = monthIndex(m[1]!);
    d = Number(m[2]);
    y = m[3] ? Number(m[3]) : null;
  } else {
    const r = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?(?: (\d{4}))?$/.exec(s);
    if (r) {
      mo = monthIndex(r[2]!);
      d = Number(r[1]);
      y = r[3] ? Number(r[3]) : null;
    }
  }
  if (mo >= 0 && d >= 1) return y ? valid(y, mo + 1, d) : nearYear(today, mo + 1, d);

  // A bare month name: the 1st of the next such month.
  const onlyMonth = monthIndex(s);
  if (onlyMonth >= 0 && /^[a-z]+$/.test(s)) return nearYear(today, onlyMonth + 1, 1);

  // A bare day of the month: the next time that day comes around (today counts).
  m = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(s);
  if (m) {
    const day = Number(m[1]);
    if (day < 1 || day > 31) return null;
    const [ty, tm, td] = parts(today);
    for (let k = 0; k < 3; k++) {
      const cand = valid(ty + Math.floor((tm - 1 + k) / 12), ((tm - 1 + k) % 12) + 1, day);
      if (cand && (k > 0 || day >= td)) return cand;
    }
    return null;
  }
  return null;
}

/** Relative words for a date: `today`, `tomorrow`, `yesterday`, `in 4d`, `3d ago`. */
export function relativeDay(date: string, today: string): string {
  const n = daysBetween(today, date);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n}d` : `${-n}d ago`;
}

/** DateField trigger text: `Oct 16 · in 4d`, `Today`, `Oct 6 · 4d ago`. */
export function dateFieldLabel(date: string, today: string): string {
  const n = daysBetween(today, date);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  return `${formatDate(date, today)} · ${relativeDay(date, today)}`;
}

/** The 6×7 grid of ISO dates for the month containing `month` (weeks start on Sunday). */
export function monthGrid(month: string): string[] {
  const [y, m] = parts(month);
  const first = iso(y, m, 1);
  const start = addDays(first, -weekday(first));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
