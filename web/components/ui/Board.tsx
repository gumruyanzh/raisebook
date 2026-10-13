import type { ComponentProps, CSSProperties, DragEvent, ReactNode, Ref } from "react";

import type { FollowUpState, StageColor } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { moneyCompact, num } from "@/lib/format";
import { cardSlot, type CardSlot } from "@/lib/pipeline";

import { Chip } from "./Chip";
import { FitMeter } from "./FitMeter";
import { StageDot, stageVar } from "./Stage";
import { Tooltip } from "./Tooltip";

/**
 * Horizontal board scroller (DECISION §5.2). `columns` is the grid template: the pipeline
 * passes one track per stage (`minmax(352px, 2.5fr)` for the dominant stage, `minmax(232px,
 * 1fr)` for a stage with cards, `minmax(136px, .6fr)` for an empty one), so nothing ever
 * folds into a rail and a mature round scrolls sideways. Without `columns`, columns are
 * `minmax(232px, 1fr)`. Under 640px columns are 85vw with snap.
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
        "relative grid min-h-[60vh] auto-cols-[85vw] grid-flow-col gap-12 overflow-x-auto pb-8 scrollbar-thin",
        "snap-x snap-mandatory sm:auto-cols-[minmax(232px,1fr)] sm:snap-none",
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
  /** For the won stage: the column total ("$650k") in good-ink. */
  total?: { amount: number; currency: string } | null;
  /** Follow-ups due now in this column ("2 due", bad-ink mono). */
  dueCount?: number;
  /** Drop target highlight (2px dashed accent outline). */
  isDropTarget?: boolean;
  /** Viewers see "Nothing here yet" instead of the drop zone. */
  readOnly?: boolean;
  /** Filters hide every card in this column (the empty copy changes). */
  filtered?: boolean;
  /** One line under "Drop here" on an empty column ("Worth a closer look"). */
  meaning?: string | null;
  /** Cards being dragged: an empty column's box reads "Drop 14". */
  dragCount?: number;
  /** After the count in the header (the New column's "Triage →"). */
  headerAction?: ReactNode;
  /** Right end of the header (a sort Menu). */
  headerAside?: ReactNode;
  /** Under the header, outside the scrolling body (the priority bar). */
  headerExtra?: ReactNode;
  /** The scrolling body (virtualized columns measure it). */
  bodyRef?: Ref<HTMLDivElement>;
  /** Fill the parent's height (the pipeline board fits the viewport) instead of max 78vh. */
  fill?: boolean;
  children?: ReactNode;
}

/**
 * A sunk column with a 3px top rule in the stage color and a 40px header that stays put while
 * the body scrolls (DECISION §5.2). An empty column stays full height (all of it is the drop
 * target) with a dashed "Drop here" box and the stage's meaning at the top. Pass drag handlers
 * (onDragOver, onDrop…) straight through.
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
  meaning,
  dragCount = 0,
  headerAction,
  headerAside,
  headerExtra,
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
      style={{ borderTop: `3px solid ${stageVar(color)}` }}
      {...rest}
    >
      <header className="flex h-40 shrink-0 items-center gap-6 rounded-t-md bg-sunk pr-6 pl-10 text-13 font-semibold">
        <StageDot color={color} />
        <h3 className="min-w-0 truncate">{label}</h3>
        <span className="shrink-0 font-mono text-[12px] font-normal text-muted" title={`${num(count)} in ${label}`}>
          {num(count)}
        </span>
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
        </span>
        {headerAside}
      </header>
      {headerExtra}
      <div
        ref={bodyRef}
        className={cn("flex min-h-40 flex-col overflow-y-auto overscroll-contain px-8 pt-2 pb-8 scrollbar-thin", fill && "flex-1")}
      >
        {children}
        {empty ? (
          readOnly || filtered ? (
            <p className="t-body-s px-4 py-6 text-muted">{filtered ? "None match the filters" : "Nothing here yet"}</p>
          ) : (
            <div
              className={cn(
                "flex min-h-96 flex-col gap-2 rounded-md border border-dashed p-10",
                dragCount > 0 ? "border-accent bg-accent-soft" : "border-line",
              )}
            >
              <span className={cn("font-medium", dragCount > 0 ? "text-accent" : "text-muted")}>
                {dragCount > 0 ? `Drop ${num(dragCount)}` : "Drop here"}
              </span>
              {meaning ? <span className="t-body-s text-muted">{meaning}</span> : null}
            </div>
          )
        ) : null}
      </div>
    </section>
  );
}

export interface EmptyStageItem {
  key: string;
  label: string;
  color: StageColor;
  /** One line under the label ("They wrote back"). */
  meaning?: string | null;
}

/**
 * A run of two or more empty stages in one narrow track (critique 1): each stage is its own
 * small dashed drop zone, stacked, so a round that has only started to move investors out of
 * New fits the screen instead of showing seven identical empty slabs. Each zone carries
 * `data-stage` and its own drag handlers.
 */
export function EmptyStages({
  stages,
  readOnly,
  filtered,
  dragCount = 0,
  overKey,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  stages: EmptyStageItem[];
  readOnly?: boolean;
  filtered?: boolean;
  /** Cards being dragged (each zone reads "Drop 14"). */
  dragCount?: number;
  /** The zone the drag is over. */
  overKey?: string | null;
  onDragOver?: (key: string, e: DragEvent<HTMLElement>) => void;
  onDragLeave?: (key: string, e: DragEvent<HTMLElement>) => void;
  onDrop?: (key: string, e: DragEvent<HTMLElement>) => void;
}) {
  const dragging = dragCount > 0;
  return (
    <section aria-label={`${stages.length} empty stages`} className="flex min-h-0 min-w-0 flex-col">
      <header className="flex h-40 shrink-0 items-center px-4" style={{ borderTop: "3px solid transparent" }}>
        <span className="t-label">{filtered ? "None match here" : readOnly ? "Empty stages" : "Drop to file"}</span>
      </header>
      <div className="flex min-h-0 flex-col gap-6 overflow-y-auto pb-8 scrollbar-thin">
        {stages.map((st) => {
          const over = overKey === st.key;
          return (
            <div
              key={st.key}
              data-stage={st.key}
              aria-label={`${st.label}, 0`}
              onDragOver={onDragOver ? (e) => onDragOver(st.key, e) : undefined}
              onDragLeave={onDragLeave ? (e) => onDragLeave(st.key, e) : undefined}
              onDrop={onDrop ? (e) => onDrop(st.key, e) : undefined}
              className={cn(
                "flex min-h-52 flex-col justify-center gap-2 rounded-md border px-10 py-6 transition-colors duration-[120ms]",
                readOnly || filtered ? "border-line border-solid" : "border-dashed",
                over ? "border-accent bg-accent-soft" : dragging ? "border-accent" : "border-line",
              )}
              style={{ boxShadow: `inset 3px 0 0 ${stageVar(st.color)}` }}
            >
              <span className="flex min-w-0 items-center gap-6 text-13 font-semibold">
                <StageDot color={st.color} />
                <span className="min-w-0 truncate">{st.label}</span>
                <span className="ml-auto font-mono text-[12px] font-normal text-muted">0</span>
              </span>
              <span className={cn("t-body-s truncate", over ? "text-accent" : "text-muted")}>
                {dragging && !readOnly ? `Drop ${num(dragCount)} here` : (st.meaning ?? (readOnly ? "Nothing here yet" : "Drop here"))}
              </span>
            </div>
          );
        })}
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
