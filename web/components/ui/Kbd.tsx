import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Keyboard hint: mono 10.5px in a 1px line box (SYSTEM 3.24). */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-18 min-w-18 items-center justify-center rounded-kbd border border-line px-4",
        "font-mono text-2xs leading-none font-normal text-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
