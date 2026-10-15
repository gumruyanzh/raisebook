import type { Metadata } from "next";

import { A, DocTable, H2, P, Ul } from "@/components/marketing/docs/Prose";
import { PRIVACY_PROMISE } from "@/components/marketing/promise";
import { SeoPage } from "@/components/marketing/seo/Blocks";
import { REPO_URL, pageMeta } from "@/components/marketing/site";
import { COMPARE_CHECKED_ON } from "@/lib/seo/competitors";
import { LIMITS } from "@/lib/seo/facts";
import type { FaqItem } from "@/lib/seo/faq";
import { CodeBlock } from "@/components/ui";

export const metadata: Metadata = pageMeta("/free-investor-crm");

const FAQ: FaqItem[] = [
  {
    q: "What is the catch?",
    a: "There is no investor database and no investor-update emails. Raisebook tracks the raise and nothing else, and it is paid for by its maintainer, not by your data.",
  },
  {
    q: "Is the hosted version the same as the open-source code?",
    a: "Yes. raisebook.org runs the code in the public repository. The AGPL-3.0 licence requires anyone who runs a modified copy as a service to publish their changes.",
  },
  {
    q: "Can I self-host it for my company?",
    a: "Yes. One Docker Compose file runs Postgres, the API and MCP server, the web app and Caddy for TLS.",
    link: { href: "/docs/self-hosting", label: "Self-hosting" },
  },
];

export default function FreeInvestorCrm() {
  return (
    <SeoPage
      path="/free-investor-crm"
      eyebrow="Free · Open source"
      title="A free, open-source investor CRM"
      answer={
        <p>
          Raisebook is a free investor CRM with no paid tier: $0 for every feature, up to {LIMITS.investors.toLocaleString("en-US")}{" "}
          investors, {LIMITS.rounds} rounds and {LIMITS.members} members per workspace. It is open source under AGPL-3.0, so you can
          read the code that holds your investor list or run your own copy, and it never pools, sells or mines that list.
        </p>
      }
      toc={["Free, with no caps that matter", "Open source", "The privacy promise", "Run your own"]}
      faq={FAQ}
      related={[
        { href: "/pricing", label: "Pricing and limits" },
        { href: "/compare", label: "Compare investor CRMs" },
        { href: "/investor-crm", label: "What an investor CRM does" },
      ]}
    >
      <H2>Free, with no caps that matter</H2>
      <P>
        Most free plans for fundraising tools stop early. As their pricing pages read on {COMPARE_CHECKED_ON}: Foundersuite&apos;s
        free plan tracks 75 investors per pipeline, Visible&apos;s free plan has 2 pipelines, and Attio&apos;s free plan allows 3
        seats. Raisebook has one plan, and it is free:
      </P>
      <DocTable
        caption="Free plan limits"
        head={["", "Raisebook", "Foundersuite Basic", "Visible Starter", "Attio Free"]}
        monoFirst={false}
        minWidth={640}
        rows={[
          ["Investors", LIMITS.investors.toLocaleString("en-US"), "75 per pipeline", "–", "50,000 records"],
          ["Pipelines / rounds", String(LIMITS.rounds), "Unlimited", "2", "–"],
          ["People", String(LIMITS.members), "Unlimited users", "2 users", "3 seats"],
          ["Open source", "Yes", "No", "No", "No"],
        ].map(([k, ...v]) => [<b key="k" className="font-semibold">{k}</b>, ...v])}
      />
      <P>
        Sources and details: <A href="/compare/foundersuite">vs Foundersuite</A>, <A href="/compare/visible">vs Visible</A>,{" "}
        <A href="/compare/attio-folk">vs Attio and folk</A>.
      </P>

      <H2>Open source</H2>
      <P>
        Everything is in one repository under AGPL-3.0: the API, the MCP server, the web app and the deploy files. The
        hosted service at raisebook.org runs that same code, so you get a free hosted app and the right to check it or leave with
        it. <A href={REPO_URL}>{REPO_URL.replace(/^https?:\/\//, "")}</A>
      </P>

      <H2>The privacy promise</H2>
      <Ul ordered>
        {PRIVACY_PROMISE.map((p) => (
          <li key={p.lead}>
            <b>{p.lead}</b> {p.body}
          </li>
        ))}
      </Ul>

      <H2>Run your own</H2>
      <CodeBlock
        className="mb-18"
        lang="shell"
        title="Self-host"
        code={[
          `git clone ${REPO_URL}.git && cd raisebook`,
          "cp deploy/.env.example deploy/.env   # set your hosts and secrets",
          "docker compose -f deploy/docker-compose.yml up -d --build",
        ].join("\n")}
      />
    </SeoPage>
  );
}
