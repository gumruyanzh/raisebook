"use client";

import { Menu, type MenuEntry } from "@/components/ui";
import type { AiSettings, RoundResearchRow } from "@/lib/api/research";
import { num } from "@/lib/format";
import { approxUsd } from "@/lib/research";

/** Who in the round still needs an identity, and who could get a dossier. */
export function researchCounts(ids: readonly string[], rows: Map<string, RoundResearchRow>): { noIdentity: number; withIdentity: number; dossiers: number } {
  let noIdentity = 0;
  let withIdentity = 0;
  let dossiers = 0;
  for (const id of ids) {
    const r = rows.get(id);
    const st = r?.identity_status ?? "none";
    if (st === "none") noIdentity++;
    if (st === "matched" || st === "confirmed") withIdentity++;
    if (r?.verdict) dossiers++;
  }
  return { noIdentity, withIdentity, dossiers };
}

/**
 * The round's Research menu in the title row (R4; RESEARCH-PLAN §8.5): "Match all 411
 * ≈ $2.90" (the cheap identity step on its own) and "Research all with an identity…", each
 * through the estimate dialog. Never automatic.
 */
export function RoundResearchMenu({
  ids,
  rows,
  settings,
  wsSlug,
  onMatchAll,
  onResearchAll,
}: {
  ids: readonly string[];
  rows: Map<string, RoundResearchRow>;
  settings: AiSettings | null | undefined;
  wsSlug: string;
  onMatchAll: () => void;
  onResearchAll: () => void;
}) {
  const c = researchCounts(ids, rows);
  const available = Boolean(settings?.research_available);
  const items: MenuEntry[] = available
    ? [
        {
          label: c.noIdentity ? `Match all ${num(c.noIdentity)} without an identity` : "Everyone has an identity",
          hint: c.noIdentity ? approxUsd((settings?.estimates.identity ?? 0) * c.noIdentity) : undefined,
          disabled: c.noIdentity === 0,
          onSelect: onMatchAll,
        },
        {
          label: c.withIdentity ? `Research all ${num(c.withIdentity)} with an identity…` : "Research all with an identity…",
          disabled: c.withIdentity === 0,
          onSelect: onResearchAll,
        },
        { type: "separator" },
        { label: "AI research settings", href: `/w/${encodeURIComponent(wsSlug)}/settings/ai` },
      ]
    : [
        { type: "label", label: "Research needs an OpenRouter key" },
        { label: "Set up AI research", href: `/w/${encodeURIComponent(wsSlug)}/settings/ai` },
      ];
  return (
    <Menu
      label="Research"
      align="end"
      minWidth={300}
      trigger="Research"
      triggerClassName="inline-flex h-28 shrink-0 items-center gap-6 rounded-sm border border-line bg-surface px-10 text-sm text-fg hover:border-muted"
      items={items}
    />
  );
}
