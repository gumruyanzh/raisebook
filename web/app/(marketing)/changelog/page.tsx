import type { Metadata } from "next";

import { DocHeader } from "@/components/marketing/docs/Prose";
import { AsideFacts, PageShell } from "@/components/marketing/PageShell";
import { REPO_URL } from "@/components/marketing/site";
import { Chip, TextLink } from "@/components/ui";

export const metadata: Metadata = {
  title: "Changelog",
  description: "What changed in Raisebook, newest first.",
  alternates: { canonical: "/changelog" },
};

interface Entry {
  date: string;
  version: string;
  status?: string;
  title: string;
  groups: { label: string; items: string[] }[];
}

/** Newest first. Add an entry for every release and for any change to the privacy page or terms. */
const ENTRIES: Entry[] = [
  {
    date: "2026-10-10",
    version: "0.1.0",
    status: "Unreleased",
    title: "The first build",
    groups: [
      {
        label: "Pipeline",
        items: [
          "Workspaces, rounds with terms, and per-round stages you can rename, recolor and reorder.",
          "The round page: a ledger strip with committed against target, the funnel and due follow-ups; a board with drag and keyboard moves; a sortable, filterable table; and an investor sheet.",
          "Investor contacts shared across rounds, with dedupe on email, LinkedIn and name + firm.",
          "An append-only timeline on every investor that records who did what, people and agents alike.",
        ],
      },
      {
        label: "Agents",
        items: [
          "An MCP server at /mcp with 15 tools, for Claude Code, Codex, Cursor and other MCP clients.",
          "Workspace API keys with read, write and admin scopes. Agent actions are marked in orchid.",
          "A REST API under /v1 that mirrors the MCP tools.",
        ],
      },
      {
        label: "Data",
        items: [
          "CSV import with column mapping, preview and dedupe; prototype JSON import.",
          "CSV and JSON export of a round, all investors or the whole workspace.",
          "Permanent, immediate deletion of an investor, round, workspace or account.",
        ],
      },
      {
        label: "Project",
        items: [
          "Open source under AGPL-3.0, with Docker Compose files for self-hosting.",
          "This site: landing page, docs, privacy page and terms.",
        ],
      },
    ],
  },
];

export default function Changelog() {
  return (
    <PageShell
      aside={
        <AsideFacts
          items={[
            ["Latest", ENTRIES[0]!.version],
            ["Source", <TextLink key="r" href={`${REPO_URL}/commits/main`} external>Commits</TextLink>],
          ]}
        />
      }
    >
      <DocHeader
        eyebrow="Changelog"
        title="What changed"
        lede={<p>Releases, newest first. Changes to the privacy page or the terms are listed here too.</p>}
      />
      <ol className="m-0 list-none p-0">
        {ENTRIES.map((e) => (
          <li key={e.version} className="border-t border-line pt-18 pb-40">
            <p className="flex flex-wrap items-baseline gap-x-12 gap-y-4">
              <time dateTime={e.date} className="t-data text-muted">
                {e.date}
              </time>
              <span className="t-data text-fg">v{e.version}</span>
              {e.status ? <Chip tone="mode">{e.status}</Chip> : null}
            </p>
            <h2 id={`v${e.version}`} className="t-display-s mt-8 scroll-mt-24">
              {e.title}
            </h2>
            {e.groups.map((g) => (
              <section key={g.label} className="mt-18">
                <h3 className="t-label mb-6">{g.label}</h3>
                <ul className="t-body-l m-0 flex list-disc flex-col gap-6 pl-20 marker:text-faint">
                  {g.items.map((it) => (
                    <li key={it}>{it}</li>
                  ))}
                </ul>
              </section>
            ))}
          </li>
        ))}
      </ol>
    </PageShell>
  );
}
