/**
 * Display formatting (SYSTEM §2.6). Use these everywhere so money, dates and counts look the
 * same on every screen. Locale is fixed to en-US (American English, SYSTEM §6); the currency
 * symbol comes from the round currency.
 *
 * Dates from the API are `YYYY-MM-DD` in the workspace timezone; they are formatted without
 * timezone conversion. Timestamps are RFC 3339 UTC and are shown in `timeZone` when given.
 */

import type { FollowUpState, Priority } from "./api/types";

const LOCALE = "en-US";

function currencyFormatter(currency: string, opts: Intl.NumberFormatOptions = {}) {
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 0,
      ...opts,
    });
  } catch {
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
      ...opts,
    });
  }
}

/** Full amount: `$2,000,000`. Ledger, dashboard, `title` attributes. */
export function money(amount: number | null | undefined, currency = "USD"): string {
  return currencyFormatter(currency).format(Math.round(amount ?? 0));
}

/** Currency symbol for a code (`USD` → `$`, `EUR` → `€`). */
export function currencySymbol(currency = "USD"): string {
  const part = currencyFormatter(currency)
    .formatToParts(0)
    .find((p) => p.type === "currency");
  return part?.value ?? currency;
}

/** Compact amount for cards, chips and tables: `$250k`, `$1.5M`, `$900`. */
export function moneyCompact(amount: number | null | undefined, currency = "USD"): string {
  const n = Math.round(amount ?? 0);
  const sym = currencySymbol(currency);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const fmt = (v: number, suffix: string) => {
    const s = v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
    return `${sign}${sym}${s}${suffix}`;
  };
  if (abs >= 1_000_000_000) return fmt(abs / 1_000_000_000, "B");
  if (abs >= 1_000_000) return fmt(abs / 1_000_000, "M");
  if (abs >= 1_000) return fmt(abs / 1_000, "k");
  return `${sign}${sym}${abs}`;
}

/** Plain integer with separators: `1,240`. */
export function num(n: number | null | undefined): string {
  return new Intl.NumberFormat(LOCALE).format(n ?? 0);
}

/** `1 investor`, `3 investors`. Pass `many` for irregular plurals. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

/** Percent with one decimal at most: `37.5%`, `112%`. */
export function pct(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

/* ---------- dates ---------- */

/** Today's date (`YYYY-MM-DD`) in a timezone (the workspace timezone). */
export function todayIn(timeZone?: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function parseDate(d: string): { y: number; m: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), day: Number(m[3]) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * UI date: `Oct 14`, plus the year when it is not the current year (`Oct 14, 2025`).
 * `today` (YYYY-MM-DD) decides the current year; defaults to the browser/server clock.
 */
export function formatDate(d: string | null | undefined, today?: string): string {
  if (!d) return "";
  const p = parseDate(d);
  if (!p) return d;
  const year = Number((today ?? todayIn()).slice(0, 4));
  const base = `${MONTHS[p.m - 1]} ${p.day}`;
  return p.y === year ? base : `${base}, ${p.y}`;
}

/** Data contexts (mono): ISO `2026-10-14`. Accepts a date or a timestamp. */
export function isoDate(d: string | null | undefined, timeZone?: string): string {
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? d : todayIn(timeZone, t);
}

/** Timestamp as `Oct 14, 2026, 3:04 PM` in a timezone (for `title` attributes). */
export function formatDateTime(ts: string | null | undefined, timeZone?: string): string {
  if (!ts) return "";
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return ts;
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(t);
}

/** Clock time: `3:04 PM`. */
export function formatTime(ts: string, timeZone?: string): string {
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return "";
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: "numeric", minute: "2-digit" }).format(
    t,
  );
}

/** Relative time for the timeline only: `just now`, `5m ago`, `2h ago`, `3d ago`, else `Oct 2`. */
export function relativeTime(ts: string, now: Date = new Date(), timeZone?: string): string {
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return "";
  const s = Math.round((now.getTime() - t.getTime()) / 1000);
  if (s < 0) {
    const ahead = -s;
    if (ahead < 3600) return `in ${Math.max(1, Math.round(ahead / 60))}m`;
    if (ahead < 86400) return `in ${Math.round(ahead / 3600)}h`;
    return formatDate(isoDate(ts, timeZone), todayIn(timeZone, now));
  }
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  return formatDate(isoDate(ts, timeZone), todayIn(timeZone, now));
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). Positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return 0;
  const ua = Date.UTC(a.y, a.m - 1, a.day);
  const ub = Date.UTC(b.y, b.m - 1, b.day);
  return Math.round((ub - ua) / 86_400_000);
}

/** Timeline day separator: `TODAY`, `YESTERDAY`, `OCT 9`, `DEC 30, 2025`. */
export function dayLabel(day: string, today: string): string {
  const diff = daysBetween(day, today);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return formatDate(day, today);
}

/* ---------- derived pipeline values (SPEC §3.5) ---------- */

export function priorityFromFit(fit: number): Priority {
  if (fit >= 5) return "hot";
  if (fit === 4) return "warm";
  if (fit === 3) return "maybe";
  return "low";
}

/** Same rule as the API: overdue (before today), today, soon (1–7 days), later. */
export function followUpState(
  on: string | null | undefined,
  today: string,
): FollowUpState | null {
  if (!on) return null;
  const d = daysBetween(today, on);
  if (d < 0) return "overdue";
  if (d === 0) return "today";
  if (d <= 7) return "soon";
  return "later";
}

/** Chip text for a follow-up (SYSTEM §2.3). */
export function followUpLabel(on: string, state: FollowUpState, today?: string): string {
  if (state === "overdue") return "Follow up overdue";
  if (state === "today") return "Follow up today";
  return `Follow up ${formatDate(on, today)}`;
}

/** Initials for the account circle: "Sam Rivera" → "SR", "dana@example.com" → "D". */
export function initials(nameOrEmail: string): string {
  const base = nameOrEmail.includes("@") ? nameOrEmail.split("@")[0]! : nameOrEmail;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]![0], words[words.length - 1]![0]] : [base[0]];
  return letters.join("").toUpperCase();
}
