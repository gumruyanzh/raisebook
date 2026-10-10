/**
 * Fictional data for the /design inventory. Every person, firm and email here is made up
 * (SYSTEM §6, SPEC §8.5). Never put real investors in this file.
 */
import type { Activity, StageColor } from "@/lib/api/types";

export const TODAY = "2026-10-10";
export const NOW = new Date("2026-10-10T18:30:00Z");
export const TZ = "America/Los_Angeles";

export const STAGES: { key: string; label: string; color: StageColor; count: number }[] = [
  { key: "new", label: "New", color: "slate", count: 12 },
  { key: "research", label: "Researching", color: "violet", count: 8 },
  { key: "contacted", label: "Contacted", color: "cobalt", count: 9 },
  { key: "replied", label: "Replied", color: "teal", count: 4 },
  { key: "meeting", label: "Meeting", color: "amber", count: 6 },
  { key: "dd", label: "Diligence", color: "orange", count: 2 },
  { key: "committed", label: "Committed", color: "green", count: 4 },
  { key: "passed", label: "Passed", color: "gray", count: 7 },
];

export interface SampleCard {
  id: string;
  name: string;
  title: string;
  firm: string;
  fit: number;
  type: string;
  industry: string;
  extraTags: number;
  followUpOn?: string;
  followUpState?: "overdue" | "today" | "soon" | "later";
  amount?: number;
  soft?: boolean;
  nextStep?: string;
  agent?: string;
  stage: string;
}

export const CARDS: SampleCard[] = [
  {
    id: "i1",
    name: "Dana Whitfield",
    title: "Partner",
    firm: "Harbor Light Ventures",
    fit: 5,
    type: "VC",
    industry: "Robotics",
    extraTags: 2,
    followUpOn: "2026-10-08",
    followUpState: "overdue",
    nextStep: "Send the data room link",
    agent: "Moved by claude-code 2h ago",
    stage: "dd",
  },
  {
    id: "i2",
    name: "Marcus Odell",
    title: "Angel",
    firm: "Juniper Angels",
    fit: 4,
    type: "Angel",
    industry: "Hardware",
    extraTags: 0,
    followUpOn: "2026-10-14",
    followUpState: "soon",
    amount: 50_000,
    soft: true,
    stage: "meeting",
  },
  {
    id: "i3",
    name: "Priya Castellano",
    title: "Principal",
    firm: "Northgate Field Partners",
    fit: 3,
    type: "VC",
    industry: "Industrial",
    extraTags: 1,
    followUpOn: TODAY,
    followUpState: "today",
    stage: "contacted",
  },
  {
    id: "i4",
    name: "Theo Brandvold",
    title: "Managing Director",
    firm: "Fernhill Family Office",
    fit: 4,
    type: "Family Office",
    industry: "Logistics",
    extraTags: 0,
    amount: 250_000,
    stage: "committed",
  },
  {
    id: "i5",
    name: "Lena Okafor-Reyes",
    title: "Scout",
    firm: "Copperline Capital",
    fit: 2,
    type: "Scout",
    industry: "Automation",
    extraTags: 0,
    stage: "contacted",
  },
];

const agent = { type: "agent", label: "claude-code", agent_model: "claude-opus-4-5", via: "mcp" } as const;
const user = { type: "user", label: "Sam Rivera", via: "web" } as const;
const system = { type: "system", label: "Raisebook", via: "system" } as const;

function act(
  id: string,
  kind: Activity["kind"],
  occurred_at: string,
  actor: Activity["actor"],
  data: Record<string, unknown> = {},
  body?: string,
): Activity {
  return {
    id,
    investor_id: "i1",
    investor_name: "Dana Whitfield",
    round_id: "r1",
    round_slug: "seed",
    kind,
    occurred_at,
    body: body ?? null,
    data,
    actor,
    created_at: occurred_at,
    deletable: ["note", "email", "call", "meeting"].includes(kind),
  };
}

export const ACTIVITIES: Activity[] = [
  act("a1", "follow_up_set", "2026-10-10T17:42:00Z", { ...agent }, { to: "2026-10-16" }),
  act(
    "a2",
    "stage_change",
    "2026-10-10T17:41:00Z",
    { ...agent },
    { from: { key: "meeting", label: "Meeting" }, to: { key: "dd", label: "Diligence" } },
    "She asked for the data room after the demo.",
  ),
  act(
    "a3",
    "meeting",
    "2026-10-10T17:40:00Z",
    { ...agent },
    {},
    "Met Dana at Harbor Light's office. Walked through the pick-and-place demo; she wants the data room and two customer references.",
  ),
  act("a4", "call", "2026-10-08T20:15:00Z", { ...user }, { direction: "outbound" }, "Intro call. Interested in the warehouse pilot numbers."),
  act("a5", "commitment", "2026-10-07T16:00:00Z", { ...user }, { amount: 250000, currency: "USD", committed_on: "2026-10-07" }),
  act("a6", "investor_created", "2026-10-01T12:00:00Z", { ...system }),
];

export const MCP_SNIPPETS = [
  {
    label: "Claude Code",
    lang: "shell" as const,
    code: `claude mcp add --transport http raisebook https://api.raisebook.org/mcp \\
  --header "Authorization: Bearer rb_live_…" --header "X-Agent-Name: claude-code"`,
    caption: "Run in your terminal. Replace rb_live_… with your key.",
  },
  {
    label: "Codex",
    lang: "toml" as const,
    code: `[mcp_servers.raisebook]
url = "https://api.raisebook.org/mcp"
bearer_token_env_var = "RAISEBOOK_API_KEY"
http_headers = { "X-Agent-Name" = "codex" }`,
    caption: "~/.codex/config.toml",
  },
  {
    label: "Cursor",
    lang: "json" as const,
    code: `{"mcpServers": {"raisebook": {"url": "https://api.raisebook.org/mcp",
  "headers": {"Authorization": "Bearer \${env:RAISEBOOK_API_KEY}", "X-Agent-Name": "cursor"}}}}`,
    caption: ".cursor/mcp.json or ~/.cursor/mcp.json",
  },
];
