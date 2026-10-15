/**
 * /llms.txt and /llms-full.txt (llmstxt.org): a plain Markdown description of Raisebook for
 * AI assistants and answer engines. Built from facts.ts, pages.ts, competitors.ts and faq.ts,
 * so it never says more than the site does.
 */

import { MCP_URL, PUBLIC_API_URL, REPO_URL, SITE_URL } from "@/components/marketing/site";

import { COMPARE_CHECKED_ON, COMPARISONS } from "./competitors";
import {
  DEFAULT_STAGES,
  DEFINITION,
  FEATURES,
  LIMITS,
  MCP_CORE_TOOLS,
  MCP_TOOLS_WITH_RESEARCH,
  NOT_FOR,
  OPERATOR,
  RESEARCH_MONTHLY_LIMIT_USD,
  WHO_FOR,
} from "./facts";
import { HOME_FAQ, MORE_FAQ } from "./faq";
import { PAGES, type Section } from "./pages";

const url = (path: string) => `${SITE_URL}${path === "/" ? "" : path}`;

const GROUPS: { title: string; sections: Section[] }[] = [
  { title: "Product", sections: ["home", "product"] },
  { title: "Guides", sections: ["guide"] },
  { title: "Comparisons", sections: ["compare"] },
  { title: "Docs", sections: ["docs"] },
  { title: "Policies and project", sections: ["about"] },
];

function links(): string {
  return GROUPS.map((g) => {
    const items = PAGES.filter((p) => p.llms && g.sections.includes(p.section)).map(
      (p) => `- [${p.path === "/" ? "Raisebook home" : p.title}](${url(p.path)}): ${p.description}`,
    );
    return `## ${g.title}\n\n${items.join("\n")}`;
  }).join("\n\n");
}

function keyFacts(): string {
  return [
    "- Price: $0. No paid tier, no seat price, no feature behind a paywall. Donations (once open) pay for hosting only and never buy features.",
    `- Limits per workspace, the same for everyone: ${LIMITS.rounds} rounds, ${LIMITS.investors.toLocaleString("en-US")} investors, ${LIMITS.members} members (owner, editor, viewer), ${LIMITS.apiKeys} API keys (read, write, admin).`,
    `- MCP server at ${MCP_URL}: ${MCP_CORE_TOOLS} tools, ${MCP_TOOLS_WITH_RESEARCH} with investor research enabled (as on raisebook.org). No delete tools. Works with Claude Code, Codex, Cursor and any MCP client that can send an API key header; Claude Desktop through mcp-remote. claude.ai and ChatGPT web connectors need OAuth, which Raisebook does not offer yet.`,
    `- REST API under ${PUBLIC_API_URL}/v1 with workspace API keys.`,
    `- Investor research on the user's own OpenRouter key, only when they start it (a button in the app, or an agent they connected); cited dossiers; a monthly limit per workspace ($${RESEARCH_MONTHLY_LIMIT_USD} by default); no markup.`,
    "- Meetings with .ics downloads and a private calendar feed for Google Calendar, Apple Calendar or Outlook.",
    "- CSV import (column mapping, preview, dedupe); CSV and JSON export at any time; hard delete.",
    `- Open source: AGPL-3.0, self-hostable with Docker Compose. Source: ${REPO_URL}`,
    "- Sign in with an emailed link or with Google. Phone layout for the pipeline, board and triage.",
    "- Privacy: no investor database, never pools, sells or mines workspace data, no ads, trackers or analytics scripts.",
    `- Operator: ${OPERATOR.name}. Contact: ${OPERATOR.email}.`,
  ].join("\n");
}

export function llmsTxt(): string {
  return `# Raisebook

> ${DEFINITION}

Raisebook is free with no paid tier, open source under AGPL-3.0, and private per workspace. Use it at ${SITE_URL} or self-host it.

## Who it is for

${WHO_FOR}

## Key facts

${keyFacts()}

## What it is not

${NOT_FOR.map((n) => `- ${n}`).join("\n")}

${links()}

## Optional

- [Full text for AI assistants](${url("/llms-full.txt")}): the features, comparisons and FAQ in one file.
- [Source code on GitHub](${REPO_URL})
`;
}

export function llmsFullTxt(): string {
  const comparisons = COMPARISONS.map((c) => {
    const head = ["", "Raisebook", ...c.columns];
    const table = [
      `| ${head.join(" | ")} |`,
      `| ${head.map(() => "---").join(" | ")} |`,
      ...c.rows.map((r) => `| ${[r.label, ...r.cells].join(" | ")} |`),
    ].join("\n");
    const sources = c.sources.length
      ? `\n\nSources (checked ${COMPARE_CHECKED_ON}): ${c.sources.map((s) => `[${s.label}](${s.url})`).join(", ")}.`
      : "";
    return `### Raisebook vs ${c.name}

${c.answer}

${table}

Choose ${c.name} when: ${c.chooseThem.join(" ")}

Choose Raisebook when: ${c.chooseRaisebook.join(" ")}${sources}

Page: ${url(`/compare/${c.slug}`)}`;
  }).join("\n\n");

  const faq = [...HOME_FAQ, ...MORE_FAQ.flatMap((g) => g.items)]
    .map((f) => `### ${f.q}\n\n${f.a}${f.link ? ` More: ${url(f.link.href)}` : ""}`)
    .join("\n\n");

  return `# Raisebook: full description

> ${DEFINITION}

Website: ${SITE_URL}. Source code: ${REPO_URL}. License: AGPL-3.0. Price: $0.

## Who it is for

${WHO_FOR}

## Key facts

${keyFacts()}

## Features

${FEATURES.map((f) => `- **${f.name}.** ${f.text}`).join("\n")}

Default stages of a new round: ${DEFAULT_STAGES.join(", ")}. Stages can be renamed, recolored and reordered.

## What it is not

${NOT_FOR.map((n) => `- ${n}`).join("\n")}

## Connect an AI agent (MCP)

Create an API key in Settings → Connect an agent, then for Claude Code:

\`\`\`
claude mcp add --transport http raisebook ${MCP_URL} \\
  --header "Authorization: Bearer rb_live_XXXX" \\
  --header "X-Agent-Name: claude-code"
\`\`\`

Setup for Codex, Cursor and other clients: ${url("/docs/mcp")}. Tool reference: ${url("/docs/mcp-tools")}.

## How it compares

Competitor facts come from each product's own public pages, checked ${COMPARE_CHECKED_ON}. Prices change; follow the source links.

${comparisons}

## Frequently asked questions

${faq}

## Pages

${links()}
`;
}
