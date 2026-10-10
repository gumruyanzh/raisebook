// STUB by Foundation-web. Owner: App-UI (docs/OWNERSHIP.md) — replace freely.
import { redirect } from "next/navigation";

import { ButtonLink, EmptyState } from "@/components/ui";
import { listRounds, type Round } from "@/lib/api/core";
import { authBypass, serverApi } from "@/lib/api/server";

/** /w/[ws] → the first open round (else the first round), or an empty state. */
export default async function WorkspaceIndex({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  let rounds: Round[] = [];
  if (authBypass()) redirect(`/w/${ws}/r/seed`);
  try {
    rounds = (await listRounds(await serverApi(ws), "all")).data;
  } catch {
    rounds = [];
  }
  const first = rounds.find((r) => r.status === "open") ?? rounds[0];
  if (first) redirect(`/w/${ws}/r/${encodeURIComponent(first.slug)}`);
  return (
    <EmptyState
      title="No rounds yet"
      actions={<ButtonLink variant="primary" href={`/w/${ws}/settings?new_round=1`}>New round</ButtonLink>}
    >
      A round holds a pipeline of investors with its own stages and target.
    </EmptyState>
  );
}
