/**
 * The 26 MCP tools (SPEC §6.4, the four meeting tools of §6.8, and the five research tools from RESEARCH-PLAN §7, served only with
 * RAISEBOOK_RESEARCH_ENABLED). Descriptions are the binding tool description text, word for
 * word. Parameters follow the spec's input schemas. If the spec changes, change this file.
 */

export interface ToolParam {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

export interface McpTool {
  name: string;
  title: string;
  access: "read" | "write";
  idempotent: boolean;
  description: string;
  params: ToolParam[];
  output: string;
  example?: string;
}

const INVESTOR_REF: ToolParam = {
  name: "investor",
  type: "string",
  required: true,
  description: 'Id, email, LinkedIn URL, "Name" or "Name @ Firm". Exact match after normalization.',
};

const ROUND_REQUIRED: ToolParam = {
  name: "round",
  type: "string",
  description: "Round id, slug or name. Omit it when the workspace has exactly one open round.",
};

const ROUND_OPTIONAL = (what: string): ToolParam => ({
  name: "round",
  type: "string",
  description: `Round id, slug or name. ${what}`,
});

export const MCP_TOOLS: McpTool[] = [
  {
    name: "get_workspace",
    title: "Workspace and rounds",
    access: "read",
    idempotent: true,
    description:
      "Who am I and what's here: workspace name, timezone and today's date, your scopes and agent name, every round with its stage keys, and the allowed investor types and activity kinds. Call this first.",
    params: [],
    output:
      "{workspace: {id, name, slug, is_sandbox, timezone, today, weekday, default_currency}, you: {agent_name, scopes, key_prefix}, rounds: [{id, slug, name, status, currency, target_amount, stages: [{key, label, kind}]}], investor_types, loggable_activity_kinds}",
  },
  {
    name: "list_rounds",
    title: "List rounds",
    access: "read",
    idempotent: true,
    description:
      "List fundraising rounds with target, committed amount and participant counts per stage kind. Use the slug or name as `round` in other tools.",
    params: [{ name: "status", type: '"open" | "closed" | "all"', description: 'Default "open".' }],
    output:
      "{rounds: [{id, slug, name, status, instrument, currency, target_amount, committed_amount, target_close_on?, counts: {total, open, active, won, lost}}]}",
  },
  {
    name: "create_round",
    title: "Create round",
    access: "write",
    idempotent: true,
    description:
      "Create a fundraising round with the default stages (New, Researching, Contacted, Replied, Meeting, Diligence, Committed, Passed). Safe to repeat: if a round with this name exists, it is returned unchanged with `created: false`. Returns the round with its stage keys, ready for add_investor / add_to_round.",
    params: [
      { name: "name", type: "string 1-80", required: true, description: 'e.g. "Seed" or "Seed Extension".' },
      { name: "target_amount", type: "integer or \"2M\"", description: "Whole units." },
      { name: "currency", type: "string", description: "3-letter code. Default: the workspace currency." },
      { name: "instrument", type: "string", description: "safe (default), priced, convertible_note or other." },
      { name: "valuation_cap", type: "integer", description: "Optional." },
      { name: "target_close_on", type: "date", description: "YYYY-MM-DD." },
    ],
    output: "{created, round: {id, slug, name, status, instrument, currency, target_amount, stages: [{key, label, kind}]}}",
  },
  {
    name: "get_round_summary",
    title: "Round summary",
    access: "read",
    idempotent: true,
    description:
      "The state of a round in one call: committed vs target, soft-circled and weighted pipeline, investors per stage, overdue and upcoming follow-ups, stale conversations (no activity for 14+ days), recent activity and warnings. Use it for status updates and 'what should I do today'.",
    params: [ROUND_REQUIRED],
    output:
      "RoundSummary: {round, money: {currency, target, committed, pct_of_target, soft_circled, weighted_pipeline, committed_count}, funnel, counts, follow_ups: {overdue, today, next_7_days, top}, stale, recent_activity, warnings}",
  },
  {
    name: "search_investors",
    title: "Search investors",
    access: "read",
    idempotent: true,
    description:
      "Find investors. `query` matches name, firm, title, email, location, tags, industries, source and notes (all words must match). Without `round`, it searches all workspace contacts and shows each one's stage in every round. With `round` (or any of stage/fit_min/follow_up, which imply the single open round), it returns investors in that round with stage, fit, follow-up and amounts.",
    params: [
      { name: "query", type: "string", description: "Words that must all match." },
      ROUND_OPTIONAL("Limits results to that round's participants."),
      { name: "stage", type: "string | string[]", description: "Stage key(s) or label(s)." },
      { name: "fit_min", type: "integer 0-5", description: "Minimum fit." },
      { name: "tags", type: "string[]", description: "All must match." },
      { name: "industries", type: "string[]", description: "Any may match." },
      { name: "type", type: "investor type", description: "vc, angel, family_office, corporate_vc, accelerator, scout, other." },
      { name: "follow_up", type: '"due" | "week" | "none"', description: "Due now, due within a week, or no follow-up set." },
      { name: "sort", type: '"fit" | "name" | "follow_up" | "recent" | "stage"', description: "Default fit in a round, name for contacts." },
      { name: "limit", type: "integer 1-100", description: "Default 25." },
      { name: "cursor", type: "string", description: "From next_cursor." },
    ],
    output:
      "{round?: {slug, name}, results: [investor + stage, fit, priority, follow_up_on, amounts (in a round) or rounds: [{round_slug, stage_key, fit}]], next_cursor?, total}",
  },
  {
    name: "get_investor",
    title: "Investor file",
    access: "read",
    idempotent: true,
    description:
      "Everything about one investor: contact fields, notes, their stage and terms in every round, and the timeline (newest first) with who did what, including agent actions.",
    params: [
      INVESTOR_REF,
      ROUND_OPTIONAL("Filters the timeline and the participation shown."),
      { name: "timeline_limit", type: "integer 1-100", description: "Default 20." },
    ],
    output: "{investor, participations: Participant[], timeline: Activity[], timeline_truncated}",
  },
  {
    name: "add_investor",
    title: "Add investor",
    access: "write",
    idempotent: true,
    description:
      "Add an investor contact, or find the existing one and fill in what it is missing. Dedupes by email, then LinkedIn profile, then name+firm, then the name alone when there is exactly one person with that name; `matched_on` tells you which. on_duplicate: fill_empty (default: fill empty fields, merge tags, and append new notes as a dated paragraph; it never overwrites), return_existing (change nothing; `not_applied` lists the fields you sent that were not saved), create_anyway (ignore name matches; email/LinkedIn duplicates are never created). Pass `round` (and optionally `stage`, `fit`, `follow_up_on`, `follow_up_note`, `next_step`, `amount_soft`) to also put them on that round's board in the same call. Leave unknown fields out.",
    params: [
      { name: "name", type: "string 1-200", required: true, description: "Full name." },
      { name: "firm", type: "string", description: "Fund or company." },
      { name: "title", type: "string", description: "Partner, Principal, Angel…" },
      { name: "type", type: "investor type", description: "vc, angel, family_office, corporate_vc, accelerator, scout, other." },
      { name: "email", type: "string", description: "Used for dedupe." },
      { name: "linkedin", type: "string", description: "Profile URL. Used for dedupe." },
      { name: "website", type: "string", description: "URL." },
      { name: "x", type: "string", description: "URL or @handle." },
      { name: "location", type: "string", description: "City or region." },
      { name: "check_min, check_max", type: "integer", description: "Check size range in whole units." },
      { name: "check_note", type: "string", description: 'Free text, e.g. "$250k-$1M, leads". Parsed for min and max.' },
      { name: "stage_focus, industries, tags", type: "string[]", description: "Lists." },
      { name: "notes", type: "string", description: "Research notes." },
      { name: "source, warm_intro_by", type: "string", description: "Where you met, who introduced you." },
      { name: "on_duplicate", type: '"fill_empty" | "return_existing" | "create_anyway"', description: "Default fill_empty (never overwrites)." },
      ROUND_OPTIONAL("Also adds the investor to this round. Omitted with any option below: the single open round."),
      { name: "stage", type: "string", description: "Stage in that round. Default: the first stage." },
      { name: "fit", type: "integer 0-5", description: "0 = unrated; 5 hot, 4 warm, 3 maybe, 1-2 low." },
      { name: "follow_up_on, follow_up_note", type: "date, string", description: "Set the next follow-up in the same call." },
      { name: "next_step", type: "string", description: "One line." },
      { name: "amount_soft", type: "integer or \"250k\"", description: "Soft-circled amount." },
    ],
    output:
      "{investor, created, matched_on?: email | linkedin | name_firm | name, filled_fields?, not_applied?, hint?, round?, participant?, warning?}",
    example: '{"name": "Dana Whitfield", "firm": "Harbor Light Ventures", "email": "dana@example.com", "type": "vc", "round": "seed", "stage": "research", "fit": 4}',
  },
  {
    name: "add_investors",
    title: "Add investors",
    access: "write",
    idempotent: true,
    description:
      "Add up to 50 investors in one call, each exactly as add_investor would (same dedupe and on_duplicate rules), optionally all on one round. Each item takes add_investor's contact fields plus its own stage, fit, follow_up_on, follow_up_note, next_step and amount_soft. Returns one compact line per item (id, name, created or matched_on, and any error), so one bad item does not stop the rest.",
    params: [
      { name: "items", type: "object[] 1-50", required: true, description: "add_investor arguments, one object per investor." },
      ROUND_OPTIONAL("Adds every item to this round."),
      { name: "on_duplicate", type: '"fill_empty" | "return_existing" | "create_anyway"', description: "Default fill_empty." },
    ],
    output: "{counts: {created, existing, errors}, results: [{item, id, name, created, matched_on?, not_applied?, stage?, error?}]}",
  },
  {
    name: "update_investor",
    title: "Update investor",
    access: "write",
    idempotent: false,
    description:
      "Change an investor's contact fields. Only keys in `set` change; null clears a field. Use add_tags/remove_tags to edit tags without rewriting the list, and append_notes to add a dated paragraph to their notes instead of replacing them. Round-specific fields (stage, fit, follow-up, amounts) are changed with add_to_round, move_stage, set_follow_up and record_commitment.",
    params: [
      INVESTOR_REF,
      { name: "set", type: "object", description: "Any add_investor contact field. null clears it." },
      { name: "add_tags, remove_tags", type: "string[]", description: "Edit tags in place." },
      { name: "add_industries", type: "string[]", description: "Append industries." },
      { name: "append_notes", type: "string", description: 'Adds "[YYYY-MM-DD, agent name] text" as a new paragraph.' },
    ],
    output: "{investor, changed_fields} (an empty list means nothing changed and nothing was logged)",
  },
  {
    name: "add_to_round",
    title: "Add to round",
    access: "write",
    idempotent: true,
    description:
      "Put an investor on a round's board, or update their round fields if they are already there. Safe to repeat. New participants start in the first stage unless you pass `stage`. For an existing participant, a different `stage` moves them (logged as a stage change).",
    params: [
      INVESTOR_REF,
      ROUND_REQUIRED,
      { name: "stage", type: "string", description: "Stage key or label." },
      { name: "fit", type: "integer 0-5", description: "Fit." },
      { name: "probability", type: "integer 0-100", description: "Chance they invest, for the weighted pipeline." },
      { name: "amount_soft", type: "integer", description: "Soft-circled amount." },
      { name: "next_step", type: "string", description: "One line." },
      { name: "follow_up_on", type: "date", description: "YYYY-MM-DD." },
      { name: "owner_email", type: "string", description: "A member who owns this conversation." },
    ],
    output: "{participant, created, changed}",
  },
  {
    name: "move_stage",
    title: "Move stage",
    access: "write",
    idempotent: true,
    description:
      "Move an investor to another stage in a round (for example contacted → meeting). Moving to the current stage does nothing. Add `note` to explain why; it appears on the timeline. To mark a commitment with an amount, use record_commitment instead of moving to the won stage.",
    params: [
      INVESTOR_REF,
      { name: "stage", type: "string", required: true, description: "Stage key or label." },
      ROUND_REQUIRED,
      { name: "note", type: "string ≤2000", description: "Why. Shown on the timeline." },
    ],
    output: "{participant, changed, from, to}. Errors: not_in_round (use add_to_round), stage_not_found (lists valid keys).",
  },
  {
    name: "log_activity",
    title: "Log activity",
    access: "write",
    idempotent: false,
    description:
      "Record something that happened with an investor: a note, an email (sent or received), a call or a meeting. `body` is what happened in plain words. `occurred_at` defaults to now; past dates are fine, and a future meeting time records a scheduled meeting. Pass `round` when it concerns a specific round. Pass a stable `idempotency_key` (for example an email message id) to make retries safe.",
    params: [
      INVESTOR_REF,
      { name: "kind", type: '"note" | "email" | "call" | "meeting"', required: true, description: "What kind of thing happened." },
      { name: "body", type: "string 1-20000", required: true, description: "What happened, in plain words." },
      { name: "occurred_at", type: "string", description: "RFC 3339, or a date (read as 12:00 local time)." },
      ROUND_OPTIONAL("Omit for activity that is not about one round."),
      { name: "direction", type: '"inbound" | "outbound"', description: "For emails and calls." },
      { name: "idempotency_key", type: "string ≤200", description: "Repeat calls with the same key return the first activity." },
    ],
    output: "{activity, duplicate}",
  },
  {
    name: "set_follow_up",
    title: "Set follow-up",
    access: "write",
    idempotent: true,
    description:
      "Set or clear the date you should next follow up with an investor in a round. Give exactly one of `on` (YYYY-MM-DD), `in_days` (from today in the workspace timezone) or `clear: true`. `note` says what the follow-up is for (shown in the follow-up list).",
    params: [
      INVESTOR_REF,
      ROUND_REQUIRED,
      { name: "on", type: "date", description: "YYYY-MM-DD." },
      { name: "in_days", type: "integer 0-365", description: "Days from today." },
      { name: "clear", type: "boolean", description: "Remove the follow-up." },
      { name: "note", type: "string ≤500", description: "What the follow-up is for." },
    ],
    output: "{participant, changed}",
  },
  {
    name: "list_due_follow_ups",
    title: "Due follow-ups",
    access: "read",
    idempotent: true,
    description:
      "Follow-ups that are due: overdue first, then today, then (with within_days > 0) the next N days. Without `round`, it covers all open rounds. Use it to plan the founder's outreach for the day; for 'this week', pass within_days=7. `counts` always includes next_7_days and next_due_on, so an empty list never hides a busy week ahead.",
    params: [
      ROUND_OPTIONAL("Omit to cover all open rounds."),
      { name: "within_days", type: "integer 0-60", description: "Default 0 (overdue and today only)." },
      { name: "include_overdue", type: "boolean", description: "Default true." },
      { name: "limit", type: "integer 1-200", description: "Default 50." },
    ],
    output: "{today, weekday, items: FollowUpItem[], counts: {overdue, today, upcoming, next_7_days, next_due_on?}}",
  },
  {
    name: "record_commitment",
    title: "Record commitment",
    access: "write",
    idempotent: true,
    description:
      "Record that an investor committed money to a round. `amount` is the total commitment in whole currency units (it replaces any earlier amount; it is not added to it), and 0 clears it. By default this also moves them to the round's won stage (Committed) and adds them to the round if needed.",
    params: [
      INVESTOR_REF,
      { name: "amount", type: "integer ≥ 0", required: true, description: "Total commitment. 0 clears it." },
      ROUND_REQUIRED,
      { name: "committed_on", type: "date", description: "Default today." },
      { name: "note", type: "string", description: "Shown on the timeline." },
      { name: "move_to_won", type: "boolean", description: "Default true." },
    ],
    output: "{participant, previous_amount?, moved_stage, round_committed_total}",
  },
  {
    name: "import_investors_csv",
    title: "Import CSV",
    access: "write",
    idempotent: false,
    description:
      'Import investors from CSV text (first row = headers). Columns are auto-mapped from common headers (Name, Firm/Fund/Company, Email, LinkedIn, Type, Check size, Tags, Stage, Fit, Follow up…); pass `mapping` to override ({"Column header": "field" or null to ignore}). Existing investors are matched like add_investor. dry_run defaults to true and returns a preview with counts and per-row actions; show it to the human, then call again with dry_run=false. With `round`, imported investors are added to that round, and the stage, fit, follow-up and amount columns apply.',
    params: [
      { name: "csv", type: "string ≤2 MB", required: true, description: "CSV text with a header row." },
      ROUND_OPTIONAL("Adds imported investors to this round."),
      { name: "mapping", type: "object", description: '{"Column header": "field" | null}.' },
      { name: "default_stage", type: "string", description: "For rows without a stage." },
      { name: "on_duplicate", type: '"skip" | "fill_empty" | "update"', description: "skip (default) leaves existing investors and their round fields untouched; fill_empty fills blanks; update overwrites with non-empty CSV values and applies the round columns." },
      { name: "source", type: "string", description: 'Fills source on rows without one, e.g. "Robotics Demo Night".' },
      { name: "dry_run", type: "boolean", description: "Default true. Nothing is written until false." },
    ],
    output:
      "Dry run: {counts, mapping, warnings, rows} where rows lists only updates, skips, errors and rows with warnings (plain creates are counted). Otherwise: {import_run_id, counts, errors, created: [{row, id, name}]}.",
  },
  {
    name: "export_round",
    title: "Export round",
    access: "read",
    idempotent: true,
    description:
      "Export a round's pipeline: every investor in the round with contact fields, stage, fit, follow-up, amounts and last activity date. format=csv gives spreadsheet-ready text; json gives structured data. Set include_activities to add each investor's timeline (json only).",
    params: [
      ROUND_REQUIRED,
      { name: "format", type: '"json" | "csv"', description: "Default json." },
      { name: "include_activities", type: "boolean", description: "json only. Default false." },
    ],
    output: "{round: {slug, name}, format, filename, row_count, content}. Over 1 MB: payload_too_large with the REST URL to use.",
  },
  {
    name: "schedule_meeting",
    title: "Schedule a meeting",
    access: "write",
    idempotent: true,
    description:
      "Put a future meeting with an investor on the founder's calendar. By default it also moves them to the round's Meeting stage when they are earlier in the pipeline. Scheduling the same investor at the same start again returns the existing meeting, so retries are safe. `source` says where you learned about it (email, calendar); it defaults to agent.",
    params: [
      INVESTOR_REF,
      { name: "starts_at", type: "string", required: true, description: "RFC 3339, or a local time 2026-10-20T11:00 in the workspace timezone." },
      { name: "duration_minutes", type: "integer 5-1440", description: "Default 30." },
      { name: "ends_at", type: "string", description: "Instead of duration_minutes." },
      ROUND_OPTIONAL("Omit to use the investor's only open round (else no round)."),
      { name: "title", type: "string", description: 'Default "Meeting with <name> (<firm>)".' },
      { name: "location", type: "string", description: "Address or place." },
      { name: "video_url", type: "string", description: "Video call link." },
      { name: "agenda", type: "string", description: "What to cover." },
      { name: "guests", type: "string[]", description: "Up to 10 more people from the same firm (investor references)." },
      { name: "source", type: '"manual" | "email" | "agent" | "calendar"', description: "Where the meeting came from. Default agent." },
      { name: "move_to_meeting_stage", type: "boolean", description: "Default true." },
    ],
    output: "{meeting: {id, title, starts_at, local, minutes, status, investor, location?, video_url?, round?, by}, created, changed, moved_stage?: {from?, to}, participant?, warnings?}",
  },
  {
    name: "list_meetings",
    title: "List meetings",
    access: "read",
    idempotent: true,
    description:
      "Meetings with investors, soonest first (past and needs_outcome: latest first). Use it to prepare the founder's day ('today'), and 'needs_outcome' to find meetings that happened but have no outcome yet; record those with complete_meeting.",
    params: [
      { name: "when", type: '"upcoming" | "today" | "week" | "needs_outcome" | "past" | "all"', description: "Default upcoming." },
      { name: "investor", type: "string", description: "Only this investor (as host or guest)." },
      ROUND_OPTIONAL("Only this round's meetings."),
      { name: "status", type: '"scheduled" | "done" | "cancelled" | "no_show"', description: "Filter by status." },
      { name: "limit", type: "integer 1-200", description: "Default 50." },
    ],
    output: "{now, today, timezone, items: [meeting], counts: {returned, needs_outcome}}",
  },
  {
    name: "update_meeting",
    title: "Reschedule or cancel a meeting",
    access: "write",
    idempotent: true,
    description:
      "Reschedule a meeting (new starts_at; the length stays unless you pass duration_minutes or ends_at), edit its details, cancel it (status: cancelled) or mark a no-show. Rescheduling a cancelled or no-show meeting brings it back. Every change stays in the meeting's history and on the timeline. To record how a meeting went, use complete_meeting.",
    params: [
      { name: "meeting_id", type: "string", required: true, description: "From schedule_meeting or list_meetings." },
      { name: "starts_at", type: "string", description: "The new start (RFC 3339 or workspace-local)." },
      { name: "duration_minutes", type: "integer 5-1440", description: "A new length." },
      { name: "ends_at", type: "string", description: "Instead of duration_minutes." },
      { name: "status", type: '"scheduled" | "cancelled" | "no_show"', description: "Cancel, mark a no-show, or reopen." },
      { name: "title, location, video_url, agenda", type: "string", description: "New details." },
      { name: "note", type: "string", description: "Why; shown on the timeline." },
    ],
    output: "{meeting (with history), changed, participant?, warnings?}",
  },
  {
    name: "complete_meeting",
    title: "Record a meeting's outcome",
    access: "write",
    idempotent: true,
    description:
      "Mark a meeting done and record the outcome (logged as a meeting on the investor's timeline). Optionally set the next step and the follow-up date for the investor's round in the same call. Repeating it changes nothing. Use move_stage separately if the meeting moved them further (for example to Diligence).",
    params: [
      { name: "meeting_id", type: "string", required: true, description: "The meeting." },
      { name: "outcome", type: "string", description: "How it went, in plain words." },
      { name: "next_step", type: "string", description: "Saved on the investor's round." },
      { name: "follow_up_on", type: "date", description: "YYYY-MM-DD." },
      { name: "follow_up_in_days", type: "integer 0-365", description: "Instead of follow_up_on." },
      { name: "follow_up_note", type: "string", description: "What the follow-up is for." },
    ],
    output: "{meeting, changed, participant?, warnings?}",
  },
  {
    name: "get_dossier",
    title: "Read an investor's dossier",
    access: "read",
    idempotent: true,
    description:
      "Read an investor's research dossier: the Brief (verdict, why, best way in, opener, risk) and the sections Fit, Recent activity, Thesis & public views, Ways in, Talking points and Red flags. Every claim ends with source refs like [s3] that point into `sources` (url, title, date). `new_since` marks a refresh; `stale` means older than 90 days. `unverified` claims are from model memory, not cited: never present them as facts. `from_your_notes` came only from the founder's own notes: say \"from your notes\", never cite them as public or verified. `reused` names the founder's other workspace whose research (identity and public sources) this dossier reused.",
    params: [
      INVESTOR_REF,
      { name: "version", type: "integer ≥1", description: "An older version (the last 5 are kept)." },
      { name: "section", type: '"brief" | "fit" | "activity" | "thesis" | "ways_in" | "talking_points" | "red_flags" | "all"', description: "One section, or all (default)." },
    ],
    output:
      "{investor: {id, name, firm}, version, date, verdict, author, stale?, sections, sources: [{ref, url, title, date}], unverified?, pending_suggestions?, new_since?: {date, facts}, refresh_offer?}",
  },
  {
    name: "list_research_runs",
    title: "List research runs",
    access: "read",
    idempotent: true,
    description:
      "List research runs, newest first: kind, status, cost in USD, progress and errors (with what to do next). A failed, partial or capped run keeps what it gathered and can be resumed by the founder in the app.",
    params: [
      { name: "investor", type: "string", description: "Investor id, email, LinkedIn URL or exact name." },
      { name: "status", type: '"queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled" | "capped" | "blocked_identity"', description: "Only runs in this status." },
      { name: "kind", type: '"identity" | "dossier" | "refresh" | "prefill" | "agent"', description: "Only runs of this kind." },
      { name: "limit", type: "integer 1–50", description: "Default 20." },
    ],
    output: "{runs: [{id, investor, kind, status, cost_usd?, progress?, step?, error?, dossier_id?, can_resume?}]}",
  },
  {
    name: "research_investor",
    title: "Research an investor",
    access: "write",
    idempotent: true,
    description:
      "Start research on an investor with the workspace's OpenRouter key (it runs in the background; poll list_research_runs, then read get_dossier). Respects the monthly AI limit. Never pays twice: a run already going is returned (reason active), a dossier under 30 days old is returned instead of researching again (created=false, reason fresh: read it with get_dossier; kind=refresh or force=true researches again), and an identity run on a confirmed identity starts nothing (reason identified). When the founder researched the same person in another workspace they own within 30 days, that identity and its public sources are reused and only the writer runs (cheaper; the dossier says \"Reused research from <workspace>\"). Errors: no_ai_key (an owner adds a key in Settings → AI research; or research yourself and use save_dossier), spend_cap_reached, identity_required (call match_identity first).",
    params: [
      INVESTOR_REF,
      { name: "kind", type: '"identity" | "dossier" | "refresh"', description: "identity = find who this is (cheap); dossier (default) = full research; refresh = research again and mark what is new." },
      ROUND_OPTIONAL("The dossier's Fit compares to it."),
      { name: "dry_run", type: "boolean", description: "Only estimate the cost; start nothing." },
      { name: "force", type: "boolean", description: "Pay for new research even though the dossier is under 30 days old (or the identity is confirmed). Only when the founder asks for it." },
    ],
    output: "{id, investor, kind, status, estimate_usd, created, reason?, dossier?, next}; dry run: {dry_run, count, skipped, per_run_usd, total_usd, remaining_usd, fits}",
  },
  {
    name: "match_identity",
    title: "Match an investor's identity",
    access: "write",
    idempotent: true,
    description:
      'Find or confirm who an investor is before deeper research. Without a choice: returns the confirmed identity, the candidates to pick from ("Is this them?"), or starts the cheap identity search. With `pick` (candidate id or rank), `linkedin_url`, or `none`: confirms. Only pick a candidate the human or your own evidence supports.',
    params: [
      INVESTOR_REF,
      { name: "pick", type: "string", description: "A candidate id, or its rank 1-3, from a previous call." },
      { name: "linkedin_url", type: "string", description: "Their LinkedIn profile URL, if you know it." },
      { name: "none", type: "boolean", description: "True: none of the candidates is this investor." },
    ],
    output: "{investor: {id, name}, identity: {status, linkedin_url?, firm?, title?, …}, candidates?: [{id, rank, name, title, firm, linkedin_url, confidence}], run?, next}",
  },
  {
    name: "save_dossier",
    title: "Save a dossier you researched",
    access: "write",
    idempotent: false,
    description:
      'Save a dossier you researched with your own tools (web search, fetch). It costs the workspace nothing and needs no OpenRouter key; it is shown "by <your agent name>". The identity must match the investor\'s confirmed identity when one exists, every fact must cite a page you actually fetched, ways in need public evidence, and only professional information is kept (personal phones, home addresses, family, health, politics and religion are stripped or dropped). Pass `idempotency_key` to make retries safe.',
    params: [
      INVESTOR_REF,
      { name: "dossier", type: "DossierDoc v1", required: true, description: "{identity, sources, facts, analysis, suggestions?, unverified?}. See Investor research in the docs." },
      ROUND_OPTIONAL("The round the Fit and fit suggestion apply to."),
      { name: "idempotency_key", type: "string", description: "Retries with the same key return the first result." },
    ],
    output: "{dossier_id, version, by, kept: {facts, sources_accepted}, dropped: [{key, reason}], sources_rejected, privacy_removed, suggestions: {applied, suggested}, new_facts, repeated?}",
  },
];

/** Research tools are served only with RAISEBOOK_RESEARCH_ENABLED (unreleased, off by default). */
export const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_dossier",
  "list_research_runs",
  "research_investor",
  "match_identity",
  "save_dossier",
]);

/** The tools every server serves today: the public reference lists only these. */
export const SHIPPED_MCP_TOOLS: McpTool[] = MCP_TOOLS.filter((t) => !RESEARCH_TOOL_NAMES.has(t.name));
