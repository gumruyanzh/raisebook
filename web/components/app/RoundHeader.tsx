import { Chip, TabLinks } from "@/components/ui";
import type { Round } from "@/lib/api/types";
import { INSTRUMENT_LABEL } from "@/lib/api/types";

/** Title row for a round's Overview and Settings: name, status and the round tabs. */
export function RoundHeader({
  wsSlug,
  round,
  active,
}: {
  wsSlug: string;
  round: Round;
  active: "pipeline" | "overview" | "settings";
}) {
  const base = `/w/${encodeURIComponent(wsSlug)}/r/${encodeURIComponent(round.slug)}`;
  return (
    <div className="mb-16 flex flex-col gap-10">
      <div className="flex flex-wrap items-baseline gap-x-12 gap-y-4">
        <h1 className="t-display-m">{round.name}</h1>
        <span className="t-micro text-muted">{INSTRUMENT_LABEL[round.instrument]}</span>
        {round.status === "closed" ? <Chip tone="mode">Closed</Chip> : null}
      </div>
      <TabLinks
        label={`${round.name} sections`}
        active={active}
        items={[
          { key: "pipeline", label: "Pipeline", href: base },
          { key: "overview", label: "Overview", href: `${base}/overview` },
          { key: "settings", label: "Settings", href: `${base}/settings` },
        ]}
      />
    </div>
  );
}
