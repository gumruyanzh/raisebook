import type { Metadata } from "next";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { load, optional, workspaceFor } from "@/components/app/load";
import { AiResearchSettings } from "@/components/app/research/AiResearchSettings";
import { getInvestor } from "@/lib/api/investors";
import { getAiSettings, getCompanyProfile, listRuns } from "@/lib/api/research";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI research" };

/** Settings → AI research (RESEARCH-PLAN §8.1): key, models, monthly limit, recent runs. */
export default async function AiResearchPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { client } = await workspaceFor(ws);
  const res = await load(async () => {
    const [settings, runs, profile] = await Promise.all([
      getAiSettings(client),
      optional(listRuns(client, { limit: 20 }).then((r) => r.data), []),
      optional(getCompanyProfile(client), null),
    ]);
    const ids = [...new Set(runs.map((r) => r.investor_id).filter((x): x is string => Boolean(x)))];
    const named = await Promise.all(ids.map((id) => optional(getInvestor(client, id).then((i) => [id, i.name] as const), null)));
    const names = Object.fromEntries(named.filter((x): x is readonly [string, string] => x !== null));
    return { settings, runs, names, profileEmpty: profile?.is_empty ?? false };
  });
  if (!res.ok) return <ApiErrorState error={res.error} title="AI research settings could not load" retryHref={`/w/${ws}/settings/ai`} />;
  return <AiResearchSettings {...res.data} />;
}
