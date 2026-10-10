"use client";

import type { RoundSummary, StageColor } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { money, moneyCompact, num } from "@/lib/format";

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
  /** compact on the pipeline page, full on the overview (adds soft and weighted lines). */
  variant?: "compact" | "full";
  weightedPipeline?: number;
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
  const shown = p.due.slice(0, 8);
  const stats: { n: string; label: string }[] = [
    { n: num(p.inConversation), label: "in conversation" },
    { n: num(p.committedCount), label: "committed" },
    { n: moneyCompact(p.softCircled, p.currency), label: "soft" },
  ];
  if (p.daysToClose !== undefined && p.daysToClose !== null) {
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
        "grid grid-cols-1 gap-18 rounded-md border border-line bg-surface p-14 md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)]",
        p.className,
      )}
    >
      <div className="min-w-0">
        <p className="t-label">Committed toward {p.roundName}</p>
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
        <p className="t-body-s mt-8 flex flex-wrap gap-x-6 gap-y-2 text-muted">
          {stats.map((s, i) => (
            <span key={s.label}>
              {i > 0 ? <span aria-hidden className="mr-6">·</span> : null}
              <b className="tnum font-semibold text-fg">{s.n}</b> {s.label}
            </span>
          ))}
        </p>
        {variant === "full" && p.weightedPipeline !== undefined ? (
          <p className="t-body-s mt-4 text-muted">
            Weighted pipeline{" "}
            <b className="tnum font-semibold text-fg" title={money(p.weightedPipeline, p.currency)}>
              {moneyCompact(p.weightedPipeline, p.currency)}
            </b>
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        <p className="t-label">Pipeline</p>
        <FunnelBar segments={p.funnel} onSelect={p.onStageSelect} active={p.activeStage} />
        <div className="t-body-s flex flex-wrap items-center gap-6 text-muted">
          {shown.length ? (
            <>
              <span>Follow up now:</span>
              {shown.map((d) =>
                p.onDueSelect ? (
                  <Chip key={d.id} as="button" tone="due" onClick={() => p.onDueSelect?.(d.id)}>
                    {d.name}
                  </Chip>
                ) : (
                  <Chip key={d.id} tone="due">
                    {d.name}
                  </Chip>
                ),
              )}
              {dueTotal > shown.length ? <span>+{num(dueTotal - shown.length)} more</span> : null}
            </>
          ) : (
            <span>No follow-ups due. Set a date on an investor&apos;s file to get reminded here.</span>
          )}
        </div>
      </div>
    </section>
  );
}
