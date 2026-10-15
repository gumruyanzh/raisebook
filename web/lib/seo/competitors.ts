/**
 * Comparison pages (/compare/*). Competitor facts come only from the competitor's own public
 * pages, linked in `sources`, as they read on COMPARE_CHECKED_ON. Re-check every source before
 * changing a number. No ratings, no claims about quality: prices, limits, licence, hosting and
 * documented features only.
 */

import { LIMITS, MCP_CORE_TOOLS } from "./facts";

export const COMPARE_CHECKED_ON = "2026-10-15";

export interface Source {
  label: string;
  url: string;
}

export interface CompareRow {
  label: string;
  /** One cell per column, Raisebook first. */
  cells: string[];
}

export interface Comparison {
  slug: string;
  /** Short name used in links: "Foundersuite". */
  name: string;
  /** Column headers after "Raisebook". */
  columns: string[];
  /** Search phrase the page answers ("Foundersuite alternative"). */
  phrase: string;
  /** Answer-first paragraph, quotable on its own. */
  answer: string;
  rows: CompareRow[];
  /** When the other tool is the better choice. Fair, specific. */
  chooseThem: string[];
  chooseRaisebook: string[];
  faq: { q: string; a: string }[];
  sources: Source[];
}

const RB_PRICE = "$0. No paid tier, no seat price";
const RB_LIMITS = `${LIMITS.rounds} rounds, ${LIMITS.investors.toLocaleString("en-US")} investors, ${LIMITS.members} members per workspace, the same for everyone`;
const RB_OPEN = "Yes, AGPL-3.0";
const RB_SELF = "Yes, Docker Compose";
const RB_MCP = `Yes, ${MCP_CORE_TOOLS} tools on the free plan (no deletes over MCP)`;
const RB_DATA = "No investor database; your list is never pooled, sold or shown to another workspace";

export const COMPARISONS: Comparison[] = [
  {
    slug: "foundersuite",
    name: "Foundersuite",
    columns: ["Foundersuite"],
    phrase: "Foundersuite alternative",
    answer:
      "Raisebook is a free, open-source alternative to Foundersuite for founders who already have (or can build) their investor list and want an investor CRM without a cap. Foundersuite's free Basic plan tracks up to 75 investors per pipeline and its paid plans run $745 to $1,609 a year, with access to its investor database. Raisebook has no investor database, but it is $0 with every feature, tracks up to 20,000 investors per workspace, can be self-hosted, and has an MCP server so an AI agent can update the pipeline.",
    rows: [
      { label: "Price", cells: [RB_PRICE, "Basic $0; Silver $745/yr; Gold $1,069/yr; Platinum $1,609/yr (billed annually)"] },
      { label: "Free plan limit", cells: [RB_LIMITS, "75 investors per pipeline on Basic"] },
      { label: "Paid plan limits", cells: ["None: there are no paid plans", "200 (Silver), 1,000 (Gold), 1,500 (Platinum) investors per pipeline"] },
      { label: "Investor database", cells: ["No. Bring your list; research investors you already have", "Yes, on every plan"] },
      { label: "Open source", cells: [RB_OPEN, "No"] },
      { label: "Self-hosting", cells: [RB_SELF, "No"] },
      { label: "MCP server for AI agents", cells: [RB_MCP, "Not listed on its pricing page"] },
      { label: "Your data", cells: [RB_DATA, "See Foundersuite's own terms"] },
    ],
    chooseThem: [
      "You need a database of investors to find names you do not have yet.",
      "You want investor-update and outreach tools in the same product.",
    ],
    chooseRaisebook: [
      "Your list is longer than 75 investors and you do not want to pay $745+ a year.",
      "You want the code open, the option to self-host, and a promise that your investor list is never pooled.",
      "You want Claude Code, Codex or Cursor to log calls and set follow-ups over MCP.",
    ],
    faq: [
      {
        q: "Is Raisebook a free Foundersuite alternative?",
        a: "Yes. Raisebook costs $0 with no paid tier and tracks up to 20,000 investors per workspace. It does not include an investor database, which Foundersuite does.",
      },
      {
        q: "Can I move my Foundersuite pipeline to Raisebook?",
        a: "Export your investors as CSV and import the file in Raisebook. You map the columns, preview what will be created, updated or skipped, and only then write. Duplicates are matched on email, LinkedIn and name + firm.",
      },
    ],
    sources: [{ label: "Foundersuite pricing", url: "https://foundersuite.com/pricing" }],
  },
  {
    slug: "visible",
    name: "Visible",
    columns: ["Visible"],
    phrase: "Visible.vc alternative",
    answer:
      "Raisebook is a free, open-source alternative to Visible for the investor-pipeline part of fundraising. Visible combines a fundraising CRM with investor updates, pitch decks, data rooms and KPI reporting; its free Starter plan includes 2 pipelines and 100 update recipients, and paid plans start at $59 a month billed annually. Raisebook does only the pipeline (rounds, stages, follow-ups, meetings, notes, commitments) with every feature at $0, open source code and an MCP server on the free plan. If you also need investor updates and data rooms, Visible covers more.",
    rows: [
      { label: "Price", cells: [RB_PRICE, "Starter $0; Base $59/mo, Core $129/mo, Growth $199/mo (annual billing); $69, $149, $249 billed monthly"] },
      { label: "Free plan limit", cells: [RB_LIMITS, "Starter: 2 pipelines, 100 update recipients, 2 users, 1 data room (25 files)"] },
      { label: "Scope", cells: ["Investor pipeline: rounds, stages, follow-ups, meetings, notes, commitments, research", "Fundraising CRM plus investor updates, decks, data rooms and KPI reporting"] },
      { label: "Open source", cells: [RB_OPEN, "No"] },
      { label: "Self-hosting", cells: [RB_SELF, "No"] },
      { label: "MCP server for AI agents", cells: [RB_MCP, "Yes; listed among AI features on its pricing page"] },
      { label: "Your data", cells: [RB_DATA, "See Visible's own terms"] },
    ],
    chooseThem: [
      "You want investor updates, a data room and KPI reporting in the same tool as the pipeline.",
      "You run investor relations after the round, not just the raise.",
    ],
    chooseRaisebook: [
      "You only need the investor pipeline and want more than 2 pipelines without paying.",
      "You want open source code and the option to self-host.",
      "You want an MCP server without a paid plan.",
    ],
    faq: [
      {
        q: "Does Raisebook send investor updates like Visible?",
        a: "No. Raisebook never emails anyone on your behalf. It tracks the raise: who you talked to, what stage they are in, the next follow-up, meetings and commitments.",
      },
      {
        q: "Do both have an MCP server?",
        a: `Yes. Visible lists an MCP server among its AI features. Raisebook's MCP server has ${MCP_CORE_TOOLS} tools, is on the free plan, and is open source.`,
      },
    ],
    sources: [
      { label: "Visible pricing", url: "https://visible.vc/pricing/" },
      { label: "Visible MCP server", url: "https://visible.vc/mcp-server/" },
    ],
  },
  {
    slug: "affinity",
    name: "Affinity",
    columns: ["Affinity"],
    phrase: "Affinity alternative for founders",
    answer:
      "Affinity is a relationship-intelligence CRM built for investment firms (venture capital, private equity, family offices) and priced from $2,000 per user per year, billed annually, with no free plan listed. Raisebook is built for the other side of the table: founders raising a round. It is free, open source, and tracks investors through stages, follow-ups and meetings, with an MCP server for AI agents. A founder who wants Affinity-style tracking for a seed round without a per-seat contract can use Raisebook.",
    rows: [
      { label: "Price", cells: [RB_PRICE, "Essential $2,000, Scale $2,300, Advanced $2,700 per user per year; Enterprise custom (billed annually)"] },
      { label: "Free plan", cells: ["Yes: the whole product is free", "None listed"] },
      { label: "Built for", cells: ["Founders raising a round", "\"The CRM built for deal teams\": VC, PE, private credit, banking, family offices"] },
      { label: "Open source", cells: [RB_OPEN, "No"] },
      { label: "Self-hosting", cells: [RB_SELF, "No"] },
      { label: "Your data", cells: [RB_DATA, "See Affinity's own terms"] },
    ],
    chooseThem: [
      "You are an investment firm managing deal flow and relationships across a team.",
      "You want relationship intelligence built from your team's email and calendars.",
    ],
    chooseRaisebook: [
      "You are a founder raising money and need a pipeline, not a firm-wide deal-flow system.",
      "You do not want a per-user annual contract.",
      "You want the code open and your data exportable at any time.",
    ],
    faq: [
      {
        q: "Is there a free Affinity alternative for startups?",
        a: "Raisebook is free with no paid tier. It is a fundraising CRM for founders, so it tracks the investors you are raising from rather than a VC firm's deal flow.",
      },
    ],
    sources: [{ label: "Affinity pricing", url: "https://www.affinity.co/pricing" }],
  },
  {
    slug: "attio-folk",
    name: "Attio and folk",
    columns: ["Attio", "folk"],
    phrase: "Attio or folk for fundraising",
    answer:
      "Attio and folk are general-purpose CRMs that many founders adapt for fundraising with a custom pipeline. Attio's free plan allows up to 3 seats and paid plans start at $35 per seat per month (annual); folk starts at $24 per member per month (annual) after a 14-day trial. Raisebook is built only for fundraising: rounds with targets and instruments, investor stages, follow-ups, meetings and commitments come set up, it is free for up to 20 members, open source, and has an MCP server. If you also need a sales CRM, Attio or folk can do both jobs.",
    rows: [
      { label: "Price", cells: [RB_PRICE, "Free; Plus $35, Pro $79 per seat/mo annual ($44, $99 monthly)", "Standard $24, Premium $48 per member/mo annual ($30, $60 monthly); Enterprise from $80"] },
      { label: "Free plan", cells: [RB_LIMITS, "Up to 3 seats, 50,000 records", "No free plan; 14-day trial"] },
      { label: "Made for", cells: ["Fundraising only: rounds, investor stages, commitments", "General CRM you configure", "General relationship CRM you configure"] },
      { label: "Open source", cells: [RB_OPEN, "No", "No"] },
      { label: "Self-hosting", cells: [RB_SELF, "No", "No"] },
      { label: "MCP server for AI agents", cells: [RB_MCP, "Yes (mcp.attio.com)", "Yes, hosted by folk"] },
    ],
    chooseThem: [
      "You want one CRM for sales, hiring and fundraising.",
      "You want email and calendar sync and contact enrichment.",
    ],
    chooseRaisebook: [
      "You want a fundraising pipeline that works on day one, with round targets, instruments and commitments.",
      "You have more than 3 people on the raise and do not want to pay per seat.",
      "You want the code open and the option to self-host.",
    ],
    faq: [
      {
        q: "Can I use Attio as an investor CRM?",
        a: "Yes, by building a fundraising pipeline in it. Raisebook gives you that pipeline ready-made, with round targets, instruments, commitments and follow-ups, free.",
      },
    ],
    sources: [
      { label: "Attio pricing", url: "https://attio.com/pricing" },
      { label: "Attio MCP", url: "https://mcp.attio.com/" },
      { label: "folk pricing", url: "https://www.folk.app/pricing" },
      { label: "folk MCP", url: "https://www.folk.app/articles/folk-crm-mcp-review" },
    ],
  },
  {
    slug: "spreadsheet",
    name: "a spreadsheet or Notion template",
    columns: ["Google Sheets / Excel", "Notion or Airtable template"],
    phrase: "investor tracker spreadsheet vs investor CRM",
    answer:
      "A spreadsheet or a Notion or Airtable template is the usual first investor tracker, and it works for a short list. It gets hard to keep current as the list grows: follow-ups slip, notes scatter, duplicates creep in and the history of who said what is lost. Raisebook is a free investor CRM that imports the same CSV, then adds stages, follow-up dates, meetings, an append-only timeline per investor, dedupe and an MCP server, while staying exportable to CSV and JSON at any time.",
    rows: [
      { label: "Price", cells: [RB_PRICE, "Free (Google Sheets) or part of Microsoft 365", "Free plans exist; templates vary"] },
      { label: "Stages and pipeline view", cells: ["Built in: Triage, kanban Board, Table", "Columns you maintain", "Board and table views you build"] },
      { label: "Follow-up reminders", cells: ["Follow-up date and note per investor; Today lists who is due", "Manual (conditional formatting)", "Manual (date fields and filters)"] },
      { label: "History per investor", cells: ["Append-only timeline of calls, emails, meetings, notes", "Overwritten cells", "Page notes"] },
      { label: "Dedupe", cells: ["On email, LinkedIn, name + firm", "Manual", "Manual"] },
      { label: "Meetings and calendar feed", cells: ["Yes, with .ics and a private feed for Google, Apple or Outlook", "No", "Not built in"] },
      { label: "Export", cells: ["CSV and JSON, any time", "Yes", "Yes"] },
    ],
    chooseThem: ["You are contacting fewer than a couple of dozen investors and want nothing new to learn."],
    chooseRaisebook: [
      "Your list is past the point where you remember who needs a follow-up.",
      "A co-founder or advisor works on the raise with you.",
      "You want your coding agent to log calls and set follow-ups.",
    ],
    faq: [
      {
        q: "Can I import my investor spreadsheet?",
        a: "Yes. Export it as CSV and drop it in. Raisebook reads common headers (Name, Fund, E-mail, Cheque size, Met at, Status), lets you map the rest, and previews every row before writing.",
      },
      {
        q: "Can I go back to a spreadsheet later?",
        a: "Yes. Export any round or the whole workspace as CSV or JSON at any time.",
      },
    ],
    sources: [],
  },
];

/** Price and free-plan facts per product, from the sources on each comparison page. */
export const OVERVIEW: [string, string, string, string, string][] = [
  ["Raisebook", "$0, no paid tier", "Everything: 50 rounds, 20,000 investors, 20 members", "Yes (AGPL-3.0)", "Yes, free plan"],
  ["Foundersuite", "$745/yr (Silver)", "Basic: 75 investors per pipeline", "No", "Not listed"],
  ["Visible", "$59/mo (Base, annual)", "Starter: 2 pipelines, 100 update recipients", "No", "Yes"],
  ["Affinity", "$2,000/user/yr", "None listed", "No", "Not checked"],
  ["Attio", "$35/seat/mo (Plus, annual)", "Up to 3 seats", "No", "Yes"],
  ["folk", "$24/member/mo (annual)", "14-day trial", "No", "Yes"],
];

export function comparison(slug: string): Comparison {
  const c = COMPARISONS.find((x) => x.slug === slug);
  if (!c) throw new Error(`unknown comparison ${slug}`);
  return c;
}
