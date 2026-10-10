"use client";

import { useRef, type KeyboardEvent } from "react";

import type { StageColor } from "@/lib/api/types";
import { cn } from "@/lib/cn";

/** Static class map so Tailwind sees every stage utility. */
export const STAGE_BG: Record<StageColor, string> = {
  slate: "bg-stage-slate",
  violet: "bg-stage-violet",
  cobalt: "bg-stage-cobalt",
  teal: "bg-stage-teal",
  amber: "bg-stage-amber",
  orange: "bg-stage-orange",
  green: "bg-stage-green",
  gray: "bg-stage-gray",
  olive: "bg-stage-olive",
  sky: "bg-stage-sky",
};

export const STAGE_TEXT: Record<StageColor, string> = {
  slate: "text-stage-slate",
  violet: "text-stage-violet",
  cobalt: "text-stage-cobalt",
  teal: "text-stage-teal",
  amber: "text-stage-amber",
  orange: "text-stage-orange",
  green: "text-stage-green",
  gray: "text-stage-gray",
  olive: "text-stage-olive",
  sky: "text-stage-sky",
};

/** CSS variable for inline styles (column top rule, funnel segments). */
export const stageVar = (color: StageColor) => `var(--stage-${color})`;

/** 9px stage dot, aria-hidden. Always next to a text label (SYSTEM 3.6). */
export function StageDot({ color, className }: { color: StageColor; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-9 shrink-0 rounded-pill", STAGE_BG[color], className)}
    />
  );
}

/** Stage as dot + label, no background (the table "stage pill", SYSTEM §2.1). */
export function StagePill({
  color,
  label,
  className,
}: {
  color: StageColor;
  label: string;
  className?: string;
}) {
  return (
    <span className={cn("t-body-s inline-flex items-center gap-6 whitespace-nowrap", className)}>
      <StageDot color={color} />
      {label}
    </span>
  );
}

export interface StageOption {
  key: string;
  label: string;
  color: StageColor;
}

/**
 * The sheet's stage selector: a row of pill buttons; the active one is filled fg with canvas
 * text (SYSTEM §2.1). Arrow keys move focus; Enter/Space selects.
 */
export function StageSelector({
  stages,
  value,
  onSelect,
  disabled,
  label = "Stage",
  className,
}: {
  stages: StageOption[];
  value: string | null | undefined;
  onSelect?: (key: string) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const next = btns[(i + (e.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length];
    next?.focus();
  };
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      onKeyDown={onKey}
      className={cn("flex flex-wrap gap-5", className)}
    >
      {stages.map((s) => {
        const active = s.key === value;
        return (
          <button
            key={s.key}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            title={disabled ? "View only" : undefined}
            onClick={() => !active && onSelect?.(s.key)}
            className={cn(
              "t-body-s inline-flex h-28 items-center gap-6 rounded-pill border px-10 transition-colors duration-[120ms]",
              active
                ? "border-fg bg-fg text-canvas"
                : "border-line bg-surface text-fg hover:border-muted",
              disabled && "opacity-60",
            )}
          >
            <StageDot color={s.color} />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
