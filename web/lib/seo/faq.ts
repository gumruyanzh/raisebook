/**
 * Questions founders ask, as plain text so the same entries render on the page and in the
 * FAQPage structured data (Google requires the marked-up answer to be visible). `link` is
 * rendered after the answer.
 */

import { LIMITS, MCP_CORE_TOOLS, MCP_TOOLS_WITH_RESEARCH } from "./facts";

export interface FaqItem {
  q: string;
  a: string;
  link?: { href: string; label: string };
}

export const HOME_FAQ: FaqItem[] = [
  {
    q: "What is Raisebook?",
    a: "Raisebook is a free, open-source investor CRM for startup founders. It tracks every investor through every round (stages, follow-ups, meetings, notes and commitments) and has an MCP server so your coding agent can work the pipeline with you.",
  },
  {
    q: "Is it really free?",
    a: "Yes. There is no paid tier, no seat price and no feature behind a paywall. The limits are the same for everyone. Donations, if you choose to give, change nothing about what you get.",
    link: { href: "/pricing", label: "Pricing" },
  },
  {
    q: "Then how does it pay for itself?",
    a: "The costs are small: a server, a database and the email that delivers sign-in links. The maintainer pays them today, and donations will cover them once they open. And because the code is open, you can always run your own copy.",
  },
  {
    q: "Can Raisebook see my investor list?",
    a: "Your workspace is stored on Raisebook's servers, so the people who run them could technically read it, as with any hosted app. Raisebook never uses it: there is no investor database, no feature that reads across workspaces, and no analytics. You can check that in the code. If you want the data on your own machine, self-host it.",
    link: { href: "/docs/self-hosting", label: "Self-hosting" },
  },
  {
    q: "Which agents can connect?",
    a: "Any MCP client that speaks streamable HTTP and can send an API key header. Claude Code, Codex and Cursor have ready snippets; clients that only start local servers, such as Claude Desktop, connect through mcp-remote. Web-only connectors (claude.ai and ChatGPT connectors) need OAuth, which Raisebook does not offer yet.",
    link: { href: "/docs/mcp", label: "MCP setup" },
  },
  {
    q: "Do I need an agent to use it?",
    a: "No. The board, the table and the investor files work on their own. The agent is there for the moments when typing \"log that call and remind me Friday\" is faster than clicking.",
  },
  {
    q: "What can an agent change? Can it delete things?",
    a: "With a write key it can add investors, move stages, log activity, set follow-ups, schedule meetings and record commitments. Over MCP it cannot delete anything, create keys or invite people. A read-only key can only look. Every write shows on the timeline under the agent's name.",
  },
  {
    q: "Does it handle investor meetings?",
    a: "Yes. Schedule a meeting from an investor's file and they move to the Meeting stage. Today's meetings show on Today and on board cards; afterwards you record the outcome and the next step. Each meeting has an .ics file, and a private feed URL puts all of them in Google Calendar, Apple Calendar or Outlook.",
    link: { href: "/docs/meetings", label: "Meetings and the calendar feed" },
  },
  {
    q: "Can it research investors for me?",
    a: "Yes, when you start it (with a button in the app, or through your agent) and on your own OpenRouter key. Research writes a short dossier per investor (recent deals, thesis, a way in, an opener, a risk) where every fact cites a source. Raisebook never runs AI on its own, adds no markup, and caps spend with a monthly limit per workspace.",
    link: { href: "/ai-investor-research", label: "Investor research" },
  },
  {
    q: "Does it work on a phone?",
    a: "Yes. The pipeline, the board and Triage have a phone layout with touch-sized controls.",
  },
  {
    q: "Can I bring data from Airtable, Notion or Google Sheets?",
    a: "Export it as CSV and import that. You map columns, see what will be created, updated or skipped, and only then write.",
    link: { href: "/docs/csv", label: "CSV format" },
  },
  {
    q: "Can my co-founder work in it too?",
    a: `Invite them by email as an editor, or add an advisor as a viewer, up to ${LIMITS.members} members. Each investor in a round can have an owner, so you know who is on which conversation. Sign in with an emailed link or with Google.`,
  },
  {
    q: "Will Raisebook ever email my investors?",
    a: "No. It never contacts anyone on your behalf. The only emails it sends are sign-in links and workspace invites, to the people you enter.",
  },
  {
    q: "How is it different from Foundersuite, Visible or Affinity?",
    a: "Raisebook is free with no investor cap, open source and self-hostable, and has an MCP server on the free plan. It has no investor database, sends no investor updates and is built for founders, not VC firms.",
    link: { href: "/compare", label: "Comparisons" },
  },
  {
    q: "What happens if I want to leave?",
    a: "Export the workspace as JSON and each round as CSV, then delete the workspace. Deletion is immediate and permanent, and backups age out within 14 days.",
    link: { href: "/docs/export", label: "Export and delete" },
  },
];

/** Extra questions for the /faq hub, grouped after the home set. */
export const MORE_FAQ: { group: string; items: FaqItem[] }[] = [
  {
    group: "Choosing an investor CRM",
    items: [
      {
        q: "What is an investor CRM?",
        a: "An investor CRM (or fundraising CRM) is a tool for tracking the investors you are raising from: who they are, which stage of your pipeline they are in, what was said, the next follow-up and what they committed. It replaces the investor spreadsheet once the list gets long.",
        link: { href: "/investor-crm", label: "Investor CRM for founders" },
      },
      {
        q: "What is the best free investor CRM for a seed round?",
        a: `Raisebook is free with no paid tier and tracks up to ${LIMITS.investors.toLocaleString("en-US")} investors and ${LIMITS.rounds} rounds per workspace, with stages, follow-ups, meetings and an MCP server. Other free options have caps: Foundersuite's free plan tracks 75 investors per pipeline, Visible's free plan has 2 pipelines, and Attio's free plan allows 3 seats.`,
        link: { href: "/free-investor-crm", label: "Free investor CRM" },
      },
      {
        q: "Is there an open-source fundraising CRM?",
        a: "Yes. Raisebook is open source under AGPL-3.0. You can use the hosted version at raisebook.org for free or run your own copy with Docker Compose.",
        link: { href: "/docs/self-hosting", label: "Self-hosting" },
      },
      {
        q: "When should I move off a spreadsheet?",
        a: "When follow-ups start slipping, a co-founder needs to work the list with you, or you cannot tell who said what last. Raisebook imports the same CSV, so the move takes minutes.",
        link: { href: "/compare/spreadsheet", label: "Spreadsheet vs investor CRM" },
      },
    ],
  },
  {
    group: "AI and agents",
    items: [
      {
        q: "Is there a fundraising CRM with an MCP server?",
        a: `Yes. Raisebook's MCP server has ${MCP_CORE_TOOLS} tools (${MCP_TOOLS_WITH_RESEARCH} with research on, as on raisebook.org) to read the pipeline, add investors, move stages, log activity, set follow-ups and schedule meetings. It is on the free plan and has no delete tools.`,
        link: { href: "/fundraising-crm-mcp", label: "Raisebook for AI agents" },
      },
      {
        q: "Can Claude Code research investors and save the result?",
        a: "Yes. An agent can research with its own web tools and save a dossier with the save_dossier tool. That costs the workspace nothing and goes through the same citation checks as Raisebook's own research.",
        link: { href: "/docs/research", label: "Research docs" },
      },
    ],
  },
  {
    group: "Data and privacy",
    items: [
      {
        q: "Does Raisebook sell or pool investor data?",
        a: "No. Raisebook never builds an investor database from your data and never shows one workspace's data to another. There are no ads, trackers or analytics scripts.",
        link: { href: "/privacy", label: "Privacy" },
      },
      {
        q: "What does research send to the AI provider?",
        a: "The investor's name, firm, title and links, your company profile and the round's terms, to OpenRouter on your own key. Never notes, emails, amounts or timelines.",
        link: { href: "/research-policy", label: "Research Policy" },
      },
    ],
  },
];
