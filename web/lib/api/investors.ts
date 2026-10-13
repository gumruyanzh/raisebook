/**
 * Investor contacts (workspace level, reusable across rounds; SPEC §5.7). Every function takes
 * a workspace-scoped client first.
 */

import { seg, type ApiClient } from "./client";
import type { Investor, InvestorType, Page, UUID } from "./types";

/** Contact fields accepted on create and update (SPEC §5.7). */
export interface InvestorInput {
  name?: string;
  firm?: string | null;
  title?: string | null;
  type?: InvestorType;
  email?: string | null;
  linkedin_url?: string | null;
  website_url?: string | null;
  x_url?: string | null;
  location?: string | null;
  check_min?: number | null;
  check_max?: number | null;
  check_note?: string | null;
  stage_focus?: string[];
  industries?: string[];
  tags?: string[];
  notes?: string | null;
  source?: string | null;
  warm_intro_by?: string | null;
}

export type OnDuplicate = "return_existing" | "fill_empty" | "create_anyway";

export interface CreateInvestorResult {
  investor: Investor;
  created: boolean;
  matched_on?: "email" | "linkedin" | "name_firm" | null;
}

export type InvestorSort = "name" | "firm" | "updated" | "created";

export interface InvestorQuery {
  q?: string;
  type?: string;
  tag?: string;
  industry?: string;
  /** Only investors in this round (id or slug). */
  round?: string;
  /** Only investors not in this round. */
  not_in_round?: string;
  sort?: InvestorSort;
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string;
}

export const listInvestors = (c: ApiClient, q: InvestorQuery = {}) =>
  c.get<Page<Investor> & { total: number }>("/v1/investors", { ...q });

/**
 * 201 `{created: true}` or 200 `{created: false, matched_on}` with the existing contact
 * (dedupe: email, then LinkedIn, then name + firm).
 */
export const createInvestor = (
  c: ApiClient,
  body: InvestorInput & { name: string; on_duplicate?: OnDuplicate },
) => c.post<CreateInvestorResult>("/v1/investors", body);

/** The MCP reference rules: id, email, LinkedIn URL, "Name" or "Name @ Firm". */
export const resolveInvestor = (c: ApiClient, ref: string) =>
  c.get<{ investor: Investor }>("/v1/investors/resolve", { ref });

export const getInvestor = (c: ApiClient, id: UUID) => c.get<Investor>(`/v1/investors/${seg(id)}`);

export interface InvestorUpdate extends InvestorInput {
  add_tags?: string[];
  remove_tags?: string[];
  append_notes?: string;
}

/** 409 `duplicate` when the email or LinkedIn profile belongs to another contact. */
export const updateInvestor = (c: ApiClient, id: UUID, body: InvestorUpdate) =>
  c.patch<Investor>(`/v1/investors/${seg(id)}`, body);

/** Hard delete: removes them from every round and deletes their timeline. */
export const deleteInvestor = (c: ApiClient, id: UUID) => c.del<void>(`/v1/investors/${seg(id)}`);

/** Every investor (follows cursors, up to `max`). */
export async function listAllInvestors(
  c: ApiClient,
  q: Omit<InvestorQuery, "cursor" | "limit"> = {},
  max = 5000,
): Promise<{ data: Investor[]; total: number }> {
  const out: Investor[] = [];
  let cursor: string | undefined;
  let total = 0;
  while (out.length < max) {
    const page = await listInvestors(c, { ...q, limit: 200, cursor });
    out.push(...page.data);
    total = page.total ?? out.length;
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return { data: out, total };
}

/* ---------- directory rows (UX-PASS-1 P2-5) ---------- */

/** A contact as the directory needs it: every field it shows or searches, nothing more. */
export interface InvestorRow {
  id: UUID;
  name: string;
  firm: string | null;
  title: string | null;
  type: InvestorType;
  email: string | null;
  location: string | null;
  linkedin_url: string | null;
  check_min: number | null;
  check_max: number | null;
  check_note: string | null;
  stage_focus: string[];
  industries: string[];
  tags: string[];
  source: string | null;
  warm_intro_by: string | null;
  /** The first 400 characters of the notes, for search. */
  notes: string | null;
  rounds: { slug: string; name: string; label: string; color: Investor["rounds"][number]["stage"]["color"]; kind: string }[];
  updated_at: string;
}

const NOTE_SEARCH_CHARS = 400;

/** Server-side trim: the directory ships ~40% of the full contact shape. */
export function toInvestorRow(i: Investor): InvestorRow {
  return {
    id: i.id,
    name: i.name,
    firm: i.firm ?? null,
    title: i.title ?? null,
    type: i.type,
    email: i.email ?? null,
    location: i.location ?? null,
    linkedin_url: i.linkedin_url ?? null,
    check_min: i.check_min ?? null,
    check_max: i.check_max ?? null,
    check_note: i.check_note ?? null,
    stage_focus: i.stage_focus,
    industries: i.industries,
    tags: i.tags,
    source: i.source ?? null,
    warm_intro_by: i.warm_intro_by ?? null,
    notes: i.notes ? i.notes.slice(0, NOTE_SEARCH_CHARS) : null,
    rounds: i.rounds.map((r) => ({ slug: r.round_slug, name: r.round_name, label: r.stage.label, color: r.stage.color, kind: r.stage.kind })),
    updated_at: i.updated_at,
  };
}

/** Lowercased, diacritic-free text a directory search runs against (the API's `q` fields). */
export function investorSearchText(r: InvestorRow): string {
  return [r.name, r.firm, r.title, r.email, r.location, r.tags.join(" "), r.industries.join(" "), r.source, r.warm_intro_by, r.notes]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
