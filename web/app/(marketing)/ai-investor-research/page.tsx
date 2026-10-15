import type { Metadata } from "next";

import { A, C, DocTable, H2, P, Ul } from "@/components/marketing/docs/Prose";
import { SeoPage } from "@/components/marketing/seo/Blocks";
import { pageMeta } from "@/components/marketing/site";
import { RESEARCH_MONTHLY_LIMIT_USD } from "@/lib/seo/facts";
import type { FaqItem } from "@/lib/seo/faq";

export const metadata: Metadata = pageMeta("/ai-investor-research");

const FAQ: FaqItem[] = [
  {
    q: "Why do I need my own OpenRouter key?",
    a: "So Raisebook never pays for or runs AI on your data by itself, and never marks up the cost. OpenRouter bills you directly; the cost of each call is recorded on the run.",
  },
  {
    q: "Will research change what I already typed?",
    a: "No. Research fills empty fields (check size, stage focus, title) and marks them as from research. A field you filled is never changed: research suggests the new value and you accept or ignore it.",
  },
  {
    q: "Can my agent do the research instead?",
    a: "Yes. Claude Code or another agent can research with its own web tools and save the result with save_dossier. That needs no OpenRouter key, costs the workspace nothing, and goes through the same citation checks.",
  },
  {
    q: "Can an investor ask to be removed?",
    a: "Yes, through the Research Policy page, confirmed by email.",
    link: { href: "/research-policy", label: "Research Policy" },
  },
];

export default function AiInvestorResearch() {
  return (
    <SeoPage
      path="/ai-investor-research"
      eyebrow="Investor research"
      title="Research investors with AI, with every fact cited"
      answer={
        <p>
          Raisebook turns an investor in your pipeline into a short, cited dossier: who they are, what they invested in lately, what
          they talk about, a way in, an opener and a risk. It runs only when you start it, on your own OpenRouter key, with
          a monthly spend limit per workspace and no markup. Every fact cites a public source; what cannot be cited is set apart as
          unverified.
        </p>
      }
      toc={["What a dossier holds", "How it works", "Cost and limits", "Privacy"]}
      faq={FAQ}
      related={[
        { href: "/docs/research", label: "Research docs" },
        { href: "/research-policy", label: "Research Policy" },
        { href: "/seed-round-tracker", label: "Track your seed round" },
      ]}
    >
      <H2>What a dossier holds</H2>
      <Ul>
        <li>
          <b>The brief:</b> a verdict on fit, why, the best way in, an opener for your first message and the main risk.
        </li>
        <li>
          <b>Sections:</b> profile, fit, recent activity (deals, posts, talks), thesis and public views, ways in, talking points and
          red flags.
        </li>
        <li>
          <b>Sources:</b> every claim points to a page with its title and date.
        </li>
        <li>
          <b>Freshness:</b> a dossier older than 90 days says it may be stale; moving someone to Meeting with a dossier older than 30
          days offers a refresh, and a refresh shows what is new.
        </li>
      </Ul>

      <H2>How it works</H2>
      <Ul ordered>
        <li>
          <b>Identity first.</b> A cheap search works out who the investor is professionally. An unclear match asks &ldquo;Is this
          them?&rdquo; and nothing deeper runs until you pick.
        </li>
        <li>
          <b>Search.</b> Three searches read recent deals, posts and talks, and the fund. Pages that do not match the confirmed
          identity are thrown away.
        </li>
        <li>
          <b>Write.</b> The writer model reads the kept pages and writes the dossier, citing a page for every fact.
        </li>
        <li>
          <b>Check.</b> Raisebook checks every citation again and strips phones, addresses and private topics before saving.
        </li>
      </Ul>

      <H2>Cost and limits</H2>
      <DocTable
        caption="Research presets"
        head={["Preset", "Search", "Writer"]}
        monoFirst={false}
        minWidth={420}
        rows={[
          ["Best (default)", "Sonar Pro", "Claude Opus"],
          ["Balanced", "Sonar", "Claude Sonnet"],
          ["Budget", "Sonar", "a fast, cheap writer"],
        ]}
      />
      <P>
        Settings show the estimate per dossier from OpenRouter&apos;s current prices, usually cents. Each workspace has a monthly
        limit, ${RESEARCH_MONTHLY_LIMIT_USD} by default, that owners change; runs never go over it. Bulk research shows the count and
        the total before you confirm. Agents can also start research with <C>research_investor</C> and read it with{" "}
        <C>get_dossier</C>.
      </P>

      <H2>Privacy</H2>
      <P>
        Research sends the investor&apos;s name, firm, title and links, your company profile and the round&apos;s terms to
        OpenRouter. It never sends notes, emails, amounts or timelines. Dossiers hold professional information only and stay private
        to your workspace. <A href="/privacy">The privacy promise</A>.
      </P>
    </SeoPage>
  );
}
