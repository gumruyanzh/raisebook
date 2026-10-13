import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AgentTranscript } from "@/components/marketing/AgentTranscript";
import { Faq } from "@/components/marketing/Faq";
import { HeroDesk } from "@/components/marketing/HeroDesk";
import { ImportVignette } from "@/components/marketing/ImportVignette";
import { PRIVACY_PROMISE } from "@/components/marketing/promise";
import { RuledList, Section } from "@/components/marketing/Section";
import { MCP_TOOL_COUNT, REPO_URL, SPONSOR_URL } from "@/components/marketing/site";
import { claudeCodeSnippet } from "@/components/marketing/snippets";
import {
  AgentTimeline,
  CardVignette,
  SheetVignette,
  TableVignette,
} from "@/components/marketing/Vignettes";
import { ButtonLink, CodeBlock, TextLink } from "@/components/ui";
import { getSession } from "@/lib/api/server";

export const metadata: Metadata = {
  title: { absolute: "Raisebook · The free fundraising CRM, built for founders and their agents" },
  description:
    "Track every investor through every round: stages, follow-ups, notes and commitments. Free forever, open source, private per workspace, with an MCP server so Claude Code, Codex or Cursor can work the pipeline with you.",
  alternates: { canonical: "/" },
};

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

const FAQ = [
  {
    q: "Is it really free?",
    a: (
      <p>
        Yes. There is no paid tier, no seat price and no feature behind a paywall. The limits in
        the table above are the same for everyone. Donations, if you choose to give, change
        nothing about what you get.
      </p>
    ),
  },
  {
    q: "Then how does it pay for itself?",
    a: (
      <p>
        The costs are small: a server, a database and the email that delivers sign-in links.
        Donations cover them. And because the code is open, you can always run your own copy.
      </p>
    ),
  },
  {
    q: "Can Raisebook see my investor list?",
    a: (
      <p>
        Your workspace is stored on Raisebook&apos;s servers, so the people who run them could
        technically read it, as with any hosted app. Raisebook never uses it: there is no investor
        database, no feature that reads across workspaces, and no analytics. You can check that in
        the code. If you want the data on your own machine, <Link href="/docs/self-hosting">self-host it</Link>.
      </p>
    ),
  },
  {
    q: "Which agents can connect?",
    a: (
      <p>
        Any MCP client that speaks streamable HTTP. Claude Code, Codex and Cursor have ready
        snippets in <Link href="/docs/mcp">the MCP setup guide</Link>. Clients that only start
        local servers connect through mcp-remote.
      </p>
    ),
  },
  {
    q: "Do I need an agent to use it?",
    a: (
      <p>
        No. The board, the table and the investor files work on their own. The agent is there for
        the moments when typing &ldquo;log that call and remind me Friday&rdquo; is faster than
        clicking.
      </p>
    ),
  },
  {
    q: "What can an agent change? Can it delete things?",
    a: (
      <p>
        With a write key it can add investors, move stages, log activity, set follow-ups and
        record commitments. Over MCP it cannot delete anything, create keys or invite people. A
        read-only key can only look. Every write shows on the timeline under the agent&apos;s
        name.
      </p>
    ),
  },
  {
    q: "Can I bring data from Airtable, Notion or Google Sheets?",
    a: (
      <p>
        Export it as CSV and import that. You map columns, see what will be created, updated or
        skipped, and only then write. <Link href="/docs/csv">CSV format</Link>.
      </p>
    ),
  },
  {
    q: "Can my co-founder work in it too?",
    a: (
      <p>
        Invite them by email as an editor, or add an advisor as a viewer. Each investor in a round
        can have an owner, so you know who is on which conversation.
      </p>
    ),
  },
  {
    q: "Will Raisebook ever email my investors?",
    a: (
      <p>
        No. It never contacts anyone on your behalf. The only emails it sends are sign-in links and
        workspace invites, to the people you enter.
      </p>
    ),
  },
  {
    q: "What happens if I want to leave?",
    a: (
      <p>
        Export the workspace as JSON and each round as CSV, then delete the workspace. Deletion is
        immediate and permanent, and backups age out within 14 days.{" "}
        <Link href="/docs/export">Export and delete</Link>.
      </p>
    ),
  },
];

export default async function Landing() {
  // Signed in: the product, not the pitch.
  if ((await getSession()).status === "ok") redirect("/app");
  return (
    <>
      {/* ---------------- Hero ---------------- */}
      <section aria-labelledby="hero-title" className="overflow-hidden">
        <div className="gutter mx-auto grid max-w-site gap-x-40 gap-y-40 pt-48 pb-56 lg:grid-cols-12 lg:pt-80 lg:pb-80">
          <div className="min-w-0 lg:col-span-5 lg:pt-8">
            <p className="t-label mb-18">Free forever · Open source · AGPL-3.0</p>
            <h1 id="hero-title" className="t-display-xl max-w-[12ch]">
              Run your raise from one ledger.
            </h1>
            <p className="t-body-l mt-18 max-w-[44ch] text-muted">
              Raisebook tracks every investor through every round: stages, follow-ups, notes and
              commitments. It&apos;s free forever, and your coding agent can work the pipeline with
              you over MCP.
            </p>
            <div className="mt-28 flex flex-wrap items-center gap-x-18 gap-y-12">
              <ButtonLink href="/signin" variant="primary" size="lg">
                Start your raise
              </ButtonLink>
              <TextLink href="/docs/mcp">Connect Claude Code →</TextLink>
            </div>
            <p className="t-body-s mt-24 text-muted">
              Sign in with an email link. Try it with a sample workspace of fictional investors.
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

      {/* ---------------- 03 Import ---------------- */}
      <Section
        id="import"
        index="03"
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

      {/* ---------------- 04 Privacy ---------------- */}
      <Section
        id="privacy"
        index="04"
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

      {/* ---------------- 05 Free forever ---------------- */}
      <Section id="free" index="05" note="Free forever" title="Free forever. Here's how.">
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
              running costs are kept small. If Raisebook saves you a subscription, you can chip in.
              Donations pay for hosting and nothing else. They never buy features, priority or a
              different deal on your data.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-18 gap-y-12">
              <ButtonLink href={SPONSOR_URL} external>
                Support Raisebook
              </ButtonLink>
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

      {/* ---------------- 06 Open source ---------------- */}
      <Section
        id="source"
        index="06"
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
            "cp deploy/.env.example deploy/.env   # fill in the secrets",
            "docker compose -f deploy/docker-compose.yml up -d --build",
          ].join("\n")}
        />
      </Section>

      {/* ---------------- 07 FAQ ---------------- */}
      <Section id="faq" index="07" note="Questions" title="Questions founders ask.">
        <div className="max-w-[860px]">
          <Faq items={FAQ} />
        </div>
      </Section>
    </>
  );
}
