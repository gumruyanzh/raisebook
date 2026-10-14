/**
 * The REST API surface, transcribed from SPEC §5.4–5.8. `auth` is the scope (for keys) or the
 * session rule. If the spec changes, change this file.
 */

export interface Endpoint {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  auth: string;
  request?: string;
  response: string;
}

export interface EndpointGroup {
  id: string;
  title: string;
  intro?: string;
  endpoints: Endpoint[];
}

export const REST_GROUPS: EndpointGroup[] = [
  {
    id: "auth-account",
    title: "Auth and account",
    intro:
      "Session endpoints used by the web app. They take no X-Workspace header. API keys cannot call them.",
    endpoints: [
      { method: "POST", path: "/v1/auth/magic-link", auth: "none", request: "{email, redirect_path?, invite_token?}", response: "202 {sent: true}. Never reveals whether an account exists." },
      { method: "POST", path: "/v1/auth/verify", auth: "none", request: "{token}", response: "{user, csrf_token, redirect_path?, workspaces} and the session cookies. 400 invalid_token." },
      { method: "GET", path: "/v1/auth/session", auth: "session", response: "{user, csrf_token, workspaces}" },
      { method: "POST", path: "/v1/auth/signout", auth: "session", response: "204. The session is revoked." },
      { method: "GET", path: "/v1/me", auth: "session", response: "{id, email, name?, created_at}" },
      { method: "PATCH", path: "/v1/me", auth: "session", request: "{name?}", response: "User" },
      { method: "DELETE", path: "/v1/me", auth: "session", request: "{confirm_email}", response: "204. Deletes workspaces where you are the only member. 409 transfer_ownership_first if you are the only owner of a shared workspace." },
    ],
  },
  {
    id: "workspaces",
    title: "Workspaces, members and keys",
    endpoints: [
      { method: "GET", path: "/v1/workspaces", auth: "session", response: "{data: Workspace[]} with your role" },
      { method: "POST", path: "/v1/workspaces", auth: "session", request: "{name, timezone?, default_currency?, sample?}", response: "201 Workspace. sample: true creates a sandbox with fictional data." },
      { method: "GET", path: "/v1/workspace", auth: "read", response: "Workspace + {you: {type, role?, scopes, agent_name?, key_prefix?}, limits}" },
      { method: "PATCH", path: "/v1/workspace", auth: "admin", request: "{name?, timezone?, default_currency?}", response: "Workspace" },
      { method: "DELETE", path: "/v1/workspace", auth: "owner session", request: '{confirm: "<slug>"}', response: "204. Everything is deleted at once. 422 confirmation_required on a mismatch." },
      { method: "GET", path: "/v1/members", auth: "read", response: "{data: Member[]}" },
      { method: "PATCH", path: "/v1/members/{user_id}", auth: "owner session", request: "{role}", response: "Member. 409 last_owner." },
      { method: "DELETE", path: "/v1/members/{user_id}", auth: "owner session, or self", response: "204. 409 last_owner." },
      { method: "GET", path: "/v1/invites", auth: "admin", response: "{data: Invite[]}" },
      { method: "POST", path: "/v1/invites", auth: "owner session", request: "{email, role}", response: "201 Invite. 409 already_member." },
      { method: "DELETE", path: "/v1/invites/{id}", auth: "owner session", response: "204 (revoked)" },
      { method: "GET", path: "/v1/invites/lookup?token=", auth: "none", response: "{workspace_name, inviter_name?, email_hint, role, expired}" },
      { method: "POST", path: "/v1/invites/accept", auth: "session", request: "{token}", response: "Workspace. 409 invite_mismatch." },
      { method: "GET", path: "/v1/api-keys", auth: "admin", response: "{data: ApiKey[]}" },
      { method: "POST", path: "/v1/api-keys", auth: "owner session", request: "{name, agent_name?, scopes, expires_at?}", response: '201 {api_key, secret: "rb_live_…"}. The secret is shown once.' },
      { method: "DELETE", path: "/v1/api-keys/{id}", auth: "owner session", response: "204 (revoked)" },
    ],
  },
  {
    id: "rounds",
    title: "Rounds",
    intro: "{round} in a path is a round id or slug.",
    endpoints: [
      { method: "GET", path: "/v1/rounds?status=open|closed|all", auth: "read", response: "{data: Round[]}, open rounds first" },
      { method: "POST", path: "/v1/rounds", auth: "write", request: "{name, target_amount?, currency?, instrument?, valuation_cap?, pre_money_valuation?, target_close_on?, notes?, stages?}", response: "201 Round. 409 duplicate returns the existing round." },
      { method: "GET", path: "/v1/rounds/{round}", auth: "read", response: "Round, with a count on each stage" },
      { method: "PATCH", path: "/v1/rounds/{round}", auth: "write", request: "Any round field, status", response: "Round. Closing sets closed_on to today unless given." },
      { method: "DELETE", path: "/v1/rounds/{round}", auth: "admin", request: '{confirm: "<name or slug>"}', response: "204" },
      { method: "PUT", path: "/v1/rounds/{round}/stages", auth: "write", request: "{stages: StageInput[], reassign?: {removed_key: target_key}}", response: "Round. 409 stage_in_use, 422 invalid_stage_config." },
      { method: "GET", path: "/v1/rounds/{round}/summary", auth: "read", response: "RoundSummary" },
    ],
  },
  {
    id: "participants",
    title: "Investors in a round",
    intro:
      "A participant is an investor in a round, addressed by investor_id. stage accepts a key or a label; an unknown one returns 422 stage_not_found with the valid keys.",
    endpoints: [
      { method: "GET", path: "/v1/rounds/{round}/participants", auth: "read", request: "q, stage, fit_min, type, tag, industry, follow_up=due|week|none, owner, sort, order, limit (≤1000), cursor", response: "{data: Participant[], next_cursor, total}" },
      { method: "POST", path: "/v1/rounds/{round}/participants", auth: "write", request: "{investor_id, stage?, fit?, probability?, amount_soft?, next_step?, follow_up_on?, follow_up_note?, owner_user_id?}", response: "201 Participant, or 200 if already in the round (fields applied)" },
      { method: "POST", path: "/v1/rounds/{round}/participants/bulk", auth: "write", request: "{investor_ids (≤500), stage?}", response: "{added, already}" },
      { method: "GET", path: "/v1/rounds/{round}/participants/{investor_id}", auth: "read", response: "Participant" },
      { method: "PATCH", path: "/v1/rounds/{round}/participants/{investor_id}", auth: "write", request: "{stage?, note?, fit?, probability?, amount_soft?, amount_committed?, committed_on?, follow_up_on?, follow_up_note?, next_step?, owner_user_id?}", response: "Participant. One timeline entry per kind of change." },
      { method: "POST", path: "/v1/rounds/{round}/participants/{investor_id}/stage", auth: "write", request: "{stage, note?}", response: "{participant, changed, from, to}" },
      { method: "POST", path: "/v1/rounds/{round}/participants/{investor_id}/follow-up", auth: "write", request: "{on? | in_days? | clear?, note?}", response: "{participant, changed}" },
      { method: "POST", path: "/v1/rounds/{round}/participants/{investor_id}/commitment", auth: "write", request: "{amount, committed_on?, note?, move_to_won?}", response: "{participant, previous_amount, moved_stage}" },
      { method: "DELETE", path: "/v1/rounds/{round}/participants/{investor_id}", auth: "write", response: "204. Logged as removed_from_round." },
      { method: "GET", path: "/v1/follow-ups?round=&within_days=0&include_overdue=true&limit=", auth: "read", response: "{today, data: FollowUpItem[], counts: {overdue, today, upcoming}}" },
    ],
  },
  {
    id: "investors",
    title: "Investors and activity",
    endpoints: [
      { method: "GET", path: "/v1/investors", auth: "read", request: "q, type, tag, industry, round, not_in_round, sort, order, limit, cursor", response: "{data: Investor[], next_cursor, total}" },
      { method: "POST", path: "/v1/investors", auth: "write", request: "Investor fields + on_duplicate?: return_existing | fill_empty | create_anyway", response: "201 {investor, created: true}, or 200 {investor, created: false, matched_on}" },
      { method: "GET", path: "/v1/investors/resolve?ref=", auth: "read", response: "{investor}. 404, or 409 ambiguous_reference (MCP reference rules)." },
      { method: "GET", path: "/v1/investors/{id}", auth: "read", response: "Investor, with rounds" },
      { method: "PATCH", path: "/v1/investors/{id}", auth: "write", request: "Investor fields + add_tags?, remove_tags?, append_notes?", response: "Investor. 409 duplicate on an email or LinkedIn collision." },
      { method: "DELETE", path: "/v1/investors/{id}", auth: "write", response: "204. Hard delete, with their round entries and timeline." },
      { method: "GET", path: "/v1/activities", auth: "read", request: "investor_id, round, kind, actor_type, since, until, limit, cursor", response: "{data: Activity[], next_cursor}, newest first" },
      { method: "POST", path: "/v1/activities", auth: "write", request: "{investor_id, kind: note|email|call|meeting, body, occurred_at?, round?, direction?, idempotency_key?}", response: "201 Activity, or 200 with duplicate: true on a repeated key" },
      { method: "DELETE", path: "/v1/activities/{id}", auth: "write", response: "204. Notes, emails, calls and meetings only; 409 not_deletable otherwise." },
    ],
  },
  {
    id: "meetings",
    title: "Meetings and calendar",
    intro:
      "Meetings with investors. Times are RFC 3339; a time without an offset is read in the workspace timezone. Scheduling in a round moves the investor to the Meeting stage when they are earlier (move_to_meeting_stage, default true). Every change is on the timeline.",
    endpoints: [
      { method: "GET", path: "/v1/meetings?investor_id=&round=&status=&when=upcoming|needs_outcome|all&from=&to=&order=&limit=&cursor=", auth: "read", response: "{data: Meeting[], next_cursor}" },
      { method: "POST", path: "/v1/meetings", auth: "write", request: "{investor_id, starts_at, duration_minutes? | ends_at?, round?, title?, location?, video_url?, agenda?, guest_ids?, source?, move_to_meeting_stage?}", response: "201 {meeting, created, moved_stage?, participant?, warnings}. The same investor at the same start returns the existing meeting (200, created: false)." },
      { method: "GET", path: "/v1/meetings/{id}", auth: "read", response: "Meeting with its history" },
      { method: "PATCH", path: "/v1/meetings/{id}", auth: "write", request: "{starts_at?, ends_at?, duration_minutes?, title?, location?, video_url?, agenda?, guest_ids?, round?, status?: scheduled|cancelled|no_show, note?}", response: "{meeting, changed}. 409 meeting_done for a meeting already done." },
      { method: "POST", path: "/v1/meetings/{id}/complete", auth: "write", request: "{outcome?, next_step?, follow_up_on? | follow_up_in_days?, follow_up_note?}", response: "{meeting, activity, participant?}. The outcome is logged as a meeting activity." },
      { method: "DELETE", path: "/v1/meetings/{id}", auth: "write", response: "204. For mistakes; cancel a meeting to keep its history." },
      { method: "GET", path: "/v1/meetings/{id}/ics", auth: "read", response: "text/calendar file" },
      { method: "GET", path: "/v1/me/calendar-feed", auth: "session", response: "{active, token_hint?, created_at?, last_used_at?}" },
      { method: "POST", path: "/v1/me/calendar-feed", auth: "session", response: "201 {url, webcal_url, …}. The URL is shown once; creating again replaces it." },
      { method: "DELETE", path: "/v1/me/calendar-feed", auth: "session", response: "204. The feed stops working." },
      { method: "GET", path: "/v1/calendar/{token}.ics", auth: "the token", response: "text/calendar: meetings in every workspace you belong to, 60 days back to 400 days ahead" },
    ],
  },
  {
    id: "imports-exports",
    title: "Imports and exports",
    endpoints: [
      { method: "POST", path: "/v1/imports/preview", auth: "write", request: "ImportRequest", response: "ImportPreview. Writes nothing." },
      { method: "POST", path: "/v1/imports", auth: "write", request: "ImportRequest", response: "ImportResult. One transaction; error rows are skipped and reported." },
      { method: "GET", path: "/v1/imports", auth: "read", response: "{data: ImportRun[]} (last 50)" },
      { method: "GET", path: "/v1/export?format=json", auth: "read", response: "The whole workspace as JSON" },
      { method: "GET", path: "/v1/investors/export?format=csv", auth: "read", response: "All investors as CSV" },
      { method: "GET", path: "/v1/rounds/{round}/export?format=csv|json", auth: "read", response: "One round as CSV or JSON" },
    ],
  },
];

export const ERROR_CODES: [string, string, string][] = [
  ["400", "bad_request, workspace_required", "Malformed request; a session with several workspaces and no X-Workspace header."],
  ["401", "unauthorized, invalid_api_key, session_invalid", "No credentials, or bad ones."],
  ["403", "csrf_failed, insufficient_scope, forbidden_role", "The key or role cannot do this. details.required says what is needed."],
  ["404", "not_found, workspace_not_found", "Missing, or in another workspace. Raisebook never says which."],
  ["409", "duplicate", "Unique conflict. details.existing holds the existing investor or round."],
  ["409", "ambiguous_reference", "A reference matched several records. details.candidates lists up to 10."],
  ["409", "stage_in_use, last_owner, not_in_round, already_member, invite_mismatch, transfer_ownership_first, not_deletable", "The current state does not allow the change. The message says what to do."],
  ["413", "payload_too_large", "Body over 1 MB (6 MB for imports), or an inline export over its limit."],
  ["422", "validation_error", "details lists each field: {loc, msg, type}."],
  ["422", "round_required, stage_not_found, invalid_stage_config, limit_reached, confirmation_required, import_invalid", "The request is well formed but cannot be applied."],
  ["429", "rate_limited", "Wait Retry-After seconds. details.retry_after_s says the same."],
  ["500", "internal_error", "Unexpected. The message carries the request id to report."],
];

export const RATE_LIMITS: [string, string][] = [
  ["API key, reads (GET, MCP read tools)", "600 / min"],
  ["API key, writes (POST, PATCH, PUT, DELETE, MCP write tools)", "120 / min"],
  ["Signed-in user, all requests", "1,200 / min"],
  ["Imports (preview and commit), per workspace", "30 / hour"],
  ["Exports, per workspace", "60 / hour"],
  ["Sign-in links", "5 / 15 min per email, 30 / hour per IP"],
  ["Invites sent, per workspace", "50 / day"],
  ["Unauthenticated requests, per IP", "120 / min"],
  ["MCP protocol messages that are not tool calls, per key", "300 / min"],
];

export const SHAPES = `type Stage = { key: string; label: string; color: StageColor; kind: "open" | "active" | "won" | "lost"; position: number; count?: number };
type StageColor = "slate" | "violet" | "cobalt" | "teal" | "amber" | "orange" | "green" | "gray" | "olive" | "sky";
type Actor = { type: "user" | "agent" | "system"; label: string; user_id?: string; api_key_id?: string;
               agent_model?: string; via: "web" | "api" | "mcp" | "import" | "system" };

type Round = { id; slug; name; status: "open" | "closed"; instrument: "safe" | "priced" | "convertible_note" | "other";
               currency; target_amount: number; valuation_cap?; pre_money_valuation?; target_close_on?; closed_on?;
               notes?; stages: Stage[]; committed_amount: number; participant_count: number; created_at; updated_at };

type InvestorCompact = { id; name; firm?; title?; type; email?; linkedin_url?; tags: string[] };
type Investor = InvestorCompact & { website_url?; x_url?; location?; check_min?; check_max?; check_note?;
                stage_focus: string[]; industries: string[]; notes?; source?; warm_intro_by?;
                rounds: { round_id; round_slug; round_name; stage: Stage; fit; follow_up_on?; amount_committed? }[];
                created_at; updated_at };

type Participant = { round_id; round_slug; investor: InvestorCompact; stage: Stage; fit: number;
                     priority: "hot" | "warm" | "maybe" | "low"; probability?; amount_soft?; amount_committed?;
                     committed_on?; follow_up_on?; follow_up_note?; follow_up_state?: "overdue" | "today" | "soon" | "later";
                     next_step?; owner?: { user_id; name?; email }; stage_changed_at; last_activity_at?; created_at; updated_at };

type Activity = { id; investor_id; investor_name; round_id?; round_slug?; kind; occurred_at; body?;
                  data: object; actor: Actor; created_at; deletable: boolean };

type FollowUpItem = { investor: InvestorCompact; round: { id; slug; name }; stage: Stage; follow_up_on;
                      follow_up_state; days_overdue: number; follow_up_note?; next_step?; last_activity_at? };`;
