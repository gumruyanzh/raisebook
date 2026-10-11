import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Keyboard hint: mono 11px in a 1px line box (SYSTEM 3.24). Hidden on touch screens
 * (pointer: coarse), where there is no keyboard to press it on.
 */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-18 min-w-18 items-center justify-center rounded-kbd border border-line px-4",
        "font-mono text-xs leading-none font-normal text-muted [@media(pointer:coarse)]:hidden",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
