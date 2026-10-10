import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Title block for non-round pages (SYSTEM §4.1): display-m title, muted subline, actions right. */
export function PageHeader({
  title,
  subline,
  actions,
  className,
}: {
  title: ReactNode;
  subline?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-16 flex flex-wrap items-end gap-x-16 gap-y-10", className)}>
      <div className="min-w-0 flex-1">
        <h1 className="t-display-m">{title}</h1>
        {subline ? <p className="mt-4 text-muted">{subline}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-8">{actions}</div> : null}
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
        state === "saved" && "text-good",
        state === "saving" && "text-muted",
        state === "error" && "text-bad",
      )}
    >
      {state === "saved" ? "Saved" : state === "saving" ? "Saving…" : "Not saved"}
    </span>
  );
}
