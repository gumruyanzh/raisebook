"use client";

import { useLayoutEffect, useRef, useState } from "react";

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
      won: f.kind === "won",
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
  // One line of whole chips, as many as fit (measured), then "+N more", which is always
  // fully visible (UX pass 1, P2-11).
  const shown = p.due.slice(0, 8);
  const strip = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(Math.min(shown.length, variant === "full" ? 3 : 5));
  const shownKey = shown.map((d) => d.id).join(",");
  useLayoutEffect(() => {
    const box = strip.current;
    if (!box) return;
    const measure = () => {
      const kids = Array.from(box.querySelectorAll<HTMLElement>("[data-due-chip]"));
      const width = box.clientWidth;
      let n = 0;
      for (const k of kids) {
        if (k.offsetLeft + k.offsetWidth <= width + 0.5) n++;
        else break;
      }
      setFit(n);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(box);
    return () => ro?.disconnect();
  }, [shownKey]);
  const more = Math.max(0, dueTotal - fit);
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
            {p.hasProbabilities === false ? (
              <span>Weighted pipeline: set a probability on investors to see it</span>
            ) : (
              <>
                Weighted pipeline{" "}
                <b className="tnum font-semibold text-fg" title={money(p.weightedPipeline, p.currency)}>
                  {moneyCompact(p.weightedPipeline, p.currency)}
                </b>
              </>
            )}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        <p className="t-label max-sm:hidden">Pipeline</p>
        {p.funnel.some((f) => f.count > 0) ? (
          <FunnelBar
            segments={p.funnel}
            onSelect={p.onStageSelect}
            active={p.activeStage}
            legendClassName={variant === "full" ? undefined : "max-sm:hidden"}
            phoneList={variant === "full"}
          />
        ) : (
          // An all-zero funnel says nothing; it appears with the first investor (P2-4).
          <p className="t-body-s text-muted">The funnel appears once the round has investors.</p>
        )}
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
                  <div ref={strip} className="relative flex min-w-0 shrink flex-nowrap items-center gap-6 overflow-hidden">
                    {shown.map((d, i) => {
                      const hidden = i >= fit;
                      return p.onDueSelect ? (
                        <Chip
                          key={d.id}
                          as="button"
                          tone="due"
                          data-due-chip
                          aria-hidden={hidden || undefined}
                          tabIndex={hidden ? -1 : undefined}
                          className={cn("shrink-0", hidden && "invisible")}
                          onClick={() => p.onDueSelect?.(d.id)}
                        >
                          {d.name}
                        </Chip>
                      ) : (
                        <Chip key={d.id} tone="due" data-due-chip className={cn("shrink-0", hidden && "invisible")}>
                          {d.name}
                        </Chip>
                      );
                    })}
                  </div>
                  {more > 0 ? (
                    p.onDueFilter ? (
                      <button
                        type="button"
                        onClick={p.onDueFilter}
                        className="link shrink-0 border-0 bg-transparent p-0 whitespace-nowrap"
                      >
                        +{num(more)} more
                      </button>
                    ) : (
                      <span className="shrink-0 whitespace-nowrap">+{num(more)} more</span>
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
