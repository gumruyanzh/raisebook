import type { Metadata } from "next";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { load, optional, workspaceFor } from "@/components/app/load";
import { MembersSettings } from "@/components/app/settings/MembersSettings";
import { listInvites, listMembers } from "@/lib/api/settings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Members" };

/** Settings → Members (SYSTEM §4.9). Invites are listed for owners (admin scope). */
export default async function MembersPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { workspace, client, today } = await workspaceFor(ws);
  const res = await load(async () => {
    const [members, invites] = await Promise.all([
      listMembers(client).then((r) => r.data),
      workspace.role === "owner" ? optional(listInvites(client).then((r) => r.data), []) : Promise.resolve(null),
    ]);
    return { members, invites };
  });
  if (!res.ok) return <ApiErrorState error={res.error} title="Members could not load" retryHref={`/w/${ws}/settings/members`} />;
  return <MembersSettings {...res.data} today={today} />;
}
