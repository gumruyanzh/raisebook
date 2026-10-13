import type { ComponentProps, CSSProperties, ReactNode, Ref } from "react";

import type { FollowUpState, StageColor } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { daysBetween, formatDate, moneyCompact, num } from "@/lib/format";

import { Chip, MoneyChip, PriorityChip } from "./Chip";
import { FitMeter } from "./FitMeter";
import { StageDot, stageVar } from "./Stage";
import { Tooltip } from "./Tooltip";

/**
 * Horizontal board scroller: 85vw columns with snap under 640px; from 640px columns are
 * minmax(250px, 1fr), narrowing to minmax(176px, 1fr) from 1280px so a full default pipeline
 * (with the lost stage collapsed to a rail) fits at 1440. `columns` overrides the template from
 * 640px up (a collapsed column is a fixed 44px track): use `minmax(var(--col-min), 1fr)`.
 */
export function Board({
  children,
  className,
  columns,
  style,
  ...rest
}: ComponentProps<"div"> & { columns?: string }) {
  return (
    <div
      className={cn(
        // `relative` keeps absolutely positioned bits (sr-only text) inside the scroller, so they
        // never widen the page on phones.
        "relative grid min-h-[60vh] auto-cols-[85vw] grid-flow-col gap-10 overflow-x-auto pb-8 scrollbar-thin",
        "snap-x snap-mandatory [--col-min:250px] sm:auto-cols-[minmax(var(--col-min),1fr)] sm:snap-none",
        "2xl:[--col-min:176px]",
        columns && "sm:[grid-template-columns:var(--board-cols)]",
        className,
      )}
      style={columns ? ({ ...style, "--board-cols": columns } as CSSProperties) : style}
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
  /** Follow-ups due now in this column ("3 due", bad-ink mono). */
  dueCount?: number;
  /** Drop target highlight (2px dashed accent outline). */
  isDropTarget?: boolean;
  /** Viewers see "Nothing here yet" instead of "Drag investors here". */
  readOnly?: boolean;
  /** Cards not rendered yet (after the first 60). Shows "Show N more". */
  hiddenCount?: number;
  onShowMore?: () => void;
  /** Render as a 44px vertical rail (label + count); pressing it calls `onExpand`. */
  collapsed?: boolean;
  onExpand?: () => void;
  /** Shows a "Hide" control in the header that calls this (the lost stage). */
  onCollapse?: () => void;
  /** Right end of the header (a sort Menu). */
  headerAside?: ReactNode;
  /** The scrolling body (virtualized columns measure it). */
  bodyRef?: Ref<HTMLDivElement>;
  /** Fill the parent's height (the pipeline board fits the viewport) instead of max 78vh. */
  fill?: boolean;
  children?: ReactNode;
}

/**
 * A sunk column with a 3px top rule in the stage color and a header that stays put while the
 * body scrolls (SYSTEM 3.12). Pass drag handlers (onDragOver, onDrop…) straight through.
 */
export function BoardColumn({
  label,
  color,
  count,
  total,
  dueCount = 0,
  isDropTarget,
  readOnly,
  hiddenCount = 0,
  onShowMore,
  collapsed,
  onExpand,
  onCollapse,
  headerAside,
  bodyRef,
  fill,
  children,
  className,
  ...rest
}: BoardColumnProps) {
  const empty = count === 0;
  const frame = cn(
    "flex min-w-0 flex-col rounded-md bg-sunk",
    fill ? "h-full min-h-0" : "max-h-[78vh]",
    isDropTarget && "outline-2 -outline-offset-2 outline-accent outline-dashed",
  );
  if (collapsed) {
    return (
      <section
        aria-label={`${label}, ${count}`}
        className={cn(frame, className)}
        style={{ borderTop: `3px solid ${stageVar(color)}` }}
        {...rest}
      >
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={false}
          title={`Show ${label}`}
          className="flex w-full flex-1 flex-col items-center gap-8 rounded-b-md border-0 bg-transparent px-0 pt-10 pb-12 text-fg hover:bg-line/40 focus-visible:-outline-offset-2"
        >
          <StageDot color={color} />
          <span className="font-mono text-[12px] text-muted">{num(count)}</span>
          <span className="text-13 font-semibold [writing-mode:vertical-rl]">{label}</span>
        </button>
      </section>
    );
  }
  return (
    <section
      aria-label={`${label}, ${count}`}
      className={cn(frame, "snap-start", className)}
      style={{ borderTop: `3px solid ${stageVar(color)}` }}
      {...rest}
    >
      <header className="flex h-36 shrink-0 items-center gap-6 rounded-t-md bg-sunk pr-4 pl-10 text-13 font-semibold">
        <StageDot color={color} />
        <h3 className="min-w-0 truncate">{label}</h3>
        <span className="ml-auto flex shrink-0 items-baseline gap-6 font-mono text-[12px] font-normal text-muted">
          {dueCount > 0 ? (
            <span
              className="rounded-pill bg-bad-soft px-5 text-[11px] leading-[16px] text-bad"
              title={`${num(dueCount)} follow-up${dueCount === 1 ? "" : "s"} due now`}
            >
              {num(dueCount)}
              <span className="sr-only"> due now</span>
            </span>
          ) : null}
          {total && total.amount > 0 ? (
            <span className="text-good-ink" title={`${label} total`}>
              {moneyCompact(total.amount, total.currency)}
            </span>
          ) : null}
          <span title={`${num(count)} in ${label}`}>{num(count)}</span>
        </span>
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            aria-expanded
            className="t-micro border-0 bg-transparent px-2 font-normal text-muted hover:text-fg"
          >
            Hide
          </button>
        ) : null}
        {headerAside}
      </header>
      <div
        ref={bodyRef}
        className={cn("flex min-h-40 flex-col overflow-y-auto overscroll-contain px-8 pt-2 pb-8 scrollbar-thin", fill && "flex-1")}
      >
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
          <p className="t-body-s px-4 py-6 text-muted">
            {readOnly ? "Nothing here yet" : "Drag investors here"}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Long type labels shortened on cards (the full label is the chip's title). */
const SHORT_TYPE: Record<string, string> = {
  "Corporate VC": "CVC",
  "Family Office": "FO",
  "Family office": "FO",
  Accelerator: "Accel.",
};

export type BoardCardVariant = "standard" | "compact";

/** Gap under each card in a column (folded into the virtualized row height). */
export const CARD_GAP = 6;
export const COMPACT_CARD_GAP = 4;

/**
 * Exact card heights in px (borders included), so a column can be windowed without measuring.
 * Every line on a card has a fixed height and never wraps.
 */
export function boardCardLines(p: {
  title?: string | null;
  firm?: string | null;
  nextStep?: string | null;
  won?: boolean;
  typeLabel?: string | null;
  industry?: string | null;
  followUpOn?: string | null;
  followUpState?: FollowUpState | null;
  amount?: { value: number } | null;
}): { who: boolean; chips: boolean; nextStep: boolean } {
  const due = Boolean(p.followUpOn && p.followUpState && p.followUpState !== "later");
  const money = Boolean(p.amount && p.amount.value > 0);
  return {
    who: Boolean(p.firm || p.title),
    chips: due || money || !p.won || Boolean(p.typeLabel) || Boolean(p.industry),
    nextStep: Boolean(p.nextStep),
  };
}

export function boardCardHeight(
  variant: BoardCardVariant,
  c: { who: boolean; chips: boolean; nextStep: boolean },
): number {
  if (variant === "compact") return 50;
  return 2 + 14 + 17 + (c.who ? 2 + 16 : 0) + (c.chips ? 4 + 20 : 0) + (c.nextStep ? 3 + 16 : 0);
}

export interface BoardCardProps extends Omit<ComponentProps<"button">, "title"> {
  name: string;
  title?: string | null;
  firm?: string | null;
  fit: number;
  /** Investor type label ("VC"). */
  typeLabel?: string | null;
  /** First industry; it is the first chip to drop out when the row is full. */
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
  /** The button's tooltip (e.g. "View only" for viewers). */
  hint?: string;
  /** `compact` (52px): name, firm, and only the stage-relevant chip (due or amount). */
  variant?: BoardCardVariant;
  /** In the won stage: fit and priority are hidden (the money is what matters). */
  won?: boolean;
  /** The investor whose sheet is open. */
  current?: boolean;
}

/** "Overdue 4d", "Due today", "Oct 16" (cards); nothing for "later" or no date. */
export function shortFollowUp(on: string | null | undefined, state: FollowUpState | null | undefined, today?: string): string | null {
  if (!on || !state || state === "later") return null;
  if (state === "today") return "Due today";
  if (state === "overdue") {
    const late = today ? daysBetween(on, today) : 0;
    return late > 0 ? `Overdue ${late}d` : "Overdue";
  }
  return formatDate(on, today);
}

/**
 * The investor card (SYSTEM 3.13, compact pass): a <button>. Row 1 name (+ agent marker),
 * row 2 "Firm · Title", row 3 one line of chips (follow-up, money, priority, type, industry;
 * a chip that does not fit drops out whole) + FitMeter, then an optional next-step line.
 * Keyboard moves (Alt+←/→, M) and roving focus are wired by the board via onKeyDown.
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
  hint,
  variant = "standard",
  won,
  current,
  className,
  type = "button",
  ...rest
}: BoardCardProps) {
  const who = [firm, title].filter(Boolean).join(" · ");
  const due = shortFollowUp(followUpOn, followUpState, today);
  const dueChip = due ? (
    <Chip
      tone={followUpState === "soon" ? "soon" : "due"}
      className="shrink-0"
      title={followUpOn ? `Follow up ${formatDate(followUpOn, today)}` : undefined}
    >
      {due}
    </Chip>
  ) : null;
  const moneyChip =
    amount && amount.value > 0 ? (
      <MoneyChip amount={amount.value} currency={amount.currency} className="shrink-0">
        {amount.soft ? <span className="font-body text-good-ink"> soft</span> : null}
      </MoneyChip>
    ) : null;
  const marker = agentMark ? (
    <Tooltip tip={agentMark.tip} align="end">
      <span className="agent-diamond self-center" aria-label={agentMark.tip} role="img" />
    </Tooltip>
  ) : null;
  const base = cn(
    "flex w-full shrink-0 flex-col rounded-card border bg-surface px-10 text-left",
    "transition-[border-color] duration-[120ms] hover:border-accent focus-visible:-outline-offset-2",
    current ? "border-accent" : "border-line",
    rest.draggable && "cursor-grab active:cursor-grabbing",
    dragging && "opacity-50",
  );

  if (variant === "compact") {
    const chip = dueChip ?? moneyChip;
    return (
      <button type={type} title={hint} className={cn(base, "h-50 justify-center py-5", className)} {...rest}>
        <span className="flex h-19 w-full min-w-0 items-center gap-6">
          <span className="min-w-0 flex-1 truncate leading-[19px] font-semibold">{name}</span>
          {marker}
        </span>
        <span className="flex h-19 w-full min-w-0 items-center gap-6">
          <span className="t-body-s min-w-0 flex-1 truncate leading-[19px] text-muted">{who || "\u00a0"}</span>
          {chip ? <span className="flex shrink-0 [&>*]:leading-[1.4]">{chip}</span> : null}
        </span>
      </button>
    );
  }

  const typeChip = typeLabel ? (
    <Chip tone="type" className="shrink-0" title={SHORT_TYPE[typeLabel] ? typeLabel : undefined}>
      {SHORT_TYPE[typeLabel] ?? typeLabel}
    </Chip>
  ) : null;
  const lines = boardCardLines({ title, firm, nextStep, won, typeLabel, industry, followUpOn, followUpState, amount });
  const hasChips = lines.chips;
  return (
    <button
      type={type}
      title={hint}
      className={cn(base, "py-7", className)}
      style={{ height: boardCardHeight("standard", lines) }}
      {...rest}
    >
      <span className="flex h-17 w-full min-w-0 items-center gap-6">
        <span className="min-w-0 flex-1 truncate leading-[17px] font-semibold">{name}</span>
        {marker}
      </span>
      {who ? <span className="t-body-s mt-2 block h-16 w-full truncate leading-[16px] text-muted">{who}</span> : null}
      {hasChips ? (
        <span className="mt-4 flex h-20 w-full min-w-0 items-center gap-4">
          {/* One line: a chip that does not fit drops out whole (industry first, then type),
              never as a truncated stub. */}
          <span
            className="flex h-20 min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-[40px] overflow-hidden"
            title={industry ? (extraTagCount > 0 ? `${industry} and ${extraTagCount} more` : industry) : undefined}
          >
            {dueChip}
            {moneyChip}
            {won ? null : <PriorityChip fit={fit} className="shrink-0" />}
            {typeChip}
            {industry ? (
              <Chip tone="industry" className="shrink-0">
                {industry}
              </Chip>
            ) : null}
          </span>
          {won ? null : <FitMeter value={fit} className="shrink-0 pl-2" />}
        </span>
      ) : null}
      {nextStep ? (
        <span className="t-body-s mt-3 block h-16 w-full truncate leading-[16px] text-muted" title={nextStep}>
          {nextStep}
        </span>
      ) : null}
    </button>
  );
}
