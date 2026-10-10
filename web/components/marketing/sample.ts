/**
 * Fictional data for the landing page vignettes. Every person, firm and email here is made up
 * (SYSTEM §6, SPEC §8.5). Never put a real investor, founder or firm in this file.
 *
 * The vignettes are frozen at TODAY so the page renders the same on every build.
 */
import type { Activity, FollowUpState, StageColor } from "@/lib/api/types";

export const TODAY = "2026-10-10";
/** 4:50 PM in the sample workspace timezone. */
export const NOW_ISO = "2026-10-10T23:50:00Z";
export const TZ = "America/Los_Angeles";
export const CURRENCY = "USD";

export const WORKSPACE = "Kestrel Robotics";
export const ROUND = "Seed";

export interface SampleStage {
  key: string;
  label: string;
  color: StageColor;
  count: number;
}

export const STAGES: SampleStage[] = [
  { key: "new", label: "New", color: "slate", count: 12 },
  { key: "research", label: "Researching", color: "violet", count: 8 },
  { key: "contacted", label: "Contacted", color: "cobalt", count: 9 },
  { key: "replied", label: "Replied", color: "teal", count: 4 },
  { key: "meeting", label: "Meeting", color: "amber", count: 6 },
  { key: "dd", label: "Diligence", color: "orange", count: 2 },
  { key: "committed", label: "Committed", color: "green", count: 4 },
  { key: "passed", label: "Passed", color: "gray", count: 7 },
];

export const LEDGER = {
  roundName: ROUND,
  currency: CURRENCY,
  committed: 750_000,
  target: 2_000_000,
  inConversation: 21,
  committedCount: 4,
  softCircled: 410_000,
  daysToClose: 41,
  funnel: STAGES,
  due: [
    { id: "d1", name: "Priya Castellano", state: "today" as const },
    { id: "d2", name: "Bram Ellery", state: "overdue" as const },
    { id: "d3", name: "Sol Whitaker-Ames", state: "overdue" as const },
  ],
  dueTotal: 5,
};

export interface SampleCard {
  id: string;
  name: string;
  title?: string;
  firm?: string;
  fit: number;
  type: string;
  industry?: string;
  extraTags?: number;
  followUpOn?: string;
  followUpState?: FollowUpState;
  amount?: number;
  soft?: boolean;
  nextStep?: string;
  agentTip?: string;
}

export interface SampleColumn {
  key: string;
  label: string;
  color: StageColor;
  count: number;
  won?: boolean;
  cards: SampleCard[];
}

export const HERO_COLUMNS: SampleColumn[] = [
  {
    key: "contacted",
    label: "Contacted",
    color: "cobalt",
    count: 9,
    cards: [
      {
        id: "c1",
        name: "Priya Castellano",
        title: "Principal",
        firm: "Northgate Field Partners",
        fit: 4,
        type: "VC",
        industry: "Industrial",
        followUpOn: TODAY,
        followUpState: "today",
      },
      {
        id: "c2",
        name: "Ansel Pruitt-Kova",
        title: "Partner",
        firm: "Saltmarsh Ventures",
        fit: 3,
        type: "VC",
        industry: "Robotics",
        extraTags: 1,
      },
      {
        id: "c3",
        name: "Lena Okafor-Reyes",
        title: "Scout",
        firm: "Copperline Fund",
        fit: 2,
        type: "Scout",
        industry: "Automation",
      },
    ],
  },
  {
    key: "meeting",
    label: "Meeting",
    color: "amber",
    count: 6,
    cards: [
      {
        id: "m1",
        name: "Hollis Brande",
        title: "General Partner",
        firm: "Tidewater Works",
        fit: 5,
        type: "VC",
        industry: "Hardware",
        nextStep: "Second meeting with their robotics lead",
      },
      {
        id: "m2",
        name: "Marcus Odell",
        title: "Angel",
        firm: "Juniper Angels",
        fit: 4,
        type: "Angel",
        industry: "Hardware",
        followUpOn: "2026-10-14",
        followUpState: "soon",
        amount: 50_000,
        soft: true,
      },
      {
        id: "m3",
        name: "Ines Varga-Holm",
        title: "Associate",
        firm: "Lowfield Capital",
        fit: 3,
        type: "VC",
        industry: "Logistics",
      },
    ],
  },
  {
    key: "dd",
    label: "Diligence",
    color: "orange",
    count: 2,
    cards: [
      {
        id: "x1",
        name: "Dana Whitfield",
        title: "Partner",
        firm: "Harbor Light Ventures",
        fit: 5,
        type: "VC",
        industry: "Robotics",
        extraTags: 2,
        followUpOn: "2026-10-16",
        followUpState: "soon",
        nextStep: "Send the data room link",
        agentTip: "Moved by claude-code 2h ago",
      },
      {
        id: "x2",
        name: "Rafael Quist",
        title: "Director",
        firm: "Ostrava Industrial CVC",
        fit: 4,
        type: "Corporate VC",
        industry: "Manufacturing",
        amount: 150_000,
        soft: true,
      },
    ],
  },
  {
    key: "committed",
    label: "Committed",
    color: "green",
    count: 4,
    won: true,
    cards: [
      {
        id: "w1",
        name: "Theo Brandvold",
        title: "Managing Director",
        firm: "Fernhill Family Office",
        fit: 4,
        type: "Family Office",
        industry: "Logistics",
        amount: 250_000,
      },
      {
        id: "w2",
        name: "Noor Haddad-Lin",
        title: "Partner",
        firm: "Kiln Street Capital",
        fit: 5,
        type: "VC",
        industry: "Robotics",
        amount: 200_000,
      },
      {
        id: "w3",
        name: "Wes Arkwright",
        title: "Angel",
        firm: "Juniper Angels",
        fit: 3,
        type: "Angel",
        industry: "Hardware",
        amount: 175_000,
      },
    ],
  },
];

/* ---------------- the agent example (one conversation, three tool calls) ---------------- */

export const AGENT_PROMPT =
  "Met Dana from Harbor Light today, she wants the data room. Move her to Diligence and remind me Friday.";

export interface TranscriptCall {
  tool: string;
  args: [string, string][];
  result: string;
}

export const TRANSCRIPT: TranscriptCall[] = [
  {
    tool: "log_activity",
    args: [
      ["investor", '"Dana Whitfield @ Harbor Light Ventures"'],
      ["kind", '"meeting"'],
      ["body", '"Intro meeting. Wants the data room before their Monday partner meeting."'],
    ],
    result: "Logged a meeting on Dana Whitfield's timeline.",
  },
  {
    tool: "move_stage",
    args: [
      ["investor", '"Dana Whitfield"'],
      ["stage", '"dd"'],
    ],
    result: "Seed: Meeting → Diligence",
  },
  {
    tool: "set_follow_up",
    args: [
      ["investor", '"Dana Whitfield"'],
      ["on", '"2026-10-16"'],
      ["note", '"Send the data room link"'],
    ],
    result: "Follow-up set for Fri Oct 16.",
  },
];

export const AGENT_REPLY =
  "Done. Dana is in Diligence, the meeting is on her timeline, and she will show up under Follow up now on Friday.";

const agent = {
  type: "agent",
  label: "claude-code",
  agent_model: "claude-opus-4-5",
  via: "mcp",
} as const;

function act(
  id: string,
  kind: Activity["kind"],
  at: string,
  data: Record<string, unknown>,
  body?: string,
): Activity {
  return {
    id,
    investor_id: "x1",
    investor_name: "Dana Whitfield",
    round_id: "r1",
    round_slug: "seed",
    kind,
    occurred_at: at,
    body: body ?? null,
    data,
    actor: { ...agent },
    created_at: at,
    deletable: kind === "meeting",
  };
}

/** Newest first, as the API returns them. */
export const AGENT_TIMELINE: Activity[] = [
  act("a3", "follow_up_set", "2026-10-10T21:42:00Z", { to: "2026-10-16", note: "Send the data room link" }),
  act("a2", "stage_change", "2026-10-10T21:42:00Z", {
    from: { key: "meeting", label: "Meeting" },
    to: { key: "dd", label: "Diligence" },
  }),
  act(
    "a1",
    "meeting",
    "2026-10-10T21:41:00Z",
    {},
    "Intro meeting. Wants the data room before their Monday partner meeting.",
  ),
];

/* ---------------- section 5: table rows and the sheet ---------------- */

export interface SampleRow {
  name: string;
  title: string;
  firm: string;
  stage: { label: string; color: StageColor };
  fit: number;
  followUp?: { on: string; state: FollowUpState };
  committed?: number;
}

export const TABLE_ROWS: SampleRow[] = [
  {
    name: "Dana Whitfield",
    title: "Partner",
    firm: "Harbor Light Ventures",
    stage: { label: "Diligence", color: "orange" },
    fit: 5,
    followUp: { on: "2026-10-16", state: "soon" },
  },
  {
    name: "Theo Brandvold",
    title: "Managing Director",
    firm: "Fernhill Family Office",
    stage: { label: "Committed", color: "green" },
    fit: 4,
    committed: 250_000,
  },
  {
    name: "Bram Ellery",
    title: "Partner",
    firm: "Quarry Lane Partners",
    stage: { label: "Replied", color: "teal" },
    fit: 3,
    followUp: { on: "2026-10-07", state: "overdue" },
  },
];

/* ---------------- section 6: spreadsheet column mapping ---------------- */

export const MAPPING: { header: string; sample: string; field: string; round?: boolean }[] = [
  { header: "Full name", sample: "Dana Whitfield", field: "name" },
  { header: "Fund", sample: "Harbor Light Ventures", field: "firm" },
  { header: "E-mail", sample: "dana@example.com", field: "email" },
  { header: "Cheque size", sample: "$250k-$1M", field: "check_note" },
  { header: "Met at", sample: "Robotics Demo Night", field: "source" },
  { header: "Status", sample: "Meeting", field: "stage", round: true },
  { header: "Priority", sample: "hot", field: "fit", round: true },
];

export const IMPORT_COUNTS = [
  { label: "Create", n: 140 },
  { label: "Update", n: 12 },
  { label: "Skip", n: 30 },
  { label: "Errors", n: 3 },
  { label: "Add to Seed", n: 182 },
];
