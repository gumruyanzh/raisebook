import type { Metadata } from "next";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { load, optional, roundOr404, workspaceFor } from "@/components/app/load";
import { RoundHeader } from "@/components/app/RoundHeader";
import { RoundOverview } from "@/components/app/RoundOverview";
import { listActivities } from "@/lib/api/activities";
import { listMeetings, type Meeting } from "@/lib/api/meetings";
import { getRoundSummary, listFollowUps } from "@/lib/api/rounds";

export const dynamic = "force-dynamic";

type Params = { ws: string; round: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { round } = await params;
  return { title: `Overview · ${decodeURIComponent(round)}` };
}

/** Round overview (SYSTEM §4.5). */
export default async function OverviewPage({ params }: { params: Promise<Params> }) {
  const { ws, round: ref } = await params;
  const { workspace, client, today } = await workspaceFor(ws);
  const res = await load(async () => {
    const round = await roundOr404(client, ref);
    const week = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const [summary, activity, followUps, agentActivity, meetings] = await Promise.all([
      getRoundSummary(client, round.id),
      optional(listActivities(client, { round: round.id, limit: 50, collapse_runs: true }).then((r) => r.data), []),
      optional(listFollowUps(client, { round: round.id, within_days: 7, include_overdue: true, limit: 200 }), {
        today,
        data: [],
        counts: { overdue: 0, today: 0, upcoming: 0 },
      }),
      optional(
        listActivities(client, { round: round.id, actor_type: "agent", since: week, limit: 200 }).then((r) => r.data),
        [],
      ),
      optional(
        Promise.all([
          listMeetings(client, { round: round.id, when: "needs_outcome", order: "desc", limit: 5 }),
          listMeetings(client, { round: round.id, when: "upcoming", limit: 5 }),
        ]).then(([a, b]) => [...a.data, ...b.data]),
        [] as Meeting[],
      ),
    ]);
    return { round, summary, activity, followUps, agentActivity, meetings };
  });
  if (!res.ok) return <ApiErrorState error={res.error} title="The overview could not load" retryHref={`/w/${ws}/r/${ref}/overview`} />;
  return (
    <>
      <RoundHeader wsSlug={workspace.slug} round={res.data.round} active="overview" />
      <RoundOverview {...res.data} today={today} />
    </>
  );
}
