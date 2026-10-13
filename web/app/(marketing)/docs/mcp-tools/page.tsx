import type { Metadata } from "next";

import { pageMeta } from "@/components/marketing/site";

import {
  A,
  C,
  DocHeader,
  DocPagerFor,
  DocTable,
  H2,
  P,
  Ticks,
  Ul,
} from "@/components/marketing/docs/Prose";
import { SHIPPED_MCP_TOOLS as MCP_TOOLS } from "@/components/marketing/docs/mcp-tools";
import { Chip, CodeBlock } from "@/components/ui";

export const metadata: Metadata = {
  title: "MCP tools reference",
  description:
    "All 17 Raisebook MCP tools: what each one does, its parameters, what it returns, and which ones are safe to repeat.",
  ...pageMeta("/docs/mcp-tools"),
};

const INSTRUCTIONS = `Raisebook is the founder's fundraising CRM: rounds, investors, and each investor's stage in a round. Your API key belongs to one workspace (one company). Start with get_workspace to learn the rounds, valid stage keys and today's date in the workspace timezone. Refer to investors by id, email, LinkedIn URL, or exact name ("Name" or "Name @ Firm"). Refer to rounds by id, slug or name; you may omit the round when the workspace has exactly one open round. Amounts are whole units of the round's currency (250000 means $250k). Dates are YYYY-MM-DD. add_investor deduplicates by email, LinkedIn and name+firm, so call it directly instead of searching first. Use log_activity for what happened (email sent, call, meeting), set_follow_up for what should happen next, move_stage when the relationship advances, and record_commitment only when the investor has actually committed. Every write is recorded on the investor's timeline under your agent name, and the founder sees it. Never invent investor details; leave unknown fields empty. import_investors_csv defaults to dry_run=true: show the human the preview counts, then rerun with dry_run=false.`;

export default function McpTools() {
  return (
    <>
      <DocHeader
        eyebrow="Docs · MCP"
        title="MCP tools reference"
        lede={
          <p>
            Fifteen tools, written for language models: plain descriptions, forgiving references,
            and idempotent writes where it matters. They call the same code as the REST API, so the
            rules are the same everywhere. None of them deletes anything.
          </p>
        }
      />

      <DocTable
        caption="All tools"
        head={["Tool", "Access", "Safe to repeat"]}
        minWidth={420}
        rows={MCP_TOOLS.map((t) => [
          <a key={t.name} href={`#${t.name}`} className="link">
            {t.name}
          </a>,
          t.access,
          t.idempotent ? "yes" : t.name === "log_activity" ? "with idempotency_key" : "no",
        ])}
      />

      <H2>How references work</H2>
      <Ul>
        <li>
          <b>investor</b>: a UUID, an email, a LinkedIn URL, <C>&quot;Name&quot;</C> or{" "}
          <C>&quot;Name @ Firm&quot;</C>. Matching is exact after normalization (case, accents,
          punctuation), not fuzzy. No match returns <C>not_found</C> with the three closest names;
          more than one returns <C>ambiguous_reference</C> with the candidates.
        </li>
        <li>
          <b>round</b>: a UUID, slug or name, case-insensitive. Where a round is required and you
          leave it out, Raisebook uses the only open round, or answers <C>round_required</C> with
          the open rounds listed.
        </li>
        <li>
          <b>stage</b>: a stage key or label, case-insensitive (<C>dd</C> or{" "}
          <C>Diligence</C>).
        </li>
        <li>
          <b>dates</b> are <C>YYYY-MM-DD</C> in the workspace timezone; <b>amounts</b> are whole
          units of the round currency.
        </li>
      </Ul>

      <H2>Server instructions</H2>
      <P>Clients receive this text when they connect. It is the short version of this page.</P>
      <CodeBlock code={INSTRUCTIONS} lang="text" title="instructions" className="mb-18 [&_pre]:whitespace-pre-wrap" />

      {MCP_TOOLS.map((t) => (
        <section key={t.name} className="mt-48 border-t border-line pt-18">
          <h2 id={t.name} className="group flex scroll-mt-24 flex-wrap items-baseline gap-x-10 gap-y-4">
            <span className="font-mono text-[17px] font-medium">{t.name}</span>
            <Chip tone={t.access === "read" ? "tag" : "type"}>{t.access}</Chip>
            {t.idempotent && t.access === "write" ? <Chip tone="tag">idempotent</Chip> : null}
            <a
              href={`#${t.name}`}
              aria-label={`Link to ${t.name}`}
              className="font-mono text-[13px] text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              #
            </a>
          </h2>
          <p className="t-body-l mt-10 mb-14">
            <Ticks text={t.description} />
          </p>
          {t.params.length ? (
            <DocTable
              caption={`${t.name} parameters`}
              head={["Name", "Type", "Required", "Description"]}
              minWidth={600}
              widths={["24%", "26%", "12%", "38%"]}
              rows={t.params.map((p) => [
                p.name,
                <span key="t" className="font-mono text-[12px] text-muted">
                  {p.type}
                </span>,
                p.required ? "yes" : "",
                p.description,
              ])}
            />
          ) : (
            <p className="t-body-s mb-14 text-muted">No parameters.</p>
          )}
          <p className="t-body-s text-muted">
            <span className="t-label mr-8">Returns</span>
            <span className="font-mono text-[12px] [overflow-wrap:anywhere]">{t.output}</span>
          </p>
          {t.example ? (
            <CodeBlock code={t.example} lang="json" title="Example arguments" className="mt-12" />
          ) : null}
        </section>
      ))}

      <P className="mt-48">
        Setting up a client? <A href="/docs/mcp">Connect an agent</A>.
      </P>

      <DocPagerFor href="/docs/mcp-tools" />
    </>
  );
}
