import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * CSS-only tooltip (hover and keyboard focus, 300ms delay). The trigger stays the accessible
 * element; the tip is also exposed through `aria-describedby` when you pass `id`.
 * Keep tips to one short line ("Moved by claude-code 2h ago").
 */
export function Tooltip({
  tip,
  children,
  side = "top",
  align = "center",
  id,
  className,
}: {
  tip: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  id?: string;
  className?: string;
}) {
  return (
    <span className={cn("rb-tip", className)} data-side={side} data-align={align}>
      {children}
      <span role="tooltip" id={id}>
        {tip}
      </span>
    </span>
  );
}
