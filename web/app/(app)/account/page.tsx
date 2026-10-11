import type { Metadata } from "next";

import { Account, type WorkspaceMembership } from "@/components/app/account/Account";
import { ApiErrorState } from "@/components/app/ApiErrorState";
import { load, optional } from "@/components/app/load";
import { AppShell } from "@/components/ui";
import { getMe } from "@/lib/api/core";
import { getSession, serverApi } from "@/lib/api/server";
import { listMembers } from "@/lib/api/settings";
import { todayIn } from "@/lib/format";

import { WorkspaceTopBar } from "../_shell/WorkspaceTopBar";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Account", robots: { index: false } };

/** Account (SYSTEM §4.13). */
export default async function AccountPage() {
  const s = await getSession();
  const workspaces = s.status === "ok" ? s.session.workspaces : [];
  const res = await load(async () => {
    const c = await serverApi();
    const me = await getMe(c);
    const memberships: WorkspaceMembership[] = await Promise.all(
      workspaces.map(async (w) => {
        const ms = await optional(listMembers(c.ws(w.slug)).then((r) => r.data), null);
        return {
          ...w,
          member_count: ms ? ms.length : null,
          owner_count: ms ? ms.filter((m) => m.role === "owner").length : null,
        };
      }),
    );
    return { me, workspaces: memberships };
  });
  return (
    <AppShell topBar={<WorkspaceTopBar />}>
      {res.ok ? (
        <Account {...res.data} today={todayIn()} />
      ) : (
        <ApiErrorState error={res.error} title="Your account could not load" retryHref="/account" />
      )}
    </AppShell>
  );
}
