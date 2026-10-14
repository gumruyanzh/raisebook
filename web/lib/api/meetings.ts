/**
 * Meetings (`/v1/meetings`) and the private calendar feed (`/v1/me/calendar-feed`), docs/SPEC.md
 * §5.9. Every workspace call takes a workspace-scoped client first; the feed calls take the
 * org-less client (`api`).
 */

import { seg, type ApiClient } from "./client";
import type { Activity, Actor, InvestorCompact, Participant, Stage, Timestamp, UUID } from "./types";

export type MeetingStatus = "scheduled" | "done" | "cancelled" | "no_show";
export type MeetingSource = "manual" | "email" | "agent" | "calendar";

export interface MeetingChange {
  at: Timestamp;
  change: "scheduled" | "rescheduled" | "edited" | "cancelled" | "no_show" | "reopened" | "done" | string;
  from_starts_at?: Timestamp | null;
  to_starts_at?: Timestamp | null;
  by: Actor;
}

export interface Meeting {
  id: UUID;
  investor: InvestorCompact;
  guests: InvestorCompact[];
  round?: { id: UUID; slug: string; name: string } | null;
  title: string;
  starts_at: Timestamp;
  ends_at: Timestamp;
  duration_minutes: number;
  /** The workspace timezone when it was scheduled. */
  timezone: string;
  location?: string | null;
  video_url?: string | null;
  agenda?: string | null;
  status: MeetingStatus;
  /** Scheduled, over, and no outcome yet. */
  needs_outcome: boolean;
  outcome?: string | null;
  outcome_activity_id?: UUID | null;
  source: MeetingSource;
  created_by: Actor;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at?: Timestamp | null;
  cancelled_at?: Timestamp | null;
  history: MeetingChange[];
}

export interface MeetingWrite {
  meeting: Meeting;
  created: boolean;
  changed: boolean;
  moved_stage?: { from?: Stage | null; to: Stage } | null;
  participant?: Participant | null;
  activity?: Activity | null;
  warnings: string[];
}

export interface MeetingQuery {
  investor_id?: UUID;
  round?: string;
  status?: MeetingStatus[];
  when?: "upcoming" | "needs_outcome" | "all";
  from?: Timestamp;
  to?: Timestamp;
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string;
}

export const listMeetings = (c: ApiClient, q: MeetingQuery = {}, opts?: { signal?: AbortSignal }) =>
  c.get<{ data: Meeting[]; next_cursor: string | null }>("/v1/meetings", { ...q }, opts);

export const getMeeting = (c: ApiClient, id: UUID) => c.get<Meeting>(`/v1/meetings/${seg(id)}`);

export interface ScheduleInput {
  investor_id: UUID;
  /** RFC 3339, or a local `YYYY-MM-DDTHH:MM` in the workspace timezone. */
  starts_at: string;
  duration_minutes?: number;
  ends_at?: string;
  round?: string;
  title?: string;
  location?: string;
  video_url?: string;
  agenda?: string;
  guest_ids?: UUID[];
  source?: MeetingSource;
  move_to_meeting_stage?: boolean;
}

export const scheduleMeeting = (c: ApiClient, body: ScheduleInput) => c.post<MeetingWrite>("/v1/meetings", body);

export interface MeetingPatch {
  starts_at?: string;
  ends_at?: string;
  duration_minutes?: number;
  round?: string | null;
  title?: string | null;
  location?: string | null;
  video_url?: string | null;
  agenda?: string | null;
  guest_ids?: UUID[];
  status?: "scheduled" | "cancelled" | "no_show";
  note?: string;
}

export const updateMeeting = (c: ApiClient, id: UUID, body: MeetingPatch) =>
  c.patch<MeetingWrite>(`/v1/meetings/${seg(id)}`, body);

export interface CompleteInput {
  outcome?: string;
  next_step?: string;
  follow_up_on?: string;
  follow_up_in_days?: number;
  follow_up_note?: string;
}

export const completeMeeting = (c: ApiClient, id: UUID, body: CompleteInput) =>
  c.post<MeetingWrite>(`/v1/meetings/${seg(id)}/complete`, body);

export const deleteMeeting = (c: ApiClient, id: UUID) => c.del<void>(`/v1/meetings/${seg(id)}`);

/** Download the meeting as an `.ics` file (the request carries the workspace header). */
export async function downloadMeetingIcs(c: ApiClient, id: UUID): Promise<void> {
  const res = await c.raw(`/v1/meetings/${seg(id)}/ics`, { headers: { Accept: "text/calendar" } });
  const url = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = `raisebook-meeting-${id}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Upcoming, needing an outcome, and the last 30 days (server and client share it). */
export async function loadMeetings(client: ApiClient): Promise<Meeting[]> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [up, due, past] = await Promise.all([
    listMeetings(client, { when: "upcoming", limit: 200 }),
    listMeetings(client, { when: "needs_outcome", order: "desc", limit: 100 }),
    listMeetings(client, { status: ["done", "cancelled", "no_show"], from: since, order: "desc", limit: 100 }),
  ]);
  const seen = new Set<string>();
  return [...due.data, ...up.data, ...past.data].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

/* ---------- the private calendar feed (per user, every workspace) ---------- */

export interface CalendarFeed {
  active: boolean;
  token_hint?: string | null;
  created_at?: Timestamp | null;
  last_used_at?: Timestamp | null;
}

export interface CalendarFeedCreated extends CalendarFeed {
  url: string;
  webcal_url: string;
}

export const getCalendarFeed = (c: ApiClient) => c.get<CalendarFeed>("/v1/me/calendar-feed");
export const createCalendarFeed = (c: ApiClient) => c.post<CalendarFeedCreated>("/v1/me/calendar-feed");
export const revokeCalendarFeed = (c: ApiClient) => c.del<void>("/v1/me/calendar-feed");
