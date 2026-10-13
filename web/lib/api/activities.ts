/**
 * The activity timeline (append-only; SPEC §5.7, §8.1). Every function takes a
 * workspace-scoped client first.
 */

import { seg, type ApiClient } from "./client";
import type { Activity, ActivityKind, ActorType, LoggableKind, Page, Timestamp, UUID } from "./types";

/** An import run or bulk change collapsed into one feed entry (`collapse_runs`). */
export interface ActivityRun {
  key: string;
  kind: "import" | "bulk";
  /** Activities in the run (within the same filters). */
  size: number;
  /** Distinct investors they touch. */
  investors: number;
  /** Import runs: the file it came from. */
  filename?: string | null;
}

/** What `/v1/activities` returns beyond the shared `Activity` shape. */
export interface FeedActivity extends Activity {
  import_run_id?: UUID | null;
  run?: ActivityRun | null;
}

/** The run an activity belongs to: its import run, else the bulk change's `data.bulk_id`. */
export function runKeyOf(a: Activity): string | null {
  const f = a as FeedActivity;
  if (f.import_run_id) return f.import_run_id;
  const b = a.data?.bulk_id;
  return typeof b === "string" ? b : null;
}

export interface ActivityQuery {
  investor_id?: UUID;
  round?: string;
  kind?: ActivityKind[];
  actor_type?: ActorType;
  since?: Timestamp;
  until?: Timestamp;
  /** Only the activities of one import run or bulk change. */
  run?: string;
  /** One entry per import run or bulk change (its newest), sized in `run`. Feeds use it. */
  collapse_runs?: boolean;
  limit?: number;
  cursor?: string;
}

/** Newest `occurred_at` first. */
export const listActivities = (c: ApiClient, q: ActivityQuery = {}, opts?: { signal?: AbortSignal }) =>
  c.get<Page<FeedActivity>>("/v1/activities", { ...q }, opts);

export interface LogActivityInput {
  investor_id: UUID;
  kind: LoggableKind;
  body: string;
  occurred_at?: Timestamp;
  /** Round id or slug, when it concerns a specific round. */
  round?: string;
  direction?: "inbound" | "outbound";
  idempotency_key?: string;
}

/** 201 Activity; 200 with `duplicate: true` on a repeated idempotency key. */
export const logActivity = (c: ApiClient, body: LogActivityInput) =>
  c.post<Activity & { duplicate?: boolean }>("/v1/activities", body);

/** Manual kinds only (note, email, call, meeting); otherwise 409 `not_deletable`. */
export const deleteActivity = (c: ApiClient, id: UUID) => c.del<void>(`/v1/activities/${seg(id)}`);
