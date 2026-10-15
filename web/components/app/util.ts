/**
 * Small helpers shared by the signed-in feature screens (App-UI). Formatting lives in
 * `lib/format.ts`; these are input parsing, local-time math and client-side CSV.
 */

import { useEffect, useState } from "react";

import type { PipelineExtra } from "@/lib/api/rounds";
import type { Investor, Participant } from "@/lib/api/types";
import { INVESTOR_TYPE_LABEL } from "@/lib/api/types";
import { daysBetween } from "@/lib/format";

/**
 * Parse a money input the way founders type it: `250000`, `250,000`, `$250k`, `1.5M`, `2m`.
 * Returns whole units, `null` for an empty input, and `NaN` for something unreadable.
 */
export function parseMoney(input: string): number | null {
  const s = input.trim().replace(/[$€£¥,\s_]/g, "").toLowerCase();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(s);
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  const mult = m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : m[2] === "b" ? 1_000_000_000 : 1;
  return Math.round(n * mult);
}

/** Integer 0..max from an input, `null` if empty, `NaN` if invalid. */
export function parseIntIn(input: string, min: number, max: number): number | null {
  const s = input.trim().replace(/%$/, "");
  if (!s) return null;
  if (!/^\d+$/.test(s)) return Number.NaN;
  const n = Number(s);
  return n < min || n > max ? Number.NaN : n;
}

/** Plain digits with separators for an editable money input (`2000000` → `2,000,000`). */
export function moneyInput(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : new Intl.NumberFormat("en-US").format(n);
}

/** Offset of `timeZone` from UTC at `at`, in minutes (e.g. -420 for PDT). */
function tzOffsetMinutes(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** RFC 3339 for 12:00 on `date` (YYYY-MM-DD) in the workspace timezone (SPEC §6.2). */
export function localNoon(date: string, timeZone: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const off = tzOffsetMinutes(timeZone, guess);
  return new Date(guess.getTime() - off * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Date `n` days after `date` (YYYY-MM-DD). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Days from `today` until `date` (negative when past). */
export const daysUntil = (today: string, date: string) => daysBetween(today, date);

/** Card and table order within a stage: fit desc, follow-up asc, then name (prototype byFit). */
export function byFit(a: Participant, b: Participant): number {
  if (b.fit !== a.fit) return b.fit - a.fit;
  const fa = a.follow_up_on ?? "9999-12-31";
  const fb = b.follow_up_on ?? "9999-12-31";
  if (fa !== fb) return fa < fb ? -1 : 1;
  return a.investor.name.localeCompare(b.investor.name);
}

/**
 * Lowercased text a participant is searched by (all words must match). `extra` is either the
 * full investor (directory) or the pipeline's trimmed extras (industries + a search blob).
 */
export function participantSearchText(p: Participant, extra?: Investor | PipelineExtra): string {
  const i = p.investor;
  const inv = extra && "id" in extra ? extra : undefined;
  const brief = extra && !("id" in extra) ? extra : undefined;
  return [
    i.name,
    i.firm,
    i.title,
    i.email,
    INVESTOR_TYPE_LABEL[i.type],
    ...(i.tags ?? []),
    ...(extra?.industries ?? []),
    brief?.search,
    inv?.location,
    ...(inv?.stage_focus ?? []),
    inv?.source,
    inv?.warm_intro_by,
    inv?.check_note,
    inv?.notes?.slice(0, 2000),
    p.next_step,
    p.follow_up_note,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/* ---------- per-viewer preferences and media queries (client only) ---------- */

export function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStore(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = readStore(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** `null` until mounted (the server cannot know), then whether `query` matches. */
export function useMediaQuery(query: string): boolean | null {
  const [m, setM] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}

export function matchesQuery(text: string, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => text.includes(w));
}

/* ---------- CSV (client-side, for exporting a selection) ---------- */

/** Formula-injection guard (SPEC §8.3) + RFC 4180 quoting. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join("; ") : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Save text as a file in the browser. */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Display name for a member or owner: name, else the email's local part. */
export function personName(p: { name?: string | null; email: string }): string {
  return p.name?.trim() || p.email;
}

/** A short, stable key for "something happened" idempotency in the log composer. */
export function newIdempotencyKey(): string {
  try {
    return `web-${crypto.randomUUID()}`;
  } catch {
    return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * The compact (phone) layout: under 640px wide, or under 500px tall, so a phone on its side
 * gets the phone layout too (design/mobile-audit). Mirrors the `phone:` CSS variant.
 */
export const COMPACT_QUERY = "(max-width: 639px), (max-height: 499px)";

/** `true` in the compact (phone) layout; `false` before mount and on larger screens. */
export function useCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY) === true;
}
