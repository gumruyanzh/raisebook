/**
 * Rounds, stages, the round summary, participants (an investor in a round) and follow-ups
 * (SPEC §5.5, §5.6). Every function takes a workspace-scoped client first:
 * `useWorkspace().client` in the browser, `await serverApi(slug)` on the server.
 * `round` is a round id or slug everywhere.
 */

import { followUpState, priorityFromFit } from "../format";

import { seg, type ApiClient } from "./client";
import { roundPath } from "./core";
import type {
  DateString,
  FollowUpItem,
  FollowUpState,
  Instrument,
  Investor,
  InvestorCompact,
  Page,
  Participant,
  ParticipantOwner,
  Round,
  RoundStatus,
  RoundSummary,
  Stage,
  StageInput,
  UUID,
} from "./types";

/* ---------- rounds ---------- */

export interface RoundInput {
  name?: string;
  target_amount?: number;
  currency?: string;
  instrument?: Instrument;
  valuation_cap?: number | null;
  pre_money_valuation?: number | null;
  target_close_on?: DateString | null;
  notes?: string | null;
  stages?: StageInput[];
}

export interface RoundUpdate extends Omit<RoundInput, "stages"> {
  status?: RoundStatus;
  closed_on?: DateString | null;
}

/** 409 `duplicate` (details.existing) when a round with that name exists. */
export const createRound = (c: ApiClient, body: RoundInput & { name: string }) =>
  c.post<Round>("/v1/rounds", body);

/** Round detail; stages include `count`. */
export const getRound = (c: ApiClient, round: string) => c.get<Round>(roundPath(round));

export const updateRound = (c: ApiClient, round: string, body: RoundUpdate) =>
  c.patch<Round>(roundPath(round), body);

/** Admin; `confirm` must be the round name or slug (422 `confirmation_required`). */
export const deleteRound = (c: ApiClient, round: string, confirm: string) =>
  c.del<void>(roundPath(round), { confirm });

/**
 * Replace the ordered stage list. A removed stage with participants needs
 * `reassign[removed_key] = target_key`, or the API answers 409 `stage_in_use` with counts.
 */
export const replaceStages = (
  c: ApiClient,
  round: string,
  stages: StageInput[],
  reassign?: Record<string, string>,
) => c.put<Round>(roundPath(round, "/stages"), { stages, ...(reassign ? { reassign } : {}) });

export const getRoundSummary = (c: ApiClient, round: string) =>
  c.get<RoundSummary>(roundPath(round, "/summary"));

/* ---------- participants ---------- */

export type ParticipantSort =
  | "fit"
  | "name"
  | "firm"
  | "stage"
  | "follow_up"
  | "updated"
  | "amount";

export interface ParticipantQuery {
  q?: string;
  stage?: string[];
  fit_min?: number;
  type?: string;
  tag?: string[];
  industry?: string;
  follow_up?: "due" | "week" | "none";
  owner?: string;
  sort?: ParticipantSort;
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string;
}

export const listParticipants = (c: ApiClient, round: string, q: ParticipantQuery = {}) =>
  c.get<Page<Participant> & { total: number }>(roundPath(round, "/participants"), {
    ...q,
    limit: q.limit ?? 1000,
  });

/** Every participant in a round (follows cursors; the board and table work client-side). */
export async function listAllParticipants(c: ApiClient, round: string): Promise<Participant[]> {
  const out: Participant[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await listParticipants(c, round, { limit: 1000, cursor });
    out.push(...page.data);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return out;
}

export const getParticipant = (c: ApiClient, round: string, investorId: UUID) =>
  c.get<Participant>(roundPath(round, `/participants/${seg(investorId)}`));

export interface ParticipantAdd {
  investor_id: UUID;
  stage?: string;
  fit?: number;
  probability?: number;
  amount_soft?: number;
  next_step?: string;
  follow_up_on?: DateString;
  follow_up_note?: string;
  owner_user_id?: UUID;
}

/** 201 with `created: true`, or 200 when already in the round (fields are applied). */
export const addParticipant = (c: ApiClient, round: string, body: ParticipantAdd) =>
  c.post<Participant & { created?: boolean }>(roundPath(round, "/participants"), body);

export const bulkAddParticipants = (
  c: ApiClient,
  round: string,
  investorIds: UUID[],
  stage?: string,
) =>
  c.post<{ added: number; already: number }>(roundPath(round, "/participants/bulk"), {
    investor_ids: investorIds,
    ...(stage ? { stage } : {}),
  });

export interface ParticipantUpdate {
  stage?: string;
  note?: string;
  fit?: number;
  probability?: number | null;
  amount_soft?: number | null;
  amount_committed?: number | null;
  committed_on?: DateString | null;
  follow_up_on?: DateString | null;
  follow_up_note?: string | null;
  next_step?: string | null;
  owner_user_id?: UUID | null;
}

export const updateParticipant = (
  c: ApiClient,
  round: string,
  investorId: UUID,
  body: ParticipantUpdate,
) => c.patch<Participant>(roundPath(round, `/participants/${seg(investorId)}`), body);

export interface MoveResult {
  participant: Participant;
  changed: boolean;
  from: Stage;
  to: Stage;
}

export const moveStage = (
  c: ApiClient,
  round: string,
  investorId: UUID,
  stage: string,
  note?: string,
) =>
  c.post<MoveResult>(roundPath(round, `/participants/${seg(investorId)}/stage`), {
    stage,
    ...(note ? { note } : {}),
  });

export type FollowUpInput =
  | { on: DateString; note?: string }
  | { in_days: number; note?: string }
  | { clear: true };

export const setFollowUp = (c: ApiClient, round: string, investorId: UUID, body: FollowUpInput) =>
  c.post<{ participant: Participant; changed: boolean }>(
    roundPath(round, `/participants/${seg(investorId)}/follow-up`),
    body,
  );

export interface CommitmentInput {
  amount: number;
  committed_on?: DateString;
  note?: string;
  move_to_won?: boolean;
}

export const recordCommitment = (
  c: ApiClient,
  round: string,
  investorId: UUID,
  body: CommitmentInput,
) =>
  c.post<{ participant: Participant; previous_amount?: number | null; moved_stage: boolean }>(
    roundPath(round, `/participants/${seg(investorId)}/commitment`),
    body,
  );

/** Logs `removed_from_round`. */
export const removeParticipant = (c: ApiClient, round: string, investorId: UUID) =>
  c.del<void>(roundPath(round, `/participants/${seg(investorId)}`));

/* ---------- bulk changes (UX pass 1, P1-6) ---------- */

export type BulkOp =
  | "stage"
  | "follow_up"
  | "owner"
  | "fit"
  | "add_tag"
  | "remove_tag"
  | "remove"
  | "restore";

/** One investor's values for `op: "restore"` (Undo); only the given fields are applied. */
export interface BulkItem extends Omit<ParticipantUpdate, "note"> {
  investor_id: UUID;
}

export type BulkInput =
  | { op: "stage"; investor_ids: UUID[]; stage: string }
  | { op: "follow_up"; investor_ids: UUID[]; follow_up_on: DateString | null }
  | { op: "owner"; investor_ids: UUID[]; owner_user_id: UUID | null }
  | { op: "fit"; investor_ids: UUID[]; fit: number }
  | { op: "add_tag" | "remove_tag"; investor_ids: UUID[]; tag: string }
  | { op: "remove"; investor_ids: UUID[] }
  | { op: "restore"; items: BulkItem[] };

export interface BulkResult {
  bulk_id: UUID;
  op: BulkOp;
  changed: number;
  unchanged: number;
  /** The listed investors' participations after the change (empty for `remove`). */
  participants: Participant[];
  removed: UUID[];
}

/**
 * Up to 1,000 investors in one transaction, one activity each with a shared `data.bulk_id`.
 * All or nothing: 404 if any id is outside the workspace, 409 `not_in_round` (except for
 * `restore`, which adds them back).
 */
export const bulkUpdateParticipants = (c: ApiClient, round: string, body: BulkInput) =>
  c.post<BulkResult>(roundPath(round, "/participants/bulk-update"), body);

/* ---------- the pipeline page's trimmed payload (UX pass 1, P1-1) ---------- */

/**
 * One row of the pipeline as the server page sends it: the participant without the
 * repeated round and stage objects, plus the few investor fields the cards, rows and
 * filters use. `search` is the lowercased extra text the search box matches (location,
 * focus, source, intro, check note and the start of the notes). The client expands rows
 * back to `Participant` with {@link expandPipelineItems}.
 */
export interface PipelineItem {
  investor: InvestorCompact;
  stage: string;
  fit: number;
  probability?: number | null;
  amount_soft?: number | null;
  amount_committed?: number | null;
  committed_on?: DateString | null;
  follow_up_on?: DateString | null;
  follow_up_note?: string | null;
  next_step?: string | null;
  owner?: ParticipantOwner | null;
  stage_changed_at: string;
  last_activity_at?: string | null;
  created_at: string;
  updated_at: string;
  /** The next scheduled meeting (the card's "Meeting today 11:00" chip), only when set. */
  next_meeting?: Participant["next_meeting"];
  industries: string[];
  search: string;
  /** Where the investor came from ("SF Tech Week"), only when set. */
  source?: string;
  /** Board card facts (DECISION §15), only when set. */
  stage_focus?: string[];
  check_min?: number;
  check_max?: number;
}

/** Investor fields the pipeline keeps per row (filters and search), by investor id. */
export interface PipelineExtra {
  industries: string[];
  search: string;
  /** Triage hides the source chip when every investor in the queue shares it. */
  source?: string;
  /** Board card facts (DECISION §15): stage focus and check size, when known. */
  stage_focus?: string[];
  check_min?: number;
  check_max?: number;
}

const NOTES_IN_SEARCH = 400;

/** The board card's investor facts (stage focus, check size), only the ones that are set. */
export function cardFacts(inv: Pick<Investor, "stage_focus" | "check_min" | "check_max">): Pick<
  PipelineExtra,
  "stage_focus" | "check_min" | "check_max"
> {
  const out: Pick<PipelineExtra, "stage_focus" | "check_min" | "check_max"> = {};
  if (inv.stage_focus?.length) out.stage_focus = inv.stage_focus;
  if (inv.check_min != null) out.check_min = inv.check_min;
  if (inv.check_max != null) out.check_max = inv.check_max;
  return out;
}

/** Server side: participants (+ the round's investors) → the trimmed rows. */
export function toPipelineItems(participants: Participant[], investors: Investor[]): PipelineItem[] {
  const byId = new Map(investors.map((i) => [i.id, i]));
  return participants.map((p) => {
    const inv = byId.get(p.investor.id);
    // Email and LinkedIn travel only when set (the Table shows them; an import has little else).
    const { email, linkedin_url, ...rest } = p.investor;
    const investor: InvestorCompact = { ...rest, ...(email ? { email } : {}), ...(linkedin_url ? { linkedin_url } : {}) };
    const search = inv
      ? [
          inv.location,
          ...(inv.stage_focus ?? []),
          inv.source,
          inv.warm_intro_by,
          inv.check_note,
          inv.notes?.slice(0, NOTES_IN_SEARCH),
          p.investor.email,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
      : (p.investor.email ?? "").toLowerCase();
    const item: PipelineItem = {
      investor,
      stage: p.stage.key,
      fit: p.fit,
      stage_changed_at: p.stage_changed_at,
      created_at: p.created_at,
      updated_at: p.updated_at,
      industries: inv?.industries ?? [],
      search,
    };
    // Only non-empty optional fields travel (most rows have few of them).
    if (p.probability != null) item.probability = p.probability;
    if (p.amount_soft != null) item.amount_soft = p.amount_soft;
    if (p.amount_committed != null) item.amount_committed = p.amount_committed;
    if (p.committed_on) item.committed_on = p.committed_on;
    if (p.follow_up_on) item.follow_up_on = p.follow_up_on;
    if (p.follow_up_note) item.follow_up_note = p.follow_up_note;
    if (p.next_step) item.next_step = p.next_step;
    if (p.owner) item.owner = p.owner;
    if (p.last_activity_at) item.last_activity_at = p.last_activity_at;
    if (p.next_meeting) item.next_meeting = p.next_meeting;
    if (inv?.source) item.source = inv.source;
    if (inv) Object.assign(item, cardFacts(inv));
    return item;
  });
}

/** Client side: trimmed rows → `Participant` objects (stage objects, priority, state). */
export function expandPipelineItems(
  items: PipelineItem[],
  round: Pick<Round, "id" | "slug" | "stages">,
  today: string,
): { participants: Participant[]; extras: Record<UUID, PipelineExtra> } {
  const stages = new Map(round.stages.map((s) => [s.key, s]));
  const fallback = sortedStages(round.stages)[0]!;
  const extras: Record<UUID, PipelineExtra> = {};
  const participants = items.map((it) => {
    const { industries, search, source, stage, stage_focus, check_min, check_max, ...rest } = it;
    const extra: PipelineExtra = source ? { industries, search, source } : { industries, search };
    if (stage_focus?.length) extra.stage_focus = stage_focus;
    if (check_min != null) extra.check_min = check_min;
    if (check_max != null) extra.check_max = check_max;
    extras[it.investor.id] = extra;
    return {
      ...rest,
      round_id: round.id,
      round_slug: round.slug,
      investor: { ...it.investor, tags: it.investor.tags ?? [] },
      stage: stages.get(stage) ?? fallback,
      priority: priorityFromFit(it.fit),
      follow_up_state: followUpState(it.follow_up_on, today),
    } satisfies Participant;
  });
  return { participants, extras };
}

/* ---------- follow-ups ---------- */

export interface FollowUpList {
  today: DateString;
  data: FollowUpItem[];
  counts: { overdue: number; today: number; upcoming: number };
}

/** Without `round`: all open rounds. */
export const listFollowUps = (
  c: ApiClient,
  q: { round?: string; within_days?: number; include_overdue?: boolean; limit?: number } = {},
) => c.get<FollowUpList>("/v1/follow-ups", q);

/* ---------- small helpers shared by the round screens ---------- */

export const wonStage = (r: Pick<Round, "stages">) => r.stages.find((s) => s.kind === "won");
export const lostStage = (r: Pick<Round, "stages">) => r.stages.find((s) => s.kind === "lost");
export const sortedStages = (stages: Stage[]) => [...stages].sort((a, b) => a.position - b.position);

export type { FollowUpState };
