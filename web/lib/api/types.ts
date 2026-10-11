/**
 * Shared API shapes, mirroring SPEC §5.3 (and the backend `schemas/*`). Every module under
 * `lib/api/` imports its object types from here so the app has one definition of a Round,
 * a Participant or an Activity. Feature modules add request/response types of their own.
 *
 * Conventions: ids are UUID strings, timestamps RFC 3339 UTC, dates `YYYY-MM-DD`, money is
 * whole units of the round currency (250000 = $250k). `?` fields may be absent or null.
 */

export type UUID = string;
/** RFC 3339 UTC timestamp, e.g. "2026-10-10T17:04:05Z". */
export type Timestamp = string;
/** Calendar date, "YYYY-MM-DD", in the workspace timezone. */
export type DateString = string;

/* ============================== enums ============================== */

export type Role = "owner" | "editor" | "viewer";
export type Scope = "raisebook:read" | "raisebook:write" | "raisebook:admin";
export type KeyMode = "live" | "test";
export type StageColor =
  | "slate"
  | "violet"
  | "cobalt"
  | "teal"
  | "amber"
  | "orange"
  | "green"
  | "gray"
  | "olive"
  | "sky";
export type StageKind = "open" | "active" | "won" | "lost";
export type RoundStatus = "open" | "closed";
export type Instrument = "safe" | "priced" | "convertible_note" | "other";
export type InvestorType =
  | "vc"
  | "angel"
  | "family_office"
  | "corporate_vc"
  | "accelerator"
  | "scout"
  | "other";
export type Priority = "hot" | "warm" | "maybe" | "low";
export type FollowUpState = "overdue" | "today" | "soon" | "later";
export type ActorType = "user" | "agent" | "system";
export type Via = "web" | "api" | "mcp" | "import" | "system";
export type LoggableKind = "note" | "email" | "call" | "meeting";
export type ActivityKind =
  | LoggableKind
  | "stage_change"
  | "follow_up_set"
  | "commitment"
  | "investor_created"
  | "investor_updated"
  | "added_to_round"
  | "removed_from_round"
  | "participant_updated";
export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

/* ============================== labels (SPEC §3.8) ============================== */

export const STAGE_COLORS: readonly StageColor[] = [
  "slate",
  "violet",
  "cobalt",
  "teal",
  "amber",
  "orange",
  "green",
  "gray",
  "olive",
  "sky",
];

export const INVESTOR_TYPE_LABEL: Record<InvestorType, string> = {
  vc: "VC",
  angel: "Angel",
  family_office: "Family Office",
  corporate_vc: "Corporate VC",
  accelerator: "Accelerator",
  scout: "Scout",
  other: "Other",
};

export const INSTRUMENT_LABEL: Record<Instrument, string> = {
  safe: "SAFE",
  priced: "Priced round",
  convertible_note: "Convertible note",
  other: "Other",
};

export const ROUND_STATUS_LABEL: Record<RoundStatus, string> = { open: "Open", closed: "Closed" };

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
};

export const LOGGABLE_KIND_LABEL: Record<LoggableKind, string> = {
  note: "Note",
  email: "Email",
  call: "Call",
  meeting: "Meeting",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  hot: "Hot",
  warm: "Warm",
  maybe: "Maybe",
  low: "Low fit",
};

export const SCOPE_LABEL: Record<Scope, string> = {
  "raisebook:read": "Read",
  "raisebook:write": "Write",
  "raisebook:admin": "Admin",
};

/* ============================== errors and pages ============================== */

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; request_id?: string | null };
}

/** `?limit=&cursor=` list response (SPEC §5.1). */
export interface Page<T> {
  data: T[];
  next_cursor: string | null;
  total?: number;
}

export interface DataList<T> {
  data: T[];
}

/* ============================== shapes (SPEC §5.3) ============================== */

export interface Actor {
  type: ActorType;
  /** Resolved display name: user name, agent name, or "Raisebook". */
  label: string;
  user_id?: UUID | null;
  api_key_id?: UUID | null;
  agent_model?: string | null;
  via: Via;
}

export interface Stage {
  key: string;
  label: string;
  color: StageColor;
  kind: StageKind;
  position: number;
  /** Only in round detail. */
  count?: number;
}

export interface StageInput {
  key?: string;
  label: string;
  color: StageColor;
  kind: StageKind;
}

export interface Workspace {
  id: UUID;
  slug: string;
  name: string;
  is_sandbox: boolean;
  default_currency: string;
  timezone: string;
  role?: Role | null;
  created_at: Timestamp;
}

export interface WorkspaceYou {
  type: "user" | "api_key";
  role?: Role | null;
  scopes: Scope[];
  agent_name?: string | null;
  key_prefix?: string | null;
}

export interface WorkspaceLimits {
  members?: number;
  api_keys?: number;
  rounds?: number;
  investors?: number;
  activities?: number;
  [k: string]: number | undefined;
}

/** `GET /v1/workspace`. */
export interface WorkspaceDetail extends Workspace {
  you: WorkspaceYou;
  limits: WorkspaceLimits;
}

export interface Member {
  user_id: UUID;
  email: string;
  name?: string | null;
  role: Role;
  joined_at: Timestamp;
  is_you: boolean;
  /** Active API keys this person created; revoked if they are removed or (owner) demoted. */
  active_api_keys?: number;
}

export interface Invite {
  id: UUID;
  email: string;
  role: Role;
  invited_by?: string | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  status: InviteStatus;
}

export interface ApiKey {
  id: UUID;
  name: string;
  agent_name?: string | null;
  key_prefix: string;
  mode: KeyMode;
  scopes: Scope[];
  created_by?: string | null;
  created_at: Timestamp;
  last_used_at?: Timestamp | null;
  expires_at?: Timestamp | null;
  revoked_at?: Timestamp | null;
}

export interface Round {
  id: UUID;
  slug: string;
  name: string;
  status: RoundStatus;
  instrument: Instrument;
  currency: string;
  target_amount: number;
  valuation_cap?: number | null;
  pre_money_valuation?: number | null;
  target_close_on?: DateString | null;
  closed_on?: DateString | null;
  notes?: string | null;
  stages: Stage[];
  committed_amount: number;
  participant_count: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface InvestorCompact {
  id: UUID;
  name: string;
  firm?: string | null;
  title?: string | null;
  type: InvestorType;
  email?: string | null;
  linkedin_url?: string | null;
  tags: string[];
}

export interface ParticipationBrief {
  round_id: UUID;
  round_slug: string;
  round_name: string;
  stage: Stage;
  fit: number;
  follow_up_on?: DateString | null;
  amount_committed?: number | null;
}

export interface Investor extends InvestorCompact {
  website_url?: string | null;
  x_url?: string | null;
  location?: string | null;
  check_min?: number | null;
  check_max?: number | null;
  check_note?: string | null;
  stage_focus: string[];
  industries: string[];
  notes?: string | null;
  source?: string | null;
  warm_intro_by?: string | null;
  rounds: ParticipationBrief[];
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ParticipantOwner {
  user_id: UUID;
  name?: string | null;
  email: string;
}

export interface Participant {
  round_id: UUID;
  round_slug: string;
  investor: InvestorCompact;
  stage: Stage;
  fit: number;
  priority: Priority;
  probability?: number | null;
  amount_soft?: number | null;
  amount_committed?: number | null;
  committed_on?: DateString | null;
  follow_up_on?: DateString | null;
  follow_up_note?: string | null;
  follow_up_state?: FollowUpState | null;
  next_step?: string | null;
  owner?: ParticipantOwner | null;
  stage_changed_at: Timestamp;
  last_activity_at?: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Activity {
  id: UUID;
  investor_id: UUID;
  investor_name: string;
  round_id?: UUID | null;
  round_slug?: string | null;
  kind: ActivityKind;
  occurred_at: Timestamp;
  body?: string | null;
  data: Record<string, unknown>;
  actor: Actor;
  created_at: Timestamp;
  deletable: boolean;
}

export interface RoundRef {
  id: UUID;
  slug: string;
  name: string;
}

export interface FollowUpItem {
  investor: InvestorCompact;
  round: RoundRef;
  stage: Stage;
  follow_up_on: DateString;
  follow_up_state: FollowUpState;
  days_overdue: number;
  follow_up_note?: string | null;
  next_step?: string | null;
  last_activity_at?: Timestamp | null;
}

export interface FunnelStage extends Stage {
  count: number;
  amount_soft: number;
  amount_committed: number;
}

export interface RoundSummary {
  round: Round & { days_to_close?: number | null };
  money: {
    currency: string;
    target: number;
    committed: number;
    pct_of_target: number;
    soft_circled: number;
    weighted_pipeline: number;
    committed_count: number;
  };
  funnel: FunnelStage[];
  counts: { total: number; open: number; active: number; won: number; lost: number };
  follow_ups: { overdue: number; today: number; next_7_days: number; top: FollowUpItem[] };
  stale: { investor: InvestorCompact; stage: Stage; days_since_activity: number }[];
  recent_activity: Activity[];
  warnings: string[];
}

/* ============================== auth and account ============================== */

export interface SessionUser {
  id: UUID;
  email: string;
  name?: string | null;
}

/** `GET /v1/auth/session`. */
export interface SessionInfo {
  user: SessionUser;
  csrf_token: string;
  workspaces: Workspace[];
}

/** `POST /v1/auth/verify`. */
export interface VerifyResult {
  user: SessionUser;
  csrf_token: string;
  redirect_path?: string | null;
  workspaces: Workspace[];
}

export interface MagicLinkRequest {
  email: string;
  redirect_path?: string;
  invite_token?: string;
}

export interface MagicLinkResult {
  sent: true;
  /** Only when the API runs on a localhost URL (dev). */
  dev_link?: string | null;
}

/** `GET /v1/me`. */
export interface Me {
  id: UUID;
  email: string;
  name?: string | null;
  created_at: Timestamp;
}

/** A signed-in browser (`GET /v1/me/sessions`). */
export interface UserSessionInfo {
  id: UUID;
  created_at: Timestamp;
  last_seen_at?: Timestamp | null;
  expires_at: Timestamp;
  user_agent?: string | null;
  ip?: string | null;
  current: boolean;
}

/** `GET /v1/auth/verify/peek`: does not spend the token. */
export interface VerifyPeek {
  valid: boolean;
  email_hint?: string | null;
}

export interface WorkspaceCreate {
  name: string;
  timezone?: string;
  default_currency?: string;
  sample?: boolean;
}

export interface WorkspaceUpdate {
  name?: string;
  timezone?: string;
  default_currency?: string;
}

/** `GET /v1/invites/lookup?token=` (no auth). */
export interface InviteLookup {
  workspace_name: string;
  inviter_name?: string | null;
  /** Masked, e.g. "d***@example.com". */
  email_hint: string;
  role: Role;
  expired: boolean;
}
