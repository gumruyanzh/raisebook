import { A, DocTable, H2, Muted, P, Ul } from "@/components/marketing/docs/Prose";
import { COMPARE_CHECKED_ON, COMPARISONS, comparison } from "@/lib/seo/competitors";
import { page } from "@/lib/seo/pages";

import { SeoPage } from "./Blocks";

/** A comparison page (/compare/<slug>): answer, table with sources, when to choose which, FAQ. */
export function ComparePage({ slug }: { slug: string }) {
  const c = comparison(slug);
  const path = `/compare/${slug}`;
  const others = COMPARISONS.filter((x) => x.slug !== slug);
  return (
    <SeoPage
      path={path}
      eyebrow={`Compare · ${c.phrase}`}
      title={page(path).title}
      answer={<p>{c.answer}</p>}
      toc={["Side by side", `When ${c.name} fits better`, "When Raisebook fits better", "Sources"]}
      facts={[
        ["Checked", COMPARE_CHECKED_ON],
        ["Raisebook", "$0, AGPL-3.0"],
      ]}
      faq={c.faq}
      related={[
        { href: "/compare", label: "All comparisons" },
        ...others.slice(0, 3).map((o) => ({ href: `/compare/${o.slug}`, label: page(`/compare/${o.slug}`).title })),
        { href: "/pricing", label: "Raisebook pricing" },
      ]}
    >
      <H2>Side by side</H2>
      <DocTable
        caption={`Raisebook compared with ${c.name}`}
        head={["", "Raisebook", ...c.columns]}
        monoFirst={false}
        minWidth={c.columns.length > 1 ? 720 : 560}
        rows={c.rows.map((r) => [<b key="l" className="font-semibold">{r.label}</b>, ...r.cells])}
      />
      <Muted>
        Competitor facts are from their public pages as they read on {COMPARE_CHECKED_ON}. Prices and plans change; check the
        sources below before you decide.
      </Muted>

      <H2>{`When ${c.name} fits better`}</H2>
      <Ul>
        {c.chooseThem.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </Ul>

      <H2>When Raisebook fits better</H2>
      <Ul>
        {c.chooseRaisebook.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </Ul>
      <P>
        Raisebook has no investor database and never emails investors for you. It tracks the raise: rounds, stages, follow-ups,
        meetings, notes and commitments, with <A href="/fundraising-crm-mcp">an MCP server for your agent</A> and{" "}
        <A href="/ai-investor-research">cited investor research on your own key</A>.
      </P>

      <H2>Sources</H2>
      {c.sources.length ? (
        <Ul>
          {c.sources.map((s) => (
            <li key={s.url}>
              <A href={s.url}>{s.label}</A> <span className="text-muted">(checked {COMPARE_CHECKED_ON})</span>
            </li>
          ))}
          <li>
            Raisebook: <A href="/pricing">pricing and limits</A>, <A href="/docs">docs</A> and the source code.
          </li>
        </Ul>
      ) : (
        <P>
          Raisebook facts are from <A href="/pricing">its pricing and limits</A> and <A href="/docs">docs</A>. The spreadsheet
          and template columns describe what those tools do without extra setup.
        </P>
      )}
    </SeoPage>
  );
}
