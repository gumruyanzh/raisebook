import type { ReactNode } from "react";

/**
 * Single-topic pages (privacy, terms, support, changelog): a margin column with the page's
 * facts (updated date, status, contents) and the text at a 680px measure.
 */
export function PageShell({
  aside,
  children,
}: {
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="gutter mx-auto grid max-w-site gap-x-56 gap-y-24 pt-32 pb-96 xl:grid-cols-[220px_minmax(0,680px)] xl:pt-56">
      <aside className="min-w-0 xl:order-none">
        <div className="xl:sticky xl:top-24">{aside}</div>
      </aside>
      <article className="min-w-0">{children}</article>
    </div>
  );
}

/** Mono facts for the margin: "UPDATED 2026-10-10", "STATUS Draft". */
export function AsideFacts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-12 gap-y-6 border-y border-line py-10 xl:grid-cols-1 xl:gap-y-2">
      {items.map(([k, v]) => (
        <div key={k} className="contents xl:mb-8 xl:block">
          <dt className="t-label">{k}</dt>
          <dd className="t-micro m-0 text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** In-page contents list for the margin (hidden on phones). */
export function AsideToc({ items }: { items: { id: string; label: string }[] }) {
  return (
    <nav aria-label="On this page" className="mt-18 hidden xl:block">
      <p className="t-label mb-8">On this page</p>
      <ul className="m-0 flex list-none flex-col gap-5 p-0">
        {items.map((i) => (
          <li key={i.id}>
            <a href={`#${i.id}`} className="text-sm text-muted hover:text-fg">
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
