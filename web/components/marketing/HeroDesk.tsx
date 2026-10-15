"use client";

import { BoardCard, BoardColumn, Ledger } from "@/components/ui";
import { FilterChips, type FilterField } from "@/components/ui/FilterBar";
import { cn } from "@/lib/cn";

import { CURRENCY, HERO_COLUMNS, LEDGER, TODAY, WORKSPACE } from "./sample";

// The toolbar's applied filters, rendered by the app's own FilterChips.
const HERO_FILTERS: FilterField[] = [
  { key: "fit", label: "Fit", values: [{ value: "4", label: "4+" }], verb: "is" },
  { key: "type", label: "Type", values: [{ value: "vc", label: "VC" }] },
];
const HERO_ACTIVE = { fit: "4", type: "vc" };
const noop = () => {};

/**
 * The hero product vignette (SYSTEM §4.14 item 2, UX-PASS-1 P2-14): the app's own Ledger,
 * one-line toolbar with filter chips, and four BoardColumns with fictional investors, inside
 * a frame that runs off the right edge of the page. It is a picture (inert): nothing in it
 * takes focus or clicks.
 */
export function HeroDesk({ className }: { className?: string }) {
  return (
    <figure className={cn("m-0", className)}>
      <figcaption className="sr-only">
        Example: the Seed round of a fictional company, {WORKSPACE}, with $750,000 committed of a
        $2,000,000 target, a funnel of 52 investors, and a pipeline board. One card, Dana
        Whitfield in Diligence, carries the orchid marker because claude-code moved her two hours
        ago.
      </figcaption>
      <div
        aria-hidden
        inert
        // Phones: drawn at a little over half size, so most of the desk shows, not a corner of it.
        className="w-[760px] overflow-hidden rounded-l-md border-y border-l border-line bg-canvas max-sm:[zoom:0.56] lg:w-[1080px]"
      >
        {/* A miniature of the app top bar. */}
        <div className="flex h-44 items-center gap-14 border-b border-line px-14 whitespace-nowrap [&>*]:shrink-0">
          <span className="font-display text-[17px] font-bold tracking-[-0.02em]">Raisebook</span>
          <span className="text-sm text-muted">{WORKSPACE} ▾</span>
          <span className="inline-flex items-center gap-2 rounded-pill bg-sunk p-3 text-sm">
            <span className="rounded-pill bg-surface px-10 py-2 font-medium shadow-pill">Seed</span>
            <span className="px-10 py-2 text-muted">
              Pre-seed 2025 <span className="font-mono text-2xs">closed</span>
            </span>
          </span>
          <span className="ml-18 flex flex-1 items-center gap-14 text-sm text-muted [&>*]:shrink-0">
            <span className="relative font-medium text-fg after:absolute after:inset-x-0 after:-bottom-[13px] after:h-2 after:bg-accent">
              Pipeline
            </span>
            <span>Overview</span>
            <span>Investors</span>
            <span>Settings</span>
            <span className="ml-auto mr-10 hidden items-center gap-6 rounded-sm border border-line bg-surface px-8 py-3 lg:inline-flex">
              Search
              <span className="rounded-kbd border border-line px-4 font-mono text-2xs">⌘K</span>
            </span>
            <span className="ml-auto inline-flex size-24 items-center justify-center rounded-pill bg-sunk font-mono text-2xs text-fg lg:ml-0">
              SR
            </span>
          </span>
        </div>

        <div className="flex flex-col gap-12 p-14">
          <Ledger {...LEDGER} variant="compact" />

          <div className="flex flex-col gap-8">
            <div className="flex items-center gap-8">
              <span className="flex h-30 w-[280px] items-center justify-between rounded-sm border border-line bg-surface px-9 text-faint">
                Search name, firm, notes…
                <span className="rounded-kbd border border-line px-4 font-mono text-2xs text-muted">/</span>
              </span>
              <span className="inline-flex h-28 items-center gap-6 rounded-sm border border-line bg-surface px-9 text-sm font-medium">
                Filter <span className="rounded-kbd border border-line px-4 font-mono text-2xs text-muted">F</span>
              </span>
              <span className="ml-auto inline-flex overflow-hidden rounded-md border border-line bg-surface text-sm">
                <span className="bg-fg px-10 py-4 text-canvas">Board</span>
                <span className="px-10 py-4 text-muted">Table</span>
              </span>
              <span className="t-micro text-muted">31 of 52</span>
              <span className="inline-flex h-30 items-center rounded-sm bg-accent px-10 text-sm font-medium text-accent-ink">
                Add investor
              </span>
            </div>
            <FilterChips fields={HERO_FILTERS} active={HERO_ACTIVE} onRemove={noop} onClear={noop} />
          </div>

          <div className="grid grid-cols-[repeat(4,236px)] gap-10 lg:grid-cols-[repeat(4,252px)]">
            {HERO_COLUMNS.map((col) => {
              const total = col.won
                ? { amount: LEDGER.committed, currency: CURRENCY }
                : null;
              return (
                <BoardColumn
                  key={col.key}
                  label={col.label}
                  color={col.color}
                  count={col.count}
                  total={total}
                  dueCount={col.cards.filter((c) => c.followUpState === "overdue" || c.followUpState === "today").length || undefined}
                  className="max-h-none"
                >
                  {col.cards.map((c) => (
                    <BoardCard
                      key={c.id}
                      tabIndex={-1}
                      name={c.name}
                      title={c.title}
                      firm={c.firm}
                      fit={c.fit}
                      typeLabel={c.type}
                      industry={c.industry}
                      extraTagCount={c.extraTags}
                      followUpOn={c.followUpOn}
                      followUpState={c.followUpState}
                      today={TODAY}
                      amount={c.amount ? { value: c.amount, currency: CURRENCY, soft: c.soft } : null}
                      nextStep={c.nextStep}
                      agentMark={c.agentTip ? { tip: c.agentTip } : null}
                      won={col.won}
                    />
                  ))}
                  {col.count > col.cards.length ? (
                    <p className="t-micro px-4 pt-2 text-muted">
                      +{col.count - col.cards.length} more
                    </p>
                  ) : null}
                </BoardColumn>
              );
            })}
          </div>
        </div>
      </div>
    </figure>
  );
}
