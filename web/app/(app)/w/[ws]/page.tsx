import { redirect } from "next/navigation";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { load, workspaceFor } from "@/components/app/load";
import { ButtonLink, EmptyState } from "@/components/ui";
import { listRounds } from "@/lib/api/core";
import { authBypass } from "@/lib/api/server";

export const dynamic = "force-dynamic";

/** /w/[ws] → the first open round (else the first round), or an empty state. */
export default async function WorkspaceIndex({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  if (authBypass()) redirect(`/w/${ws}/r/seed`);
  const { workspace, client } = await workspaceFor(ws);
  const res = await load(() => listRounds(client, "all"));
  if (!res.ok) return <ApiErrorState error={res.error} title="Your rounds could not load" retryHref={`/w/${ws}`} />;
  const rounds = res.data.data;
  const first = rounds.find((r) => r.status === "open") ?? rounds[0];
  if (first) redirect(`/w/${encodeURIComponent(workspace.slug)}/r/${encodeURIComponent(first.slug)}`);
  const canWrite = workspace.role !== "viewer";
  return (
    <EmptyState
      className="mt-32"
      title={`${workspace.name} has no rounds yet`}
      actions={
        canWrite ? (
          <ButtonLink variant="primary" href={`/w/${encodeURIComponent(workspace.slug)}/settings?new_round=1`}>
            New round
          </ButtonLink>
        ) : null
      }
    >
      A round holds a pipeline of investors with its own stages, target and close date.
    </EmptyState>
  );
}
