"use client";

import type { ReactNode } from "react";

import { Button, StageDot } from "@/components/ui";
import type { Participant, Round } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { daysBetween, formatDate, money, moneyCompact, num } from "@/lib/format";
import { nextUpBuckets, type NextUpBucket } from "@/lib/pipeline";

/** The due list (overdue first, then today), most overdue first. */
export function dueRows(rows: readonly Participant[]): Participant[] {
  return rows
    .filter((p) => p.follow_up_on && (p.follow_up_state === "overdue" || p.follow_up_state === "today"))
    .sort((a, b) => (a.follow_up_on! < b.follow_up_on! ? -1 : a.follow_up_on! > b.follow_up_on! ? 1 : a.investor.name.localeCompare(b.investor.name)));
}

export function dueText(p: Participant, today: string): string {
  if (p.follow_up_state === "today") return "Today";
  const late = p.follow_up_on ? daysBetween(p.follow_up_on, today) : 0;
  return late > 0 ? `Overdue ${late}d` : "Overdue";
}

export interface LedgerFacts {
  total: number;
  openCount: number;
  /** Hot + Warm still in `O`. */
  hwOpen: number;
  committed: number;
  soft: number;
  committedCount: number;
  talking: number;
  daysToClose: number | null;
  dueCount: number;
}

export function ledgerFacts(rows: readonly Participant[], openKey: string | null, today: string, closeOn?: string | null): LedgerFacts {
  let openCount = 0;
  let hwOpen = 0;
  let committed = 0;
  let soft = 0;
  let committedCount = 0;
  let talking = 0;
  let dueCount = 0;
  for (const p of rows) {
    if (openKey && p.stage.key === openKey) {
      openCount++;
      if (p.fit >= 4) hwOpen++;
    }
    committed += p.amount_committed ?? 0;
    if (p.stage.kind !== "won" && p.stage.kind !== "lost") soft += p.amount_soft ?? 0;
    if (p.stage.kind === "won") committedCount++;
    if (p.stage.kind === "active") talking++;
    if (p.follow_up_state === "overdue" || p.follow_up_state === "today") dueCount++;
  }
  return {
    total: rows.length,
    openCount,
    hwOpen,
    committed,
    soft,
    committedCount,
    talking,
    daysToClose: closeOn ? daysBetween(today, closeOn) : null,
    dueCount,
  };
}

/** "40 Hot and Warm are still New. Start with them." and its siblings (DECISION §5.1). */
export function stripMessage(f: LedgerFacts, openLabel: string): { text: ReactNode; triage: boolean } {
  if (f.hwOpen > 0) {
    return {
      // One sentence on desktop and phone (critique 4: "are waiting" on the phone).
      text: (
        <>
          <b className="font-semibold text-fg">{f.hwOpen === 1 ? "1 Hot or Warm investor" : `${num(f.hwOpen)} Hot and Warm`}</b> {f.hwOpen === 1 ? "is" : "are"} still {openLabel}. Start with{" "}
          {f.hwOpen === 1 ? "it" : "them"}.
        </>
      ),
      triage: true,
    };
  }
  if (f.openCount > 0) {
    return {
      text: (
        <>
          <b className="font-semibold text-fg">{num(f.openCount)}</b> {f.openCount === 1 ? "is" : "are"} still {openLabel}, highest fit first.
        </>
      ),
      triage: true,
    };
  }
  return {
    text:
      f.dueCount > 0 ? (
        <>
          Everyone is sorted. <b className="font-semibold text-fg">{num(f.dueCount)}</b>{" "}
          {f.dueCount === 1 ? "follow-up" : "follow-ups"} due now.
        </>
      ) : (
        "Everyone is sorted. Nothing due."
      ),
    triage: false,
  };
}

const cell = "flex min-w-0 items-center gap-10 px-16";

/** Width steps for the ledger (the space the page has, not the viewport: the split sheet takes 512px). */
export const LEDGER_WIDE = 1180;
export const LEDGER_NARROW = 760;

/**
 * The 52px strip before money exists: target, Sorted progress, what to do, Start triage. No
 * "$0 committed" cell: before anyone is talking, $0 says nothing. `width` is the space the
 * page has; under 1000px the target cell steps aside so it stays one line.
 */
export function LedgerStrip({
  round,
  facts,
  openLabel,
  today,
  canWrite,
  width,
  onStartTriage,
}: {
  round: Round;
  facts: LedgerFacts;
  openLabel: string;
  today: string;
  canWrite: boolean;
  width: number;
  onStartTriage: () => void;
}) {
  const sorted = facts.total - facts.openCount;
  const msg = stripMessage(facts, openLabel);
  const wide = width >= LEDGER_WIDE;
  // Narrow (1024px, or the split sheet open): the target steps aside so the message and the
  // button keep one line.
  const narrow = width < 1000;
  const closes = round.target_close_on
    ? `closes ${formatDate(round.target_close_on, today)}${facts.daysToClose !== null && facts.daysToClose >= 0 ? `, ${num(facts.daysToClose)} days` : ""}`
    : null;
  return (
    <section
      aria-label={`${round.name} progress`}
      className="flex h-52 min-w-0 items-stretch overflow-hidden rounded-md border border-line bg-surface [&>*+*]:border-l [&>*+*]:border-line"
    >
      {narrow ? null : (
        <div className={cn(cell, "shrink-0")}>
          <span className="t-label">Target</span>
          <b className="font-display text-[16px] font-bold tnum">{money(round.target_amount, round.currency)}</b>
          {closes && wide ? <span className="t-body-s whitespace-nowrap text-muted">· {closes}</span> : null}
        </div>
      )}
      <div className={cn(cell, "shrink-0")}>
        <span className="t-label">Sorted</span>
        <span
          role="meter"
          aria-label="Sorted out of New"
          aria-valuemin={0}
          aria-valuemax={facts.total}
          aria-valuenow={sorted}
          className={cn("h-6 overflow-hidden rounded-pill bg-sunk", wide ? "w-160" : "w-80")}
        >
          <i className="block h-full bg-good not-italic transition-[width] duration-[400ms]" style={{ width: `${facts.total ? (sorted / facts.total) * 100 : 0}%` }} />
        </span>
        <span className="t-body-s whitespace-nowrap text-muted">
          <b className="font-semibold text-fg tnum">{num(sorted)}</b> of {num(facts.total)}
        </span>
      </div>
      <p className={cn(cell, "t-body min-w-0 flex-1 text-muted")}>
        <span className="min-w-0 truncate">{msg.text}</span>
      </p>
      {msg.triage && canWrite ? (
        <div className={cn(cell, "shrink-0 pr-8")}>
          <Button variant="primary" onClick={onStartTriage} kbd="T" aria-keyshortcuts="T" title="Start triage (T)" className="shrink-0">
            Start triage
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The Next up rows the desk shows at this width: up to four side by side, one in the compact
 * band. The page uses it to keep one way into Triage per screen (critique 4): when the "still
 * New → Triage" row is on screen, the New column drops its own link.
 */
export function shownBuckets(
  rows: Parameters<typeof nextUpBuckets>[0],
  openKey: string | null,
  today: string,
  nowMs: number,
  canWrite: boolean,
  width: number,
): NextUpBucket[] {
  const all = nextUpBuckets(rows, openKey, today, nowMs).filter((b) => canWrite || b.id !== "new");
  return all.slice(0, width >= LEDGER_WIDE ? 4 : 1);
}

/** Next up sentences and their links. */
export function bucketCopy(b: NextUpBucket, openLabel: string): { text: string; short: string; link: string } {
  switch (b.id) {
    case "ready":
      return { text: "researched, not contacted yet", short: "to contact", link: "Show →" };
    case "new":
      return {
        text: b.hw ? `still ${openLabel}, ${num(b.hw)} Hot or Warm` : `still ${openLabel}`,
        short: `still ${openLabel}`,
        link: "Triage →",
      };
    case "quiet":
      return { text: "gone quiet, 14+ days with no activity", short: "gone quiet", link: "Show →" };
    default:
      return { text: "talking with no follow-up set", short: "with no follow-up", link: "Show →" };
  }
}

/**
 * The full ledger once money exists (DECISION §5.1): committed with the soft tint, Follow up
 * now (overdue first, then today) and the Next up rows. No funnel bar. `width` is the space
 * the page has: from 1180px the three blocks sit side by side with up to four rows each;
 * below that (1024px, or any width with the split sheet open) it is one compact band with
 * the first item of each list, so the board or table starts high on the screen.
 */
export function LedgerDesk({
  round,
  rows,
  facts,
  openKey,
  openLabel,
  today,
  nowMs,
  canWrite,
  width,
  onOpen,
  onDueAll,
  onBucket,
}: {
  round: Round;
  rows: readonly Participant[];
  facts: LedgerFacts;
  openKey: string | null;
  openLabel: string;
  today: string;
  nowMs: number;
  canWrite: boolean;
  width: number;
  onOpen: (investorId: string) => void;
  onDueAll: () => void;
  onBucket: (b: NextUpBucket) => void;
}) {
  const due = dueRows(rows);
  const next = rows
    .filter((p) => p.follow_up_on && p.follow_up_on > today)
    .sort((a, b) => (a.follow_up_on! < b.follow_up_on! ? -1 : 1))[0];
  const buckets = shownBuckets(rows, openKey, today, nowMs, canWrite, width);
  const target = round.target_amount;
  const pctC = target > 0 ? Math.min(100, (facts.committed / target) * 100) : 0;
  const pctS = target > 0 ? Math.min(100 - pctC, (facts.soft / target) * 100) : 0;
  const stats: [string, string][] = [
    [moneyCompact(facts.soft, round.currency), "soft"],
    [num(facts.talking), "talking"],
    [num(facts.committedCount), "committed"],
  ];
  if (facts.daysToClose !== null) stats.push([num(Math.abs(facts.daysToClose)), facts.daysToClose >= 0 ? "days left" : "days past close"]);
  const wide = width >= LEDGER_WIDE;

  const meter = (className: string) => (
    <div
      role="meter"
      aria-label={`Committed toward ${round.name}`}
      aria-valuemin={0}
      aria-valuemax={target}
      aria-valuenow={facts.committed}
      className={cn("flex h-8 overflow-hidden rounded-pill bg-sunk", className)}
    >
      <i className="block h-full bg-good not-italic" style={{ width: `${pctC}%` }} />
      {pctS > 0 ? (
        <i
          className="block h-full not-italic"
          title={`${moneyCompact(facts.soft, round.currency)} soft`}
          style={{ width: `${pctS}%`, background: "color-mix(in oklab, var(--good) 30%, var(--sunk))" }}
        />
      ) : null}
    </div>
  );
  const dueRow = (p: Participant, withStep: boolean) => (
    <button
      type="button"
      onClick={() => onOpen(p.investor.id)}
      className="flex h-28 w-full min-w-0 items-center gap-8 border-0 bg-transparent px-0 text-left hover:text-accent"
    >
      <StageDot color={p.stage.color} />
      <span className="min-w-0 shrink truncate font-medium">{p.investor.name}</span>
      {withStep ? <span className="t-body-s min-w-0 flex-1 truncate text-muted">{p.next_step || p.follow_up_note || ""}</span> : <span className="flex-1" />}
      <span className="shrink-0 font-mono text-[12px] text-bad">{dueText(p, today)}</span>
    </button>
  );
  const nothingDue = next ? `Nothing due. Next: ${next.investor.name}, ${formatDate(next.follow_up_on, today)}.` : "Nothing due.";
  const bucketRow = (b: NextUpBucket, short = false, shortText = short) => {
    const c = bucketCopy(b, openLabel);
    return (
      <li key={b.id} className="flex h-28 min-w-0 items-center gap-8">
        <span className={cn("shrink-0 text-right font-mono text-[12.5px] font-medium text-fg tnum", short ? "" : "w-36")}>{num(b.count)}</span>
        {/* The name is the useful part: the sentence gives way first (critique 3). */}
        <span className="t-body-s flex min-w-0 flex-1 items-baseline gap-4">
          <span className="min-w-0 truncate" title={c.text}>
            {shortText ? c.short : c.text}
          </span>
          {b.id === "ready" && b.next ? (
            <span className="min-w-0 shrink-0 truncate whitespace-nowrap">
              {"· next "}
              <button
                type="button"
                onClick={() => onOpen(b.next!.id)}
                className="border-0 bg-transparent p-0 font-semibold text-fg hover:text-accent hover:underline"
                title={`Open ${b.next.name} (fit ${b.next.fit})`}
              >
                {b.next.name}
              </button>
            </span>
          ) : null}
        </span>
        <button type="button" onClick={() => onBucket(b)} className="link t-body-s shrink-0 border-0 bg-transparent p-0">
          {c.link}
        </button>
      </li>
    );
  };

  if (!wide) {
    // One compact band: committed · the first due · the first Next up row.
    const narrow = width < LEDGER_NARROW;
    return (
      <section
        aria-label={`${round.name} summary`}
        className={cn(
          "grid min-w-0 overflow-hidden rounded-md border border-line bg-surface",
          narrow ? "grid-cols-1 [&>*+*]:border-t" : "grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.1fr)] [&>*+*]:border-l",
          "[&>*+*]:border-line",
        )}
      >
        <div className="flex min-w-0 items-center gap-12 px-14 py-8">
          <span className="min-w-0 shrink-0">
            <span className="t-label block">Committed</span>
            <span className="font-display text-[18px] font-bold tnum">
              <span className="text-good-ink">{moneyCompact(facts.committed, round.currency)}</span>
              <span className="text-[13px] font-medium text-muted"> of {moneyCompact(target, round.currency)}</span>
            </span>
          </span>
          <span className="min-w-0 flex-1">
            {meter("")}
            <span className="t-body-s mt-4 block truncate text-muted">
              <b className="font-semibold text-fg tnum">{moneyCompact(facts.soft, round.currency)}</b> soft ·{" "}
              <b className="font-semibold text-fg tnum">{num(facts.talking)}</b> talking
            </span>
          </span>
        </div>
        <div className="min-w-0 px-14 py-8">
          <p className="t-label flex items-center">
            Follow up now
            {due.length ? (
              <button type="button" onClick={onDueAll} className="link t-body-s ml-auto border-0 bg-transparent p-0 normal-case tracking-normal">
                All {num(due.length)} →
              </button>
            ) : null}
          </p>
          {due.length ? dueRow(due[0]!, false) : <p className="t-body-s flex h-28 items-center truncate text-muted">{nothingDue}</p>}
        </div>
        <div className="min-w-0 px-14 py-8">
          <p className="t-label">Next up</p>
          {buckets.length ? (
            <ul className="m-0 list-none p-0">{bucketRow(buckets[0]!, true)}</ul>
          ) : (
            <p className="t-body-s flex h-28 items-center text-muted">Nothing waiting on you.</p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label={`${round.name} summary`}
      className="grid min-w-0 grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] overflow-hidden rounded-md border border-line bg-surface [&>*+*]:border-l [&>*+*]:border-line"
    >
      <div className="min-w-0 p-14">
        <p className="t-label">Committed toward {round.name}</p>
        <p className="t-amount mt-4">
          <span className="text-good-ink">{money(facts.committed, round.currency)}</span>{" "}
          <span className="text-[18px] font-medium whitespace-nowrap text-muted">of {money(target, round.currency)}</span>
        </p>
        {meter("mt-10")}
        <p className="t-body-s mt-8 flex flex-wrap gap-x-6 text-muted">
          {stats.map(([n, l], i) => (
            <span key={l}>
              {i > 0 ? <span className="mr-6">·</span> : null}
              <b className="font-semibold text-fg tnum">{n}</b> {l}
            </span>
          ))}
        </p>
      </div>
      <div className="min-w-0 p-14">
        <p className="t-label mb-6 flex items-center">
          Follow up now
          {due.length ? (
            <button type="button" onClick={onDueAll} className="link t-body-s ml-auto border-0 bg-transparent p-0 normal-case tracking-normal">
              All {num(due.length)} →
            </button>
          ) : null}
        </p>
        {due.length ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {due.slice(0, 4).map((p) => (
              <li key={p.investor.id}>{dueRow(p, width >= 1320)}</li>
            ))}
          </ul>
        ) : (
          <p className="t-body-s text-muted">{nothingDue}</p>
        )}
      </div>
      <div className="min-w-0 p-14">
        <p className="t-label mb-6">Next up</p>
        {buckets.length ? (
          <ul className="m-0 flex list-none flex-col p-0">{buckets.map((b) => bucketRow(b, false, width < 1360))}</ul>
        ) : (
          <p className="t-body-s text-muted">Nothing waiting on you.</p>
        )}
      </div>
    </section>
  );
}
