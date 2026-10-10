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
  | "owner_email";

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
  counts: { create: number; update: number; skip: number; error: number; add_to_round: number };
  warnings: string[];
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
  };
  errors: { row: number; field: string; message: string }[];
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
