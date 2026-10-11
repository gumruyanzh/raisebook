import type { Metadata } from "next";
import { Suspense } from "react";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { load, optional, workspaceFor } from "@/components/app/load";
import { GeneralSettings } from "@/components/app/settings/GeneralSettings";
import { listRounds, getWorkspace } from "@/lib/api/core";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

/** Settings → General (SYSTEM §4.9). `?new_round=1` opens the new-round dialog (TopBar "+ Round"). */
export default async function GeneralSettingsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { client } = await workspaceFor(ws);
  const res = await load(async () => {
    const [detail, rounds] = await Promise.all([getWorkspace(client), optional(listRounds(client, "all").then((r) => r.data), [])]);
    return { detail, rounds };
  });
  if (!res.ok) return <ApiErrorState error={res.error} title="Settings could not load" retryHref={`/w/${ws}/settings`} />;
  return (
    <Suspense>
      <GeneralSettings {...res.data} />
    </Suspense>
  );
}
