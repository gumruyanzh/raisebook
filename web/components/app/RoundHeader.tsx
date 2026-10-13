"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Chip } from "@/components/ui";
import type { Round } from "@/lib/api/types";
import { INSTRUMENT_LABEL } from "@/lib/api/types";
import { cn } from "@/lib/cn";
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
}: {
  wsSlug: string;
  round: Round;
  active: "pipeline" | "overview" | "settings";
  className?: string;
  /** Between the title and "Edit round" (the pipeline's saved views). */
  children?: ReactNode;
}) {
  const { canWrite } = useWorkspace();
  const base = `/w/${encodeURIComponent(wsSlug)}/r/${encodeURIComponent(round.slug)}`;
  return (
    <div className={cn("mb-14 flex flex-wrap items-baseline gap-x-12 gap-y-4", className)}>
      <h1 className="t-display-s">
        {round.name}
        {active === "settings" ? <span className="text-muted"> · Round settings</span> : null}
      </h1>
      <span className="t-micro text-muted">{INSTRUMENT_LABEL[round.instrument]}</span>
      {round.status === "closed" ? <Chip tone="mode">Closed</Chip> : null}
      {children}
      <span className="t-body-s ml-auto">
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
