import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * A landing section laid out like a ledger page: a hairline rule across the top, a mono margin
 * note on the left ("02 · Agents"), and the content on the right. Under 1024px the note sits
 * above the content.
 */
export function Section({
  id,
  index,
  note,
  title,
  lede,
  children,
  className,
}: {
  id?: string;
  /** Two-digit section number shown in the margin. */
  index: string;
  /** Short margin label, e.g. "Agents". */
  note: string;
  title?: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cn("gutter mx-auto max-w-site scroll-mt-24", className)}
    >
      <div className="grid gap-x-32 gap-y-14 border-t border-line pt-24 pb-64 xl:grid-cols-[168px_minmax(0,1fr)] xl:pb-96">
        <p className="t-label flex items-baseline gap-8 xl:pt-10">
          <span className="text-fg">{index}</span>
          <span aria-hidden>·</span>
          <span>{note}</span>
        </p>
        <div className="min-w-0">
          {title ? (
            <h2 id={headingId} className="t-display-l max-w-[22ch]">
              {title}
            </h2>
          ) : null}
          {lede ? <div className="t-body-l mt-14 max-w-[60ch] text-muted">{lede}</div> : null}
          {children ? <div className={cn(title || lede ? "mt-32" : undefined)}>{children}</div> : null}
        </div>
      </div>
    </section>
  );
}

/** A numbered, ruled list (privacy promise, agent points). Numbers are mono and muted. */
export function RuledList({
  items,
  numbered = true,
  className,
}: {
  items: { lead: ReactNode; body?: ReactNode }[];
  numbered?: boolean;
  className?: string;
}) {
  return (
    <ol className={cn("m-0 list-none border-b border-line p-0", className)}>
      {items.map((it, i) => (
        <li
          key={i}
          className={cn(
            "grid gap-x-14 border-t border-line py-14",
            numbered ? "grid-cols-[32px_minmax(0,1fr)]" : "grid-cols-1",
          )}
        >
          {numbered ? (
            <span className="t-micro pt-3 text-muted">{String(i + 1).padStart(2, "0")}</span>
          ) : null}
          <p className="t-body-l">
            <b className="font-semibold">{it.lead}</b>
            {it.body ? <span className="text-muted"> {it.body}</span> : null}
          </p>
        </li>
      ))}
    </ol>
  );
}
