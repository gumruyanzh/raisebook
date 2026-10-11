"use client";

import type { StageColor } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { num } from "@/lib/format";

import { StageDot, stageVar } from "./Stage";

export interface FunnelSegment {
  key: string;
  label: string;
  color: StageColor;
  count: number;
}

/**
 * The prototype funnel (SYSTEM 3.9): a 26px bar of stage-colored segments plus a legend row.
 * Every segment and legend item is a button that filters by stage (`onSelect`). Zero-count
 * stages appear only in the legend. Segment numbers show only when wider than 6%.
 */
export function FunnelBar({
  segments,
  onSelect,
  active,
  className,
  legendClassName,
  label = "Pipeline by stage",
}: {
  segments: FunnelSegment[];
  onSelect?: (key: string) => void;
  /** Stage key currently filtered, if any. */
  active?: string | null;
  className?: string;
  /** e.g. "max-sm:hidden": the bar alone on phones (tapping a segment still filters). */
  legendClassName?: string;
  label?: string;
}) {
  const total = segments.reduce((s, x) => s + x.count, 0) || 1;
  const interactive = Boolean(onSelect);
  return (
    <div className={cn("flex min-w-0 flex-col gap-8", className)}>
      <div
        role="group"
        aria-label={label}
        className="flex h-26 overflow-hidden rounded-sm bg-sunk"
      >
        {segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <button
              key={s.key}
              type="button"
              tabIndex={interactive ? 0 : -1}
              disabled={!interactive}
              onClick={() => onSelect?.(s.key)}
              title={`${s.label}: ${num(s.count)}`}
              aria-label={`${s.label}: ${num(s.count)}`}
              aria-pressed={interactive ? active === s.key : undefined}
              className={cn(
                "min-w-0 overflow-hidden border-0 p-0 font-mono text-xs font-medium whitespace-nowrap text-on-stage",
                "disabled:cursor-default",
                active && active !== s.key && "opacity-45",
              )}
              style={{ flex: `${s.count} 1 0`, background: stageVar(s.color) }}
            >
              {s.count / total > 0.06 ? num(s.count) : ""}
            </button>
          ))}
      </div>
      <div className={cn("flex flex-wrap gap-x-12 gap-y-4", legendClassName)}>
        {segments.map((s) => (
          <button
            key={s.key}
            type="button"
            disabled={!interactive}
            onClick={() => onSelect?.(s.key)}
            aria-pressed={interactive ? active === s.key : undefined}
            className={cn(
              "t-body-s inline-flex items-center gap-6 border-0 bg-transparent p-0 text-muted disabled:cursor-default",
              interactive && "hover:text-fg",
              active === s.key && "text-fg underline underline-offset-3",
            )}
          >
            <StageDot color={s.color} />
            {s.label} <b className="tnum font-semibold text-fg">{num(s.count)}</b>
          </button>
        ))}
      </div>
    </div>
  );
}
