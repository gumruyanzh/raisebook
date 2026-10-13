import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Dashed surface, centered (SYSTEM 3.17). Copy: what lives here, then how to get it there,
 * one sentence each (SYSTEM §6).
 */
export function EmptyState({
  title,
  children,
  actions,
  className,
  style,
}: {
  title: ReactNode;
  /** One sentence in muted. */
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={style}
      className={cn(
        "rounded-md border border-dashed border-line bg-surface p-28 text-center text-muted",
        className,
      )}
    >
      <p className="t-display-xs text-fg">{title}</p>
      {children ? <p className="mx-auto mt-4 max-w-[52ch]">{children}</p> : null}
      {actions ? (
        <div className="mt-14 flex flex-wrap items-center justify-center gap-8">{actions}</div>
      ) : null}
    </div>
  );
}
