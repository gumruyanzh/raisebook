import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface Crumb {
  label: ReactNode;
  href: string;
}

/**
 * The in-app title row (UX-PASS-1 P1-9): one title size on every app page (display-s,
 * 22px/700, line-height 1.15) in a fixed 40px row, so titles sit at the same y as the round
 * pages. An optional breadcrumb sits inline before the title ("Investors / Dana Whitfield"),
 * a short muted aside after it, and actions on the right. A longer subline goes under the row.
 */
export function PageHeader({
  title,
  subline,
  aside,
  crumbs,
  actions,
  className,
}: {
  title: ReactNode;
  /** One muted sentence under the title row. */
  subline?: ReactNode;
  /** A short muted note inline after the title ("212 contacts"). */
  aside?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-14", className)}>
      <div className="flex min-h-40 flex-wrap items-center gap-x-12 gap-y-6">
        <div className="flex min-w-0 flex-1 items-baseline gap-x-10">
          {crumbs?.length ? (
            <nav aria-label="Breadcrumb" className="t-body flex shrink-0 items-baseline gap-6 text-muted">
              {crumbs.map((c, i) => (
                <span key={i} className="inline-flex items-baseline gap-6">
                  <Link href={c.href} className="hover:text-fg hover:underline">
                    {c.label}
                  </Link>
                  <span aria-hidden>/</span>
                </span>
              ))}
            </nav>
          ) : null}
          <h1 className="t-display-s min-w-0 truncate">{title}</h1>
          {aside ? <span className="t-micro hidden shrink-0 text-muted sm:inline">{aside}</span> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-8">{actions}</div> : null}
      </div>
      {aside ? <p className="t-micro text-muted sm:hidden">{aside}</p> : null}
      {subline ? <p className="mt-2 max-w-[80ch] text-muted">{subline}</p> : null}
    </header>
  );
}

/** Mono uppercase section label ("PIPELINE", "STAGE FOR SEED"), optional right-side slot. */
export function SectionLabel({
  children,
  aside,
  as: Tag = "h2",
  className,
  id,
}: {
  children: ReactNode;
  aside?: ReactNode;
  as?: "h2" | "h3" | "div";
  className?: string;
  id?: string;
}) {
  return (
    <div className={cn("mb-6 flex items-baseline gap-10", className)}>
      <Tag id={id} className="t-label">
        {children}
      </Tag>
      {aside ? <span className="ml-auto">{aside}</span> : null}
    </div>
  );
}

/** Mono "Saved" in good beside a section label, or "Saving…" in muted. */
export function SaveState({ state }: { state: "idle" | "saving" | "saved" | "error" }) {
  if (state === "idle") return <span className="t-micro" aria-live="polite" />;
  return (
    <span
      aria-live="polite"
      className={cn(
        "t-micro",
        state === "saved" && "text-good-ink",
        state === "saving" && "text-muted",
        state === "error" && "text-bad",
      )}
    >
      {state === "saved" ? "Saved" : state === "saving" ? "Saving…" : "Not saved"}
    </span>
  );
}
