import type { Metadata } from "next";
import Link from "next/link";

import { A, DocTable, H2, Muted, P } from "@/components/marketing/docs/Prose";
import { SeoPage } from "@/components/marketing/seo/Blocks";
import { pageMeta } from "@/components/marketing/site";
import { COMPARE_CHECKED_ON, COMPARISONS, OVERVIEW } from "@/lib/seo/competitors";
import { page } from "@/lib/seo/pages";

export const metadata: Metadata = pageMeta("/compare");

export default function CompareHub() {
  return (
    <SeoPage
      path="/compare"
      eyebrow="Compare"
      title="Raisebook compared with other investor CRMs"
      answer={
        <p>
          Raisebook is the free, open-source option among investor CRMs: $0 with no paid tier, up to 20,000 investors per
          workspace, self-hostable, with an MCP server on the free plan. The paid tools add things Raisebook does not do:
          Foundersuite has an investor database, Visible adds investor updates and data rooms, Affinity is built for VC firms,
          and Attio and folk are general CRMs you can shape for fundraising.
        </p>
      }
      toc={["At a glance", "Comparisons"]}
      facts={[["Checked", COMPARE_CHECKED_ON]]}
      related={[
        { href: "/investor-crm", label: "What an investor CRM does" },
        { href: "/free-investor-crm", label: "Free, open-source investor CRM" },
        { href: "/pricing", label: "Raisebook pricing" },
      ]}
    >
      <H2>At a glance</H2>
      <DocTable
        caption="Investor CRMs at a glance"
        head={["", "Lowest paid price", "Free plan", "Open source", "MCP server"]}
        monoFirst={false}
        minWidth={720}
        rows={OVERVIEW.map(([name, ...rest]) => [<b key="n" className="font-semibold">{name}</b>, ...rest])}
      />
      <Muted>
        From each product&apos;s public pricing page on {COMPARE_CHECKED_ON}; the sources are linked on each comparison. Prices
        change, so check before you decide.
      </Muted>

      <H2>Comparisons</H2>
      <ul className="m-0 mb-14 flex list-none flex-col border-b border-line p-0">
        {COMPARISONS.map((c) => {
          const p = page(`/compare/${c.slug}`);
          return (
            <li key={c.slug} className="border-t border-line py-14">
              <Link href={p.path} className="link t-body-l font-semibold">
                {p.title}
              </Link>
              <p className="t-body-s mt-4 text-muted">{p.description}</p>
            </li>
          );
        })}
      </ul>
      <P>
        Still on a spreadsheet? Read <A href="/compare/spreadsheet">when a sheet stops keeping up</A>, or{" "}
        <A href="/seed-round-tracker">how to track a seed round</A>.
      </P>
    </SeoPage>
  );
}
