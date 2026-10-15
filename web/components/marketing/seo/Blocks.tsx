import Link from "next/link";
import type { ReactNode } from "react";

import { Faq } from "@/components/marketing/Faq";
import { JsonLd } from "@/components/marketing/JsonLd";
import { AsideFacts, AsideToc, PageShell } from "@/components/marketing/PageShell";
import { DocHeader, slug } from "@/components/marketing/docs/Prose";
import { ButtonLink, TextLink } from "@/components/ui";
import type { FaqItem } from "@/lib/seo/faq";
import { crumbs, page } from "@/lib/seo/pages";
import { faqPage, pageGraph } from "@/lib/seo/schema";

/** FAQ entries (plain text + optional link) as the Faq component's items. */
export function faqNodes(items: FaqItem[]): { q: string; a: ReactNode }[] {
  return items.map((it) => ({
    q: it.q,
    a: (
      <p>
        {it.a}
        {it.link ? (
          <>
            {" "}
            <Link href={it.link.href}>{it.link.label}</Link>.
          </>
        ) : null}
      </p>
    ),
  }));
}

/** Visible breadcrumbs, matching the BreadcrumbList in the page's JSON-LD. */
export function Breadcrumbs({ path }: { path: string }) {
  const trail = crumbs(path);
  return (
    <nav aria-label="Breadcrumb" className="mb-14">
      <ol className="t-micro m-0 flex list-none flex-wrap items-center gap-x-6 gap-y-2 p-0 text-muted">
        {trail.map((c, i) => (
          <li key={c.path} className="flex items-center gap-6">
            {i > 0 ? <span aria-hidden>/</span> : null}
            {i === trail.length - 1 ? (
              <span aria-current="page" className="text-fg">
                {c.name}
              </span>
            ) : (
              <Link href={c.path} className="hover:text-fg">
                {c.name}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * A product, guide or comparison page: breadcrumbs, an answer-first header, the body, an FAQ,
 * related links and a call to action, with the page, breadcrumb and FAQ structured data.
 */
export function SeoPage({
  path,
  eyebrow,
  title,
  answer,
  toc,
  facts,
  faq,
  related,
  children,
}: {
  path: string;
  eyebrow: string;
  title: string;
  /** The answer-first paragraph: quotable on its own. */
  answer: ReactNode;
  toc?: string[];
  facts?: [string, ReactNode][];
  faq?: FaqItem[];
  related?: { href: string; label: string }[];
  children: ReactNode;
}) {
  const p = page(path);
  const tocItems = [...(toc ?? []), ...(faq?.length ? ["Questions"] : [])];
  return (
    <PageShell
      aside={
        <>
          <AsideFacts
            items={[
              ["Updated", <time key="u" dateTime={p.updated}>{p.updated}</time>],
              ...(facts ?? [
                ["Price", "$0, every feature"],
                ["License", "AGPL-3.0"],
              ]),
            ]}
          />
          {tocItems.length ? <AsideToc items={tocItems.map((s) => ({ id: slug(s), label: s }))} /> : null}
        </>
      }
    >
      <JsonLd data={pageGraph(path, ...(faq?.length ? [faqPage(faq, path)] : []))} />
      <Breadcrumbs path={path} />
      <DocHeader eyebrow={eyebrow} title={title} lede={answer} />
      <div className="mb-32 flex flex-wrap items-center gap-x-18 gap-y-12">
        <ButtonLink href="/signin" variant="primary">
          Start your raise, free
        </ButtonLink>
        <TextLink href="/docs">Read the docs →</TextLink>
      </div>

      {children}

      {faq?.length ? (
        <>
          <h2 id="questions" className="t-display-xs mt-48 mb-12 scroll-mt-24">
            Questions
          </h2>
          <Faq items={faqNodes(faq)} />
        </>
      ) : null}

      {related?.length ? (
        <nav aria-label="Related pages" className="mt-48 border-t border-line pt-18">
          <p className="t-label mb-10">Related</p>
          <ul className="m-0 flex list-none flex-col gap-6 p-0">
            {related.map((r) => (
              <li key={r.href}>
                <Link href={r.href} className="link">
                  {r.label} →
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <section aria-labelledby="cta-title" className="mt-48 rounded-md border border-line bg-surface p-18">
        <h2 id="cta-title" className="t-display-xs">
          Start your raise.
        </h2>
        <p className="t-body-l mt-6 text-muted">
          Free forever. Sign in with an email link or Google, import a CSV or start from a sample workspace of fictional
          investors.
        </p>
        <div className="mt-14 flex flex-wrap items-center gap-x-18 gap-y-12">
          <ButtonLink href="/signin" variant="primary">
            Start free
          </ButtonLink>
          <TextLink href="/docs/mcp">Connect Claude Code →</TextLink>
        </div>
      </section>
    </PageShell>
  );
}
