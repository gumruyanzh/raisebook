import type { ReactNode } from "react";

/** A ruled list of questions; each answer opens in place (native <details>, no script). */
export function Faq({ items }: { items: { q: string; a: ReactNode }[] }) {
  return (
    <div className="border-b border-line">
      {items.map((it) => (
        <details key={it.q} className="group border-t border-line">
          <summary className="flex cursor-pointer list-none items-baseline gap-14 py-14 [&::-webkit-details-marker]:hidden">
            <span className="t-body-l flex-1 font-semibold">{it.q}</span>
            <span
              aria-hidden
              className="t-micro w-16 shrink-0 text-right text-muted group-open:hidden"
            >
              +
            </span>
            <span
              aria-hidden
              className="t-micro hidden w-16 shrink-0 text-right text-muted group-open:inline"
            >
              ✕
            </span>
          </summary>
          <div className="t-body-l max-w-[64ch] pb-18 text-muted [&_a]:text-accent [&_a:hover]:underline">
            {it.a}
          </div>
        </details>
      ))}
    </div>
  );
}
