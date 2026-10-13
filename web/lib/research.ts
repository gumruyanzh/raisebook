/**
 * Pure rules for investor research in the web app (RESEARCH-PLAN §8), unit-tested in
 * `research.test.ts`: money for AI cost, freshness, the Meeting refresh offer, verdict words,
 * the dossier's fixed sections (R5) with numbered citations, "new since", suggestion lines,
 * estimate lines and run progress words.
 */

import type {
  Claim,
  DossierView,
  Estimate,
  Fact,
  FactSection,
  Run,
  RunStatus,
  Suggestion,
  Verdict,
} from "./api/research";
import { PRIORITY_LABEL } from "./api/types";
import { formatDate, moneyCompact, num, plural, priorityFromFit, stageFocusLabel } from "./format";

/* ---------- money (USD, from OpenRouter) ---------- */

/** `$0.19`, `<$0.01`, `$0.00`, `$25.00`, `$1,240.50`. Null is an empty string. */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  if (n > 0 && n < 0.005) return "<$0.01";
  const v = Math.round(n * 100) / 100;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `≈ $0.20` for an estimate; empty when unknown. */
export function approxUsd(n: number | null | undefined): string {
  const s = formatUsd(n);
  return s ? `≈ ${s}` : "";
}

/** The monthly limit as people say it: `$25`, `$12.50`. */
export function capUsd(n: number): string {
  return Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : formatUsd(n);
}

/* ---------- freshness (R10) ---------- */

export const STALE_DAYS = 90;
export const MEETING_REFRESH_DAYS = 30;

/** Whole days since a timestamp. */
export function ageDays(at: string | null | undefined, now: Date): number {
  if (!at) return 0;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/** "May be stale" after 90 days. */
export function isStale(dossierAt: string | null | undefined, now: Date): boolean {
  return Boolean(dossierAt) && ageDays(dossierAt, now) > STALE_DAYS;
}

/**
 * Offer "Refresh before your meeting?" when a move lands on the Meeting stage and the dossier
 * is older than 30 days. Never automatic, and never without a dossier.
 */
export function refreshOffer(stageKey: string | null | undefined, dossierAt: string | null | undefined, now: Date): boolean {
  return stageKey === "meeting" && Boolean(dossierAt) && ageDays(dossierAt, now) > MEETING_REFRESH_DAYS;
}

/* ---------- verdicts ---------- */

export const VERDICT_LABEL: Record<Verdict, string> = { strong: "Strong fit", possible: "Possible fit", poor: "Poor fit" };

export function verdictLabel(v: Verdict | string | null | undefined): string {
  return v && v in VERDICT_LABEL ? VERDICT_LABEL[v as Verdict] : "";
}

/** The fit a verdict writes back (Hot stays a human call). */
export function fitFromVerdict(v: Verdict | string | null | undefined): number {
  return v === "strong" ? 4 : v === "possible" ? 3 : v === "poor" ? 1 : 0;
}

/** The word for a confidence score (never a bare percentage). */
export function confidenceWord(c: number): "likely" | "possible" | "unlikely" {
  return c >= 0.8 ? "likely" : c >= 0.5 ? "possible" : "unlikely";
}

/** "anthropic/claude-opus-5.5" → "Claude Opus 5.5"; "perplexity/sonar-pro" → "Sonar Pro". */
export function modelName(id: string | null | undefined): string {
  if (!id) return "";
  const tail = id.split("/").pop() ?? id;
  return tail
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\bGpt\b/, "GPT");
}

/* ---------- the dossier's sections (R5) ---------- */

export type SectionKey = "fit" | "activity" | "thesis" | "ways_in" | "talking_points" | "red_flags";

export const SECTION_LABEL: Record<SectionKey, string> = {
  fit: "Fit",
  activity: "Recent activity",
  thesis: "Thesis and public views",
  ways_in: "Ways in",
  talking_points: "Talking points",
  red_flags: "Red flags",
};

export const SECTION_ORDER: SectionKey[] = ["fit", "activity", "thesis", "ways_in", "talking_points", "red_flags"];

export interface Line {
  text: string;
  /** "Stage", "Sector", … for the Fit assessment; the date for a deal. */
  lead?: string;
  date?: string | null;
  /** Citation numbers ([1], [2]) in the order the sources were first cited. */
  cites: number[];
  /** Cites a fact that is new since the previous version. */
  isNew: boolean;
  /** Ways in from our own data (not a public source). */
  workspace?: boolean;
}

export interface Section {
  key: SectionKey;
  label: string;
  lines: Line[];
}

export interface Citation {
  n: number;
  id: string;
  url: string;
  domain: string;
  title: string | null;
  published_at: string | null;
}

/** The keys new since the previous version (empty for a first dossier). */
export function newSince(view: Pick<DossierView, "new_since" | "dossier">): Set<string> {
  if (!view.new_since) return new Set();
  return new Set(view.dossier.new_fact_keys ?? []);
}

/**
 * Number the cited sources in reading order (Brief, then the sections top to bottom), and
 * build the six sections. A section with nothing in it is left out; activity reads newest
 * first. Every line carries the citation numbers of the facts it points at.
 */
export function sectionsOf(view: DossierView): { sections: Section[]; citations: Citation[]; briefCites: number[] } {
  const facts = new Map<string, Fact>(view.facts.map((f) => [f.key, f]));
  const sourceById = new Map(view.sources.map((s) => [String(s.id), s]));
  const fresh = newSince(view);
  const numbers = new Map<string, number>();
  const citations: Citation[] = [];
  const cite = (sourceIds: readonly string[]): number[] => {
    const out: number[] = [];
    for (const id of sourceIds) {
      const s = sourceById.get(String(id));
      if (!s) continue;
      let n = numbers.get(s.id);
      if (n === undefined) {
        n = citations.length + 1;
        numbers.set(s.id, n);
        citations.push({ n, id: s.id, url: s.url, domain: s.domain, title: s.title, published_at: s.published_at });
      }
      if (!out.includes(n)) out.push(n);
    }
    return out;
  };
  const citeKeys = (keys: readonly string[] | undefined) => cite((keys ?? []).flatMap((k) => facts.get(k)?.source_ids ?? []));
  const isNewKeys = (keys: readonly string[] | undefined) => (keys ?? []).some((k) => fresh.has(k));
  const fromFact = (f: Fact): Line => ({ text: f.text, date: f.date, cites: cite(f.source_ids), isNew: fresh.has(f.key) });
  const fromClaim = (c: Claim, lead?: string): Line => ({ text: c.text, lead, cites: citeKeys(c.fact_keys), isNew: isNewKeys(c.fact_keys) });

  const a = view.dossier.analysis ?? ({} as DossierView["dossier"]["analysis"]);
  const briefCites = citeKeys(a.brief?.fact_keys);
  const bySection = (s: FactSection) => view.facts.filter((f) => f.section === s);

  const sections: Section[] = [];
  const fit: Line[] = [];
  const fa = a.fit ?? {};
  for (const [k, lead] of [
    ["stage", "Stage"],
    ["sector", "Sector"],
    ["check", "Check"],
    ["deploying", "Deploying"],
  ] as const) {
    const c = fa[k];
    if (c && c.text) fit.push(fromClaim(c, lead));
  }
  for (const c of fa.conflicts ?? []) fit.push(fromClaim(c, "Conflict"));
  // Profile and fit facts that the assessment does not already cite.
  const used = new Set([fa.stage, fa.sector, fa.check, fa.deploying, ...(fa.conflicts ?? [])].flatMap((c) => c?.fact_keys ?? []));
  for (const f of [...bySection("fit"), ...bySection("profile")]) if (!used.has(f.key)) fit.push(fromFact(f));
  sections.push({ key: "fit", label: SECTION_LABEL.fit, lines: fit });

  const activity = bySection("activity")
    .slice()
    .sort((x, y) => (y.date ?? "").localeCompare(x.date ?? ""))
    .map(fromFact);
  sections.push({ key: "activity", label: SECTION_LABEL.activity, lines: activity });
  sections.push({ key: "thesis", label: SECTION_LABEL.thesis, lines: bySection("thesis").map(fromFact) });
  sections.push({
    key: "ways_in",
    label: SECTION_LABEL.ways_in,
    lines: (a.ways_in ?? []).map((w) => ({ ...fromClaim(w), workspace: w.basis === "workspace" })),
  });
  sections.push({ key: "talking_points", label: SECTION_LABEL.talking_points, lines: (a.talking_points ?? []).map((c) => fromClaim(c)) });
  sections.push({ key: "red_flags", label: SECTION_LABEL.red_flags, lines: bySection("red_flags").map(fromFact) });
  return { sections: sections.filter((s) => s.lines.length > 0), citations, briefCites };
}

/* ---------- suggestions (R7) ---------- */

const FIELD_WORD: Record<string, string> = {
  firm: "firm",
  title: "title",
  type: "type",
  location: "location",
  linkedin_url: "LinkedIn",
  website_url: "website",
  email: "email",
  check: "check",
  stage_focus: "stage focus",
  industries: "industries",
  fit: "fit",
};

const TYPE_WORD: Record<string, string> = {
  vc: "VC",
  angel: "Angel",
  family_office: "Family Office",
  corporate_vc: "Corporate VC",
  accelerator: "Accelerator",
  scout: "Scout",
};

function rangeText(lo: unknown, hi: unknown, currency: string): string {
  const a = typeof lo === "number" ? lo : null;
  const b = typeof hi === "number" ? hi : null;
  if (a && b && a !== b) return `${moneyCompact(a, currency)}–${moneyCompact(b, currency)}`;
  if (a || b) return moneyCompact((a || b) as number, currency);
  return "";
}

function valueText(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.map((x) => (field === "stage_focus" ? stageFocusLabel(String(x)) : String(x))).join(", ");
  if (field === "type") return TYPE_WORD[String(v)] ?? String(v);
  if (field === "linkedin_url") return String(v).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  return String(v);
}

/** One row per decision: check_min and check_max read (and accept) as one "check" pair. */
export interface SuggestionGroup {
  key: string;
  field: string;
  ids: string[];
  /** The row to accept or ignore (accepting a check accepts both). */
  primary: Suggestion;
  current: { min?: unknown; max?: unknown; value?: unknown };
  suggested: { min?: unknown; max?: unknown; value?: unknown };
}

export function groupSuggestions(list: readonly Suggestion[]): SuggestionGroup[] {
  const out: SuggestionGroup[] = [];
  const checks = new Map<string, SuggestionGroup>();
  for (const s of list) {
    if (s.field === "check_min" || s.field === "check_max") {
      const k = `${s.investor_id}:${s.round_id ?? ""}:check`;
      let g = checks.get(k);
      if (!g) {
        g = { key: k, field: "check", ids: [], primary: s, current: {}, suggested: {} };
        checks.set(k, g);
        out.push(g);
      }
      g.ids.push(s.id);
      const side = s.field === "check_min" ? "min" : "max";
      g.current[side] = s.current_value;
      g.suggested[side] = s.suggested_value;
      continue;
    }
    out.push({
      key: s.id,
      field: s.field,
      ids: [s.id],
      primary: s,
      current: { value: s.current_value },
      suggested: { value: s.suggested_value },
    });
  }
  // The fit leads: it is the decision the founder is making (Triage shows one line).
  return out.sort((a, b) => Number(b.field === "fit") - Number(a.field === "fit"));
}

const FIT_WORD: Record<number, string> = { 4: "Strong fit", 3: "Possible fit", 1: "Poor fit" };

/**
 * "Research says check $250k–$1M (you have $50k–$250k)", "Research: Strong fit (you have
 * Maybe)", "Research says title General Partner (you have Partner)".
 */
export function suggestionLine(g: SuggestionGroup, currency = "USD"): string {
  if (g.field === "check") {
    const now = rangeText(g.current.min, g.current.max, currency);
    const next = rangeText(g.suggested.min, g.suggested.max, currency);
    return `Research says check ${next}${now ? ` (you have ${now})` : ""}`;
  }
  if (g.field === "fit") {
    const to = Number(g.suggested.value);
    const from = Number(g.current.value);
    const word = FIT_WORD[to] ?? `fit ${to}`;
    return `Research: ${word}${from > 0 ? ` (you have ${PRIORITY_LABEL[priorityFromFit(from)]})` : ""}`;
  }
  const word = FIELD_WORD[g.field] ?? g.field.replaceAll("_", " ");
  const next = valueText(g.field, g.suggested.value);
  const now = valueText(g.field, g.current.value);
  return `Research says ${word} ${next}${now ? ` (you have ${now})` : ""}`;
}

/* ---------- bulk estimates (R4) ---------- */

/** "Research 37 investors ≈ $7.40" or "Match 411 identities ≈ $2.90". */
export function estimateLine(e: Pick<Estimate, "kind" | "count" | "total_usd">, n = e.count): string {
  const verb = e.kind === "identity" ? `Match ${plural(n, "identity", "identities")}` : `Research ${plural(n, "investor")}`;
  const total = e.total_usd !== null && n !== e.count && e.count > 0 ? (e.total_usd * n) / e.count : e.total_usd;
  const usd = approxUsd(total);
  return usd ? `${verb} ${usd}` : verb;
}

/** Why some are left out: "12 have no identity yet · 3 researched in the last 30 days". */
export function skippedLine(skipped: Estimate["skipped"]): string {
  const parts: string[] = [];
  if (skipped.no_identity) parts.push(`${num(skipped.no_identity)} ${skipped.no_identity === 1 ? "has" : "have"} no identity yet`);
  if (skipped.fresh) parts.push(`${num(skipped.fresh)} already ${skipped.fresh === 1 ? "has a" : "have"} recent ${skipped.fresh === 1 ? "dossier" : "dossiers"}`);
  if (skipped.active) parts.push(`${num(skipped.active)} already running`);
  if (skipped.suppressed) parts.push(`${num(skipped.suppressed)} asked not to be researched`);
  return parts.join(" · ");
}

/** "Only 23 fit under your $25 monthly limit." when the cap cuts a batch. */
export function overCapLine(e: Pick<Estimate, "count" | "fits">, capUsdValue: number): string | null {
  if (e.fits >= e.count) return null;
  if (e.fits <= 0) return `None fit under what is left of your ${capUsd(capUsdValue)} monthly limit.`;
  return `Only ${num(e.fits)} fit under your ${capUsd(capUsdValue)} monthly limit.`;
}

/* ---------- runs ---------- */

export const ACTIVE: readonly RunStatus[] = ["queued", "running"];

export function isActive(status: RunStatus | string | null | undefined): boolean {
  return status === "queued" || status === "running";
}

const TERMINAL_WORD: Record<RunStatus, string> = {
  queued: "Waiting to start",
  running: "Working",
  succeeded: "Done",
  partial: "Stopped part way",
  failed: "Failed",
  cancelled: "Cancelled",
  capped: "Stopped at your monthly limit",
  blocked_identity: "Waiting for you to pick who this is",
};

/**
 * One line for a run: "Searching recent deals · 2 of 5 · $0.03" while it works, "Done ·
 * $0.21" when finished, and the stop reason otherwise.
 */
export function runProgressLabel(run: Pick<Run, "status" | "progress" | "cost_usd" | "kind">): string {
  const cost = run.cost_usd ? formatUsd(run.cost_usd) : "";
  if (run.status === "running" || run.status === "queued") {
    const steps = run.progress?.steps ?? [];
    const current = steps.find((s) => s.state === "running") ?? (run.status === "queued" ? null : steps.find((s) => s.state === "pending"));
    const label = current?.label ?? (run.status === "queued" ? "Waiting to start" : "Working");
    const total = run.progress?.total || steps.length;
    const done = run.progress?.done ?? steps.filter((s) => s.state === "done" || s.state === "skipped").length;
    const at = total ? ` · ${Math.min(done + (current ? 1 : 0), total)} of ${total}` : "";
    return [`${label}${at}`, cost].filter(Boolean).join(" · ");
  }
  const word = run.kind === "prefill" && run.status === "succeeded" ? "Draft ready" : (TERMINAL_WORD[run.status] ?? run.status);
  return [word, cost].filter(Boolean).join(" · ");
}

/** The next action for a stopped run. */
export function runNextAction(run: Pick<Run, "status" | "can_resume" | "error">): "resume" | "raise_limit" | "pick_identity" | "fix_key" | null {
  if (run.status === "capped") return "raise_limit";
  if (run.status === "blocked_identity") return "pick_identity";
  const code = run.error?.code ?? "";
  if (/key|unauthorized|401|402|credits/.test(code)) return "fix_key";
  if (run.can_resume) return "resume";
  return null;
}

/** "Researched Oct 13 · Claude Opus 5.5 · $0.21", or "Researched Oct 13" for an agent dossier. */
export function researchedLine(
  d: { created_at: string; cost_usd: number | null },
  author: { kind: string; label: string },
  today?: string,
): string {
  const day = formatDate(d.created_at.slice(0, 10), today);
  const parts = [`Researched ${day}`];
  if (author.kind === "model") {
    const m = modelName(author.label);
    if (m) parts.push(m);
    if (d.cost_usd) parts.push(formatUsd(d.cost_usd));
  }
  return parts.join(" · ");
}

/** The source's date as "Aug 14, 2026" for a citation title. */
export function citationTitle(c: Pick<Citation, "title" | "domain" | "published_at">, today?: string): string {
  return [c.title, c.domain, c.published_at ? formatDate(c.published_at, today) : null].filter(Boolean).join(" · ");
}
