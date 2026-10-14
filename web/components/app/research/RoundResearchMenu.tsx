"use client";

import { Menu, type MenuEntry } from "@/components/ui";
import type { AiSettings, RoundResearchRow } from "@/lib/api/research";
import { num } from "@/lib/format";
import { approxUsd, researchCounts } from "@/lib/research";

/**
 * The round's AI research menu in the title row (R4; RESEARCH-PLAN §8.5): "Match all 411
 * ≈ $2.90" (the cheap identity step on its own; a LinkedIn already on file is free), who
 * still needs a person (a pick, or a LinkedIn by hand), and "Research all…", each through the
 * estimate dialog. Never automatic. Named "AI research" so it is never mistaken for the
 * pipeline's "Researching" stage.
 */
export function RoundResearchMenu({
  ids,
  rows,
  withLinkedin,
  settings,
  wsSlug,
  onMatchAll,
  onResearchAll,
  onShowNeedsPick,
}: {
  ids: readonly string[];
  rows: Map<string, RoundResearchRow>;
  /** Investors whose LinkedIn is on file: matching them is free. */
  withLinkedin: ReadonlySet<string>;
  settings: AiSettings | null | undefined;
  wsSlug: string;
  onMatchAll: () => void;
  onResearchAll: () => void;
  /** Filter the pipeline to the people research is waiting on. */
  onShowNeedsPick: () => void;
}) {
  const c = researchCounts(ids, rows, withLinkedin);
  const available = Boolean(settings?.research_available);
  const capped = Boolean(settings?.usage.cap_reached);
  const waiting = [c.needsPick ? `${num(c.needsPick)} need a pick` : "", c.notFound ? `${num(c.notFound)} not found` : ""].filter(Boolean).join(" · ");
  const items: MenuEntry[] = available
    ? [
        ...(capped ? [{ type: "label" as const, label: "This month's AI research limit is used up" }] : []),
        {
          label: c.noIdentity ? `Match all ${num(c.noIdentity)} without an identity…` : "Everyone has been matched",
          hint: c.noIdentity ? approxUsd((settings?.estimates.identity ?? 0) * c.paidMatches) || "free" : undefined,
          disabled: c.noIdentity === 0 || capped,
          onSelect: onMatchAll,
        },
        ...(waiting ? [{ label: `Show who needs you: ${waiting}`, onSelect: onShowNeedsPick }] : []),
        {
          label: c.researchable ? `Research all ${num(c.researchable)}…` : "Research all…",
          hint: c.needsIdentity ? `${num(c.needsIdentity)} matched first` : undefined,
          disabled: c.researchable === 0 || capped,
          onSelect: onResearchAll,
        },
        { type: "separator" },
        { label: "AI research settings", href: `/w/${encodeURIComponent(wsSlug)}/settings/ai` },
      ]
    : [
        { type: "label", label: "AI research needs an OpenRouter key" },
        { label: "Set up AI research", href: `/w/${encodeURIComponent(wsSlug)}/settings/ai` },
      ];
  return (
    <Menu
      label="AI research"
      align="end"
      minWidth={320}
      trigger="AI research"
      triggerClassName="inline-flex h-28 shrink-0 items-center gap-6 rounded-sm border border-line bg-surface px-10 text-sm text-fg hover:border-muted"
      items={items}
    />
  );
}
