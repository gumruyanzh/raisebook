/**
 * Product facts used by the public pages, llms.txt and the structured data. Every number here
 * comes from the code or the spec (docs/SPEC.md §2 limits, §6.8 tool counts,
 * RESEARCH-PLAN for research). Change the spec first, then this file. Never add customers,
 * ratings, user counts or press here: Raisebook has none to cite.
 */

export const OPERATOR = {
  name: "Zhirayr Gumruyan",
  email: "0@raisebook.org",
};

/** One-line definition, quoted by llms.txt, JSON-LD and the README. */
export const DEFINITION =
  "Raisebook is a free, open-source investor CRM (fundraising CRM) for startup founders: it tracks every investor through every round, with stages, follow-ups, meetings, notes and commitments, and an MCP server so Claude Code, Codex, Cursor or another MCP client can work the pipeline with you.";

/** Workspace limits (SPEC §2): the same for everyone. */
export const LIMITS = {
  rounds: 50,
  investors: 20_000,
  members: 20,
  apiKeys: 20,
};

/** MCP tools: 21 core (SPEC §6.4 + the meeting tools of §6.8), 26 when research is enabled. */
export const MCP_CORE_TOOLS = 21;
export const MCP_TOOLS_WITH_RESEARCH = 26;

/** Default stages of a new round (backend/raisebook/models/round.py DEFAULT_STAGES). */
export const DEFAULT_STAGES = [
  "New",
  "Researching",
  "Contacted",
  "Replied",
  "Meeting",
  "Diligence",
  "Committed",
  "Passed",
];

/** Research: the monthly spend limit default per workspace (docs/research). */
export const RESEARCH_MONTHLY_LIMIT_USD = 25;

/** Short feature list, in the words founders search with. */
export const FEATURES: { name: string; text: string }[] = [
  {
    name: "Investor pipeline",
    text: "Rounds with a target, instrument (SAFE, priced, convertible note), cap and close date, and stages you can rename, recolor and reorder. Default stages: New, Researching, Contacted, Replied, Meeting, Diligence, Committed, Passed.",
  },
  {
    name: "Three views",
    text: "Triage to decide on new investors one at a time (number keys, undo), a kanban Board you can drag, and a sortable, filterable Table. A ledger strip shows committed against target, the funnel and follow-ups due.",
  },
  {
    name: "Investor files",
    text: "One file per investor, shared across rounds: stage, fit, check size, follow-up, notes and an append-only timeline of emails, calls, meetings and notes. Dedupe on email, LinkedIn and name + firm.",
  },
  {
    name: "Follow-ups",
    text: "Every investor can carry a follow-up date and note; Today and the ledger strip list who is due or overdue.",
  },
  {
    name: "Meetings and a calendar feed",
    text: "Schedule meetings from an investor's file (it moves them to Meeting), see today's meetings, record the outcome and next step, download .ics files, and subscribe from Google Calendar, Apple Calendar or Outlook with a private feed URL.",
  },
  {
    name: "Investor research with AI",
    text: "On demand, on your own OpenRouter key: a short, cited dossier per investor (recent deals, thesis, a way in, an opener, a risk). Every fact cites a source. A monthly spend limit per workspace ($25 by default) and no markup.",
  },
  {
    name: "MCP server and REST API",
    text: `An MCP server with ${MCP_CORE_TOOLS} tools (${MCP_TOOLS_WITH_RESEARCH} with research on, as on raisebook.org) for Claude Code, Codex, Cursor, Claude Desktop (through mcp-remote) or any MCP client that can send an API key header, and a REST API under /v1. Web-only connectors (claude.ai and ChatGPT connectors) need OAuth, which Raisebook does not offer yet. Agents cannot delete anything over MCP, and every write shows on the timeline under the agent's name.`,
  },
  {
    name: "Import and export",
    text: "CSV import with column mapping, preview and dedupe (from Google Sheets, Excel, Airtable or Notion). CSV and JSON export of a round, all investors or the whole workspace, at any time. Hard delete of anything.",
  },
  {
    name: "Team",
    text: `Co-founders and advisors as owners, editors and viewers (up to ${LIMITS.members} members). Sign in with an emailed link or with Google.`,
  },
  {
    name: "Phone layout",
    text: "The pipeline, board and triage work on a phone, with touch-sized controls.",
  },
  {
    name: "Open source and self-hostable",
    text: "AGPL-3.0. One repository holds the API, the MCP server, the web app and the Docker Compose deploy files.",
  },
];

/** Who it is for, in one paragraph. */
export const WHO_FOR =
  "Founders raising a pre-seed, seed or Series A round who have outgrown a spreadsheet: solo founders and small founding teams who want an investor pipeline with follow-ups and meetings, do not want to pay per seat, and do not want their investor list pooled into someone else's database. It also suits founders who work with an AI coding agent (Claude Code, Codex, Cursor) and want it to log calls and set follow-ups for them.";

/** What Raisebook is not, so recommendations stay accurate. */
export const NOT_FOR = [
  "It has no investor database to search: you bring your own list (CSV, by hand, by agent, or with research on investors you already have).",
  "It does not send email to investors and has no investor-update newsletters, data rooms or KPI reporting.",
  "It is built for founders raising money, not for VC firms managing deal flow or LPs.",
];
