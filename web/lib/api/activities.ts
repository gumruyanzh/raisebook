/**
 * The activity timeline (append-only; SPEC §5.7, §8.1). Every function takes a
 * workspace-scoped client first.
 */

import { seg, type ApiClient } from "./client";
import type { Activity, ActivityKind, ActorType, LoggableKind, Page, Timestamp, UUID } from "./types";

export interface ActivityQuery {
  investor_id?: UUID;
  round?: string;
  kind?: ActivityKind[];
  actor_type?: ActorType;
  since?: Timestamp;
  until?: Timestamp;
  limit?: number;
  cursor?: string;
}

/** Newest `occurred_at` first. */
export const listActivities = (c: ApiClient, q: ActivityQuery = {}) =>
  c.get<Page<Activity>>("/v1/activities", { ...q });

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
