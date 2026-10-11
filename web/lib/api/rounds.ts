/**
 * Rounds, stages, the round summary, participants (an investor in a round) and follow-ups
 * (SPEC §5.5, §5.6). Every function takes a workspace-scoped client first:
 * `useWorkspace().client` in the browser, `await serverApi(slug)` on the server.
 * `round` is a round id or slug everywhere.
 */

import { seg, type ApiClient } from "./client";
import { roundPath } from "./core";
import type {
  DateString,
  FollowUpItem,
  FollowUpState,
  Instrument,
  Page,
  Participant,
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
