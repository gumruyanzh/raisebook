/**
 * Every public page, in one place: its title, description, share card, section and the date
 * its content last changed. metadata, the sitemap, the generated OG images, breadcrumbs,
 * JSON-LD and llms.txt all read this list, so a new public page is added here first.
 * `updated` is the date the page's text last changed (git log of the page file); bump it
 * when you change what a page says.
 */

export type Section = "home" | "product" | "compare" | "guide" | "docs" | "about";

export interface PublicPage {
  path: string;
  /** <title> (the root template adds " · Raisebook"; docs add " · Raisebook docs"). */
  title: string;
  /** A full title used as is (home only). */
  absoluteTitle?: string;
  description: string;
  section: Section;
  updated: string;
  /** Breadcrumb label; defaults to title. */
  crumb?: string;
  og: { eyebrow: string; title: string; subtitle: string };
  /** Shown in llms.txt under its section. */
  llms?: boolean;
}

export const PAGES: PublicPage[] = [
  {
    path: "/",
    title: "Free investor CRM and fundraising pipeline tracker for founders",
    absoluteTitle: "Raisebook · Free investor CRM and fundraising pipeline tracker for founders",
    description:
      "Raisebook is a free, open-source investor CRM for startup founders. Track every investor through every round: stages, follow-ups, meetings, notes and commitments, with an MCP server so Claude Code, Codex or Cursor can work the pipeline with you.",
    section: "home",
    updated: "2026-10-15",
    crumb: "Home",
    og: {
      eyebrow: "Free forever · Open source · MCP",
      title: "The free investor CRM for founders.",
      subtitle: "Stages, follow-ups, meetings and commitments. Built for founders and their agents.",
    },
    llms: true,
  },
  {
    path: "/investor-crm",
    title: "Investor CRM for founders",
    description:
      "What an investor CRM does for a startup raise, what to track per investor, and how Raisebook, a free and open-source investor CRM, handles stages, follow-ups, meetings and commitments.",
    section: "product",
    updated: "2026-10-15",
    og: {
      eyebrow: "Investor CRM",
      title: "An investor CRM built for founders.",
      subtitle: "Track every investor through every round, free and open source.",
    },
    llms: true,
  },
  {
    path: "/free-investor-crm",
    title: "Free, open-source investor CRM",
    description:
      "Raisebook is a free investor CRM with no paid tier, no seat price and no investor cap below 20,000 per workspace. Open source under AGPL-3.0 and self-hostable.",
    section: "product",
    updated: "2026-10-15",
    og: {
      eyebrow: "$0 · AGPL-3.0",
      title: "A free investor CRM. Actually free.",
      subtitle: "No paid tier, no seat price, no investor database built from your list.",
    },
    llms: true,
  },
  {
    path: "/pricing",
    title: "Pricing",
    description:
      "Raisebook costs $0: no paid tier, no seat price, every feature. Limits per workspace: 50 rounds, 20,000 investors, 20 members, 20 API keys. How it stays free.",
    section: "product",
    updated: "2026-10-15",
    og: {
      eyebrow: "Pricing",
      title: "$0. Every feature. Same limits for everyone.",
      subtitle: "50 rounds, 20,000 investors and 20 members per workspace.",
    },
    llms: true,
  },
  {
    path: "/seed-round-tracker",
    title: "Track your seed round",
    description:
      "How to track investors for a pre-seed or seed round: pipeline stages, the fields to keep, a follow-up cadence and meetings, and how to run it in Raisebook for free.",
    section: "guide",
    updated: "2026-10-15",
    og: {
      eyebrow: "Guide · Seed round",
      title: "Track your seed round.",
      subtitle: "Stages, fields, follow-ups and meetings for a pre-seed or seed raise.",
    },
    llms: true,
  },
  {
    path: "/ai-investor-research",
    title: "Investor research with AI",
    description:
      "Raisebook researches the investors in your pipeline on your own OpenRouter key and writes short, cited dossiers: recent deals, thesis, a way in, an opener and a risk.",
    section: "guide",
    updated: "2026-10-15",
    og: {
      eyebrow: "Investor research",
      title: "Cited investor dossiers, on your own key.",
      subtitle: "Recent deals, thesis, a way in, an opener and a risk. No markup.",
    },
    llms: true,
  },
  {
    path: "/fundraising-crm-mcp",
    title: "Use Raisebook from Claude Code, Codex or Cursor (MCP)",
    crumb: "Raisebook for AI agents",
    description:
      "A fundraising CRM with an MCP server: connect Claude Code, Codex, Cursor or any MCP client and let it log calls, move stages, set follow-ups and schedule meetings. Free, with no delete tools.",
    section: "guide",
    updated: "2026-10-15",
    og: {
      eyebrow: "MCP · Agents",
      title: "Your agent can work the round.",
      subtitle: "Claude Code, Codex and Cursor over MCP. Free, no deletes, every write on the timeline.",
    },
    llms: true,
  },
  {
    path: "/compare",
    title: "Compare investor CRMs",
    description:
      "How Raisebook compares with Foundersuite, Visible, Affinity, Attio, folk and spreadsheets for tracking a fundraise: price, free-plan limits, open source, MCP and data ownership.",
    section: "compare",
    updated: "2026-10-15",
    og: {
      eyebrow: "Compare",
      title: "Raisebook compared.",
      subtitle: "Foundersuite, Visible, Affinity, Attio, folk and spreadsheets.",
    },
    llms: true,
  },
  {
    path: "/compare/foundersuite",
    title: "Raisebook vs Foundersuite",
    absoluteTitle: "Raisebook vs Foundersuite: a free Foundersuite alternative",
    description:
      "A free Foundersuite alternative: Raisebook vs Foundersuite on price, investor limits, investor database, open source, self-hosting and MCP, from each product's public pages.",
    section: "compare",
    updated: "2026-10-15",
    og: { eyebrow: "Compare", title: "Raisebook vs Foundersuite", subtitle: "Price, limits, open source and MCP, side by side." },
    llms: true,
  },
  {
    path: "/compare/visible",
    title: "Raisebook vs Visible",
    absoluteTitle: "Raisebook vs Visible: a free Visible.vc alternative for the investor pipeline",
    description:
      "A Visible.vc alternative for the investor pipeline: Raisebook vs Visible on price, free-plan limits, scope, open source and MCP, from each product's public pages.",
    section: "compare",
    updated: "2026-10-15",
    og: { eyebrow: "Compare", title: "Raisebook vs Visible", subtitle: "Price, limits, scope and MCP, side by side." },
    llms: true,
  },
  {
    path: "/compare/affinity",
    title: "Raisebook vs Affinity",
    absoluteTitle: "Raisebook vs Affinity: an Affinity alternative for founders",
    description:
      "An Affinity alternative for founders: Raisebook vs Affinity on price, who each is built for, open source and data, from each product's public pages.",
    section: "compare",
    updated: "2026-10-15",
    og: { eyebrow: "Compare", title: "Raisebook vs Affinity", subtitle: "A founder's pipeline vs a firm's deal-flow CRM." },
    llms: true,
  },
  {
    path: "/compare/attio-folk",
    title: "Raisebook vs Attio and folk",
    absoluteTitle: "Raisebook vs Attio and folk: a CRM built for fundraising",
    description:
      "Attio or folk for fundraising? Raisebook vs Attio vs folk on price, seats, setup for a raise, open source and MCP, from each product's public pages.",
    section: "compare",
    updated: "2026-10-15",
    og: { eyebrow: "Compare", title: "Raisebook vs Attio and folk", subtitle: "A ready-made fundraising pipeline vs a general CRM." },
    llms: true,
  },
  {
    path: "/compare/spreadsheet",
    title: "Investor CRM vs spreadsheet or Notion template",
    absoluteTitle: "Investor CRM vs spreadsheet or Notion template · Raisebook",
    description:
      "When an investor tracker spreadsheet or Notion/Airtable template stops working, and what a free investor CRM like Raisebook adds: stages, follow-ups, timeline, dedupe and meetings.",
    section: "compare",
    updated: "2026-10-15",
    og: { eyebrow: "Compare", title: "Spreadsheet vs investor CRM", subtitle: "When the sheet stops keeping up, and what to move to." },
    llms: true,
  },
  {
    path: "/faq",
    title: "Questions founders ask",
    crumb: "FAQ",
    description:
      "Answers about Raisebook, the free investor CRM: pricing, privacy, AI agents and MCP, research, meetings, importing a spreadsheet and how it compares.",
    section: "about",
    updated: "2026-10-15",
    og: { eyebrow: "FAQ", title: "Questions founders ask.", subtitle: "Pricing, privacy, agents, research, meetings and more." },
    llms: true,
  },
  {
    path: "/docs",
    title: "Getting started",
    crumb: "Docs",
    description:
      "Set up Raisebook in a few minutes: sign in, create a workspace and a round, bring your investors, and work the pipeline from the board, the table or your agent.",
    section: "docs",
    updated: "2026-10-13",
    og: {
      eyebrow: "Raisebook docs",
      title: "Connect your agent. Import your sheet.",
      subtitle: "MCP setup for Claude Code, Codex and Cursor. REST API. CSV format.",
    },
    llms: true,
  },
  {
    path: "/docs/mcp",
    title: "Connect an agent (MCP)",
    description:
      "Connect Claude Code, Codex, Cursor or any MCP client to Raisebook with a workspace API key. Copy-ready setup for each client.",
    section: "docs",
    updated: "2026-10-14",
    og: { eyebrow: "Docs · MCP", title: "Connect an agent.", subtitle: "Claude Code, Codex, Cursor and any MCP client." },
    llms: true,
  },
  {
    path: "/docs/mcp-tools",
    title: "MCP tools reference",
    description:
      "The 21 core Raisebook MCP tools and the 5 research tools: what each one does, its parameters, what it returns, and which ones are safe to repeat.",
    section: "docs",
    updated: "2026-10-14",
    og: { eyebrow: "Docs · MCP", title: "MCP tools reference.", subtitle: "Every tool, its parameters and what it returns." },
    llms: true,
  },
  {
    path: "/docs/api",
    title: "REST API",
    description:
      "The Raisebook REST API under /v1: authentication with workspace API keys, conventions, errors, rate limits and every endpoint.",
    section: "docs",
    updated: "2026-10-13",
    og: { eyebrow: "Docs · API", title: "REST API.", subtitle: "Rounds, investors, activity, meetings and exports under /v1." },
    llms: true,
  },
  {
    path: "/docs/meetings",
    title: "Meetings and the calendar feed",
    description:
      "Schedule investor meetings in Raisebook, record outcomes and next steps, download .ics files, and subscribe from Google Calendar, Apple Calendar or Outlook with a private feed URL.",
    section: "docs",
    updated: "2026-10-15",
    og: { eyebrow: "Docs · Meetings", title: "Meetings and the calendar feed.", subtitle: "Schedule, record outcomes, subscribe from any calendar." },
    llms: true,
  },
  {
    path: "/docs/csv",
    title: "CSV import format",
    description:
      "How Raisebook reads a spreadsheet: accepted column names, list, date and money formats, dedupe and what happens to each row.",
    section: "docs",
    updated: "2026-10-13",
    og: { eyebrow: "Docs · CSV", title: "Bring your spreadsheet.", subtitle: "Column names, mapping, preview and dedupe." },
    llms: true,
  },
  {
    path: "/docs/research",
    title: "Investor research",
    description:
      "How Raisebook's investor research works: your own OpenRouter key, identity first, cited dossiers, presets and costs, the monthly limit, and save_dossier for agents.",
    section: "docs",
    updated: "2026-10-13",
    og: { eyebrow: "Docs · Research", title: "Investor research.", subtitle: "Cited dossiers on your own OpenRouter key." },
    llms: true,
  },
  {
    path: "/docs/export",
    title: "Export and delete",
    description: "Take your data out of Raisebook as CSV or JSON at any time, and delete an investor, a round, a workspace or your account permanently.",
    section: "docs",
    updated: "2026-10-13",
    og: { eyebrow: "Docs · Export", title: "Export and delete.", subtitle: "CSV and JSON, any time. Hard delete, effective immediately." },
    llms: true,
  },
  {
    path: "/docs/self-hosting",
    title: "Self-hosting",
    description: "Run Raisebook on your own server with Docker Compose: Postgres, the API and MCP server, the web app and Caddy for TLS.",
    section: "docs",
    updated: "2026-10-13",
    og: { eyebrow: "Docs · Self-hosting", title: "Run your own Raisebook.", subtitle: "Docker Compose: Postgres, API, web and Caddy." },
    llms: true,
  },
  {
    path: "/privacy",
    title: "Privacy",
    description:
      "Raisebook's privacy promise and the details behind it: what is stored, what is never collected, cookies, logs, email, backups and deletion.",
    section: "about",
    updated: "2026-10-13",
    og: { eyebrow: "Privacy", title: "The privacy promise.", subtitle: "Never pooled, sold or mined. No trackers. Leave any time." },
    llms: true,
  },
  {
    path: "/research-policy",
    title: "Research Policy",
    description:
      "What Raisebook's investor research does, who starts it, what it collects and never collects, who can see it, how long it is kept, and how to ask for removal.",
    section: "about",
    updated: "2026-10-13",
    og: { eyebrow: "Research Policy", title: "What research collects, and what it never does.", subtitle: "Professional information only. Removal on request." },
    llms: true,
  },
  {
    path: "/terms",
    title: "Terms",
    description: "The terms for using raisebook.org, the free hosted investor CRM, in plain language: your data stays yours, fair use, and how the hosted service is run.",
    section: "about",
    updated: "2026-10-13",
    og: { eyebrow: "Terms", title: "Terms of service.", subtitle: "For the hosted service at raisebook.org." },
  },
  {
    path: "/support",
    title: "Support",
    description:
      "Raisebook is free forever. If it helps your raise, you can help pay for hosting. Donations never buy features.",
    section: "about",
    updated: "2026-10-13",
    og: { eyebrow: "Support", title: "Keep Raisebook free.", subtitle: "Donations pay for hosting and never buy features." },
    llms: true,
  },
  {
    path: "/changelog",
    title: "Changelog",
    description: "What changed in Raisebook, the free and open-source investor CRM, newest first: features, fixes and changes to the API and MCP server.",
    section: "about",
    updated: "2026-10-14",
    og: { eyebrow: "Changelog", title: "What changed.", subtitle: "Raisebook, release by release." },
    llms: true,
  },
];

export function page(path: string): PublicPage {
  const p = PAGES.find((x) => x.path === path);
  if (!p) throw new Error(`unknown public page ${path}`);
  return p;
}

/** "/" → "home", "/compare/visible" → "compare-visible". Used as the OG image id. */
export function ogSlug(path: string): string {
  return path === "/" ? "home" : path.slice(1).replace(/\//g, "-");
}

export function ogPath(path: string): string {
  return `/og-image/${ogSlug(path)}`;
}

export function pageForOgSlug(slug: string): PublicPage | undefined {
  return PAGES.find((p) => ogSlug(p.path) === slug);
}

/** Breadcrumb trail of [label, path] pairs, Home first. */
export function crumbs(path: string): { name: string; path: string }[] {
  const out = [{ name: "Home", path: "/" }];
  if (path === "/") return out;
  const parts = path.split("/").filter(Boolean);
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    const p = PAGES.find((x) => x.path === acc);
    if (p) out.push({ name: p.crumb ?? p.title, path: p.path });
  }
  return out;
}
