"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * The prototype `.seg` (SYSTEM 3.3): a 1px line box; the active item is filled fg with canvas
 * text. `role="group"` + `aria-pressed`. Board/Table, the activity kind picker, instrument.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex overflow-hidden rounded-md border border-line bg-surface",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            disabled={o.disabled}
            onClick={() => !active && onChange(o.value)}
            className={cn(
              "border-0 transition-colors duration-[120ms] disabled:opacity-50",
              size === "sm" ? "h-26 px-10 text-sm" : "h-30 px-12 text-base",
              active ? "bg-fg text-canvas" : "bg-transparent text-muted hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
