import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { InvestorPage } from "@/components/app/InvestorPage";
import { load, optional, workspaceFor } from "@/components/app/load";
import { listActivities } from "@/lib/api/activities";
import { listRounds } from "@/lib/api/core";
import { getInvestor } from "@/lib/api/investors";
import { getParticipant } from "@/lib/api/rounds";
import { listMembers } from "@/lib/api/settings";

export const dynamic = "force-dynamic";

type Params = { ws: string; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { ws, id } = await params;
  if (!UUID_RE.test(id)) return { title: "Investor" };
  try {
    const { client } = await workspaceFor(ws);
    const inv = await getInvestor(client, id);
    return { title: inv.name };
  } catch {
    return { title: "Investor" };
  }
}

/** Investor page (SYSTEM §4.8). */
export default async function InvestorRoute({ params }: { params: Promise<Params> }) {
  const { ws, id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const { client, today } = await workspaceFor(ws);
  const res = await load(async () => {
    const [investor, rounds, members, timeline] = await Promise.all([
      getInvestor(client, id),
      optional(listRounds(client, "all").then((r) => r.data), []),
      optional(listMembers(client).then((r) => r.data), []),
      optional(listActivities(client, { investor_id: id, limit: 50 }), { data: [], next_cursor: null }),
    ]);
    const participations = (
      await Promise.all(investor.rounds.map((r) => optional(getParticipant(client, r.round_id, id), null)))
    ).filter((p) => p !== null);
    return { investor, rounds, members, participations, timeline: timeline.data, nextCursor: timeline.next_cursor };
  });
  if (!res.ok) return <ApiErrorState error={res.error} title="This investor could not load" retryHref={`/w/${ws}/investors/${id}`} />;
  return <InvestorPage {...res.data} today={today} />;
}
