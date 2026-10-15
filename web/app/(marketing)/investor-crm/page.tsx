import type { Metadata } from "next";

import { A, DocTable, H2, P, Ul } from "@/components/marketing/docs/Prose";
import { SeoPage } from "@/components/marketing/seo/Blocks";
import { pageMeta } from "@/components/marketing/site";
import { DEFAULT_STAGES, FEATURES, NOT_FOR, WHO_FOR } from "@/lib/seo/facts";
import { MORE_FAQ } from "@/lib/seo/faq";

export const metadata: Metadata = pageMeta("/investor-crm");

const FAQ = MORE_FAQ[0].items;

export default function InvestorCrm() {
  return (
    <SeoPage
      path="/investor-crm"
      eyebrow="Investor CRM"
      title="An investor CRM built for founders"
      answer={
        <p>
          An investor CRM is where a founder tracks a fundraise: every investor in the pipeline, the stage they are at, what was
          said, the next follow-up, meetings and what they committed. Raisebook is a free, open-source investor CRM built for
          startup founders. It does that for every round, keeps each investor&apos;s history across rounds, and lets your coding
          agent update the pipeline over MCP.
        </p>
      }
      toc={["Investor CRM vs sales CRM", "What to track per investor", "How Raisebook works", "Who it is for", "What it is not"]}
      faq={FAQ}
      related={[
        { href: "/free-investor-crm", label: "Free, open-source investor CRM" },
        { href: "/seed-round-tracker", label: "Track your seed round" },
        { href: "/compare", label: "Compare investor CRMs" },
        { href: "/fundraising-crm-mcp", label: "Raisebook for AI agents" },
      ]}
    >
      <H2>Investor CRM vs sales CRM</H2>
      <P>
        A sales CRM tracks deals that close for revenue. A raise has a different shape: one round with a target, an instrument
        (SAFE, priced round, convertible note) and a close date; dozens of investors moving through the same stages at once; soft
        and hard commitments that add up against the target; and relationships that carry into the next round. A fundraising CRM
        (another name for an investor CRM) is set up for that from the start, so you do not have to build the pipeline yourself.
      </P>

      <H2>What to track per investor</H2>
      <DocTable
        caption="Fields worth keeping per investor"
        head={["Field", "Why"]}
        monoFirst={false}
        minWidth={480}
        rows={[
          ["Name, firm, title, type", "Who they are: VC, angel, family office, corporate VC, accelerator, scout."],
          ["Email, LinkedIn, website", "How to reach them, and how to tell two entries for the same person apart."],
          ["Check size range", "Whether they can write the check your round needs."],
          ["Stage", `Where they are: ${DEFAULT_STAGES.join(", ")} (Raisebook's defaults).`],
          ["Fit (0 to 5)", "How well they match your stage, sector and size, so the best fits get attention first."],
          ["Owner", "Which founder is on the conversation."],
          ["Follow-up date and note", "The next thing to do and when. The single most useful field."],
          ["Timeline", "Emails, calls, meetings and notes, in order, so nobody asks the same question twice."],
          ["Commitment", "The amount once they commit, adding up against the round target."],
        ].map(([k, v]) => [<b key="k" className="font-semibold">{k}</b>, v])}
      />

      <H2>How Raisebook works</H2>
      <Ul>
        {FEATURES.map((f) => (
          <li key={f.name}>
            <b>{f.name}.</b> {f.text}
          </li>
        ))}
      </Ul>
      <P>
        Details are in <A href="/docs">the docs</A>; the price is <A href="/pricing">$0</A>.
      </P>

      <H2>Who it is for</H2>
      <P>{WHO_FOR}</P>

      <H2>What it is not</H2>
      <Ul>
        {NOT_FOR.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </Ul>
      <P>
        If you need one of those, the <A href="/compare">comparisons</A> say which tools cover them.
      </P>
    </SeoPage>
  );
}
