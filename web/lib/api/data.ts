/**
 * Imports and exports (SPEC §5.8). Owner: Import-Export+Ops. Every function takes a
 * workspace-scoped client first (`useWorkspace().client` or `await serverApi(slug)`).
 */

import { seg, type ApiClient } from "./client";
import type { DataList, Timestamp, UUID } from "./types";

export type ImportFormat = "csv" | "prototype_json";
export type OnDuplicate = "skip" | "fill_empty" | "update";
export type RowAction = "create" | "update" | "skip" | "error";
export type MatchedOn = "email" | "linkedin" | "name_firm";

export type ImportField =
  | "name"
  | "first_name"
  | "last_name"
  | "firm"
  | "title"
  | "type"
  | "email"
  | "linkedin_url"
  | "website_url"
  | "x_url"
  | "location"
  | "check_note"
  | "check_min"
  | "check_max"
  | "stage_focus"
  | "industries"
  | "tags"
  | "notes"
  | "source"
  | "warm_intro_by"
  | "stage"
  | "fit"
  | "follow_up_on"
  | "follow_up_note"
  | "amount_soft"
  | "amount_committed"
  | "probability"
  | "next_step"
  | "owner_email"
  | "last_contacted";

/** Contact fields, in picker order (labels match backend `csv_io.FIELD_LABELS`). */
export const CONTACT_FIELDS: ReadonlyArray<[ImportField, string]> = [
  ["name", "Name"],
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["firm", "Firm"],
  ["title", "Title"],
  ["type", "Investor type"],
  ["email", "Email"],
  ["linkedin_url", "LinkedIn"],
  ["website_url", "Website"],
  ["x_url", "X / Twitter"],
  ["location", "Location"],
  ["check_note", "Check size"],
  ["check_min", "Check min"],
  ["check_max", "Check max"],
  ["stage_focus", "Stage focus"],
  ["industries", "Industries"],
  ["tags", "Tags"],
  ["notes", "Notes"],
  ["source", "Source"],
  ["warm_intro_by", "Warm intro by"],
];

/** Round fields: only apply when a round is chosen. */
export const ROUND_FIELDS: ReadonlyArray<[ImportField, string]> = [
  ["stage", "Pipeline stage"],
  ["fit", "Fit (0-5)"],
  ["follow_up_on", "Follow up on"],
  ["follow_up_note", "Follow-up note"],
  ["amount_soft", "Soft amount"],
  ["amount_committed", "Committed amount"],
  ["probability", "Probability %"],
  ["next_step", "Next step"],
  ["owner_email", "Owner email"],
  ["last_contacted", "Last contacted (dated note)"],
];

export const ROUND_FIELD_SET: ReadonlySet<string> = new Set(ROUND_FIELDS.map(([f]) => f));

export interface RoundMapEntry {
  source_key: string;
  round: string;
  fit_field?: string | null;
}

export interface ImportRequest {
  format: ImportFormat;
  content: string;
  filename?: string | null;
  mapping?: Record<string, ImportField | null> | null;
  round?: string | null;
  default_stage?: string | null;
  on_duplicate?: OnDuplicate;
  source?: string | null;
  round_map?: RoundMapEntry[] | null;
  /** Cell text → Raisebook value, per field: {stage: {"Intro requested": "contacted"}}. */
  value_map?: Record<string, Record<string, string>> | null;
}

/** Per CSV column: empty cells, and cells that could not be read (left empty). */
export interface ColumnStats {
  empty: number;
  unreadable: number;
}

/** A distinct value of a stage or fit column, and what it becomes. */
export interface ValueCount {
  value: string;
  count: number;
  /** Stage key it matches, if any. */
  stage?: string | null;
  /** A likely stage key when it matches none. */
  suggestion?: string | null;
  /** Fit columns: the 0-5 it reads as. */
  fit?: number | null;
}

export interface ImportRowParticipant {
  round?: string | null;
  stage?: string | null;
  fit?: number | null;
  follow_up_on?: string | null;
  follow_up_note?: string | null;
  amount_soft?: number | null;
  amount_committed?: number | null;
  probability?: number | null;
  next_step?: string | null;
  owner_email?: string | null;
}

export interface ImportRow {
  row: number;
  action: RowAction;
  investor: Record<string, unknown>;
  participant?: ImportRowParticipant | null;
  match?: { investor_id?: UUID | null; row?: number | null; name: string; matched_on: MatchedOn } | null;
  errors: { field: string; message: string }[];
  warnings: string[];
}

export interface ImportPreview {
  format: ImportFormat;
  columns: string[];
  mapping: Record<string, ImportField | null>;
  row_count: number;
  rows: ImportRow[];
  counts: {
    create: number;
    update: number;
    skip: number;
    error: number;
    add_to_round: number;
    /** Unreadable optional cells left empty; their rows still import (P0-6). */
    cells_left_empty?: number;
  };
  warnings: string[];
  /** Dropped cells by kind: {"follow_up_unreadable": 74, "email_invalid": 3}. */
  warning_kinds?: Record<string, number>;
  column_stats?: Record<string, ColumnStats>;
  /** Distinct values of the columns mapped to stage or fit (CSV with a round). */
  values?: Record<string, ValueCount[]>;
  samples: Record<string, string[]>;
}

export interface ImportResult {
  import_run_id: UUID;
  counts: {
    rows: number;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
    added_to_round: number;
    cells_left_empty?: number;
  };
  errors: { row: number; field: string; message: string }[];
  warning_kinds?: Record<string, number>;
  /** Investors this import created. */
  created?: { row: number; id: UUID; name: string }[];
  round?: { id: UUID; slug: string; name: string } | null;
}

export interface ImportRun {
  id: UUID;
  format: ImportFormat;
  filename?: string | null;
  round_id?: UUID | null;
  round_name?: string | null;
  actor_type: "user" | "agent" | "system";
  actor_label: string;
  counts: Record<string, number>;
  options: Record<string, unknown>;
  created_at: Timestamp;
}

/* ---------- imports ---------- */

/** No writes. Rate limit shared with commit: 30 per hour per workspace. */
export const previewImport = (c: ApiClient, body: ImportRequest) =>
  c.post<ImportPreview>("/v1/imports/preview", body);

export const runImport = (c: ApiClient, body: ImportRequest) =>
  c.post<ImportResult>("/v1/imports", body);

export const listImports = (c: ApiClient) => c.get<DataList<ImportRun>>("/v1/imports");

const importCache = new WeakMap<ApiClient, { at: number; runs: Promise<ImportRun[]> }>();
/**
 * The workspace's import runs, shared for a minute by every timeline that words an import
 * ("imported Calla from x.csv with 410 others"), so opening ten files asks once.
 */
export function importRunsCached(c: ApiClient): Promise<ImportRun[]> {
  const hit = importCache.get(c);
  if (hit && Date.now() - hit.at < 60_000) return hit.runs;
  const runs = listImports(c)
    .then((r) => r.data)
    .catch(() => {
      importCache.delete(c);
      return [] as ImportRun[];
    });
  importCache.set(c, { at: Date.now(), runs });
  return runs;
}

/* ---------- exports ---------- */

export type ExportKind =
  | { kind: "workspace" }
  | { kind: "investors"; ids?: UUID[] }
  | { kind: "round"; round: string; format: "csv" | "json"; includeActivities?: boolean };

export function exportPath(e: ExportKind): { path: string; query: Record<string, string | string[]> } {
  if (e.kind === "workspace") return { path: "/v1/export", query: { format: "json" } };
  if (e.kind === "investors")
    return { path: "/v1/investors/export", query: { format: "csv", ...(e.ids ? { ids: e.ids } : {}) } };
  return {
    path: `/v1/rounds/${seg(e.round)}/export`,
    query: {
      format: e.format,
      ...(e.includeActivities && e.format === "json" ? { include_activities: "true" } : {}),
    },
  };
}

function filenameOf(res: Response, fallback: string): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename="?([^";]+)"?/i.exec(cd);
  return m?.[1] ?? fallback;
}

/**
 * Fetch an export with the session and save it in the browser (no new tab, no third party).
 * Returns the file name.
 */
export async function downloadExport(c: ApiClient, e: ExportKind): Promise<string> {
  const { path, query } = exportPath(e);
  const res = await c.raw(path, { query, headers: { Accept: "*/*" } });
  const blob = await res.blob();
  const name = filenameOf(res, e.kind === "workspace" ? "raisebook-export.json" : "raisebook-export.csv");
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return name;
}

/* ---------- client-side helpers ---------- */

/** "csv" unless the text looks like JSON (an array or an object). */
export function detectFormat(text: string): ImportFormat {
  const t = text.trimStart().replace(/^﻿/, "");
  return t.startsWith("[") || t.startsWith("{") ? "prototype_json" : "csv";
}

/** Keys used under `p` in a prototype JSON file, most frequent first (for round_map). */
export function prototypeRoundKeys(text: string): string[] {
  try {
    const data: unknown = JSON.parse(text.replace(/^﻿/, ""));
    const docs: unknown[] = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as { investors?: unknown }).investors)
        ? ((data as { investors: unknown[] }).investors)
        : [];
    const seen = new Map<string, number>();
    for (const d of docs) {
      const p = d && typeof d === "object" ? (d as { p?: unknown }).p : undefined;
      if (!p || typeof p !== "object") continue;
      for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
        if (v && typeof v === "object") seen.set(k, (seen.get(k) ?? 0) + 1);
      }
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  } catch {
    return [];
  }
}

/** Plain words for a dropped-cell kind, singular and plural. */
export const WARNING_KIND_LABEL: Record<string, [string, string]> = {
  follow_up_unreadable: ["follow-up date was unreadable", "follow-up dates were unreadable"],
  email_invalid: ["email was invalid", "emails were invalid"],
  url_invalid: ["link was invalid", "links were invalid"],
  check_size_invalid: ["check size range was invalid", "check size ranges were invalid"],
  fit_invalid: ["fit was out of range", "fits were out of range"],
  probability_invalid: ["probability was out of range", "probabilities were out of range"],
  amount_unreadable: ["amount was unreadable", "amounts were unreadable"],
  value_invalid: ["value was not accepted", "values were not accepted"],
  date_unreadable: ["last-contacted date was unreadable", "last-contacted dates were unreadable"],
  type_guessed: ["type was guessed from the title or firm", "types were guessed from the title or firm"],
};

/** Kinds that leave a cell empty (type_guessed fills one instead). */
export const LEFT_EMPTY_KINDS = new Set(Object.keys(WARNING_KIND_LABEL).filter((k) => k !== "type_guessed"));

/** Logical CSV rows (quotes may hold newlines), without the header; trailing blank lines ignored. */
export function csvShape(text: string): { rows: number; columns: number } {
  const t = text.replace(/^\uFEFF/, "");
  let rows = 0;
  let inQuote = false;
  let lineHasData = false;
  let first = "";
  let firstDone = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (!firstDone) first += ch;
    if (ch === '"') inQuote = !inQuote;
    else if ((ch === "\n" || ch === "\r") && !inQuote) {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      if (lineHasData) rows++;
      lineHasData = false;
      firstDone = true;
      continue;
    }
    if (ch.trim()) lineHasData = true;
  }
  if (lineHasData) rows++;
  const header = first.replace(/[\r\n]+$/, "");
  const delim = [",", ";", "\t"].reduce((best, d) => (header.split(d).length > header.split(best).length ? d : best), ",");
  let columns = 0;
  if (header.trim()) {
    let q = false;
    columns = 1;
    for (const ch of header) {
      if (ch === '"') q = !q;
      else if (ch === delim && !q) columns++;
    }
  }
  return { rows: Math.max(0, rows - 1), columns };
}
