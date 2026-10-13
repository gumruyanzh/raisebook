"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Chip } from "@/components/ui";
import type { Round } from "@/lib/api/types";
import { INSTRUMENT_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { moneyCompact } from "@/lib/format";
import { useWorkspace } from "@/lib/session";

/**
 * The same title row on every round view (pipeline, overview, round settings): name, instrument,
 * status, and the way to the round's settings. Section navigation lives only in the top bar
 * (Pipeline · Overview · Investors · Settings), so there is no second row of tabs.
 */
export function RoundHeader({
  wsSlug,
  round,
  active,
  className,
  children,
  aside,
  compact = false,
}: {
  wsSlug: string;
  round: Round;
  active: "pipeline" | "overview" | "settings";
  className?: string;
  /** Between the title and "Edit round" (the pipeline's saved views). */
  children?: ReactNode;
  /** Right-aligned with "Edit round", as one group (the pipeline's SET UP and Add investor). */
  aside?: ReactNode;
  /** A narrow page (the split sheet at 1024px): the instrument terms step aside. */
  compact?: boolean;
}) {
  const { canWrite } = useWorkspace();
  const base = `/w/${encodeURIComponent(wsSlug)}/r/${encodeURIComponent(round.slug)}`;
  const terms = [INSTRUMENT_LABEL[round.instrument], round.valuation_cap ? `${moneyCompact(round.valuation_cap, round.currency)} cap` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className={cn(
        "flex gap-x-12 gap-y-4",
        // The pipeline keeps its title row on one line (its children shrink instead).
        /\bflex-nowrap\b/.test(className ?? "") ? null : "flex-wrap",
        // Callers may set their own margin and alignment (the pipeline's title row is centered).
        /\bmb-/.test(className ?? "") ? null : "mb-14",
        /\bitems-/.test(className ?? "") ? null : "items-baseline",
        className,
      )}
    >
      <h1 className="t-display-s shrink-0">
        {round.name}
        {active === "settings" ? <span className="text-muted"> · Round settings</span> : null}
      </h1>
      {compact ? null : <span className="t-micro shrink-0 whitespace-nowrap text-muted uppercase">{terms}</span>}
      {round.status === "closed" ? <Chip tone="mode">Closed</Chip> : null}
      {children}
      <span className="t-body-s ml-auto flex shrink-0 items-center gap-12 whitespace-nowrap">
        {aside}
        {active === "settings" ? (
          <Link href={`${base}/overview`} className="link">
            ← {round.name} overview
          </Link>
        ) : canWrite ? (
          <Link href={`${base}/settings`} className="link">
            Edit round
          </Link>
        ) : null}
      </span>
    </div>
  );
}
