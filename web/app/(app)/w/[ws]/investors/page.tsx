import type { Metadata } from "next";
import { Suspense } from "react";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { InvestorsDirectory } from "@/components/app/InvestorsDirectory";
import { load, optional, workspaceFor } from "@/components/app/load";
import { Loading } from "@/components/ui";
import { listRounds } from "@/lib/api/core";
import { listAllInvestors, toInvestorRow } from "@/lib/api/investors";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Investors" };

/**
 * Investors directory (SYSTEM §4.7, UX-PASS-1 P2-5). Every contact loads once, trimmed to
 * what the table shows and searches; filters, search and sort then run in the browser, so a
 * filter change never costs a server round trip.
 */
export default async function InvestorsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { client, today } = await workspaceFor(ws);
  const res = await load(async () => {
    const [all, rounds] = await Promise.all([listAllInvestors(client), optional(listRounds(client, "all").then((r) => r.data), [])]);
    return { rows: all.data.map(toInvestorRow), rounds };
  });
  if (!res.ok) return <ApiErrorState error={res.error} title="Your contacts could not load" retryHref={`/w/${ws}/investors`} />;
  return (
    <Suspense fallback={<Loading>Loading contacts…</Loading>}>
      <InvestorsDirectory {...res.data} today={today} />
    </Suspense>
  );
}
