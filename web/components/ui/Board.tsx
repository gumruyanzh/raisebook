import type { ComponentProps, ReactNode } from "react";

import type { FollowUpState, StageColor } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { moneyCompact, num } from "@/lib/format";

import { Chip, FollowUpChip, MoneyChip, PriorityChip } from "./Chip";
import { FitMeter } from "./FitMeter";
import { StageDot, stageVar } from "./Stage";
import { Tooltip } from "./Tooltip";

/** Horizontal board scroller: columns minmax(250px, 1fr), 85vw with snap under 640px. */
export function Board({ children, className, ...rest }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid min-h-[60vh] auto-cols-[85vw] grid-flow-col gap-10 overflow-x-auto pb-8",
        "snap-x snap-mandatory sm:auto-cols-[minmax(250px,1fr)] sm:snap-none",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface BoardColumnProps extends Omit<ComponentProps<"section">, "children"> {
  label: string;
  color: StageColor;
  count: number;
  /** For the won stage: the column total ("$750k") in good. */
  total?: { amount: number; currency: string } | null;
  /** Drop target highlight (2px dashed accent outline). */
  isDropTarget?: boolean;
  /** Viewers see "Nothing here yet" instead of "Drag investors here". */
  readOnly?: boolean;
  /** Cards not rendered yet (after the first 60). Shows "Show N more". */
  hiddenCount?: number;
  onShowMore?: () => void;
  children?: ReactNode;
}

/**
 * A sunk column with a 3px top rule in the stage color and a sticky header (SYSTEM 3.12).
 * Pass drag handlers (onDragOver, onDrop…) straight through as props.
 */
export function BoardColumn({
  label,
  color,
  count,
  total,
  isDropTarget,
  readOnly,
  hiddenCount = 0,
  onShowMore,
  children,
  className,
  ...rest
}: BoardColumnProps) {
  const empty = count === 0;
  return (
    <section
      aria-label={`${label}, ${count}`}
      className={cn(
        "flex max-h-[78vh] min-w-0 snap-start flex-col rounded-md bg-sunk",
        isDropTarget && "outline-2 -outline-offset-2 outline-accent outline-dashed",
        className,
      )}
      style={{ borderTop: `3px solid ${stageVar(color)}` }}
      {...rest}
    >
      <header className="sticky top-0 flex items-center gap-8 rounded-t-md bg-sunk px-10 pt-10 pb-8 text-13 font-semibold">
        <StageDot color={color} />
        <h3 className="min-w-0 truncate">{label}</h3>
        <span className="ml-auto flex items-baseline gap-6 font-mono text-[12px] font-normal text-muted">
          {total && total.amount > 0 ? (
            <span className="text-good" title={`${label} total`}>
              {moneyCompact(total.amount, total.currency)}
            </span>
          ) : null}
          {num(count)}
        </span>
      </header>
      <div className="flex min-h-40 flex-col gap-6 overflow-y-auto px-8 pb-8">
        {children}
        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={onShowMore}
            className="link border-0 bg-transparent p-6 text-sm"
          >
            Show {num(Math.min(60, hiddenCount))} more
          </button>
        ) : null}
        {empty ? (
          <p className="t-micro px-4 py-6 text-muted">
            {readOnly ? "Nothing here yet" : "Drag investors here"}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export interface BoardCardProps extends Omit<ComponentProps<"button">, "title"> {
  name: string;
  title?: string | null;
  firm?: string | null;
  fit: number;
  /** Investor type label ("VC"). */
  typeLabel?: string | null;
  /** First industry; extra tags collapse to "+N". */
  industry?: string | null;
  extraTagCount?: number;
  followUpOn?: string | null;
  followUpState?: FollowUpState | null;
  today?: string;
  /** Money chip: committed amount in the won stage, or the soft amount. */
  amount?: { value: number; currency: string; soft?: boolean } | null;
  nextStep?: string | null;
  /** Agent changed this card in the last 24h: diamond marker + tooltip. */
  agentMark?: { tip: string } | null;
  dragging?: boolean;
}

/**
 * The investor card (SYSTEM 3.13): a <button>. Row 1 name (+ agent marker), row 2
 * "Title · Firm", row 3 chips + FitMeter, then optional due chip, money chip and next step.
 * Keyboard moves (Alt+←/→, M) are wired by the board via onKeyDown.
 */
export function BoardCard({
  name,
  title,
  firm,
  fit,
  typeLabel,
  industry,
  extraTagCount = 0,
  followUpOn,
  followUpState,
  today,
  amount,
  nextStep,
  agentMark,
  dragging,
  className,
  type = "button",
  ...rest
}: BoardCardProps) {
  const who = [title, firm].filter(Boolean).join(" · ");
  return (
    <button
      type={type}
      className={cn(
        "flex w-full flex-col gap-5 rounded-card border border-line bg-surface px-10 py-9 text-left",
        "transition-[border-color] duration-[120ms] hover:border-accent",
        rest.draggable && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-50",
        className,
      )}
      {...rest}
    >
      <span className="flex w-full min-w-0 items-baseline gap-6">
        <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
        {agentMark ? (
          <Tooltip tip={agentMark.tip} align="end">
            <span className="agent-diamond self-center" aria-label={agentMark.tip} role="img" />
          </Tooltip>
        ) : null}
      </span>
      {who ? <span className="t-body-s w-full truncate text-muted">{who}</span> : null}
      <span className="flex flex-wrap items-center gap-4">
        <PriorityChip fit={fit} />
        {typeLabel ? <Chip tone="type">{typeLabel}</Chip> : null}
        {industry ? <Chip tone="industry">{industry}</Chip> : null}
        {extraTagCount > 0 ? <Chip tone="tag">+{extraTagCount}</Chip> : null}
        <FitMeter value={fit} />
      </span>
      {(followUpState && followUpState !== "later") || amount ? (
        <span className="flex flex-wrap items-center gap-4">
          <FollowUpChip on={followUpOn} state={followUpState} today={today} />
          {amount && amount.value > 0 ? (
            <MoneyChip amount={amount.value} currency={amount.currency}>
              {amount.soft ? <span className="font-body text-good"> soft</span> : null}
            </MoneyChip>
          ) : null}
        </span>
      ) : null}
      {nextStep ? <span className="t-body-s w-full truncate text-muted">{nextStep}</span> : null}
    </button>
  );
}
