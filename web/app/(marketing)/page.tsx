import type { Metadata } from "next";
import Link from "next/link";

import { AgentTranscript } from "@/components/marketing/AgentTranscript";
import { Faq } from "@/components/marketing/Faq";
import { JsonLd } from "@/components/marketing/JsonLd";
import { HeroDesk } from "@/components/marketing/HeroDesk";
import { ImportVignette } from "@/components/marketing/ImportVignette";
import { PRIVACY_PROMISE } from "@/components/marketing/promise";
import { RuledList, Section } from "@/components/marketing/Section";
import { MCP_TOOL_COUNT, REPO_URL, SPONSOR_URL, pageMeta } from "@/components/marketing/site";
import { faqNodes } from "@/components/marketing/seo/Blocks";
import { claudeCodeSnippet } from "@/components/marketing/snippets";
import {
  AgentTimeline,
  CardVignette,
  SheetVignette,
  TableVignette,
} from "@/components/marketing/Vignettes";
import { ButtonLink, CodeBlock, TextLink } from "@/components/ui";
import { COMPARE_CHECKED_ON, COMPARISONS, OVERVIEW } from "@/lib/seo/competitors";
import { HOME_FAQ } from "@/lib/seo/faq";
import { faqPage, graph, organization, softwareApplication, sourceCode, webPage, website } from "@/lib/seo/schema";

export const metadata: Metadata = pageMeta("/");

const FACTS = [
  { k: "$0", v: "no paid tier, ever" },
  { k: `${MCP_TOOL_COUNT} MCP tools`, v: "for Claude Code, Codex, Cursor" },
  { k: "CSV in", v: "CSV and JSON out" },
  { k: "AGPL-3.0", v: "self-hostable" },
];

const LIMITS: [string, string][] = [
  ["Price", "$0"],
  ["Rounds", "50 per workspace"],
  ["Investors", "20,000 per workspace"],
  ["Members", "20, owner / editor / viewer"],
  ["API keys", "20, scoped read / write / admin"],
  ["Export", "CSV and JSON, any time"],
];

const MORE: { title: string; body: string; href?: string; link?: string }[] = [
  {
    title: "Triage",
    body: "New investors one at a time: decide with the number keys, undo a slip, and give each a fit score so the best rise to the top.",
    href: "/seed-round-tracker",
    link: "Track a seed round",
  },
  {
    title: "Meetings",
    body: "Schedule from the investor's file and they move to Meeting. Today shows the day's meetings; afterwards, record the outcome and the next step.",
    href: "/docs/meetings",
    link: "Meetings",
  },
  {
    title: "Your calendar",
    body: "Download any meeting as .ics, or subscribe from Google Calendar, Apple Calendar or Outlook with a private feed URL.",
    href: "/docs/meetings",
    link: "Calendar feed",
  },
  {
    title: "Investor research",
    body: "A short, cited dossier per investor: recent deals, thesis, a way in, an opener, a risk. On your own OpenRouter key, only when you ask.",
    href: "/ai-investor-research",
    link: "Investor research",
  },
  {
    title: "On your phone",
    body: "The pipeline, the board and Triage have a phone layout with touch-sized controls, for the walk between meetings.",
  },
  {
    title: "Your team",
    body: "Invite a co-founder as an editor and an advisor as a viewer. Sign in with an emailed link or with Google.",
  },
];

/** Static on purpose: signed-in visitors are sent to /app by middleware.ts, before rendering. */
export default function Landing() {
  return (
    <>
      <JsonLd
        data={graph(
          organization(),
          website(),
          softwareApplication(),
          sourceCode(),
          webPage("/"),
          faqPage(HOME_FAQ, "/"),
        )}
      />
      {/* ---------------- Hero ---------------- */}
      <section aria-labelledby="hero-title" className="overflow-hidden">
        <div className="gutter mx-auto grid max-w-site gap-x-40 gap-y-40 pt-48 pb-56 lg:grid-cols-12 lg:pt-80 lg:pb-80">
          <div className="min-w-0 lg:col-span-5 lg:pt-8">
            <p className="t-label mb-18">Free, open-source investor CRM · AGPL-3.0</p>
            <h1 id="hero-title" className="t-display-xl max-w-[12ch]">
              Run your raise from one ledger.
            </h1>
            <p className="t-body-l mt-18 max-w-[44ch] text-muted">
              Raisebook is the free investor CRM for founders. It tracks every investor through
              every round: stages, follow-ups, meetings, notes and commitments. Your coding agent can
              work the pipeline with you over MCP.
            </p>
            <div className="mt-28 flex flex-wrap items-center gap-x-18 gap-y-12">
              <ButtonLink href="/signin" variant="primary" size="lg">
                Start your raise
              </ButtonLink>
              <TextLink href="/docs/mcp">Connect Claude Code →</TextLink>
            </div>
            <p className="t-body-s mt-24 text-muted">
              Sign in with an email link or Google, then try a sample workspace of fictional
              investors.
            </p>
          </div>
          <div className="min-w-0 lg:col-span-7">
            <HeroDesk />
          </div>
        </div>
      </section>

      {/* ---------------- Facts strip ---------------- */}
      <div className="gutter mx-auto max-w-site">
        <dl className="grid grid-cols-2 border-y border-line md:grid-cols-4">
          {FACTS.map((f, i) => (
            <div
              key={f.k}
              className={[
                "px-14 py-16 md:px-18",
                i % 2 === 1 ? "border-l border-line" : "",
                i >= 2 ? "border-t border-line md:border-t-0" : "",
                i === 2 ? "md:border-l" : "",
              ].join(" ")}
            >
              <dt className="font-mono text-[15px] font-medium text-fg">{f.k}</dt>
              <dd className="t-micro m-0 mt-2 text-muted">{f.v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="h-64 xl:h-96" />

      {/* ---------------- 01 Agents ---------------- */}
      <Section
        id="agents"
        index="01"
        note="Agents"
        title="Your agent can work the round."
        lede={
          <p>
            Raisebook has an MCP server with {MCP_TOOL_COUNT} tools. Connect Claude Code, Codex,
            Cursor or any MCP client with a key from your workspace, then ask for what you would
            ask a good associate: log the call, move the stage, set the follow-up, tell me who is
            overdue.
          </p>
        }
      >
        <div className="grid gap-32 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="flex min-w-0 flex-col gap-24">
            <RuledList
              numbered={false}
              items={[
                {
                  lead: "It logs what happened.",
                  body: "Emails, calls, meetings and notes land on the investor's timeline, with the date you give it.",
                },
                {
                  lead: "It sets the next follow-up.",
                  body: "Tomorrow morning, the founder's list of who to chase is already right.",
                },
                {
                  lead: "You see every action, in orchid, on the timeline.",
                  body: "Each write carries the agent's name and model. Nothing it does is invisible.",
                },
              ]}
            />
            <div className="flex flex-col gap-8">
              <p className="t-label">One command for Claude Code</p>
              <CodeBlock code={claudeCodeSnippet()} lang="shell" title="Terminal" />
              <p className="t-body-s text-muted">
                Codex, Cursor and other clients: <TextLink href="/docs/mcp">MCP setup →</TextLink>
              </p>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-14">
            <AgentTranscript />
            <AgentTimeline />
          </div>
        </div>
      </Section>

      {/* ---------------- 02 The desk ---------------- */}
      <Section
        id="desk"
        index="02"
        note="The desk"
        title="Board, table, and a file on every investor."
        lede={
          <p>
            The round sits on one page. A ledger strip says how much is committed against the
            target and who needs a follow-up today. Below it, the pipeline: as a board or as a
            table.
          </p>
        }
      >
        <div className="grid gap-x-24 gap-y-40 xl:grid-cols-3">
          <figure className="m-0 flex min-w-0 flex-col gap-14">
            <CardVignette />
            <figcaption className="t-body-s text-muted">
              <b className="font-semibold text-fg">Board.</b> Drag investors between stages, or
              move a focused card with Alt+← and Alt+→. Cards sort by fit, then by follow-up date.
            </figcaption>
          </figure>
          <figure className="m-0 flex min-w-0 flex-col gap-14">
            <TableVignette />
            <figcaption className="t-body-s text-muted">
              <b className="font-semibold text-fg">Table.</b> Sort and filter every name in the
              round at once. Filters live in the URL, so you can send a view to your co-founder.
            </figcaption>
          </figure>
          <figure className="m-0 flex min-w-0 flex-col gap-14">
            <SheetVignette />
            <figcaption className="t-body-s text-muted">
              <b className="font-semibold text-fg">Investor file.</b> Stage, follow-up, amounts,
              notes and the whole timeline in one sheet. An investor&apos;s history carries over to
              your next round.
            </figcaption>
          </figure>
        </div>
      </Section>

      {/* ---------------- 03 More ---------------- */}
      <Section
        id="more"
        index="03"
        note="Also in the box"
        title="Triage, meetings, research, and your phone."
        lede={
          <p>
            Everything a raise needs between the first email and the wire, and nothing behind a
            paywall.
          </p>
        }
      >
        <ul className="m-0 grid list-none gap-x-24 gap-y-0 p-0 md:grid-cols-2 xl:grid-cols-3">
          {MORE.map((m) => (
            <li key={m.title} className="border-t border-line py-16">
              <h3 className="t-display-xs">{m.title}</h3>
              <p className="t-body-l mt-6 text-muted">{m.body}</p>
              {m.href ? (
                <p className="mt-6">
                  <TextLink href={m.href}>{m.link} →</TextLink>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      {/* ---------------- 04 Import ---------------- */}
      <Section
        id="import"
        index="04"
        note="Import"
        title="Bring the spreadsheet you already have."
      >
        <div className="grid gap-32 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="flex min-w-0 flex-col gap-14">
            <p className="t-body-l max-w-[48ch] text-muted">
              Export your sheet as CSV and drop it in. Raisebook reads the usual headers on its own
              (Name, Fund, E-mail, Cheque size, Met at, Status) and lets you fix the rest by hand.
            </p>
            <p className="t-body-l max-w-[48ch]">
              Dedupes by email, LinkedIn and name + firm. Preview before anything is written.
            </p>
            <p>
              <TextLink href="/docs/csv">CSV format and column names →</TextLink>
            </p>
          </div>
          <ImportVignette />
        </div>
      </Section>

      {/* ---------------- 05 Privacy ---------------- */}
      <Section
        id="privacy"
        index="05"
        note="Privacy"
        title="The privacy promise."
        lede={
          <p>
            Fundraising CRMs are often paid for with your data: the investor list you build becomes
            their database. Raisebook makes six promises instead, and the code is public so you can
            hold us to them.
          </p>
        }
      >
        <RuledList items={PRIVACY_PROMISE} className="max-w-[860px]" />
        <p className="mt-18">
          <TextLink href="/privacy">Read the full privacy page →</TextLink>
        </p>
      </Section>

      {/* ---------------- 06 Free forever ---------------- */}
      <Section id="free" index="06" note="Free forever" title="Free forever. Here's how.">
        <div className="grid gap-32 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <div className="t-body-l flex max-w-[62ch] flex-col gap-16">
            <p>
              Raisebook has no investors to answer to and no paid plan to grow into. It started as
              one founder&apos;s tool for his own raise, and it is open because every alternative
              charged per seat or wanted the investor list in return.
            </p>
            <p className="text-muted">
              The code is AGPL-3.0, so anyone who runs a modified copy as a service has to publish
              their changes: a hosted fork cannot quietly turn into a closed, paid product. The
              running costs are kept small, and the maintainer pays them today. Donations, once they
              open, will pay for hosting and nothing else. They will never buy features, priority
              or a different deal on your data.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-18 gap-y-12">
              {SPONSOR_URL ? (
                <ButtonLink href={SPONSOR_URL} external>
                  Support Raisebook
                </ButtonLink>
              ) : (
                <ButtonLink href="/support">How it stays free</ButtonLink>
              )}
              <TextLink href="/docs/self-hosting">Self-host it →</TextLink>
            </div>
          </div>
          <div className="min-w-0">
            <p className="t-label mb-8">What $0 gets you</p>
            <dl className="m-0 border-b border-line">
              {LIMITS.map(([k, v]) => (
                <div
                  key={k}
                  className="grid grid-cols-[112px_minmax(0,1fr)] gap-10 border-t border-line py-9"
                >
                  <dt className="text-muted">{k}</dt>
                  <dd className="t-data m-0 text-fg">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="t-body-s mt-10 text-muted">Every feature, the same limits for everyone.</p>
          </div>
        </div>
      </Section>

      {/* ---------------- 07 Open source ---------------- */}
      <Section
        id="source"
        index="07"
        note="Open source"
        title="Read the code that holds your data."
        lede={
          <p>
            Everything is in one repository: the API, the MCP server, the web app and the deploy
            files. Run it on your own server with Docker in a few minutes.{" "}
            <TextLink href={REPO_URL} external>
              {REPO_URL.replace(/^https?:\/\//, "")}
            </TextLink>
          </p>
        }
      >
        <CodeBlock
          className="max-w-[760px]"
          lang="shell"
          title="Self-host"
          code={[
            `git clone ${REPO_URL}.git && cd raisebook`,
            "cp deploy/.env.example deploy/.env   # set your hosts and secrets",
            "docker compose -f deploy/docker-compose.yml up -d --build",
          ].join("\n")}
        />
      </Section>

      {/* ---------------- 08 Compare ---------------- */}
      <Section
        id="compare"
        index="08"
        note="Compare"
        title="How it compares."
        lede={
          <p>
            Raisebook is the free, open-source investor CRM: no paid tier, no investor cap below
            20,000, and an MCP server on the free plan. It has no investor database and sends no
            investor updates; the paid tools below add those.
          </p>
        }
      >
        <div className="max-w-[960px] overflow-x-auto rounded-md border border-line bg-surface">
          <table className="w-full min-w-[640px] border-collapse text-13">
            <caption className="sr-only">Investor CRMs at a glance, from each product&apos;s pricing page on {COMPARE_CHECKED_ON}</caption>
            <thead>
              <tr>
                {["", "Lowest paid price", "Free plan", "Open source", "MCP server"].map((h) => (
                  <th key={h} scope="col" className="t-th border-b border-line px-10 py-8 text-left text-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {OVERVIEW.map(([name, ...cells]) => (
                <tr key={name} className="[&:last-child>td]:border-b-0 [&:last-child>th]:border-b-0">
                  <th scope="row" className="border-b border-line px-10 py-8 text-left font-semibold">
                    {name}
                  </th>
                  {cells.map((c, i) => (
                    <td key={i} className="border-b border-line px-10 py-8 align-top">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="t-body-s mt-10 text-muted">
          From each product&apos;s public pricing page on {COMPARE_CHECKED_ON}. Details and sources:{" "}
          {COMPARISONS.map((c, i) => (
            <span key={c.slug}>
              {i > 0 ? ", " : ""}
              <Link href={`/compare/${c.slug}`} className="link">
                vs {c.name}
              </Link>
            </span>
          ))}
          .
        </p>
      </Section>

      {/* ---------------- 09 FAQ ---------------- */}
      <Section id="faq" index="09" note="Questions" title="Questions founders ask.">
        <div className="max-w-[860px]">
          <Faq items={faqNodes(HOME_FAQ)} />
        </div>
      </Section>

      {/* ---------------- Closing call to action ---------------- */}
      <section aria-labelledby="start-title" className="gutter mx-auto max-w-site">
        <div className="flex flex-col gap-18 border-t border-line pt-40 pb-64 md:flex-row md:items-center md:justify-between xl:pb-96">
          <div className="min-w-0">
            <h2 id="start-title" className="t-display-l max-w-[22ch]">
              Start your raise.
            </h2>
            <p className="t-body-l mt-10 max-w-[52ch] text-muted">
              Free forever. Sign in with an email link, import a CSV or start from a sample.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-18 gap-y-12">
            <ButtonLink href="/signin" variant="primary" size="lg">
              Start your raise
            </ButtonLink>
            <TextLink href="/docs/mcp">Connect Claude Code →</TextLink>
          </div>
        </div>
      </section>
    </>
  );
}
