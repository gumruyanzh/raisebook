import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface DefItem {
  term: ReactNode;
  value: ReactNode;
}

/** The prototype `.facts`: 112px muted term column + value column, 13px (SYSTEM 3.31). */
export function DefList({
  items,
  className,
  termWidth = 112,
}: {
  items: DefItem[];
  className?: string;
  termWidth?: number;
}) {
  const shown = items.filter((i) => i.value !== null && i.value !== undefined && i.value !== "");
  return (
    <dl
      className={cn("grid gap-x-10 gap-y-6 text-13", className)}
      style={{ gridTemplateColumns: `${termWidth}px minmax(0, 1fr)` }}
    >
      {shown.map((item, i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{item.term}</dt>
          <dd className="m-0 [overflow-wrap:anywhere]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
