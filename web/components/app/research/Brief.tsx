"use client";

import { useState, type ReactNode } from "react";

import { AgentMarker, Chip, type ChipTone } from "@/components/ui";
import type { DossierView, Verdict } from "@/lib/api/research";
import { cn } from "@/lib/cn";
import { citationTitle, researchedLine, verdictLabel, type Citation } from "@/lib/research";

const VERDICT_TONE: Record<Verdict, ChipTone> = { strong: "strong", possible: "maybe", poor: "low" };

export function VerdictChip({ verdict, className }: { verdict: Verdict; className?: string }) {
  return (
    <Chip tone={VERDICT_TONE[verdict]} className={className}>
      {verdictLabel(verdict)}
    </Chip>
  );
}

/** Small numbered source links: `[1]` opens the page in a new tab; title, domain and date on hover. */
export function Cites({ nums, citations, today }: { nums: number[]; citations: Citation[]; today?: string }) {
  if (!nums.length) return null;
  return (
    <span className="ml-4 inline-flex gap-2 align-baseline whitespace-nowrap">
      {nums.map((n) => {
        const c = citations[n - 1];
        if (!c) return null;
        return (
          <a
            key={n}
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            title={citationTitle(c, today)}
            aria-label={`Source ${n}: ${c.title ?? c.domain}`}
            className="font-mono text-[11px] text-accent no-underline hover:underline"
          >
            [{n}]
          </a>
        );
      })}
    </span>
  );
}

/** "by claude-code" in orchid (an agent wrote this dossier), else nothing. */
export function AgentBy({ by }: { by: string | null }) {
  if (!by) return null;
  return (
    <span className="inline-flex items-center gap-6 text-agent">
      <AgentMarker />
      <span className="font-medium">{by}</span>
    </span>
  );
}

function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="link t-body-s ml-6 border-0 bg-transparent p-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          setDone(false);
        }
      }}
    >
      <span aria-live="polite">{done ? "Copied" : "Copy"}</span>
    </button>
  );
}

function Row({ term, children, compact }: { term: string; children: ReactNode; compact: boolean }) {
  return (
    <div className={cn("contents")}>
      <dt className="text-muted">{term}</dt>
      <dd className={cn("m-0 min-w-0", compact ? "truncate" : "[overflow-wrap:anywhere]")}>{children}</dd>
    </div>
  );
}

/**
 * The Brief (R5): always visible, at most five lines. Verdict + one-line why, best way in, one
 * opener (with Copy), one risk, and when it was researched (by which model and for how much,
 * or "by claude-code" in orchid). `compact` (Triage) keeps every line to one line so the
 * decision panel never changes height.
 */
export function Brief({
  view,
  citations,
  briefCites,
  today,
  compact = false,
  aside,
}: {
  view: DossierView;
  citations: Citation[];
  briefCites: number[];
  today?: string;
  compact?: boolean;
  /** Right of the researched line: "May be stale", Refresh. */
  aside?: ReactNode;
}) {
  const b = view.dossier.analysis.brief;
  const agent = view.author.kind === "agent";
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className={cn("flex min-w-0 items-baseline gap-8", compact && "h-20")}>
        <VerdictChip verdict={b.verdict} className="shrink-0" />
        <span className={cn("min-w-0 text-fg", compact && "truncate")}>
          {b.why}
          {compact ? null : <Cites nums={briefCites} citations={citations} today={today} />}
        </span>
      </p>
      <dl className={cn("m-0 grid gap-x-10 text-13", compact ? "grid-cols-[72px_minmax(0,1fr)] gap-y-2" : "grid-cols-[96px_minmax(0,1fr)] gap-y-6")}>
        <Row term="Best way in" compact={compact}>
          {b.best_way_in || <span className="text-muted">No public path found</span>}
        </Row>
        <Row term="Opener" compact={compact}>
          {b.opener ? (
            <>
              <span className="italic">{b.opener}</span>
              {compact ? null : <CopyText text={b.opener} />}
            </>
          ) : (
            <span className="text-muted">None</span>
          )}
        </Row>
        <Row term="Risk" compact={compact}>
          {b.risk || <span className="text-muted">None found</span>}
        </Row>
      </dl>
      <p className={cn("t-micro flex min-w-0 flex-wrap items-center gap-x-8 gap-y-2 text-muted", compact && "h-18 flex-nowrap overflow-hidden")}>
        <span className="truncate">{researchedLine(view.dossier, view.author, today)}</span>
        {agent ? <AgentBy by={view.author.by} /> : null}
        {aside}
      </p>
    </div>
  );
}
