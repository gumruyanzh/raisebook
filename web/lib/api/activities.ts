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

/** Consecutive look-alike edits (no shared run id) collapse in feeds from this many… */
export const MIN_SIMILAR = 5;
/** …when each one is at most this far from the one before it. */
export const SIMILAR_GAP_MS = 10 * 60_000;

const CONVERSATION_KINDS: ActivityKind[] = ["note", "email", "call", "meeting"];
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * What makes two activities "the same edit" for a feed: one actor, one kind and the same
 * shape of change (the same fields, the same target stage or date). Conversations and
 * commitments never match (each one is its own story), nor do members of a real run.
 */
export function similarKeyOf(a: Activity): string | null {
  if (CONVERSATION_KINDS.includes(a.kind) || a.kind === "commitment" || runKeyOf(a)) return null;
  const d = a.data ?? {};
  const actor = `${a.actor.type}:${a.actor.user_id ?? a.actor.api_key_id ?? ""}:${a.actor.label}`;
  let shape = "";
  if (a.kind === "participant_updated") {
    shape = d.changes && typeof d.changes === "object" ? Object.keys(d.changes).sort().join(",") : "";
  } else if (a.kind === "investor_updated") {
    shape = Array.isArray(d.fields) ? (d.fields as unknown[]).map(String).sort().join(",") : "";
  } else if (a.kind === "follow_up_set") {
    shape = `${str(d.to)}|${str(d.note)}`;
  } else if (a.kind === "stage_change") {
    const to = d.to && typeof d.to === "object" ? (d.to as Record<string, unknown>) : {};
    shape = str(to.key) || str(to.label);
  }
  return `${actor}|${a.kind}|${shape}`;
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

/** An Undo within this long of the change it reverts hides both from a timeline. */
export const UNDO_PAIR_MS = 10 * 60_000;

const keyOf = (v: unknown): string => {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o.key) || str(o.label);
  }
  return v === null || v === undefined ? "" : String(v);
};

/**
 * Drop each Undo (`data.undo`, written by a bulk `restore`) together with the change it
 * reverted: the newest earlier activity on the same investor, of the same kind, by the same
 * actor, at most 10 minutes before, whose result the Undo starts from (a stage move New →
 * Contacted and its undo Contacted → New). The log keeps both; a timeline shows neither.
 * `acts` is newest first, as the API returns them.
 */
export function dropUndone<T extends Activity>(acts: readonly T[]): T[] {
  const gone = new Set<number>();
  for (let i = 0; i < acts.length; i++) {
    const u = acts[i]!;
    if (u.data?.undo !== true || gone.has(i)) continue;
    const at = Date.parse(u.occurred_at);
    for (let j = i + 1; j < acts.length; j++) {
      const a = acts[j]!;
      if (gone.has(j) || a.data?.undo === true) continue;
      if (at - Date.parse(a.occurred_at) > UNDO_PAIR_MS) break;
      if (a.investor_id !== u.investor_id || a.kind !== u.kind) continue;
      if (a.actor.type !== u.actor.type || a.actor.label !== u.actor.label) continue;
      const reverses =
        a.kind === "stage_change" || a.kind === "follow_up_set"
          ? keyOf(a.data?.to) === keyOf(u.data?.from)
          : a.kind === "participant_updated"
            ? Object.keys((a.data?.changes as object) ?? {}).sort().join() ===
              Object.keys((u.data?.changes as object) ?? {}).sort().join()
            : false;
      if (!reverses) continue;
      gone.add(i).add(j);
      break;
    }
  }
  return gone.size ? acts.filter((_, i) => !gone.has(i)) : [...acts];
}

/**
 * Newest `occurred_at` first. One investor's timeline (`investor_id`, not a run or a
 * collapsed feed) leaves out undone pairs ({@link dropUndone}).
 */
export const listActivities = async (c: ApiClient, q: ActivityQuery = {}, opts?: { signal?: AbortSignal }) => {
  const page = await c.get<Page<FeedActivity>>("/v1/activities", { ...q }, opts);
  return q.investor_id && !q.run && !q.collapse_runs ? { ...page, data: dropUndone(page.data) } : page;
};

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
