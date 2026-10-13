import type { Metadata } from "next";
import { Suspense } from "react";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { load, optional, roundOr404, workspaceFor } from "@/components/app/load";
import { Pipeline } from "@/components/app/Pipeline";
import { Loading } from "@/components/ui";
import { listActivities } from "@/lib/api/activities";
import { listAllInvestors } from "@/lib/api/investors";
import { getRoundSummary, listAllParticipants, toPipelineItems } from "@/lib/api/rounds";
import { listApiKeys, listInvites, listMembers } from "@/lib/api/settings";

export const dynamic = "force-dynamic";

type Params = { ws: string; round: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { round } = await params;
  return { title: `Pipeline · ${decodeURIComponent(round)}` };
}

/** Round pipeline (SYSTEM §4.2): ledger, toolbar, board or table, investor sheet. */
export default async function PipelinePage({ params }: { params: Promise<Params> }) {
  const { ws, round: ref } = await params;
  const { client, today } = await workspaceFor(ws);
  const res = await load(async () => {
    const round = await roundOr404(client, ref);
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const [summary, participants, investors, members, agentActivity, keys, invites] = await Promise.all([
      getRoundSummary(client, round.id),
      listAllParticipants(client, round.id),
      optional(listAllInvestors(client, { round: round.id }).then((r) => r.data), []),
      optional(listMembers(client).then((r) => r.data), []),
      optional(
        listActivities(client, { round: round.id, actor_type: "agent", since, limit: 200 }).then((r) => r.data),
        [],
      ),
      // For the "Get set up" checklist; admins only, so null means "unknown".
      optional(listApiKeys(client).then((r) => r.data.filter((k) => !k.revoked_at).length), null),
      optional(listInvites(client).then((r) => r.data.filter((i) => i.status === "pending").length), null),
    ]);
    // Only what the cards, rows and filters use travels to the browser (UX pass 1, P1-1);
    // the sheet fetches the full investor when it opens.
    return {
      round,
      summary,
      items: toPipelineItems(participants, investors),
      members,
      agentMarks: agentActivity.map((a) => ({
        investor_id: a.investor_id,
        kind: a.kind,
        label: a.actor.label,
        type: a.actor.type,
        at: a.occurred_at,
        imported: a.actor.via === "import" || Boolean(a.data?.import_run_id),
      })),
      loadedAt: new Date().toISOString(),
      setup: { activeKeys: keys, pendingInvites: invites },
    };
  });
  if (!res.ok) return <ApiErrorState error={res.error} title="The pipeline could not load" retryHref={`/w/${ws}/r/${ref}`} />;
  return (
    <Suspense fallback={<Loading>Loading pipeline…</Loading>}>
      <Pipeline {...res.data} today={today} />
    </Suspense>
  );
}
