"use client";

import type { KeyboardEvent } from "react";

import { cn } from "@/lib/cn";

/**
 * Five 5×9px pips in a quiet ink (SYSTEM 3.7): `faint` filled on `line`, so a column of Hot
 * investors does not read as a barcode louder than the names (critique 2), and green stays
 * for committed money. One color everywhere, read-only or editable. Read-only by default.
 * `editable` turns it into a radio group of six values (0–5): click a pip, or use the arrow
 * keys, Home/End or 0–5. Fit is the pips alone: no "5/5" beside them; an unrated fit says
 * "Not rated", and a rated one offers a small ✕ (on hover or focus) to clear it.
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
      className={cn("block h-9 w-5 rounded-[1.5px] not-italic", i <= v ? "bg-faint" : "bg-line")}
    />
  ));
  const text = showLabel ? <span className="ml-4">{v}/5</span> : null;

  if (!editable) {
    return (
      <span
        role="img"
        aria-label={`${label} ${v} of 5`}
        title={`${label} ${v} of 5`}
        className={cn("inline-flex items-center gap-[2px] font-mono text-xs font-medium text-muted", className)}
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
  // A radio group of six (0–5): pips 1–5 set the fit; the "0" item (a small ✕ that shows on
  // hover or focus once a fit is set) clears it. Roving tabindex.
  return (
    <span
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKey}
      className={cn(
        "group/fit inline-flex items-center gap-2 font-mono text-xs font-medium text-muted",
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
          aria-label={i === 0 ? "Not rated (clear the fit)" : `${i} of 5`}
          title={i === 0 ? "Clear the fit" : `Fit ${i} of 5`}
          tabIndex={disabled ? -1 : i === (v === 0 ? 1 : v) ? 0 : -1}
          onClick={() => set(i)}
          className={cn(
            "flex items-center justify-center rounded-xs",
            disabled ? "cursor-not-allowed" : "cursor-pointer",
            i === 0
              ? "order-last ml-4 size-16 text-[11px] text-muted opacity-0 group-hover/fit:opacity-100 group-focus-within/fit:opacity-100 hover:bg-sunk hover:text-fg focus-visible:opacity-100"
              : "h-14 w-7",
            i === 0 && (v === 0 || disabled) && "sr-only",
          )}
        >
          {i === 0 ? (
            <span aria-hidden>✕</span>
          ) : (
            <i
              className={cn(
                "block h-12 w-6 rounded-[1.5px] not-italic transition-colors duration-[120ms]",
                i <= v ? "bg-faint group-hover/fit:bg-muted" : "bg-line hover:bg-faint",
              )}
            />
          )}
        </span>
      ))}
      {v === 0 ? (
        <span className="order-last ml-4 font-body text-micro text-muted" aria-hidden>
          Not rated
        </span>
      ) : null}
    </span>
  );
}
