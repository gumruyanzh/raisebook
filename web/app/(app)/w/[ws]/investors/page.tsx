import type { Metadata } from "next";
import { Suspense } from "react";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { InvestorsDirectory } from "@/components/app/InvestorsDirectory";
import { load, optional, workspaceFor } from "@/components/app/load";
import { Loading } from "@/components/ui";
import { listRounds } from "@/lib/api/core";
import { listInvestors, type InvestorQuery, type InvestorSort } from "@/lib/api/investors";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Investors" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/** Investors directory (SYSTEM §4.7). */
export default async function InvestorsPage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<Search>;
}) {
  const { ws } = await params;
  const sp = await searchParams;
  const { client, today } = await workspaceFor(ws);
  const sort = (one(sp.sort) ?? "name") as InvestorSort;
  const q: InvestorQuery = {
    q: one(sp.q),
    type: one(sp.type),
    tag: one(sp.tag),
    industry: one(sp.industry),
    sort,
    order: (one(sp.order) as "asc" | "desc" | undefined) ?? (sort === "updated" ? "desc" : "asc"),
    limit: 200,
  };
  const round = one(sp.round);
  if (round?.startsWith("in:")) q.round = round.slice(3);
  if (round?.startsWith("out:")) q.not_in_round = round.slice(4);
  const filtered = Boolean(q.q || q.type || q.tag || q.industry || round);

  const res = await load(async () => {
    const [initial, rounds, all] = await Promise.all([
      listInvestors(client, q),
      optional(listRounds(client, "all").then((r) => r.data), []),
      filtered ? optional(listInvestors(client, { limit: 1 }).then((r) => r.total ?? 0), 0) : Promise.resolve(-1),
    ]);
    return { initial: { ...initial, total: initial.total ?? initial.data.length }, rounds, totalAll: all < 0 ? (initial.total ?? initial.data.length) : all };
  });
  if (!res.ok) return <ApiErrorState error={res.error} title="Your contacts could not load" retryHref={`/w/${ws}/investors`} />;
  return (
    <Suspense fallback={<Loading>Loading contacts…</Loading>}>
      <InvestorsDirectory {...res.data} today={today} />
    </Suspense>
  );
}
