"use client";

import type { KeyboardEvent } from "react";

import { cn } from "@/lib/cn";

/**
 * Five 6×10px pips in a neutral ink (SYSTEM 3.7; green stays for committed money, so a board
 * of Hot investors does not read as money). Read-only by default. `editable` turns it
 * into a radio group of six values (0–5): click a pip, or use the arrow keys, Home/End or 0–5.
 */
export function FitMeter({
  value,
  showLabel,
  editable,
  onChange,
  disabled,
  className,
  label = "Fit",
}: {
  value: number;
  showLabel?: boolean;
  editable?: boolean;
  onChange?: (value: number) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
}) {
  const v = Math.max(0, Math.min(5, Math.round(value)));
  const pips = [1, 2, 3, 4, 5].map((i) => (
    <i
      key={i}
      className={cn("block h-10 w-6 rounded-xs not-italic", i <= v ? "bg-muted" : "bg-line")}
    />
  ));
  const text = showLabel ? <span className="ml-4">{v}/5</span> : null;

  if (!editable) {
    return (
      <span
        role="img"
        aria-label={`${label} ${v} of 5`}
        title={`${label} ${v} of 5`}
        className={cn("inline-flex items-center gap-2 font-mono text-xs font-medium text-muted", className)}
      >
        {pips}
        {text}
      </span>
    );
  }

  const set = (n: number) => {
    if (!disabled && n !== v) onChange?.(Math.max(0, Math.min(5, n)));
  };
  const focusValue = (root: HTMLElement | null, n: number) =>
    root?.querySelector<HTMLElement>(`[data-fit="${n}"]`)?.focus();
  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    const map: Record<string, number> = {
      ArrowRight: Math.min(5, v + 1),
      ArrowUp: Math.min(5, v + 1),
      ArrowLeft: Math.max(0, v - 1),
      ArrowDown: Math.max(0, v - 1),
      Home: 0,
      End: 5,
    };
    let n: number | undefined;
    if (e.key in map) n = map[e.key];
    else if (/^[0-5]$/.test(e.key)) n = Number(e.key);
    if (n === undefined) return;
    e.preventDefault();
    set(n);
    focusValue(e.currentTarget, n);
  };
  // A radio group of six (0–5): the "0" item (shown as a small "clear" once a fit is set)
  // clears, pips 1–5 set the fit. Roving tabindex.
  return (
    <span
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKey}
      className={cn(
        "inline-flex items-center gap-2 font-mono text-xs font-medium text-muted",
        disabled && "opacity-60",
        className,
      )}
    >
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          role="radio"
          data-fit={i}
          aria-checked={i === v}
          aria-label={i === 0 ? "Unrated (clear fit)" : `${i} of 5`}
          tabIndex={disabled ? -1 : i === (v === 0 ? 1 : v) ? 0 : -1}
          onClick={() => set(i)}
          className={cn(
            "flex items-center justify-center rounded-xs",
            disabled ? "cursor-not-allowed" : "cursor-pointer",
            i === 0 ? "order-last ml-6 h-14 font-body text-micro hover:text-fg focus-visible:text-fg" : "h-14 w-8",
            i === 0 && v === 0 && "sr-only",
          )}
        >
          {i === 0 ? (
            <span aria-hidden>clear</span>
          ) : (
            <i
              className={cn(
                "block h-14 w-8 rounded-xs not-italic transition-colors duration-[120ms]",
                i <= v ? "bg-muted" : "bg-line hover:bg-faint",
              )}
            />
          )}
        </span>
      ))}
      <span className="ml-4" aria-hidden>
        {v ? `${v}/5` : "unrated"}
      </span>
    </span>
  );
}
