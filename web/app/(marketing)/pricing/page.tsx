import type { Metadata } from "next";

import { A, C, DocTable, H2, P, Ul } from "@/components/marketing/docs/Prose";
import { SeoPage } from "@/components/marketing/seo/Blocks";
import { pageMeta } from "@/components/marketing/site";
import { LIMITS, MCP_CORE_TOOLS, RESEARCH_MONTHLY_LIMIT_USD } from "@/lib/seo/facts";
import type { FaqItem } from "@/lib/seo/faq";

export const metadata: Metadata = pageMeta("/pricing");

const n = (x: number) => x.toLocaleString("en-US");

const FAQ: FaqItem[] = [
  {
    q: "Is there a paid plan coming later?",
    a: "No. Raisebook has no paid tier, ever. The code is AGPL-3.0, so a hosted fork cannot quietly become a closed, paid product either.",
  },
  {
    q: "What does investor research cost?",
    a: `Raisebook charges nothing for it. Research runs on your own OpenRouter key, so OpenRouter bills you directly at its prices, usually cents per dossier, with no markup. A monthly limit per workspace ($${RESEARCH_MONTHLY_LIMIT_USD} by default) stops runs before they go over.`,
    link: { href: "/docs/research", label: "Research costs" },
  },
  {
    q: "What happens when I reach a limit?",
    a: "The action that would go over it is refused with a clear message; nothing already in the workspace is touched. Limits are per workspace, so a second company can have its own workspace.",
  },
];

export default function Pricing() {
  return (
    <SeoPage
      path="/pricing"
      eyebrow="Pricing"
      title="$0. Every feature, for everyone."
      answer={
        <p>
          Raisebook costs $0. There is no paid tier, no seat price, no trial and no feature behind a paywall: every workspace gets
          every feature with the same limits. The maintainer pays the small running costs today; donations, once they open, will
          pay for hosting and never buy features.
        </p>
      }
      toc={["What $0 gets you", "Limits", "How it stays free", "What costs money"]}
      faq={FAQ}
      related={[
        { href: "/free-investor-crm", label: "Why a free investor CRM" },
        { href: "/compare", label: "How Raisebook compares" },
        { href: "/support", label: "Support Raisebook" },
      ]}
    >
      <H2>What $0 gets you</H2>
      <Ul>
        <li>Rounds, stages, the Triage, Board and Table views, investor files and the timeline.</li>
        <li>Follow-ups, meetings, .ics downloads and a private calendar feed.</li>
        <li>CSV import, CSV and JSON export, hard delete.</li>
        <li>Co-founders and advisors as owners, editors and viewers.</li>
        <li>{`The REST API and the MCP server (${MCP_CORE_TOOLS} tools) for Claude Code, Codex, Cursor and other clients.`}</li>
        <li>Investor research, on your own OpenRouter key.</li>
      </Ul>

      <H2>Limits</H2>
      <DocTable
        caption="Limits per workspace"
        head={["", "Limit"]}
        monoFirst={false}
        minWidth={320}
        rows={[
          ["Price", "$0"],
          ["Rounds", `${n(LIMITS.rounds)} per workspace`],
          ["Investors", `${n(LIMITS.investors)} per workspace`],
          ["Members", `${n(LIMITS.members)}, owner / editor / viewer`],
          ["API keys", `${n(LIMITS.apiKeys)}, scoped read / write / admin`],
          ["Export", "CSV and JSON, any time"],
        ].map(([k, v]) => [<b key="k" className="font-semibold">{k}</b>, v])}
      />
      <P>The limits are the same for everyone. An action that would go over one is refused with a <C>limit_reached</C> error; nothing already saved changes.</P>

      <H2>How it stays free</H2>
      <P>
        Raisebook started as one founder&apos;s tool for his own raise. It has no investors to answer to and no paid plan to grow
        into. The costs are a server, a database, backups, the email that delivers sign-in links and the domain. The
        maintainer pays them today; once donations open, <A href="/support">the support page</A> will show what they cover.
        And because the code is open, you can always <A href="/docs/self-hosting">run your own copy</A>.
      </P>

      <H2>What costs money</H2>
      <P>
        Only what you bring: investor research uses your own OpenRouter key and OpenRouter bills you directly, with a monthly limit
        you set. Agents you connect use your own model subscription. Raisebook never runs or pays for AI on its own.
      </P>
    </SeoPage>
  );
}
