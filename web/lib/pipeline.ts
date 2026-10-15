/**
 * Pure pipeline rules for the round page (design/pipeline-redo/DECISION.md §2–§5): which view
 * opens, when money "exists", the dominant stage, the Triage targets and their keys, the one
 * right-slot item on a card, the Next up buckets, the triage queue order and cursor, and the
 * session pace. No React and no requests, so `npm run test:unit` covers all of it.
 */

import { dayOf, meetingBeatsFollowUp, meetingChipText, whenLine } from "./meetings";
import type { Participant, Priority, Stage } from "./api/types";
import { daysBetween, formatDate, moneyCompact, priorityFromFit, todayIn } from "./format";

/* ---------- hidden values ---------- */

/** The industry "Other" and the investor type `other` are never rendered as chips or labels. */
export function isHiddenValue(v: string | null | undefined): boolean {
  return !v || v.trim().toLowerCase() === "other";
}

/** Industries worth showing (no "Other", no blanks). */
export function visibleIndustries(list: readonly string[] | null | undefined): string[] {
  return (list ?? []).filter((i) => !isHiddenValue(i));
}

/** Short type labels for rows ("CVC", "Family office"); null for `other`. */
export const SHORT_TYPE: Record<string, string> = {
  vc: "VC",
  angel: "Angel",
  family_office: "Family office",
  corporate_vc: "CVC",
  accelerator: "Accel.",
  scout: "Scout",
};
export function shortType(type: string | null | undefined): string | null {
  if (!type || isHiddenValue(type)) return null;
  return SHORT_TYPE[type] ?? null;
}

/**
 * The one value every item shares (trimmed, case-insensitive), else null. A chip whose value
 * is the same on all 411 investors ("SF Tech Week") says nothing, so callers hide it.
 */
export function sharedValue(values: readonly (string | null | undefined)[]): string | null {
  let first: string | null = null;
  for (const v of values) {
    const t = v?.trim();
    if (!t) return null;
    if (first === null) first = t;
    else if (t.toLowerCase() !== first.toLowerCase()) return null;
  }
  return first;
}

/**
 * "46 VC, 13 Angel, 8 Scout and 19 more": the three largest groups, then the rest as one
 * count, so the parts always add up to the whole (types without a label are in the rest).
 */
export function breakdown(labels: readonly (string | null)[], top = 3): string {
  const m = new Map<string, number>();
  let unlabeled = 0;
  for (const l of labels) {
    if (l) m.set(l, (m.get(l) ?? 0) + 1);
    else unlabeled++;
  }
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = sorted.slice(0, top);
  const rest = unlabeled + sorted.slice(top).reduce((n, [, c]) => n + c, 0);
  const parts = shown.map(([l, c]) => `${c.toLocaleString("en-US")} ${l}`);
  if (!parts.length) return "";
  return rest ? `${parts.join(", ")} and ${rest.toLocaleString("en-US")} more` : parts.join(", ");
}

/**
 * The intro email's "why you" line, worded to the fit (critique 4: "came up as a strong fit"
 * on a fit-0 investor was a lie the founder would send).
 */
export function introFitLine(firm: string | null | undefined, fit: number): string {
  const f = firm?.trim();
  if (!f) return "";
  if (fit >= 4) return `${f} came up as a strong fit, so I wanted to reach out directly.`;
  if (fit === 3) return `${f} looks like a good fit, so I wanted to reach out directly.`;
  return `I wanted to reach out to you at ${f} directly.`;
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

/**
 * Stages that say you are already talking to them (Contacted and later, or Committed). Filing a
 * fresh import there from Triage asks first, so "I'd contact them" never records "Contacted"
 * for someone nobody has emailed (critique 2).
 */
export function claimsContact(stage: Pick<Stage, "kind">): boolean {
  return stage.kind === "active" || stage.kind === "won";
}

/** The line under a Triage decision button: what filing there means right now. */
export const TRIAGE_MEANING: Record<string, string> = {
  research: "Shortlist, reach out later",
  contacted: "You reached out",
  passed: "Not this round",
};

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
  | { kind: "meeting"; text: string; today: boolean; title?: string }
  | { kind: "due"; text: string }
  | { kind: "money"; text: string }
  | { kind: "soft"; text: string }
  | { kind: "soon"; text: string }
  | { kind: "later"; text: string };

export function cardSlot(
  p: Pick<Participant, "follow_up_on" | "follow_up_state" | "amount_soft" | "amount_committed" | "stage"> & {
    next_meeting?: Participant["next_meeting"];
  },
  today: string,
  currency: string,
  /** The viewer's timezone and clock: a scheduled meeting takes the slot when it is sooner. */
  meet?: { timeZone: string; now?: Date },
): CardSlot | null {
  const on = p.follow_up_on;
  const st = p.follow_up_state;
  const m = p.next_meeting;
  if (m && meet) {
    const now = meet.now ?? new Date();
    const viewerToday = todayIn(meet.timeZone, now);
    const day = dayOf(m.starts_at, meet.timeZone);
    // Today's follow-up date in the viewer's calendar is close enough to the workspace one here.
    if (day && meetingBeatsFollowUp(day, on && (st === "overdue" || st === "today") ? viewerToday : on, viewerToday)) {
      return {
        kind: "meeting",
        text: meetingChipText(m.starts_at, viewerToday, meet.timeZone),
        today: day <= viewerToday,
        title: `${m.title} · ${whenLine(m, meet.timeZone, viewerToday)}`,
      };
    }
  }
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
  // Nothing due, no money, no follow-up: the slot stays empty (repeating "VC" on 300 cards
  // is noise; the type lives in the sheet and the table).
  return null;
}

/**
 * Which fit the card pips leave out in a column (critique 3): pips are for deciding who to
 * contact, so talking, won and lost stages show none (returns "all"); in an open-kind stage
 * the fit most cards share (70% or more of 5+ cards) is left out, so the pips mark only the
 * investors who differ from the rest of the column. null: every card shows its pips.
 */
export function hiddenPipFit(
  stage: Pick<Stage, "kind">,
  fits: readonly number[],
): number | "all" | null {
  if (stage.kind !== "open") return "all";
  if (fits.length < 5) return null;
  const m = new Map<number, number>();
  for (const f of fits) m.set(f, (m.get(f) ?? 0) + 1);
  let best: number | null = null;
  let n = 0;
  for (const [f, c] of m) if (c > n) [best, n] = [f, c];
  return best !== null && n >= fits.length * 0.7 ? best : null;
}

/**
 * A board column's default order (critique 4, kanban): not-contacted stages by fit (fit decides
 * who to contact next), talking stages by the next follow-up (overdue, then the soonest date),
 * the won stage by the amount committed, and the lost stage by the most recent move.
 */
export function defaultColumnSort(stage: Pick<Stage, "kind">): "fit" | "due" | "amount" | "recent" {
  switch (stage.kind) {
    case "active":
      return "due";
    case "won":
      return "amount";
    case "lost":
      return "recent";
    default:
      return "fit";
  }
}

/* ---------- priority groups and the triage queue (§4.2) ---------- */

export const PRIORITY_ORDER: Priority[] = ["hot", "warm", "maybe", "low"];
export const GROUP_LABEL: Record<Priority, string> = {
  hot: "Hot · fit 5",
  warm: "Warm · fit 4",
  maybe: "Maybe · fit 3",
  low: "Low or not rated · 0–2",
};

export type TriageSlice = "all" | "hw" | "maybe" | "low";
export const SLICE_LABEL: Record<TriageSlice, string> = { all: "All", hw: "Hot + Warm", maybe: "Maybe", low: "Low / unrated" };

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

/**
 * "3 min", "15 min", "2h 40m": to the minute under 10 minutes (at least 1), then rounded to 5
 * minutes (critique 4: 9 investors at 20s each is 3 min, not "about 5").
 */
export function formatDuration(ms: number): string {
  const raw = ms / 60_000;
  const min = raw < 9.5 ? Math.max(1, Math.round(raw)) : Math.round(raw / 5) * 5;
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

/** A gap longer than this is a break, not a pace: it is left out (critique 3). */
export const MAX_GAP_MS = 120_000;

/**
 * The slowest pace a plan assumes (critique 4): five Passes a second apart are real, but "the
 * rest of New takes 10 min" for 406 investors is no plan. Faster than this, the estimate plans
 * at this pace and says so.
 */
export const PACE_FLOOR_MS = 10_000;

/**
 * The session pace (critique 3: no invented numbers). `times` are the moments of single
 * decisions only: a bulk move is one keypress for 86 investors and says nothing about how long
 * one investor takes. The pace is the median of the real gaps between them, breaks (over 2
 * minutes) left out, from the 5th decision and with at least 4 real gaps. `perMs` null before.
 * `perMs` is never under `PACE_FLOOR_MS`; `floored` says the real median was quicker.
 */
export function paceEstimate(times: readonly number[]): { sorted: number; perMs: number | null; floored: boolean } {
  const sorted = times.length;
  if (sorted < 5) return { sorted, perMs: null, floored: false };
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const g = times[i]! - times[i - 1]!;
    if (g >= 0 && g <= MAX_GAP_MS) gaps.push(g);
  }
  if (gaps.length < 4) return { sorted, perMs: null, floored: false };
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
  return { sorted, perMs: Math.max(PACE_FLOOR_MS, median), floored: median < PACE_FLOOR_MS };
}

/** "about 25s each", "about 1 min each": a pace as people say it. */
export function formatEach(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `about ${s}s each` : `about ${Math.round(s / 60)} min each`;
}

/** A total that may be under 5 minutes: "under 5 min", else formatDuration. */
export function formatRest(ms: number): string {
  return ms < 5 * 60_000 ? "under 5 min" : formatDuration(ms);
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

export type NextUpBucket =
  /** Still in `O`; `hw` of them Hot or Warm. One row, one link to Triage. */
  | { id: "new"; count: number; hw: number }
  /** Researched but not contacted yet (open-kind stages after `O`); `next` is who to contact first. */
  | { id: "ready"; count: number; stageKey: string | null; next: { id: string; name: string; fit: number } | null }
  | { id: "quiet"; count: number }
  | { id: "nofollow"; count: number };

/**
 * The Next up rows (DECISION §5.1, critique 1): who to contact next first (the highest fit
 * among the researched-but-not-contacted), then New with its Hot and Warm share in one row,
 * then the gone-quiet and no-follow-up lists. Zero rows are left out.
 */
export function nextUpBuckets(
  rows: readonly (Pick<Participant, "stage" | "fit" | "last_activity_at" | "stage_changed_at" | "follow_up_on" | "created_at"> & {
    investor: { id: string; name: string };
  })[],
  openKey: string | null,
  today: string,
  nowMs: number,
): NextUpBucket[] {
  let hw = 0;
  let quiet = 0;
  let nofollow = 0;
  let fresh = 0;
  let ready = 0;
  const readyStages = new Set<string>();
  let best: (typeof rows)[number] | null = null;
  for (const p of rows) {
    if (openKey && p.stage.key === openKey) {
      fresh++;
      if (p.fit >= 4) hw++;
    } else if (p.stage.kind === "open") {
      ready++;
      readyStages.add(p.stage.key);
      if (!best || p.fit > best.fit || (p.fit === best.fit && p.created_at < best.created_at)) best = p;
    }
    if (isQuiet(p, today, nowMs)) quiet++;
    if (p.stage.kind === "active" && !p.follow_up_on) nofollow++;
  }
  const out: NextUpBucket[] = [
    {
      id: "ready",
      count: ready,
      stageKey: readyStages.size === 1 ? [...readyStages][0]! : null,
      next: best ? { id: best.investor.id, name: best.investor.name, fit: best.fit } : null,
    },
    { id: "new", count: fresh, hw },
    { id: "quiet", count: quiet },
    { id: "nofollow", count: nofollow },
  ];
  return out.filter((b) => b.count > 0);
}

/* ---------- follow-up quick picks in Triage (§4.3) ---------- */

export interface FollowOption {
  label: string;
  /** The chord's second key (`f` then this). */
  kbd: string;
  iso: string;
}

/**
 * Tomorrow · Next Mon · In 1 week, always three different dates: on a Monday "Next Mon" and
 * "In 1 week" are the same day, so the third pick becomes "In 2 weeks".
 */
export function followOptions(picks: readonly { label: string; iso: string; kbd?: string }[]): FollowOption[] {
  const by = (k: string) => picks.find((p) => p.kbd === k);
  const out: FollowOption[] = [];
  const add = (k: string, label: string) => {
    const p = by(k);
    if (p && !out.some((o) => o.iso === p.iso)) out.push({ label, kbd: k, iso: p.iso });
  };
  add("1", "Tomorrow");
  add("m", "Next Mon");
  add("7", "In 1 week");
  if (out.length < 3) add("2", "In 2 weeks");
  return out;
}

/** The one option shown pressed for a date: the first that matches, else none (-1). */
export function pressedOption(options: readonly { iso: string | null }[], value: string | null): number {
  return options.findIndex((o) => o.iso === value);
}

/* ---------- the triage cursor after a move (§4.5, §4.6) ---------- */

/**
 * Where the cursor goes after investors leave the queue. The current row stays when it is
 * still undecided (a bulk move of other rows must not skip it); otherwise the next undecided
 * row after it, wrapping.
 */
export function cursorAfterMove(
  order: readonly string[],
  cursor: string | null,
  moved: ReadonlySet<string>,
  done: (id: string) => boolean,
): string | null {
  const gone = (id: string) => moved.has(id) || done(id);
  if (cursor && order.includes(cursor) && !gone(cursor)) return cursor;
  return nextCursor(order, cursor, gone);
}

/** "3 of 190": the cursor's place among the rows still to decide, and how many those are. */
export function queuePosition(
  order: readonly string[],
  cursor: string | null,
  left: (id: string) => boolean,
): { pos: number | null; left: number } {
  let n = 0;
  let pos: number | null = null;
  for (const id of order) {
    if (!left(id)) continue;
    n++;
    if (id === cursor) pos = n;
  }
  return { pos, left: n };
}

/* ---------- the kanban's column width (DECISION §14) ---------- */

const COL_MIN = 250;
const COL_GAP = 12;
const PEEK = 60;

/**
 * The board's `grid-auto-columns` for a board `w` px wide holding `n` stages: equal columns
 * that share the width when all fit at 250px, else as many whole columns as fit with the next
 * one peeking 60px out at the right edge (never a sliver that reads as the board's end).
 * Null under 640px (phones use the list).
 */
export function boardTrack(w: number, n: number, tablet = false): string | null {
  if (w < 640 || n === 0) return null;
  // Tablet screens: 280px columns that snap, under stage tabs (two and a good part of a third).
  if (tablet && w < 900) return n * 280 + (n - 1) * COL_GAP <= w ? "minmax(0, 1fr)" : "280px";
  if (n * COL_MIN + (n - 1) * COL_GAP <= w) return "minmax(0, 1fr)";
  const whole = Math.max(1, Math.floor((w - PEEK + COL_GAP) / (COL_MIN + COL_GAP)));
  return `${Math.floor((w - PEEK - whole * COL_GAP) / whole)}px`;
}

/* ---------- table columns that fit (critique 1) ---------- */

/**
 * The columns that fit `width`: `cols` in display order, dropping the lowest-priority ones
 * (`dropOrder`, first dropped first) until the fixed widths fit. Required columns stay.
 */
export function fitColumns<K extends string>(
  cols: readonly { key: K; width: number; required?: boolean }[],
  dropOrder: readonly K[],
  width: number,
): K[] {
  const keep = new Set(cols.map((c) => c.key));
  let total = cols.reduce((n, c) => n + c.width, 0);
  for (const k of dropOrder) {
    if (total <= width) break;
    const c = cols.find((x) => x.key === k);
    if (!c || c.required || !keep.has(k)) continue;
    keep.delete(k);
    total -= c.width;
  }
  return cols.filter((c) => keep.has(c.key)).map((c) => c.key);
}

/**
 * Columns with nothing to say for these rows: every value empty, or (from 20 rows) the same
 * value everywhere, like a Stage column that reads "New" 411 times.
 */
export function quietColumns<K extends string>(
  keys: readonly K[],
  rows: readonly unknown[],
  value: (row: never, key: K) => string | number | null | undefined,
  constantOk: readonly K[] = [],
): Set<K> {
  const out = new Set<K>();
  for (const k of keys) {
    let first: string | number | null | undefined;
    let any = false;
    let same = true;
    for (const r of rows) {
      const v = value(r as never, k);
      if (v === null || v === undefined || v === "") {
        if (any) same = false;
        continue;
      }
      if (!any) {
        any = true;
        first = v;
      } else if (v !== first) same = false;
    }
    if (!any) out.add(k);
    else if (same && rows.length >= 20 && !constantOk.includes(k)) out.add(k);
  }
  return out;
}
