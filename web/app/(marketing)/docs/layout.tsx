import type { Metadata } from "next";

import { DocsNav } from "@/components/marketing/docs/DocsNav";

export const metadata: Metadata = {
  title: { template: "%s · Raisebook docs", default: "Docs" },
};

/** Docs shell (SYSTEM §4.15): a 220px sticky nav and content at a 680px measure. */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="gutter mx-auto grid max-w-site gap-x-56 gap-y-24 pt-32 pb-96 xl:grid-cols-[220px_minmax(0,680px)] xl:pt-56">
      <div className="min-w-0">
        <DocsNav />
      </div>
      <article className="min-w-0">{children}</article>
    </div>
  );
}
