/**
 * Pure pipeline rules for the round page (design/pipeline-redo/DECISION.md §2–§5): which view
 * opens, when money "exists", the dominant stage, the Triage targets and their keys, the one
 * right-slot item on a card, the Next up buckets, the triage queue order and cursor, and the
 * session pace. No React and no requests, so `npm run test:unit` covers all of it.
 */

import type { Participant, Priority, Stage } from "./api/types";
import { daysBetween, formatDate, moneyCompact, priorityFromFit } from "./format";

/* ---------- hidden values ---------- */

/** The industry "Other" and the investor type `other` are never rendered as chips or labels. */
export function isHiddenValue(v: string | null | undefined): boolean {
  return !v || v.trim().toLowerCase() === "other";
}

/** Industries worth showing (no "Other", no blanks). */
export function visibleIndustries(list: readonly string[] | null | undefined): string[] {
  return (list ?? []).filter((i) => !isHiddenValue(i));
}

/** Short type labels for cards and rows ("CVC", "FO"); null for `other`. */
export const SHORT_TYPE: Record<string, string> = {
  vc: "VC",
  angel: "Angel",
  family_office: "FO",
  corporate_vc: "CVC",
  accelerator: "Accel.",
  scout: "Scout",
};
export function shortType(type: string | null | undefined): string | null {
  if (!type || isHiddenValue(type)) return null;
  return SHORT_TYPE[type] ?? null;
}

/* ---------- stages ---------- */

const byPos = (a: Pick<Stage, "position">, b: Pick<Stage, "position">) => a.position - b.position;

/** The open stage `O`: the first stage of kind "open" by position (New). */
export function openStage<S extends Pick<Stage, "kind" | "position">>(stages: readonly S[]): S | undefined {
  return [...stages].sort(byPos).find((s) => s.kind === "open");
}

export function countByStage(rows: readonly Pick<Participant, "stage">[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of rows) out[p.stage.key] = (out[p.stage.key] ?? 0) + 1;
  return out;
}

/** A stage holding ≥ 60% of the round and ≥ 50 investors, else null. */
export function dominantStage(counts: Record<string, number>, total: number): string | null {
  for (const [key, n] of Object.entries(counts)) if (n >= 50 && n >= total * 0.6) return key;
  return null;
}

/** soft + committed > 0 over the round, or anyone in the won stage. */
export function moneyExists(
  rows: readonly Pick<Participant, "amount_soft" | "amount_committed" | "stage">[],
): boolean {
  return rows.some((p) => (p.amount_soft ?? 0) > 0 || (p.amount_committed ?? 0) > 0 || p.stage.kind === "won");
}

export interface TriageTarget<S = Stage> {
  stage: S;
  /** "1"–"9", or null for the 10th target and later (reached through "Other stage…"). */
  key: string | null;
  primary: boolean;
}

/**
 * Every stage except `O`, in position order, numbered 1–9. Primary: the first two targets plus
 * the lost stage (Researching, Contacted, Passed with the default stages).
 */
export function triageTargets<S extends Pick<Stage, "key" | "kind" | "position">>(stages: readonly S[]): TriageTarget<S>[] {
  const o = openStage(stages);
  const list = [...stages].sort(byPos).filter((s) => s.key !== o?.key);
  return list.map((stage, i) => ({
    stage,
    key: i < 9 ? String(i + 1) : null,
    primary: i < 2 || stage.kind === "lost",
  }));
}

/** One line under "Drop here" on an empty default column (a custom stage gets none). */
export const STAGE_MEANING: Record<string, string> = {
  research: "Worth a closer look",
  contacted: "You reached out",
  replied: "They wrote back",
  meeting: "On the calendar",
  dd: "Reading the data room",
  committed: "Signed or wired",
  passed: "Not this round",
};

/* ---------- which view opens (§3) ---------- */

export type PipelineView = "triage" | "board" | "table";
export type PhoneView = "list" | "triage";

export function isView(v: string | null | undefined): v is PipelineView {
  return v === "triage" || v === "board" || v === "table";
}

/**
 * URL first, then the viewer's stored choice for this round, then the auto rule (`O` is the
 * dominant stage and the viewer can write → Triage), else Board. Triage needs a writer and an
 * open stage; it stays available (done state) when `O` empties during a session.
 */
export function defaultView(a: {
  url?: string | null;
  stored?: string | null;
  canWrite: boolean;
  hasOpenStage: boolean;
  openCount: number;
  total: number;
}): { view: PipelineView; auto: boolean } {
  const triageOk = a.canWrite && a.hasOpenStage;
  const ok = (v: string | null | undefined): v is PipelineView => isView(v) && (v !== "triage" || triageOk);
  if (ok(a.url)) return { view: a.url, auto: false };
  if (ok(a.stored) && (a.stored !== "triage" || a.openCount > 0)) return { view: a.stored, auto: false };
  const dominant = a.openCount >= 50 && a.openCount >= a.total * 0.6;
  if (triageOk && dominant) return { view: "triage", auto: true };
  return { view: "board", auto: false };
}

/* ---------- the card's one right slot (§5.3) ---------- */

export type CardSlot =
  | { kind: "due"; text: string }
  | { kind: "money"; text: string }
  | { kind: "soft"; text: string }
  | { kind: "soon"; text: string }
  | { kind: "later"; text: string }
  | { kind: "type"; text: string };

export function cardSlot(
  p: Pick<Participant, "follow_up_on" | "follow_up_state" | "amount_soft" | "amount_committed" | "stage"> & {
    investor: { type: string };
  },
  today: string,
  currency: string,
): CardSlot | null {
  const on = p.follow_up_on;
  const st = p.follow_up_state;
  if (on && st === "overdue") {
    const late = daysBetween(on, today);
    return { kind: "due", text: late > 0 ? `Overdue ${late}d` : "Overdue" };
  }
  if (on && st === "today") return { kind: "due", text: "Today" };
  if (p.stage.kind === "won" && (p.amount_committed ?? 0) > 0) {
    return { kind: "money", text: moneyCompact(p.amount_committed, currency) };
  }
  if ((p.amount_soft ?? 0) > 0) return { kind: "soft", text: `${moneyCompact(p.amount_soft, currency)} soft` };
  if (on && st === "soon") return { kind: "soon", text: formatDate(on, today) };
  if (on && st === "later") return { kind: "later", text: formatDate(on, today) };
  const t = shortType(p.investor.type);
  return t ? { kind: "type", text: t } : null;
}

/* ---------- priority groups and the triage queue (§4.2) ---------- */

export const PRIORITY_ORDER: Priority[] = ["hot", "warm", "maybe", "low"];
export const GROUP_LABEL: Record<Priority, string> = {
  hot: "Hot · fit 5",
  warm: "Warm · fit 4",
  maybe: "Maybe · fit 3",
  low: "Low fit · 0–2",
};

export type TriageSlice = "all" | "hw" | "maybe" | "low";
export const SLICE_LABEL: Record<TriageSlice, string> = { all: "All", hw: "Hot + Warm", maybe: "Maybe", low: "Low fit" };

export function inSlice(fit: number, slice: TriageSlice): boolean {
  const pr = priorityFromFit(fit);
  if (slice === "all") return true;
  if (slice === "hw") return pr === "hot" || pr === "warm";
  return pr === slice;
}

/** Priority group, then fit desc, then import order (created_at asc), then name. */
export function triageCompare(
  a: Pick<Participant, "fit" | "created_at"> & { investor: { name: string } },
  b: Pick<Participant, "fit" | "created_at"> & { investor: { name: string } },
): number {
  if (b.fit !== a.fit) return b.fit - a.fit;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.investor.name.localeCompare(b.investor.name);
}

/** Rows grouped by priority (empty groups omitted), each in triage order. */
export function priorityGroups<T extends Pick<Participant, "fit" | "created_at"> & { investor: { name: string } }>(
  rows: readonly T[],
): { priority: Priority; rows: T[] }[] {
  const m: Record<Priority, T[]> = { hot: [], warm: [], maybe: [], low: [] };
  for (const r of rows) m[priorityFromFit(r.fit)].push(r);
  return PRIORITY_ORDER.filter((p) => m[p].length).map((p) => ({ priority: p, rows: m[p].sort(triageCompare) }));
}

/**
 * The next row to show after `from`: the first later id that is not done, wrapping to the top.
 * `from` null starts at the top. Null when every row is done.
 */
export function nextCursor(order: readonly string[], from: string | null, done: (id: string) => boolean): string | null {
  const at = from ? order.indexOf(from) : -1;
  for (let k = 1; k <= order.length; k++) {
    const id = order[(at + k + order.length) % order.length]!;
    if (!done(id)) return id;
  }
  return null;
}

/* ---------- pace (§4.4) ---------- */

/** Seconds per investor before there is a pace of one's own. */
export const START_SECONDS = 20;

/** "15 min", "2h 40m"; rounded to 5 minutes, at least 5. */
export function formatDuration(ms: number): string {
  const min = Math.max(5, Math.round(ms / 60_000 / 5) * 5);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Elapsed minutes as people say it: "under a minute", "6 min", "1h 5m". */
export function formatElapsed(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
}

/**
 * The session pace: the median gap between decisions (each capped at 120s), from the 5th
 * decision on. `perMs` null before that.
 */
export function paceEstimate(times: readonly number[]): { sorted: number; perMs: number | null } {
  const sorted = times.length;
  if (sorted < 5) return { sorted, perMs: null };
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(Math.min(120_000, Math.max(0, times[i]! - times[i - 1]!)));
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
  return { sorted, perMs: median };
}

/* ---------- Next up buckets (§5.1) and the quiet filter ---------- */

const DAY = 86_400_000;

/** In an active stage, no activity (else stage change) for 14+ days, and nothing due today or later. */
export function isQuiet(
  p: Pick<Participant, "stage" | "last_activity_at" | "stage_changed_at" | "follow_up_on">,
  today: string,
  nowMs: number,
): boolean {
  if (p.stage.kind !== "active") return false;
  const last = Date.parse(p.last_activity_at ?? p.stage_changed_at);
  if (!Number.isFinite(last) || nowMs - last < 14 * DAY) return false;
  return !p.follow_up_on || p.follow_up_on < today;
}

export interface NextUpBucket {
  id: "hw" | "quiet" | "nofollow" | "new";
  count: number;
}

export function nextUpBuckets(
  rows: readonly Pick<Participant, "stage" | "fit" | "last_activity_at" | "stage_changed_at" | "follow_up_on">[],
  openKey: string | null,
  today: string,
  nowMs: number,
): NextUpBucket[] {
  let hw = 0;
  let quiet = 0;
  let nofollow = 0;
  let fresh = 0;
  for (const p of rows) {
    if (openKey && p.stage.key === openKey) {
      fresh++;
      if (p.fit >= 4) hw++;
    }
    if (isQuiet(p, today, nowMs)) quiet++;
    if (p.stage.kind === "active" && !p.follow_up_on) nofollow++;
  }
  const out: NextUpBucket[] = [
    { id: "hw", count: hw },
    { id: "quiet", count: quiet },
    { id: "nofollow", count: nofollow },
  ];
  if (fresh !== hw) out.push({ id: "new", count: fresh });
  return out.filter((b) => b.count > 0);
}
