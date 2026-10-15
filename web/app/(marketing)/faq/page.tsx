import type { Metadata } from "next";

import { DocHeader, H2, slug } from "@/components/marketing/docs/Prose";
import { Faq } from "@/components/marketing/Faq";
import { JsonLd } from "@/components/marketing/JsonLd";
import { AsideFacts, AsideToc, PageShell } from "@/components/marketing/PageShell";
import { Breadcrumbs, faqNodes } from "@/components/marketing/seo/Blocks";
import { pageMeta } from "@/components/marketing/site";
import { ButtonLink } from "@/components/ui";
import { HOME_FAQ, MORE_FAQ } from "@/lib/seo/faq";
import { page } from "@/lib/seo/pages";
import { faqPage, pageGraph } from "@/lib/seo/schema";

export const metadata: Metadata = pageMeta("/faq");

const GROUPS = [{ group: "About Raisebook", items: HOME_FAQ }, ...MORE_FAQ];

export default function FaqHub() {
  const all = GROUPS.flatMap((g) => g.items);
  return (
    <PageShell
      aside={
        <>
          <AsideFacts items={[["Updated", <time key="u" dateTime={page("/faq").updated}>{page("/faq").updated}</time>], ["Questions", String(all.length)]]} />
          <AsideToc items={GROUPS.map((g) => ({ id: slug(g.group), label: g.group }))} />
        </>
      }
    >
      <JsonLd data={pageGraph("/faq", faqPage(all, "/faq"))} />
      <Breadcrumbs path="/faq" />
      <DocHeader
        eyebrow="FAQ"
        title="Questions founders ask"
        lede={
          <p>
            Raisebook is a free, open-source investor CRM for startup founders. These are the questions people ask before they move
            their raise into it: price, privacy, agents, research, meetings and how it compares.
          </p>
        }
      />
      {GROUPS.map((g) => (
        <section key={g.group}>
          <H2>{g.group}</H2>
          <Faq items={faqNodes(g.items)} />
        </section>
      ))}
      <div className="mt-48 flex flex-wrap items-center gap-x-18 gap-y-12">
        <ButtonLink href="/signin" variant="primary">
          Start your raise, free
        </ButtonLink>
        <a href="mailto:0@raisebook.org" className="link">
          Ask another question: 0@raisebook.org
        </a>
      </div>
    </PageShell>
  );
}
