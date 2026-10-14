/**
 * Pure rules for investor research in the web app (RESEARCH-PLAN §8), unit-tested in
 * `research.test.ts`: money for AI cost, freshness, the Meeting refresh offer, verdict words,
 * the dossier's fixed sections (R5) with numbered citations, "new since", suggestion lines,
 * estimate lines and run progress words.
 */

import type {
  Batch,
  Claim,
  DossierView,
  Estimate,
  Fact,
  FactSection,
  ResearchSummary,
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

/** The one way every screen says the monthly limit is used up. */
export function limitUsedLine(capUsdValue: number, spentUsd?: number | null): string {
  const spent = typeof spentUsd === "number" && spentUsd > 0 ? ` (${formatUsd(spentUsd)} spent)` : "";
  return `This month's ${capUsd(capUsdValue)} AI research limit is used up${spent}.`;
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

export const VERDICT_LABEL: Record<Verdict, string> = {
  strong: "Strong fit",
  possible: "Possible fit",
  poor: "Poor fit",
  unrated: "No fit verdict",
};

export function verdictLabel(v: Verdict | string | null | undefined): string {
  return v && v in VERDICT_LABEL ? VERDICT_LABEL[v as Verdict] : "";
}

/** The fit a verdict writes back (Hot stays a human call; `unrated` writes nothing). */
export function fitFromVerdict(v: Verdict | string | null | undefined): number {
  return v === "strong" ? 4 : v === "possible" ? 3 : v === "poor" ? 1 : 0;
}

/** The word for a confidence score (never a bare percentage). */
export function confidenceWord(c: number): "likely" | "possible" | "unlikely" {
  return c >= 0.8 ? "likely" : c >= 0.5 ? "possible" : "unlikely";
}

/**
 * How an identity candidate reads next to the others: "Likely match", "Possible match",
 * "Unlikely match" (never just "possible", which is a fit word), with the evidence that
 * tells candidates apart ("firm matches · LinkedIn found · 2 sources").
 */
export function candidateMatchLine(
  c: { confidence_label: string; firm: string | null; linkedin_url: string | null; firm_website: string | null; sources: readonly unknown[] },
  investorFirm?: string | null,
): { word: string; reasons: string } {
  const word = `${c.confidence_label.charAt(0).toUpperCase()}${c.confidence_label.slice(1)} match`;
  const norm = (x: string | null | undefined) => (x ?? "").toLowerCase().replace(/\b(ventures|capital|partners|vc|fund|llc|inc)\b/g, "").replace(/[^a-z0-9]/g, "");
  const reasons: string[] = [];
  if (investorFirm && c.firm) reasons.push(norm(investorFirm) === norm(c.firm) ? "firm matches" : "another firm");
  reasons.push(c.linkedin_url ? "LinkedIn found" : "no LinkedIn found");
  if (c.sources.length) reasons.push(plural(c.sources.length, "source"));
  return { word, reasons: reasons.join(" · ") };
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
  if (skipped.identified) parts.push(`${num(skipped.identified)} already ${skipped.identified === 1 ? "has an identity" : "have identities"}`);
  if (skipped.no_identity) parts.push(`${num(skipped.no_identity)} ${skipped.no_identity === 1 ? "needs" : "need"} a pick first (Is this them?)`);
  if (skipped.fresh) parts.push(`${num(skipped.fresh)} already ${skipped.fresh === 1 ? "has a" : "have"} recent ${skipped.fresh === 1 ? "dossier" : "dossiers"}`);
  if (skipped.active) parts.push(`${num(skipped.active)} already running`);
  if (skipped.suppressed) parts.push(`${num(skipped.suppressed)} asked not to be researched`);
  return parts.join(" · ");
}

/**
 * The money line of a bulk estimate, honest about free matches: "18 searches ≈ $0.13 each;
 * 19 already have a LinkedIn (free)".
 */
export function perRunLine(e: Pick<Estimate, "kind" | "count" | "free" | "paid" | "per_run_usd">): string {
  const free = e.free ?? 0;
  const paid = e.paid ?? e.count - free;
  const each = e.per_run_usd !== null ? ` ≈ ${formatUsd(e.per_run_usd)} each` : "";
  if (e.kind !== "identity") return `${num(e.count)} ${e.count === 1 ? "investor" : "investors"}${each}`;
  const head = `${num(paid)} ${paid === 1 ? "search" : "searches"}${paid ? each : ""}`;
  return free ? `${head}; ${num(free)} already ${free === 1 ? "has a LinkedIn" : "have a LinkedIn"} (free)` : head;
}

/** The latest run to show when nothing is running: one that stopped without a result. */
export function stoppedRun<R extends Pick<Run, "status" | "created_at" | "error"> & { kind?: string }>(
  runs: readonly R[],
  dossierAt?: string | null,
): R | null {
  const r = runs.find((x) => x.kind !== "agent" && x.kind !== "prefill");
  if (!r) return null;
  const stopped = r.status === "failed" || r.status === "partial" || r.status === "capped" || (r.status === "cancelled" && r.error && r.error.code !== "cancelled");
  if (!stopped) return null;
  if (dossierAt && Date.parse(dossierAt) >= Date.parse(r.created_at)) return null;
  return r;
}

/** "Only 23 fit under your $25 monthly limit." when the cap cuts a batch. */
export function overCapLine(e: Pick<Estimate, "count" | "fits">, capUsdValue: number): string | null {
  if (e.fits >= e.count) return null;
  if (e.fits <= 0) return `None fit under what is left of your ${capUsd(capUsdValue)} monthly limit.`;
  return `Only ${num(e.fits)} fit under your ${capUsd(capUsdValue)} monthly limit.`;
}

/* ---------- the round's AI research menu ---------- */

/**
 * Who in the round needs what, with the same rules as the API's estimate: matching someone
 * whose LinkedIn is on file is free; a dossier run skips those waiting for a pick or a
 * LinkedIn, and matches the identity first for those with none yet.
 */
export function researchCounts(
  ids: readonly string[],
  rows: Map<string, Pick<ResearchSummary, "identity_status" | "verdict">>,
  withLinkedin: ReadonlySet<string> = new Set(),
): {
  noIdentity: number;
  paidMatches: number;
  needsPick: number;
  notFound: number;
  withIdentity: number;
  researchable: number;
  needsIdentity: number;
  dossiers: number;
} {
  const out = { noIdentity: 0, paidMatches: 0, needsPick: 0, notFound: 0, withIdentity: 0, researchable: 0, needsIdentity: 0, dossiers: 0 };
  for (const id of ids) {
    const r = rows.get(id);
    const st = r?.identity_status ?? "none";
    if (st === "none" || st === "pending") {
      out.noIdentity++;
      if (!withLinkedin.has(id)) {
        out.paidMatches++;
        out.needsIdentity++;
      }
    }
    if (st === "needs_pick") out.needsPick++;
    if (st === "not_found" || st === "rejected") out.notFound++;
    if (st === "matched" || st === "confirmed") out.withIdentity++;
    if (st !== "needs_pick" && st !== "not_found" && st !== "rejected") out.researchable++;
    if (r?.verdict) out.dossiers++;
  }
  return out;
}

/* ---------- a finished batch ---------- */

const ERROR_WORD: Record<string, string> = {
  openrouter_key_rejected: "OpenRouter refused the key: replace it in Settings",
  openrouter_out_of_credits: "the OpenRouter account is out of credits",
  openrouter_unavailable: "OpenRouter did not answer",
  spend_cap_reached: "the monthly limit was reached",
  model_unavailable: "a model is no longer on OpenRouter",
  no_key: "the key was removed",
};

/**
 * How a batch ended, in words: "192 confirmed · 60 need a pick · 36 not found" for a match,
 * "37 done · 2 stopped at the limit" for research, plus the reason when runs failed together
 * (a refused key) and whether a person is needed now.
 */
export function batchOutcome(b: Pick<Batch, "kind" | "counts" | "identity" | "errors">): { line: string; needsYou: boolean; problem: string | null } {
  const c = b.counts;
  const id = b.identity ?? {};
  const pick = id.needs_pick ?? 0;
  const notFound = (id.not_found ?? 0) + (id.rejected ?? 0);
  const parts =
    b.kind === "identity"
      ? [
          (id.matched ?? 0) + (id.confirmed ?? 0) ? `${num((id.matched ?? 0) + (id.confirmed ?? 0))} matched` : "",
          pick ? `${num(pick)} need a pick` : "",
          notFound ? `${num(notFound)} not found` : "",
        ]
      : [c.succeeded ? `${num(c.succeeded)} done` : "", c.blocked_identity ? `${num(c.blocked_identity)} need a pick` : ""];
  parts.push(
    c.partial ? `${num(c.partial)} partial` : "",
    c.capped ? `${num(c.capped)} stopped at the limit` : "",
    c.failed ? `${num(c.failed)} failed` : "",
    c.cancelled ? `${num(c.cancelled)} cancelled` : "",
  );
  const errors = Object.entries(b.errors ?? {}).sort((x, y) => y[1] - x[1]);
  const top = errors[0];
  const problem = top && ERROR_WORD[top[0]] ? `${ERROR_WORD[top[0]]} (${top[0]})` : top ? top[0] : null;
  const needsYou = pick > 0 || notFound > 0 || (c.blocked_identity ?? 0) > 0;
  return { line: parts.filter(Boolean).join(" · ") || "nothing to do", needsYou, problem };
}

/* ---------- the pipeline's Research filter ---------- */

export const RESEARCH_FILTERS = [
  { value: "pick", label: "Needs a pick (Is this them?)" },
  { value: "notfound", label: "Not found: add their LinkedIn" },
  { value: "none", label: "No identity yet" },
  { value: "dossier", label: "Has a dossier" },
  { value: "stopped", label: "Research stopped" },
] as const;

/** Does an investor's research summary match the Research filter value? */
export function researchMatches(
  row: Pick<ResearchSummary, "identity_status" | "verdict" | "stopped_run"> | null | undefined,
  value: string,
): boolean {
  const st = row?.identity_status ?? "none";
  switch (value) {
    case "pick":
      return st === "needs_pick";
    case "notfound":
      return st === "not_found" || st === "rejected";
    case "none":
      return st === "none" || st === "pending";
    case "dossier":
      return Boolean(row?.verdict);
    case "stopped":
      return Boolean(row?.stopped_run);
    default:
      return true;
  }
}

/* ---------- runs ---------- */

/**
 * Why a run that should be going is not (shown under its progress): OpenRouter not
 * answering (it retries), or a run still waiting after a minute (no worker running).
 */
export function runStallHint(run: Pick<Run, "status" | "error" | "created_at" | "started_at">, now: Date): string | null {
  if (run.status === "running" && run.error) {
    return run.error.code === "openrouter_unavailable" || run.error.code === "openrouter_rate_limited"
      ? "OpenRouter is not answering right now. Raisebook retries on its own, waiting longer each time."
      : `The last call failed (${run.error.code}); Raisebook retries on its own.`;
  }
  if (run.status === "queued") {
    const since = Date.parse(run.started_at ?? run.created_at);
    if (!Number.isNaN(since) && now.getTime() - since > 60_000) {
      return "Not started after a minute. Research runs in a background worker: if this stays, the worker may not be running (self-hosting: start the worker service).";
    }
  }
  return null;
}

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
  if (run.status === "cancelled" && (run as Partial<Pick<Run, "error">>).error?.code === "no_key") {
    return "Stopped: the OpenRouter key was removed";
  }
  const word = run.kind === "prefill" && run.status === "succeeded" ? "Draft ready" : (TERMINAL_WORD[run.status] ?? run.status);
  return [word, cost].filter(Boolean).join(" · ");
}

/** The next action for a stopped run. */
export function runNextAction(run: Pick<Run, "status" | "can_resume" | "error">): "resume" | "raise_limit" | "pick_identity" | "fix_key" | null {
  if (run.status === "capped") return "raise_limit";
  if (run.status === "blocked_identity") return "pick_identity";
  const code = run.error?.code ?? "";
  if (/key|unauthorized|401|402|credits/.test(code) || code === "model_unavailable") return "fix_key";
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
