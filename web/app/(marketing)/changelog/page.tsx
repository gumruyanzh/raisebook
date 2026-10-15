import type { Metadata } from "next";

import { JsonLd } from "@/components/marketing/JsonLd";
import { DocHeader } from "@/components/marketing/docs/Prose";
import { AsideFacts, PageShell } from "@/components/marketing/PageShell";
import { REPO_URL, pageMeta } from "@/components/marketing/site";
import { Chip, TextLink } from "@/components/ui";
import { pageGraph } from "@/lib/seo/schema";

export const metadata: Metadata = pageMeta("/changelog");

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
    date: "2026-10-14",
    version: "0.3.0",
    status: "Unreleased",
    title: "Meetings",
    groups: [
      {
        label: "Meetings",
        items: [
          "Schedule meetings with investors (press B in an investor's file): date and time in the workspace timezone, place, video link, agenda and colleagues from the same firm. Scheduling moves them to the Meeting stage when they are earlier in the pipeline.",
          "A Meetings page: what needs an outcome, today, this week and later. Marking a meeting done asks for a quick outcome, the next step and a follow-up, and logs the meeting on the timeline.",
          "Today's meetings at the top of Today with Join and Open brief; a \"Meeting today 11:00\" chip on board cards; the next meeting in the investor file; upcoming meetings on the round overview.",
          "Reschedules, cancellations and no-shows keep their history on the timeline.",
        ],
      },
      {
        label: "Calendar",
        items: [
          "Download any meeting as an .ics file or add it to Google Calendar.",
          "A private calendar feed (Account → Calendar) that Google, Apple or Outlook Calendar can subscribe to, covering every workspace you belong to. Replace or turn off the URL any time.",
        ],
      },
      {
        label: "API and agents",
        items: [
          "REST: /v1/meetings (list, schedule, reschedule, cancel, complete, .ics).",
          "Four MCP tools: schedule_meeting, list_meetings, update_meeting and complete_meeting (21 tools in all).",
          "Meetings are in the workspace JSON export.",
        ],
      },
    ],
  },
  {
    date: "2026-10-14",
    version: "0.2.0",
    status: "Public launch",
    title: "Open to everyone",
    groups: [
      {
        label: "Pipeline",
        items: [
          "Three views of a round: Triage (decide on new investors one at a time, with number keys and undo), a classic kanban Board with richer cards, and a dense Table.",
          "Board cards show fit, likelihood, the next step and the key facts; drag a card to another stage.",
          "Bulk moves and edits, saved views, a split investor sheet, and a Today queue of due follow-ups.",
          "A command palette and keyboard shortcuts across the app.",
        ],
      },
      {
        label: "Getting started",
        items: [
          "Continue with Google, next to the emailed sign-in link.",
          "A sample workspace with fictional investors, so you can try everything before importing your own.",
          "Signed-in visitors to raisebook.org go straight to their workspace.",
          "An import review you can trust: rows with bad optional cells are kept, and every skipped row says why.",
        ],
      },
      {
        label: "Phones",
        items: [
          "A stacked pipeline list, compact ledger and single-column forms at phone width.",
          "Form fields no longer zoom the page on iPhone.",
        ],
      },
      {
        label: "Privacy and terms",
        items: [
          "The privacy page and the terms are in effect: who runs raisebook.org, where it is hosted, the email provider and the contact address are filled in.",
          "The privacy page now lists Google sign-in and every cookie and browser-storage key.",
        ],
      },
    ],
  },
  {
    date: "2026-10-10",
    version: "0.1.0",
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
          "An MCP server at /mcp with 17 tools, for Claude Code, Codex, Cursor and other MCP clients.",
          "Workspace API keys with read, write and admin scopes. Agent actions are marked in orchid.",
          "A REST API under /v1 that mirrors the MCP tools.",
        ],
      },
      {
        label: "Data",
        items: [
          "CSV import with column mapping, preview and dedupe.",
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
    <>
      <JsonLd data={pageGraph("/changelog")} />
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
    </>
  );
}
