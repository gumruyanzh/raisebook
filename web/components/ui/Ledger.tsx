"use client";

import type { RoundSummary, StageColor } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDate, money, moneyCompact, num } from "@/lib/format";

import { Chip } from "./Chip";
import { FunnelBar, type FunnelSegment } from "./FunnelBar";
import { Meter } from "./Meter";

export interface LedgerDue {
  id: string;
  name: string;
  state: "overdue" | "today";
}

export interface LedgerProps {
  roundName: string;
  currency: string;
  committed: number;
  target: number;
  /** Investors in active stages. */
  inConversation: number;
  committedCount: number;
  softCircled: number;
  daysToClose?: number | null;
  funnel: FunnelSegment[];
  /** Due follow-ups (overdue and today), most urgent first. Up to 8 chips are shown. */
  due: LedgerDue[];
  /** Total due count when `due` is a prefix of the full list. */
  dueTotal?: number;
  onStageSelect?: (stageKey: string) => void;
  activeStage?: string | null;
  onDueSelect?: (id: string) => void;
  /** Phones: the due strip becomes one "N follow-ups due →" button that calls this. */
  onDueFilter?: () => void;
  /** compact on the pipeline page, full on the overview (adds soft and weighted lines). */
  variant?: "compact" | "full";
  weightedPipeline?: number;
  /** Whether any participant has a probability (weighted pipeline means nothing otherwise). */
  hasProbabilities?: boolean;
  /** A closed round reads as a result, not a to-do list. */
  closed?: boolean;
  closedOn?: string | null;
  today?: string;
  className?: string;
}

/** Map a RoundSummary (SPEC §5.3) to Ledger props. `id` of a due item is the investor id. */
export function ledgerFromSummary(
  s: RoundSummary,
): Omit<LedgerProps, "onStageSelect" | "onDueSelect" | "variant" | "className" | "activeStage"> {
  const due = s.follow_ups.top
    .filter((f) => f.follow_up_state === "overdue" || f.follow_up_state === "today")
    .map((f) => ({
      id: f.investor.id,
      name: f.investor.name,
      state: f.follow_up_state as "overdue" | "today",
    }));
  return {
    roundName: s.round.name,
    currency: s.money.currency,
    committed: s.money.committed,
    target: s.money.target,
    inConversation: s.counts.active,
    committedCount: s.money.committed_count,
    softCircled: s.money.soft_circled,
    weightedPipeline: s.money.weighted_pipeline,
    daysToClose: s.round.days_to_close ?? null,
    closed: s.round.status === "closed",
    closedOn: s.round.closed_on ?? null,
    funnel: s.funnel.map((f) => ({
      key: f.key,
      label: f.label,
      color: f.color as StageColor,
      count: f.count,
    })),
    due,
    dueTotal: s.follow_ups.overdue + s.follow_ups.today,
  };
}

/**
 * The round summary strip (SYSTEM 3.10). Left: committed toward the round, meter and stats.
 * Right: the funnel and the "Follow up now" strip. Stacks under 860px.
 */
export function Ledger(p: LedgerProps) {
  const variant = p.variant ?? "compact";
  const dueTotal = p.dueTotal ?? p.due.length;
  // One line: whole chips only (five on the pipeline, three in the narrower overview column),
  // then "+N more".
  const shown = p.due.slice(0, variant === "full" ? 3 : 5);
  const pct = p.target > 0 ? Math.round((p.committed / p.target) * 100) : null;
  const stats: { n: string; label: string }[] = p.closed
    ? [
        { n: num(p.committedCount), label: "committed" },
        ...(p.closedOn ? [{ n: formatDate(p.closedOn, p.today), label: "closed" }] : []),
        ...(pct !== null ? [{ n: `${num(pct)}%`, label: "of target" }] : []),
      ]
    : [
        { n: num(p.inConversation), label: "in conversation" },
        { n: num(p.committedCount), label: "committed" },
        { n: moneyCompact(p.softCircled, p.currency), label: "soft" },
      ];
  if (!p.closed && p.daysToClose !== undefined && p.daysToClose !== null) {
    stats.push(
      p.daysToClose >= 0
        ? { n: num(p.daysToClose), label: p.daysToClose === 1 ? "day to close" : "days to close" }
        : { n: num(-p.daysToClose), label: "days past target close" },
    );
  }
  return (
    <section
      aria-label={`${p.roundName} summary`}
      className={cn(
        "grid grid-cols-1 gap-12 rounded-md border border-line bg-surface p-14 sm:gap-18 md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)]",
        p.className,
      )}
    >
      <div className="min-w-0">
        <p className="t-label">
          {p.closed ? "Raised in" : "Committed toward"} {p.roundName}
        </p>
        <p className="t-amount mt-4">
          {money(p.committed, p.currency)}{" "}
          <span className="text-[18px] font-medium whitespace-nowrap text-muted">
            of {money(p.target, p.currency)}
          </span>
        </p>
        <Meter
          className="mt-10"
          value={p.committed}
          max={p.target}
          label={`Committed toward ${p.roundName}`}
        />
        {/* Dots sit in a 12px gutter left of each item; the gutter of an item that starts a
            line falls in the clipped -12px margin, so a wrapped line never starts with "·".
            Phones keep one line (the first two stats). */}
        <div className="mt-8 overflow-hidden">
          <p className="t-body-s -ml-12 flex flex-wrap gap-y-2 text-muted max-sm:[&>span:nth-child(n+3)]:hidden">
            {stats.map((s) => (
              <span
                key={s.label}
                className="relative pl-12 before:absolute before:left-3 before:content-['·'] before:text-muted"
              >
                <b className="tnum font-semibold text-fg">{s.n}</b> {s.label}
              </span>
            ))}
          </p>
        </div>
        {variant === "full" && !p.closed && p.weightedPipeline !== undefined ? (
          <p className="t-body-s mt-4 text-muted">
            Weighted pipeline{" "}
            {p.hasProbabilities === false ? (
              <span>: set a probability on investors to see it</span>
            ) : (
              <b className="tnum font-semibold text-fg" title={money(p.weightedPipeline, p.currency)}>
                {moneyCompact(p.weightedPipeline, p.currency)}
              </b>
            )}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        <p className="t-label max-sm:hidden">Pipeline</p>
        <FunnelBar
          segments={p.funnel}
          onSelect={p.onStageSelect}
          active={p.activeStage}
          legendClassName="max-sm:hidden"
        />
        {p.closed ? (
          <p className="t-body-s text-muted">
            This round is closed. Reopen it in its settings to track follow-ups.
          </p>
        ) : (
          <>
            {/* Phones: one button instead of a wall of red chips. */}
            {dueTotal > 0 && p.onDueFilter ? (
              <button
                type="button"
                onClick={p.onDueFilter}
                className="t-body-s self-start border-0 bg-transparent p-0 font-medium text-bad sm:hidden"
              >
                {num(dueTotal)} {dueTotal === 1 ? "follow-up" : "follow-ups"} due →
              </button>
            ) : null}
            <div
              className={cn(
                "t-body-s flex min-w-0 flex-nowrap items-center gap-6 overflow-hidden text-muted",
                p.onDueFilter && "max-sm:hidden",
              )}
            >
              {shown.length ? (
                <>
                  <span className="shrink-0">Follow up now:</span>
                  {shown.map((d) =>
                    p.onDueSelect ? (
                      <Chip
                        key={d.id}
                        as="button"
                        tone="due"
                        className="shrink-0"
                        onClick={() => p.onDueSelect?.(d.id)}
                      >
                        {d.name}
                      </Chip>
                    ) : (
                      <Chip key={d.id} tone="due" className="shrink-0">
                        {d.name}
                      </Chip>
                    ),
                  )}
                  {dueTotal > shown.length ? (
                    p.onDueFilter ? (
                      <button
                        type="button"
                        onClick={p.onDueFilter}
                        className="link shrink-0 border-0 bg-transparent p-0 whitespace-nowrap"
                      >
                        +{num(dueTotal - shown.length)} more
                      </button>
                    ) : (
                      <span className="shrink-0 whitespace-nowrap">+{num(dueTotal - shown.length)} more</span>
                    )
                  ) : null}
                </>
              ) : (
                <span className="truncate">Nothing due today.</span>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
