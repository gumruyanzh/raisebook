import type { ComponentProps, ReactNode, Ref } from "react";

import type { FollowUpState, Priority, StageColor } from "@/lib/api/types";
import { PRIORITY_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { moneyCompact, num } from "@/lib/format";
import { cardSlot, type CardSlot } from "@/lib/pipeline";

import { Chip } from "./Chip";
import { FitMeter } from "./FitMeter";
import { StageDot } from "./Stage";
import { Tooltip } from "./Tooltip";

/**
 * The kanban scroller (DECISION §14, after the prototype's `.board`): every stage is its own
 * equal-width column side by side (`grid-auto-flow: column`, at least 264px each) and the board
 * scrolls sideways when they do not fit. Under 640px columns are 85vw with snap.
 */
export function Board({ children, className, ...rest }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        // `relative` keeps absolutely positioned bits (sr-only text) inside the scroller, so they
        // never widen the page on phones.
        "relative grid min-h-[60vh] auto-cols-[85vw] grid-flow-col gap-12 overflow-x-auto pb-8 scrollbar-thin",
        "snap-x snap-mandatory sm:auto-cols-[minmax(264px,1fr)] sm:snap-none",
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
  /** For the won stage: the column total ("$650k") in good-ink. */
  total?: { amount: number; currency: string } | null;
  /** Follow-ups due now in this column ("2 due", bad-ink mono). */
  dueCount?: number;
  /** A card is dragged over this column: 2px dashed accent outline. */
  isDropTarget?: boolean;
  /** Viewers see "Nothing here yet" instead of the drag hint. */
  readOnly?: boolean;
  /** Filters hide every card in this column (the empty copy changes). */
  filtered?: boolean;
  /** After the label (the New column's "Triage →"). */
  headerAction?: ReactNode;
  /** Right end of the header, after the count (a sort Menu). */
  headerAside?: ReactNode;
  /** The scrolling body (virtualized columns measure it). */
  bodyRef?: Ref<HTMLDivElement>;
  /** Fill the parent's height (the pipeline board fits the viewport) instead of max 78vh. */
  fill?: boolean;
  children?: ReactNode;
}

/**
 * A kanban column (the prototype's `.col`): a soft `sunk` panel, radius 8, with a 40px header
 * that stays put while the body scrolls (stage dot, label, and the count right-aligned in
 * mono). An empty column keeps its full width and height, all of it the drop target, with a
 * quiet "Drag investors here". Pass drag handlers (onDragOver, onDrop…) straight through.
 */
export function BoardColumn({
  label,
  color,
  count,
  total,
  dueCount = 0,
  isDropTarget,
  readOnly,
  filtered,
  headerAction,
  headerAside,
  bodyRef,
  fill,
  children,
  className,
  ...rest
}: BoardColumnProps) {
  const empty = count === 0;
  return (
    <section
      aria-label={`${label}, ${count}`}
      className={cn(
        "flex min-w-0 snap-start flex-col rounded-md bg-sunk",
        fill ? "h-full min-h-0" : "max-h-[78vh]",
        isDropTarget && "outline-2 -outline-offset-2 outline-accent outline-dashed",
        className,
      )}
      {...rest}
    >
      <header className="flex h-40 shrink-0 items-center gap-8 rounded-t-md bg-sunk pr-6 pl-12 text-13 font-semibold">
        <StageDot color={color} />
        <h3 className="min-w-0 truncate">{label}</h3>
        {headerAction}
        <span className="ml-auto flex shrink-0 items-baseline gap-8 font-mono text-[12px] font-normal">
          {dueCount > 0 ? (
            <span className="text-bad" title={`${num(dueCount)} follow-up${dueCount === 1 ? "" : "s"} due now`}>
              {num(dueCount)} due
            </span>
          ) : null}
          {total && total.amount > 0 ? (
            <span className="text-good-ink" title={`${label} total`}>
              {moneyCompact(total.amount, total.currency)}
            </span>
          ) : null}
          <span className="text-muted tnum" title={`${num(count)} in ${label}`}>
            {num(count)}
          </span>
        </span>
        {headerAside ?? <span aria-hidden className="w-24 shrink-0" />}
      </header>
      <div
        ref={bodyRef}
        className={cn("flex min-h-40 flex-col overflow-x-hidden overflow-y-auto overscroll-y-contain px-8 pb-8 scrollbar-thin", fill && "flex-1")}
      >
        {children}
        {empty ? (
          <p className={cn("t-body-s px-4 py-6", isDropTarget ? "text-accent" : "text-muted")}>
            {filtered ? "None match the filters" : readOnly ? "Nothing here yet" : isDropTarget ? "Drop to move here" : "Drag investors here"}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Gap under each card in a column (folded into the virtualized row height). */
export const CARD_GAP = 6;
/** Card height in px: two lines, or three with "Show next step". */
export const CARD_H = 52;
export const CARD_H_STEP = 70;

export interface BoardCardProps extends Omit<ComponentProps<"button">, "title"> {
  name: string;
  title?: string | null;
  firm?: string | null;
  fit: number;
  /** Short type label ("VC", "CVC"); never for `other`. Used when no `slot` is given. */
  typeLabel?: string | null;
  followUpOn?: string | null;
  followUpState?: FollowUpState | null;
  today?: string;
  /** Committed amount in the won stage, or the soft amount. Used when no `slot` is given. */
  amount?: { value: number; currency: string; soft?: boolean } | null;
  /** The one right-slot item (`cardSlot`); derived from the fields above when omitted. */
  rightSlot?: CardSlot | null;
  nextStep?: string | null;
  /** Display → "Show next step": a third line (the card is 70px). */
  showNextStep?: boolean;
  /** Agent changed this card in the last 24h: diamond marker + tooltip. */
  agentMark?: { tip: string } | null;
  dragging?: boolean;
  /** The button's tooltip (e.g. "View only" for viewers). */
  hint?: string;
  /** In the won stage: the fit pips are hidden (the money is what matters). */
  won?: boolean;
  /** Hide the fit pips (the lost stage, or a column where every card has the same fit). */
  hidePips?: boolean;
  /** The investor whose sheet is open. */
  current?: boolean;
  /** Part of the selection: accent-soft fill and accent border. */
  selected?: boolean;
  /** Leave room on the left for the selection checkbox (rendered by the board). */
  inset?: boolean;
  /** Legacy props (the industry and tag chips are gone from cards). */
  industry?: string | null;
  extraTagCount?: number;
  variant?: "standard" | "compact";
}

const LEGACY_TYPE: Record<string, string> = {
  "Corporate VC": "CVC",
  "Family Office": "FO",
  "Family office": "FO",
  Accelerator: "Accel.",
  Other: "",
};

function SlotView({ slot }: { slot: CardSlot }) {
  switch (slot.kind) {
    case "meeting":
      // Today: the warm "soon" tint (it needs attention today); later: the neutral outline.
      return (
        <Chip tone={slot.today ? "soon" : "type"} className="shrink-0" title={slot.title}>
          {slot.text}
        </Chip>
      );
    case "due":
      return (
        <Chip tone="due" className="shrink-0">
          {slot.text}
        </Chip>
      );
    case "money":
      return (
        <Chip tone="money" className="shrink-0">
          {slot.text}
        </Chip>
      );
    case "soon":
      return (
        <Chip tone="soon" className="shrink-0">
          {slot.text}
        </Chip>
      );
    default:
      return <span className="shrink-0 font-mono text-[11.5px] text-muted">{slot.text}</span>;
  }
}

/**
 * The investor card (DECISION §5.3): a <button>, 52px, two lines. Line 1: name, the agent
 * diamond, fit pips (neutral ink). Line 2: firm (else title, else type) and at most one
 * right-slot item (overdue/today, won money, soft, soon, later); nothing else, so the slot is
 * empty on most fresh cards. No priority, type or industry chips.
 * Keyboard moves (Alt+←/→, M) and roving focus are wired by the board via onKeyDown.
 */
export function BoardCard({
  name,
  title,
  firm,
  fit,
  typeLabel,
  followUpOn,
  followUpState,
  today,
  amount,
  rightSlot: slotProp,
  nextStep,
  showNextStep,
  agentMark,
  dragging,
  hint,
  won,
  hidePips,
  current,
  selected,
  inset,
  industry: _industry,
  extraTagCount: _extra,
  variant: _variant,
  className,
  type = "button",
  ...rest
}: BoardCardProps) {
  const label = typeLabel ? (LEGACY_TYPE[typeLabel] ?? typeLabel) : null;
  const slot =
    slotProp !== undefined
      ? slotProp
      : cardSlot(
          {
            follow_up_on: followUpOn,
            follow_up_state: followUpState,
            amount_soft: amount?.soft ? amount.value : null,
            amount_committed: amount && !amount.soft ? amount.value : null,
            stage: { kind: won ? "won" : "active" } as never,
          },
          today ?? "",
          amount?.currency ?? "USD",
        );
  const who = firm || title || label || "";
  const marker = agentMark ? (
    <Tooltip tip={agentMark.tip} align="end">
      <span className="agent-diamond self-center" aria-label={agentMark.tip} role="img" />
    </Tooltip>
  ) : null;
  const step = showNextStep ? nextStep || "" : null;
  return (
    <button
      type={type}
      title={hint}
      className={cn(
        "flex w-full shrink-0 flex-col justify-center rounded-card border pr-10 text-left",
        "transition-[border-color,padding] duration-[120ms] hover:border-accent focus-visible:-outline-offset-2",
        inset ? "pl-32" : "pl-10",
        selected ? "border-accent bg-accent-soft" : current ? "border-accent bg-surface" : "border-line bg-surface",
        rest.draggable && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-50",
        className,
      )}
      style={{ height: step !== null ? CARD_H_STEP : CARD_H }}
      {...rest}
    >
      <span className="flex h-19 w-full min-w-0 items-center gap-6">
        <span className="min-w-0 truncate text-[13.5px] leading-[19px] font-semibold">{name}</span>
        {marker}
        {won || hidePips ? null : <FitMeter value={fit} className="ml-auto shrink-0 pl-4" />}
      </span>
      <span className="flex h-18 w-full min-w-0 items-center gap-6">
        <span className="t-body-s min-w-0 flex-1 truncate leading-[18px] text-muted">{who || " "}</span>
        {slot ? <SlotView slot={slot} /> : null}
      </span>
      {step !== null ? (
        <span className="t-body-s block h-18 w-full truncate leading-[18px] text-muted" title={step || undefined}>
          {step || " "}
        </span>
      ) : null}
    </button>
  );
}

/* ---------- the rich kanban card (DECISION §15) ---------- */

/** Rich card rows, in px (the virtualized column adds them up per card, plus CARD_GAP). */
const DEAL = { pad: 22, head: 22, sub: 18, meta: 26, odds: 24, foot: 26, step: 20 } as const;

/** Which optional rows a rich card shows; decides its height. */
export interface DealCardRows {
  /** Type, stage focus, industry chips or a check range. */
  meta: boolean;
  /** The likelihood line (hidden in the lost stage). */
  odds: boolean;
  /** Follow-up, money or last touch. */
  foot: boolean;
  /** Display → "Show next step". */
  step: boolean;
}

/** A rich card's height in px (borders included, the gap under it not). */
export function dealCardHeight(r: DealCardRows): number {
  return (
    DEAL.pad +
    DEAL.head +
    DEAL.sub +
    (r.step ? DEAL.step : 0) +
    (r.meta ? DEAL.meta : 0) +
    (r.odds ? DEAL.odds : 0) +
    (r.foot ? DEAL.foot : 0)
  );
}

export interface DealCardProps extends Omit<ComponentProps<"button">, "title" | "slot"> {
  name: string;
  /** Line 2: "Partner · Ember Labs" (title and firm, either may be missing). */
  title?: string | null;
  firm?: string | null;
  /** null: not rated yet, so no chip. */
  priority: Priority | null;
  /** Up to three short facts ("VC", "Seed", "Fintech"). */
  meta: string[];
  /** "$250k–1M", mono. */
  check?: string | null;
  /** Likelihood to close; null hides the line. */
  odds?: { value: number; why: string; won?: boolean } | null;
  /** Bottom left: the follow-up, the committed money or the soft amount (`cardSlot`). */
  slot?: CardSlot | null;
  /** Bottom right: "3d ago", with the date in `title`. */
  touch?: { text: string; tip: string } | null;
  nextStep?: string | null;
  showNextStep?: boolean;
  agentMark?: { tip: string } | null;
  dragging?: boolean;
  hint?: string;
  current?: boolean;
  selected?: boolean;
  /**
   * Room on the left of the name for the selection checkbox (rendered by the board): "shown"
   * while anything is selected, "hover" when it appears on hover or focus, else none.
   */
  checkbox?: "shown" | "hover" | null;
}

/**
 * The kanban card the owner asked for (DECISION §15): bigger names and more to read at a
 * glance, still calm. Name (600 15.5px) with the priority chip (Hot / Warm / Maybe / Low fit,
 * the Triage colors) · "Title · Firm" · up to three neutral meta chips and the check range in
 * mono · a thin Likelihood bar with its percent (the tooltip shows the working) · the
 * follow-up or money on the left and the last touch on the right. Rows with nothing to say
 * are left out, and the height follows (`dealCardHeight`), so the column stays windowed.
 */
export function DealCard({
  name,
  title,
  firm,
  priority,
  meta,
  check,
  odds,
  slot,
  touch,
  nextStep,
  showNextStep,
  agentMark,
  dragging,
  hint,
  current,
  selected,
  checkbox,
  className,
  type = "button",
  ...rest
}: DealCardProps) {
  const who = [title?.trim(), firm?.trim()].filter(Boolean).join(" · ");
  const step = showNextStep ? nextStep || "" : null;
  const rows: DealCardRows = {
    meta: meta.length > 0 || Boolean(check),
    odds: Boolean(odds),
    foot: Boolean(slot || touch),
    step: step !== null,
  };
  const pct = odds ? Math.max(0, Math.min(100, odds.value)) : 0;
  return (
    <button
      type={type}
      title={hint}
      className={cn(
        "flex w-full shrink-0 flex-col rounded-card border px-12 py-10 text-left",
        "transition-[border-color] duration-[120ms] hover:border-accent focus-visible:-outline-offset-2",
        selected ? "border-accent bg-accent-soft" : current ? "border-accent bg-surface" : "border-line bg-surface",
        rest.draggable && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-50",
        className,
      )}
      style={{ height: dealCardHeight(rows) }}
      {...rest}
    >
      <span
        className={cn(
          "flex w-full min-w-0 items-center gap-8 transition-[padding] duration-[120ms]",
          checkbox === "shown" && "pl-22",
          checkbox === "hover" && "group-hover/card:pl-22 group-focus-within/card:pl-22",
        )}
        style={{ height: DEAL.head }}
      >
        <span className="min-w-0 truncate text-[15.5px] leading-[22px] font-semibold tracking-[-0.005em] text-fg">{name}</span>
        {agentMark ? (
          <Tooltip tip={agentMark.tip} align="end">
            <span className="agent-diamond self-center" aria-label={agentMark.tip} role="img" />
          </Tooltip>
        ) : null}
        {priority ? (
          <Chip tone={priority} className="ml-auto shrink-0">
            {PRIORITY_LABEL[priority]}
          </Chip>
        ) : null}
      </span>
      <span className="t-body-s block w-full truncate leading-[18px] text-muted" style={{ height: DEAL.sub }}>
        {who || " "}
      </span>
      {step !== null ? (
        <span
          className="t-body-s block w-full truncate pt-2 leading-[18px] text-fg/80"
          style={{ height: DEAL.step }}
          title={step || undefined}
        >
          {step ? `→ ${step}` : " "}
        </span>
      ) : null}
      {rows.meta ? (
        <span className="flex w-full min-w-0 items-end gap-4 overflow-hidden" style={{ height: DEAL.meta }}>
          {meta.map((m) => (
            <Chip key={m} tone="type" className="min-w-0 shrink overflow-hidden text-ellipsis">
              {m}
            </Chip>
          ))}
          {check ? (
            <span className="ml-auto shrink-0 pl-4 font-mono text-[11.5px] leading-[20px] text-muted tnum" title="Check size">
              {check}
            </span>
          ) : null}
        </span>
      ) : null}
      {odds ? (
        <span className="flex w-full min-w-0 items-end gap-8" style={{ height: DEAL.odds }} title={odds.why}>
          <span className="flex h-16 w-full min-w-0 items-center gap-8">
            <span className="shrink-0 text-[11.5px] leading-none text-muted">Likelihood</span>
            <span
              aria-hidden
              className="relative h-4 min-w-0 flex-1 overflow-hidden rounded-pill bg-sunk"
            >
              <span
                className={cn("absolute inset-y-0 left-0 rounded-pill", odds.won ? "bg-good" : "bg-fg/55")}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className={cn("w-32 shrink-0 text-right font-mono text-[11.5px] leading-none tnum", odds.won ? "text-good-ink" : "text-fg")}>
              <span className="sr-only">Likelihood </span>
              {pct}%
            </span>
          </span>
        </span>
      ) : null}
      {rows.foot ? (
        <span className="flex w-full min-w-0 items-end gap-8" style={{ height: DEAL.foot }}>
          {slot ? <SlotView slot={slot} /> : null}
          {touch ? (
            <span className="t-body-s ml-auto shrink-0 leading-[20px] text-muted" title={touch.tip}>
              {touch.text}
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
