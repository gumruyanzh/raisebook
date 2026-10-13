/**
 * Pure rules for the rich kanban card (DECISION §15): the likelihood line, the meta chips,
 * the check range and the last-touch label. No React, so `npm run test:unit` covers it.
 */

import type { Participant, Priority, Stage } from "./api/types";
import { daysBetween, isoDate, moneyCompact, priorityFromFit, stageFocusLabel } from "./format";
import { shortType, visibleIndustries } from "./pipeline";

/* ---------- likelihood to close ---------- */

/**
 * The base chance a stage closes, before fit (the default stages by key; a custom stage by its
 * kind). New 5, Researching 10, Contacted 15, Replied 25, Meeting 40, Diligence 60,
 * Committed 100, Passed 0.
 */
export const STAGE_BASE: Record<string, number> = {
  new: 5,
  research: 10,
  contacted: 15,
  replied: 25,
  meeting: 40,
  dd: 60,
  committed: 100,
  passed: 0,
};
const KIND_BASE: Record<Stage["kind"], number> = { open: 5, active: 20, won: 100, lost: 0 };

/** Never claim certainty before the money is in. */
export const LIKELIHOOD_CAP = 95;

export interface Likelihood {
  /** 0–100, whole percent. */
  value: number;
  /** "set": the participant's own probability; "derived": stage base × fit. */
  source: "set" | "derived";
  /** The tooltip: how the number was made ("Meeting 40% × fit 5 → 44%"). */
  why: string;
}

/**
 * Likelihood to close for this round. A probability set on the participant wins. Otherwise
 * it is derived in the open: the stage base × (0.6 + 0.1 × fit), capped at 95% (the won stage
 * is 100% and the lost stage 0%, whatever the fit).
 */
export function closeLikelihood(
  p: Pick<Participant, "fit" | "probability"> & { stage: Pick<Stage, "key" | "kind" | "label"> },
): Likelihood {
  if (p.probability != null && Number.isFinite(p.probability)) {
    const v = Math.max(0, Math.min(100, Math.round(p.probability)));
    return { value: v, source: "set", why: `Probability set on this investor: ${v}%` };
  }
  const label = p.stage.label;
  if (p.stage.kind === "won") return { value: 100, source: "derived", why: `${label}: 100%` };
  if (p.stage.kind === "lost") return { value: 0, source: "derived", why: `${label}: 0%` };
  const base = STAGE_BASE[p.stage.key] ?? KIND_BASE[p.stage.kind] ?? 0;
  const fit = Math.max(0, Math.min(5, Math.round(p.fit || 0)));
  const raw = base * (0.6 + 0.1 * fit);
  const value = Math.min(LIKELIHOOD_CAP, Math.round(raw));
  const capped = raw > LIKELIHOOD_CAP ? ` (capped at ${LIKELIHOOD_CAP}%)` : "";
  return { value, source: "derived", why: `${label} ${base}% × fit ${fit} → ${value}%${capped}` };
}

/* ---------- priority ---------- */

/** The priority chip on a card: the same rule as everywhere else (`priorityFromFit`). */
export function cardPriority(fit: number): Priority {
  return priorityFromFit(fit);
}

/* ---------- meta chips ---------- */

/** Board card type labels: short, so three chips fit a 250px column. */
const CARD_TYPE: Record<string, string> = { family_office: "Family office" };

/**
 * Up to three small facts for a card, in this order: investor type ("VC", "Angel", "CVC"),
 * the first stage focus ("Seed"), the first industry ("Fintech"). `other` and "Other" are
 * never shown; repeated values are dropped.
 */
export function cardMeta(a: {
  type?: string | null;
  stageFocus?: readonly string[] | null;
  industries?: readonly string[] | null;
}): string[] {
  const out: string[] = [];
  const add = (v: string | null | undefined) => {
    const t = v?.trim();
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  add(a.type ? (CARD_TYPE[a.type] ?? shortType(a.type)) : null);
  add(visibleIndustries(a.stageFocus).map(stageFocusLabel)[0]);
  add(visibleIndustries(a.industries)[0]);
  return out.slice(0, 3);
}

/**
 * The check size range, compact: "$250k–1M", "$250k+", "Up to $1M", "$500k"; "" when unknown.
 * The second amount drops the symbol when it is the same currency (it always is).
 */
export function checkRange(min: number | null | undefined, max: number | null | undefined, currency = "USD"): string {
  const lo = min != null && min > 0 ? min : null;
  const hi = max != null && max > 0 ? max : null;
  if (lo === null && hi === null) return "";
  if (lo !== null && hi !== null) {
    if (lo === hi) return moneyCompact(lo, currency);
    const [a, b] = lo < hi ? [lo, hi] : [hi, lo];
    const right = moneyCompact(b, currency).replace(/^[^\d-]+/, "");
    return `${moneyCompact(a, currency)}–${right}`;
  }
  if (lo !== null) return `${moneyCompact(lo, currency)}+`;
  return `Up to ${moneyCompact(hi, currency)}`;
}

/* ---------- last touch ---------- */

/**
 * "Today", "1d ago", "3d ago", "5w ago", "4mo ago" for the last activity (a timestamp), in the
 * workspace calendar; "" when there is none.
 */
export function lastTouch(ts: string | null | undefined, today: string, timeZone?: string): string {
  if (!ts) return "";
  const day = isoDate(ts, timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const d = daysBetween(day, today);
  if (d <= 0) return "Today";
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/* ---------- fitting the meta row ---------- */

/** Rough widths at the card's sizes (chip: Plex Sans 500 11.5px; check: mono 11.5px). */
const CHIP_CHAR = 6.4;
const CHIP_PAD = 16;
const MONO_CHAR = 6.95;
const GAP = 4;

/**
 * The meta chips that fit beside the check range in `width` px, dropping from the end (the
 * industry first, then the stage focus), so no chip is ever cut off mid-word. The check range
 * always stays; the type goes last.
 */
export function fitMeta(meta: readonly string[], check: string, width: number): string[] {
  let room = width - (check ? check.length * MONO_CHAR + 8 : 0);
  const out: string[] = [];
  for (const m of meta) {
    const w = m.length * CHIP_CHAR + CHIP_PAD + (out.length ? GAP : 0);
    if (w > room) break;
    room -= w;
    out.push(m);
  }
  return out;
}
