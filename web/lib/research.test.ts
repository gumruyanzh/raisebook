import assert from "node:assert/strict";
import { test } from "node:test";

import type { DossierView, Suggestion } from "./api/research";
import {
  approxUsd,
  capUsd,
  confidenceWord,
  estimateLine,
  fitFromVerdict,
  formatUsd,
  groupSuggestions,
  isStale,
  modelName,
  newSince,
  overCapLine,
  refreshOffer,
  researchedLine,
  runNextAction,
  runProgressLabel,
  sectionsOf,
  skippedLine,
  suggestionLine,
  verdictLabel,
  batchOutcome,
  candidateMatchLine,
  limitUsedLine,
  perRunLine,
  researchCounts,
  researchMatches,
  runStallHint,
  stoppedRun,
} from "./research";

const NOW = new Date("2026-10-13T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

test("formatUsd: cents, under a cent, thousands, empty for null", () => {
  assert.equal(formatUsd(0.19), "$0.19");
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(25), "$25.00");
  assert.equal(formatUsd(1240.5), "$1,240.50");
  assert.equal(formatUsd(null), "");
  assert.equal(approxUsd(0.2), "≈ $0.20");
  assert.equal(approxUsd(null), "");
  assert.equal(capUsd(25), "$25");
  assert.equal(capUsd(12.5), "$12.50");
});

test("isStale after 90 days; refreshOffer only on meeting and past 30 days", () => {
  assert.equal(isStale(daysAgo(89), NOW), false);
  assert.equal(isStale(daysAgo(91), NOW), true);
  assert.equal(isStale(null, NOW), false);
  assert.equal(refreshOffer("meeting", daysAgo(31), NOW), true);
  assert.equal(refreshOffer("meeting", daysAgo(29), NOW), false);
  assert.equal(refreshOffer("diligence", daysAgo(120), NOW), false);
  assert.equal(refreshOffer("meeting", null, NOW), false);
});

test("verdict words and the fit they write back (Hot stays human)", () => {
  assert.equal(verdictLabel("strong"), "Strong fit");
  assert.equal(verdictLabel("poor"), "Poor fit");
  assert.equal(verdictLabel(null), "");
  assert.deepEqual(["strong", "possible", "poor", null].map(fitFromVerdict), [4, 3, 1, 0]);
  assert.deepEqual([0.9, 0.6, 0.2].map(confidenceWord), ["likely", "possible", "unlikely"]);
});

test("modelName reads like a product name", () => {
  assert.equal(modelName("anthropic/claude-opus-5.5"), "Claude Opus 5.5");
  assert.equal(modelName("perplexity/sonar-pro"), "Sonar Pro");
  assert.equal(modelName("google/gemini-3.8-flash"), "Gemini 3.8 Flash");
  assert.equal(modelName(null), "");
});

function view(over: Partial<DossierView> = {}): DossierView {
  return {
    dossier: {
      id: "d2",
      investor_id: "i1",
      version: 2,
      schema_version: 1,
      verdict: "strong",
      analysis: {
        brief: { verdict: "strong", why: "Leads seed robotics rounds.", fact_keys: ["f4", "f1"] },
        fit: { stage: { text: "Seed is her core stage.", fact_keys: ["f4"] }, conflicts: [{ text: "Brightquay is adjacent.", fact_keys: ["f1"] }] },
        ways_in: [
          { text: "Brightquay's founders know her.", basis: "public", fact_keys: ["f1"] },
          { text: "Ines Calloway co-invested with her.", basis: "workspace", fact_keys: [] },
        ],
        talking_points: [{ text: "Lead with the warehouse pilots.", fact_keys: ["f3"] }],
      },
      unverified: [],
      new_fact_keys: ["f1"],
      round_id: null,
      run_id: "r1",
      created_at: "2026-10-13T10:00:00Z",
      as_of: "2026-10-13",
      identity: {},
      cost_usd: 0.21,
    },
    facts: [
      { key: "f1", section: "activity", kind: "deal", text: "Led Brightquay's $3M seed.", date: "2026-08-14", source_ids: ["s-a"] },
      { key: "f2", section: "activity", kind: "deal", text: "Joined Kelpline's pre-seed.", date: "2026-05-02", source_ids: ["s-b"] },
      { key: "f3", section: "thesis", kind: "podcast", text: "Backs robotics founders early.", date: null, source_ids: ["s-c"] },
      { key: "f4", section: "fit", kind: "check_size", text: "Invests $250k to $1M at seed.", date: null, source_ids: ["s-d"] },
      { key: "f5", section: "profile", kind: "role", text: "Partner at Harbor Light Ventures.", date: null, source_ids: ["s-d"] },
    ],
    sources: [
      { id: "s-a", url: "https://harborlight.example/news/brightquay", domain: "harborlight.example", title: "Brightquay seed", published_at: "2026-08-14", matched_anchor: "firm_domain" },
      { id: "s-b", url: "https://news.example/kelpline", domain: "news.example", title: null, published_at: null, matched_anchor: "name_firm" },
      { id: "s-c", url: "https://podcast.example/42", domain: "podcast.example", title: "Episode 42", published_at: null, matched_anchor: "name_firm" },
      { id: "s-d", url: "https://harborlight.example/about", domain: "harborlight.example", title: "About", published_at: null, matched_anchor: "firm_domain" },
    ],
    author: { kind: "model", label: "anthropic/claude-opus-5.5", by: null },
    new_since: "2026-09-01T10:00:00Z",
    stale: false,
    age_days: 0,
    refresh_offer: false,
    suggestions: [],
    ...over,
  };
}

test("sectionsOf: fixed order, citations numbered in reading order, newest deals first", () => {
  const { sections, citations, briefCites } = sectionsOf(view());
  assert.deepEqual(
    sections.map((s) => s.key),
    ["fit", "activity", "thesis", "ways_in", "talking_points"],
  );
  // The Brief cites f4 (s-d) then f1 (s-a): they are [1] and [2].
  assert.deepEqual(briefCites, [1, 2]);
  assert.deepEqual(
    citations.map((c) => c.id),
    ["s-d", "s-a", "s-b", "s-c"],
  );
  const fit = sections[0]!;
  assert.equal(fit.lines[0]!.lead, "Stage");
  assert.equal(fit.lines[1]!.lead, "Conflict");
  // The profile fact is not cited by the assessment, so it joins Fit.
  assert.ok(fit.lines.some((l) => l.text.startsWith("Partner at")));
  const activity = sections[1]!;
  assert.deepEqual(
    activity.lines.map((l) => l.date),
    ["2026-08-14", "2026-05-02"],
  );
  assert.equal(activity.lines[0]!.isNew, true);
  assert.equal(activity.lines[1]!.isNew, false);
  const ways = sections[3]!;
  assert.equal(ways.lines[1]!.workspace, true);
  assert.deepEqual(ways.lines[1]!.cites, []);
});

test("newSince: only after a refresh", () => {
  assert.deepEqual([...newSince(view())], ["f1"]);
  assert.equal(newSince(view({ new_since: null })).size, 0);
});

const sug = (field: string, current: unknown, suggested: unknown, id = field): Suggestion => ({
  id,
  investor_id: "i1",
  round_id: null,
  dossier_id: "d1",
  field,
  current_value: current,
  suggested_value: suggested,
  status: "pending",
  created_at: "2026-10-13T10:00:00Z",
  decided_at: null,
});

test("suggestionLine: check pairs read as one range, fit uses words", () => {
  const groups = groupSuggestions([sug("check_min", 50000, 250000), sug("check_max", 250000, 1000000), sug("title", "Partner", "General Partner")]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]!.ids, ["check_min", "check_max"]);
  assert.equal(suggestionLine(groups[0]!), "Research says check $250k–$1M (you have $50k–$250k)");
  assert.equal(suggestionLine(groups[1]!), "Research says title General Partner (you have Partner)");
  const [fit] = groupSuggestions([{ ...sug("fit", 3, 4), round_id: "r1" }]);
  assert.equal(suggestionLine(fit!), "Research: Strong fit (you have Maybe)");
  const [focus] = groupSuggestions([sug("stage_focus", ["pre-seed"], ["pre-seed", "seed"])]);
  assert.equal(suggestionLine(focus!), "Research says stage focus Pre-seed, Seed (you have Pre-seed)");
  const [li] = groupSuggestions([sug("linkedin_url", null, "https://www.linkedin.com/in/example-dana/")]);
  assert.equal(suggestionLine(li!), "Research says LinkedIn linkedin.com/in/example-dana");
});

test("estimateLine, skippedLine and overCapLine", () => {
  assert.equal(estimateLine({ kind: "dossier", count: 37, total_usd: 7.4 }), "Research 37 investors ≈ $7.40");
  assert.equal(estimateLine({ kind: "identity", count: 411, total_usd: 2.9 }), "Match 411 identities ≈ $2.90");
  assert.equal(estimateLine({ kind: "dossier", count: 40, total_usd: 8 }, 20), "Research 20 investors ≈ $4.00");
  assert.equal(estimateLine({ kind: "dossier", count: 1, total_usd: null }), "Research 1 investor");
  assert.equal(
    skippedLine({ no_identity: 12, fresh: 1, active: 0, suppressed: 2 }),
    "12 need a pick first (Is this them?) · 1 already has a recent dossier · 2 asked not to be researched",
  );
  // An identity run's left-outs already have an identity; they are not "recent dossiers".
  assert.equal(skippedLine({ identified: 3 }), "3 already have identities");
  assert.equal(skippedLine({}), "");
  assert.equal(overCapLine({ count: 37, fits: 23 }, 25), "Only 23 fit under your $25 monthly limit.");
  assert.equal(overCapLine({ count: 5, fits: 5 }, 25), null);
  assert.equal(overCapLine({ count: 5, fits: 0 }, 25), "None fit under what is left of your $25 monthly limit.");
});

test("runProgressLabel and runNextAction", () => {
  const steps = [
    { key: "identity", label: "Finding who this is", state: "done" as const },
    { key: "search:activity", label: "Searching recent deals", state: "running" as const },
    { key: "write", label: "Writing", state: "pending" as const },
  ];
  assert.equal(
    runProgressLabel({ status: "running", kind: "dossier", cost_usd: 0.03, progress: { steps, done: 1, total: 3 } }),
    "Searching recent deals · 2 of 3 · $0.03",
  );
  assert.equal(runProgressLabel({ status: "queued", kind: "dossier", cost_usd: null, progress: { steps: [], done: 0, total: 0 } }), "Waiting to start");
  assert.equal(runProgressLabel({ status: "succeeded", kind: "dossier", cost_usd: 0.21, progress: { steps, done: 3, total: 3 } }), "Done · $0.21");
  assert.equal(runProgressLabel({ status: "capped", kind: "dossier", cost_usd: 0.05, progress: { steps, done: 1, total: 3 } }), "Stopped at your monthly limit · $0.05");
  assert.equal(runNextAction({ status: "capped", can_resume: true, error: null }), "raise_limit");
  assert.equal(runNextAction({ status: "blocked_identity", can_resume: false, error: null }), "pick_identity");
  assert.equal(runNextAction({ status: "failed", can_resume: true, error: { code: "openrouter_key_invalid", message: null } }), "fix_key");
  assert.equal(runNextAction({ status: "partial", can_resume: true, error: { code: "writer_invalid", message: null } }), "resume");
  assert.equal(runNextAction({ status: "succeeded", can_resume: false, error: null }), null);
});

test("researchedLine: model dossiers name the writer and cost; agent ones do not", () => {
  assert.equal(
    researchedLine({ created_at: "2026-10-13T10:00:00Z", cost_usd: 0.21 }, { kind: "model", label: "anthropic/claude-opus-5.5" }, "2026-10-13"),
    "Researched Oct 13 · Claude Opus 5.5 · $0.21",
  );
  assert.equal(researchedLine({ created_at: "2026-10-01T10:00:00Z", cost_usd: null }, { kind: "agent", label: "claude-code" }, "2026-10-13"), "Researched Oct 1");
});


/* ---------- verification-pass regressions ---------- */

test("researchCounts: the menu agrees with the estimate (LinkedIn on file is free; picks wait)", () => {
  const rows = new Map([
    ["a", { identity_status: "none" as const, verdict: null }],
    ["b", { identity_status: "none" as const, verdict: null }],
    ["c", { identity_status: "needs_pick" as const, verdict: null }],
    ["d", { identity_status: "not_found" as const, verdict: null }],
    ["e", { identity_status: "confirmed" as const, verdict: "strong" as const }],
  ]);
  const c = researchCounts(["a", "b", "c", "d", "e", "f"], rows, new Set(["a"]));
  assert.equal(c.noIdentity, 3); // a, b and f (no row yet)
  assert.equal(c.paidMatches, 2); // a has a LinkedIn: free
  assert.equal(c.needsPick, 1);
  assert.equal(c.notFound, 1);
  assert.equal(c.researchable, 4); // everyone but c and d, like POST /research/estimate
  assert.equal(c.needsIdentity, 2);
  assert.equal(c.dossiers, 1);
});

test("researchMatches: the Research filter finds who needs a pick or a LinkedIn", () => {
  assert.equal(researchMatches({ identity_status: "needs_pick", verdict: null }, "pick"), true);
  assert.equal(researchMatches({ identity_status: "rejected", verdict: null }, "notfound"), true);
  assert.equal(researchMatches({ identity_status: "matched", verdict: null }, "pick"), false);
  assert.equal(researchMatches(undefined, "none"), true);
  assert.equal(researchMatches({ identity_status: "confirmed", verdict: "poor", stopped_run: null }, "dossier"), true);
  assert.equal(
    researchMatches({ identity_status: "confirmed", verdict: null, stopped_run: { id: "r", kind: "dossier", status: "failed", error_code: "x" } }, "stopped"),
    true,
  );
});

test("batchOutcome: a match batch says who needs a pick; a refused key says why", () => {
  const m = batchOutcome({
    kind: "identity",
    counts: { succeeded: 411 },
    identity: { matched: 123, confirmed: 192, needs_pick: 60, not_found: 36 },
    errors: {},
  });
  assert.equal(m.line, "315 matched · 60 need a pick · 36 not found");
  assert.equal(m.needsYou, true);
  const k = batchOutcome({ kind: "dossier", counts: { failed: 114 }, identity: {}, errors: { openrouter_key_rejected: 114 } });
  assert.equal(k.line, "114 failed");
  assert.match(k.problem ?? "", /OpenRouter refused the key/);
});

test("perRunLine: free matches are said, not hidden in the average", () => {
  assert.equal(perRunLine({ kind: "identity", count: 411, free: 192, paid: 219, per_run_usd: 0.007 }), "219 searches ≈ $0.01 each; 192 already have a LinkedIn (free)");
  assert.equal(perRunLine({ kind: "dossier", count: 38, per_run_usd: 0.21 }), "≈ $0.21 each");
  assert.equal(perRunLine({ kind: "dossier", count: 38, per_run_usd: null }), "");
});

test("stoppedRun: a failed, partial or capped run stays visible until a newer dossier", () => {
  const failed = { kind: "dossier", status: "failed" as const, created_at: "2026-10-12T10:00:00Z", error: { code: "openrouter_unavailable", message: "x" } };
  assert.equal(stoppedRun([failed]), failed);
  assert.equal(stoppedRun([failed], "2026-10-12T11:00:00Z"), null);
  assert.equal(stoppedRun([{ ...failed, status: "cancelled" as const, error: { code: "cancelled", message: null } }]), null);
  assert.equal(stoppedRun([{ ...failed, status: "succeeded" as const, error: null }]), null);
});

test("runStallHint: OpenRouter down while retrying, or no worker after a minute", () => {
  const base = { created_at: daysAgo(0), started_at: null, error: null };
  assert.match(runStallHint({ ...base, status: "running", error: { code: "openrouter_unavailable", message: "busy" } }, NOW) ?? "", /retries/);
  assert.equal(runStallHint({ ...base, status: "queued" }, NOW), null);
  assert.match(runStallHint({ ...base, status: "queued", created_at: new Date(NOW.getTime() - 120_000).toISOString() }, NOW) ?? "", /worker/);
});

test("candidateMatchLine: a match word, never the fit word alone, with what tells them apart", () => {
  const c = { confidence_label: "possible", firm: "Lodestar Collective", linkedin_url: null, firm_website: "https://lodestar.example", sources: [1, 2] };
  const out = candidateMatchLine(c, "Lodestar Collective");
  assert.equal(out.word, "Possible match");
  assert.equal(out.reasons, "firm matches · no LinkedIn found · 2 sources");
});

test("unrated verdicts and the spend-limit sentence", () => {
  assert.equal(verdictLabel("unrated"), "No fit verdict");
  assert.equal(fitFromVerdict("unrated"), 0);
  assert.equal(limitUsedLine(13, 13.3), "This month's $13 AI research limit is used up ($13.30 spent).");
});
