/**
 * Investor research (docs/RESEARCH-SPEC.md, RESEARCH-PLAN §6): AI settings and the OpenRouter
 * key, the company profile, runs, batches, identity, dossiers, suggestions, usage and the
 * public Research Policy removal form. Every function takes a client first (workspace-scoped,
 * except the public removal calls). Money is float USD; timestamps are RFC 3339 UTC.
 */

import { seg, type ApiClient } from "./client";
import type { DataList, Timestamp, UUID } from "./types";

/* ============================== shapes ============================== */

export type PresetId = "best" | "balanced" | "budget";
export type Preset = PresetId | "custom";
export type KeyStatus = "none" | "ok" | "unreadable";

export interface AiUsage {
  /** YYYY-MM in the workspace timezone. */
  month: string;
  spent_usd: number;
  reserved_usd: number;
  remaining_usd: number;
  calls: number;
  /** Dossier and refresh runs that cost something this month. */
  dossiers?: number;
  /** Identity matches that ran a model call this month. */
  matches?: number;
  /** Nothing is left under the monthly limit: paid research is off until it is raised. */
  cap_reached?: boolean;
}

export interface PresetInfo {
  id: PresetId;
  label: string;
  identity_model: string;
  search_model: string;
  writer_model: string;
  dossier_usd: number | null;
}

export interface AiSettings {
  has_key: boolean;
  key_status: KeyStatus;
  key_last4: string | null;
  key_label: string | null;
  key_set_at: Timestamp | null;
  key_validated_at: Timestamp | null;
  /** OpenRouter refused the saved key during research (saving it again clears this). */
  key_error?: "openrouter_key_rejected" | "openrouter_out_of_credits" | string | null;
  key_error_at?: Timestamp | null;
  preset: Preset;
  identity_model: string;
  search_model: string;
  writer_model: string;
  models_verified_at: Timestamp | null;
  monthly_cap_usd: number;
  usage: AiUsage;
  estimates: {
    best: number | null;
    balanced: number | null;
    budget: number | null;
    /** A dossier with the current models. */
    current: number | null;
    /** One identity match. */
    identity: number | null;
  };
  presets: PresetInfo[];
  /** The server has a key-encryption key; without it research cannot run here. */
  kek_configured: boolean;
  research_available: boolean;
  /** An owner signed in to the web: may save or remove the key. */
  can_manage_key: boolean;
  /** raisebook:admin: preset, models and the monthly limit. */
  can_edit: boolean;
}

export interface AiSettingsUpdate {
  preset?: PresetId;
  identity_model?: string;
  search_model?: string;
  writer_model?: string;
  monthly_cap_usd?: number;
}

export interface ResearchModel {
  id: string;
  name: string;
  prompt_per_mtok_usd: number;
  completion_per_mtok_usd: number;
  web_search_usd: number;
  context_length: number | null;
  supports_structured: boolean;
  supports_file: boolean;
  native_search: boolean;
}

export type CompanyStage = "pre-seed" | "seed" | "series-a" | "series-b+" | "other";
export type WantsLead = "lead" | "follow" | "either";

export interface CompanyProfileFields {
  pitch: string | null;
  sectors: string[];
  stage: CompanyStage | null;
  location: string | null;
  traction: string[];
  wants_lead: WantsLead | null;
  check_min: number | null;
  check_max: number | null;
  strategic_help: string | null;
  website_url: string | null;
}

export interface CompanyProfile extends CompanyProfileFields {
  /** The workspace currency; the check range is in whole units of it. */
  currency: string;
  deck_filename: string | null;
  prefilled_at: Timestamp | null;
  updated_at: Timestamp | null;
  is_empty: boolean;
}

export type RunKind = "identity" | "dossier" | "refresh" | "prefill" | "agent";
export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "capped"
  | "blocked_identity";
export type StepState = "pending" | "running" | "done" | "skipped" | "failed";

export interface RunStep {
  key: string;
  label: string;
  state: StepState;
}

export interface Run {
  id: UUID;
  investor_id: UUID | null;
  round_id: UUID | null;
  batch_id: UUID | null;
  kind: RunKind;
  status: RunStatus;
  preset: string | null;
  models: { identity: string | null; search: string | null; writer: string | null };
  estimate_usd: number | null;
  cost_usd: number | null;
  progress: {
    step?: string | null;
    steps: RunStep[];
    done: number;
    total: number;
    sources_accepted?: number | null;
    privacy_removed?: number | null;
  };
  error: { code: string; message: string | null } | null;
  dossier_id: UUID | null;
  result: Record<string, unknown> | null;
  sources: { gathered: number; accepted: number };
  can_resume: boolean;
  by: { type: string; label: string | null; via: string };
  created_at: Timestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

export interface RunStarted {
  run: Run;
  estimate_usd: number | null;
  created: boolean;
}

export type IdentityStatus = "none" | "pending" | "matched" | "confirmed" | "needs_pick" | "not_found" | "rejected";

export interface CandidateSource {
  id: UUID;
  url: string;
  domain: string;
  title: string | null;
}

export interface Candidate {
  id: UUID;
  rank: number;
  name: string;
  title: string | null;
  firm: string | null;
  linkedin_url: string | null;
  firm_website: string | null;
  confidence: number;
  confidence_label: "likely" | "possible" | "unlikely";
  picked: boolean | null;
  sources: CandidateSource[];
}

export interface Identity {
  investor_id: UUID;
  status: IdentityStatus;
  source: string | null;
  linkedin_url: string | null;
  firm: string | null;
  firm_website: string | null;
  title: string | null;
  confidence: number | null;
  confirmed_at: Timestamp | null;
  candidates: Candidate[];
  active_run: { id: UUID; kind: string; status: string } | null;
}

/** Exactly one of these per pick (`linkedin_url` may carry `firm_website` and `title`). */
export type IdentityPick =
  | { candidate_id: UUID }
  | { rank: number }
  | { none: true }
  | { linkedin_url: string; firm_website?: string; title?: string };

/** `unrated`: written without a company profile, so there is no fit verdict. */
export type Verdict = "strong" | "possible" | "poor" | "unrated";
export type FactSection = "profile" | "fit" | "activity" | "thesis" | "red_flags";

export interface Claim {
  text: string;
  fact_keys?: string[];
}

export interface DossierAnalysis {
  brief: {
    verdict: Verdict;
    why: string;
    best_way_in?: string;
    opener?: string;
    risk?: string;
    fact_keys?: string[];
  };
  fit?: {
    stage?: Claim | null;
    sector?: Claim | null;
    check?: Claim | null;
    deploying?: Claim | null;
    conflicts?: Claim[];
  };
  ways_in?: (Claim & { basis?: "public" | "workspace" })[];
  talking_points?: Claim[];
}

export interface Dossier {
  id: UUID;
  investor_id: UUID;
  version: number;
  schema_version: number;
  verdict: Verdict;
  analysis: DossierAnalysis;
  unverified: { section: FactSection; text: string }[];
  new_fact_keys: string[];
  round_id: UUID | null;
  run_id: UUID | null;
  created_at: Timestamp;
  as_of: string | null;
  identity: Record<string, unknown>;
  cost_usd: number | null;
}

export interface Fact {
  key: string;
  section: FactSection;
  kind: string;
  text: string;
  date: string | null;
  source_ids: string[];
}

export interface Source {
  id: UUID;
  url: string;
  domain: string;
  title: string | null;
  published_at: string | null;
  matched_anchor: string | null;
}

export interface DossierAuthor {
  kind: "model" | "agent";
  label: string;
  /** "by claude-code" for agent dossiers. */
  by: string | null;
}

export type SuggestionStatus = "pending" | "accepted" | "ignored" | "superseded" | "auto_applied";

export interface Suggestion {
  id: UUID;
  investor_id: UUID;
  round_id: UUID | null;
  dossier_id: UUID | null;
  field: string;
  current_value: unknown;
  suggested_value: unknown;
  status: SuggestionStatus;
  created_at: Timestamp;
  decided_at: Timestamp | null;
}

export interface DossierView {
  dossier: Dossier;
  facts: Fact[];
  sources: Source[];
  author: DossierAuthor;
  /** The previous version's date: its `new_fact_keys` lead ("New since Oct 1"). */
  new_since: Timestamp | null;
  stale: boolean;
  age_days: number;
  refresh_offer: boolean;
  suggestions: Suggestion[];
}

export interface DossierVersion {
  id: UUID;
  version: number;
  verdict: Verdict;
  created_at: Timestamp;
  author: DossierAuthor;
}

export interface EstimateRequest {
  kind: "identity" | "dossier";
  investor_ids?: UUID[];
  round?: string;
}

export interface Estimate {
  kind: "identity" | "dossier";
  count: number;
  /** Of `count`, need no model call (their LinkedIn is already known). */
  free?: number;
  /** Of `count`, need a model call at `per_run_usd`. */
  paid?: number;
  /** `fresh`: a dossier from the last 30 days; `identified`: identity already confirmed. */
  skipped: { no_identity?: number; suppressed?: number; fresh?: number; identified?: number; active?: number };
  per_run_usd: number | null;
  total_usd: number | null;
  remaining_usd: number | null;
  fits: number;
  /** Dossier runs that match the identity first (and stop to ask when unsure). */
  needs_identity?: number;
  /** No company profile: dossiers would have no fit verdict. */
  no_profile?: boolean;
  /** `fit`: a round's investors, best fit first (who goes first under the limit). */
  order?: "fit" | "given";
}

export interface Batch {
  id: UUID;
  kind: string;
  round_id: UUID | null;
  total: number;
  counts: Partial<Record<RunStatus, number>>;
  active: number;
  /** Identity outcomes now: needs_pick and not_found need a person. */
  identity?: Partial<Record<IdentityStatus, number>>;
  /** Stopped runs by error code ("openrouter_key_rejected": 114). */
  errors?: Record<string, number>;
  estimate_usd: number | null;
  spent_usd: number | null;
  created_at: Timestamp;
}

export interface ResearchSummary {
  identity_status: IdentityStatus;
  verdict: Verdict | null;
  dossier_at: Timestamp | null;
  dossier_author: { kind?: string; label?: string; by?: string } | null;
  stale: boolean;
  pending_suggestions: number;
  active_run: { id: UUID; kind: RunKind; status: RunStatus } | null;
  /** The last run, when it stopped without a result and nothing newer replaced it. */
  stopped_run?: { id: UUID; kind: RunKind; status: RunStatus; error_code: string | null } | null;
  refresh_offer: boolean;
  /** Fields whose value research filled in. */
  from_research: string[];
}

export interface RoundResearchRow extends ResearchSummary {
  investor_id: UUID;
}

export interface UsageReport {
  month: string;
  spent_usd: number | null;
  reserved_usd: number | null;
  calls: number;
  cap_usd: number | null;
  remaining_usd: number | null;
  by_kind: Record<string, { runs: number; cost_usd: number | null }>;
}

/* ============================== settings and key ============================== */

export const getAiSettings = (c: ApiClient) => c.get<AiSettings>("/v1/workspace/ai-settings");

/** Owner signed in to the web. OpenRouter checks the key first (422 when it refuses it). */
export const saveAiKey = (c: ApiClient, key: string) => c.put<AiSettings>("/v1/workspace/ai-settings/key", { key });

/** Owner signed in. Deletes the key now; queued research is cancelled. */
export const removeAiKey = (c: ApiClient) => c.del<void>("/v1/workspace/ai-settings/key");

/** raisebook:admin. Model ids by hand make the preset `custom`. */
export const updateAiSettings = (c: ApiClient, body: AiSettingsUpdate) =>
  c.patch<AiSettings>("/v1/workspace/ai-settings", body);

export const listResearchModels = (c: ApiClient) => c.get<DataList<ResearchModel>>("/v1/research/models");

export const getResearchUsage = (c: ApiClient, month?: string) =>
  c.get<UsageReport>("/v1/research/usage", { month });

/* ============================== company profile ============================== */

export const getCompanyProfile = (c: ApiClient) => c.get<CompanyProfile>("/v1/workspace/company-profile");

export const putCompanyProfile = (c: ApiClient, body: CompanyProfileFields) =>
  c.put<CompanyProfile>("/v1/workspace/company-profile", body);

/** The multipart body for a prefill: a website URL and/or a deck PDF. */
export function prefillForm(input: { websiteUrl?: string | null; deck?: Blob | null; deckName?: string | null }): FormData {
  const form = new FormData();
  const url = input.websiteUrl?.trim();
  if (url) form.append("website_url", url);
  if (input.deck) form.append("deck", input.deck, input.deckName ?? "deck.pdf");
  return form;
}

/** 202: poll the run; the draft is in `run.result.draft` and nothing is saved until a PUT. */
export const prefillCompanyProfile = (c: ApiClient, input: { websiteUrl?: string | null; deck?: Blob | null; deckName?: string | null }) =>
  c.post<RunStarted>("/v1/workspace/company-profile/prefill", prefillForm(input));

/* ============================== runs ============================== */

/**
 * 202 (200 when the same run was already going). 422 `no_ai_key` / `spend_cap_reached`, 409
 * `identity_required` / `research_suppressed`, 503 `research_unavailable`.
 */
export const startResearch = (
  c: ApiClient,
  investorId: UUID,
  body: { kind?: "identity" | "dossier" | "refresh"; round?: string } = {},
) => c.post<RunStarted>(`/v1/investors/${seg(investorId)}/research`, body);

export const listRuns = (
  c: ApiClient,
  q: { investor_id?: UUID; batch_id?: UUID; status?: RunStatus; kind?: RunKind; limit?: number; cursor?: string } = {},
) => c.get<{ data: Run[]; next_cursor: string | null }>("/v1/research/runs", q);

export const getRun = (c: ApiClient, id: UUID, signal?: AbortSignal) =>
  c.get<Run>(`/v1/research/runs/${seg(id)}`, undefined, { signal });

export const cancelRun = (c: ApiClient, id: UUID) => c.post<Run>(`/v1/research/runs/${seg(id)}/cancel`);

/** Only failed, partial or capped runs; finished steps are skipped and not charged again. */
export const resumeRun = (c: ApiClient, id: UUID) => c.post<Run>(`/v1/research/runs/${seg(id)}/resume`);

/* ============================== bulk ============================== */

/** Body for estimate and batch calls: explicit ids win over a whole round. */
export function bulkTarget(target: { investorIds?: readonly UUID[] | null; round?: string | null }): {
  investor_ids?: UUID[];
  round?: string;
} {
  if (target.investorIds && target.investorIds.length) return { investor_ids: [...target.investorIds] };
  if (target.round) return { round: target.round };
  return {};
}

/** The body of `POST /v1/research/batches`: the total the person saw, rounded to cents. */
export function batchBody(
  kind: "identity" | "dossier",
  target: { investorIds?: readonly UUID[] | null; round?: string | null },
  confirmUsd: number,
  allowPartial = false,
): { kind: "identity" | "dossier"; investor_ids?: UUID[]; round?: string; confirm_usd: number; allow_partial?: boolean } {
  return {
    kind,
    ...bulkTarget(target),
    confirm_usd: Math.round(Math.max(0, confirmUsd) * 1e6) / 1e6,
    ...(allowPartial ? { allow_partial: true } : {}),
  };
}

export const estimateResearch = (
  c: ApiClient,
  kind: "identity" | "dossier",
  target: { investorIds?: readonly UUID[] | null; round?: string | null },
) => c.post<Estimate>("/v1/research/estimate", { kind, ...bulkTarget(target) });

/**
 * 202. 409 `estimate_changed` carries the new total in `details.total_usd`; 422
 * `spend_cap_reached` carries `details.fits` and `details.count` when not all fit.
 */
export const startBatch = (c: ApiClient, body: ReturnType<typeof batchBody>) =>
  c.post<{ batch: Batch; runs: number }>("/v1/research/batches", body);

export const getBatch = (c: ApiClient, id: UUID, signal?: AbortSignal) =>
  c.get<Batch>(`/v1/research/batches/${seg(id)}`, undefined, { signal });

export const cancelBatch = (c: ApiClient, id: UUID) => c.post<{ cancelled: number }>(`/v1/research/batches/${seg(id)}/cancel`);

/* ============================== identity ============================== */

export const getIdentity = (c: ApiClient, investorId: UUID) => c.get<Identity>(`/v1/investors/${seg(investorId)}/identity`);

export const pickIdentity = (c: ApiClient, investorId: UUID, pick: IdentityPick) =>
  c.post<Identity>(`/v1/investors/${seg(investorId)}/identity`, pick);

/* ============================== dossiers ============================== */

/** 404 `no_dossier` when there is none yet. */
export const getDossier = (c: ApiClient, investorId: UUID, version?: number) =>
  c.get<DossierView>(`/v1/investors/${seg(investorId)}/dossier`, { version });

export const listDossierVersions = (c: ApiClient, investorId: UUID) =>
  c.get<DataList<DossierVersion>>(`/v1/investors/${seg(investorId)}/dossiers`);

/* ============================== suggestions ============================== */

export const listSuggestions = (c: ApiClient, q: { investor_id?: UUID; round?: string; status?: SuggestionStatus } = {}) =>
  c.get<{ data: Suggestion[] }>("/v1/research/suggestions", q);

/** Accepting a check size accepts both min and max. */
export const acceptSuggestion = (c: ApiClient, id: UUID) => c.post<Suggestion>(`/v1/research/suggestions/${seg(id)}/accept`);

export const ignoreSuggestion = (c: ApiClient, id: UUID) => c.post<Suggestion>(`/v1/research/suggestions/${seg(id)}/ignore`);

export const acceptAllSuggestions = (c: ApiClient, target: { investorIds?: readonly UUID[] | null; round?: string | null }) =>
  c.post<{ accepted: number; skipped: { id?: string; reason?: string }[]; bulk_id: UUID }>(
    "/v1/research/suggestions/accept-all",
    bulkTarget(target),
  );

/* ============================== round view ============================== */

export const roundResearch = (c: ApiClient, round: string) =>
  c.get<DataList<RoundResearchRow>>(`/v1/rounds/${seg(round)}/research`);

/* ============================== Research Policy (public) ============================== */

export interface RemovalRequest {
  name: string;
  email: string;
  linkedin_url?: string;
  firm?: string;
  message?: string;
}

/** Always 202: the answer never says whether anything is stored about the person. */
export const requestRemoval = (c: ApiClient, body: RemovalRequest) =>
  c.post<{ ok: boolean; message: string }>("/v1/research-policy/removal-requests", body, { workspace: null });

/** 200, or 400 `invalid_token`. */
export const verifyRemoval = (c: ApiClient, token: string) =>
  c.post<{ ok: boolean; message: string }>("/v1/research-policy/removal-requests/verify", { token }, { workspace: null });
