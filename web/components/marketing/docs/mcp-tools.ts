/**
 * The 15 MCP tools (SPEC §6.4). Descriptions are the binding tool description text, word for
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
      "{workspace: {id, name, slug, is_sandbox, timezone, today, default_currency}, you: {agent_name, scopes, key_prefix}, rounds: [{id, slug, name, status, currency, target_amount, stages: [{key, label, kind}]}], investor_types, loggable_activity_kinds}",
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
      "Add an investor contact, or return the existing one. Dedupes by email, then LinkedIn profile, then name+firm; `matched_on` tells you which. on_duplicate: return_existing (default, changes nothing), fill_empty (fill only fields that are empty, merge tags), create_anyway (ignore a name+firm match; email/LinkedIn duplicates are never created). Pass `round` (and optionally `stage`, `fit`) to also put them on that round's board. Leave unknown fields out.",
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
      { name: "on_duplicate", type: '"return_existing" | "fill_empty" | "create_anyway"', description: "Default return_existing." },
      ROUND_OPTIONAL("Also adds the investor to this round."),
      { name: "stage", type: "string", description: "Stage in that round. Default: the first stage." },
      { name: "fit", type: "integer 0-5", description: "Fit in that round." },
    ],
    output: "{investor, created, matched_on?: email | linkedin | name_firm, filled_fields?, participant?}",
    example: '{"name": "Dana Whitfield", "firm": "Harbor Light Ventures", "email": "dana@example.com", "type": "vc", "round": "seed", "stage": "research", "fit": 4}',
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
      "Follow-ups that are due: overdue first, then today, then (with within_days > 0) the next N days. Without `round`, it covers all open rounds. Use it to plan the founder's outreach for the day.",
    params: [
      ROUND_OPTIONAL("Omit to cover all open rounds."),
      { name: "within_days", type: "integer 0-60", description: "Default 0 (overdue and today only)." },
      { name: "include_overdue", type: "boolean", description: "Default true." },
      { name: "limit", type: "integer 1-200", description: "Default 50." },
    ],
    output: "{today, items: FollowUpItem[], counts: {overdue, today, upcoming}}",
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
      { name: "on_duplicate", type: '"skip" | "fill_empty" | "update"', description: "Default skip." },
      { name: "source", type: "string", description: 'Fills source on rows without one, e.g. "Robotics Demo Night".' },
      { name: "dry_run", type: "boolean", description: "Default true. Nothing is written until false." },
    ],
    output: "Dry run: ImportPreview (rows cut to 50). Otherwise: ImportResult {import_run_id, counts, errors}.",
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
];
