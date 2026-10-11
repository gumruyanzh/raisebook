import type { Metadata } from "next";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { load, workspaceFor } from "@/components/app/load";
import { ApiKeysSettings } from "@/components/app/settings/ApiKeysSettings";
import { listApiKeys } from "@/lib/api/settings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "API keys" };

/** Settings → API keys (SYSTEM §4.9). Listing needs admin (owners); others see an explanation. */
export default async function ApiKeysPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { workspace, client, today } = await workspaceFor(ws);
  if (workspace.role !== "owner") return <ApiKeysSettings keys={null} today={today} />;
  const res = await load(() => listApiKeys(client).then((r) => r.data));
  if (!res.ok) return <ApiErrorState error={res.error} title="API keys could not load" retryHref={`/w/${ws}/settings/api-keys`} />;
  return <ApiKeysSettings keys={res.data} today={today} />;
}
