import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DataSettings } from "@/components/data/DataSettings";
import { listImports, type ImportRun } from "@/lib/api/data";
import { authBypass, getSession, serverApi } from "@/lib/api/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Data" };

async function optional<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

/** Settings → Data (SYSTEM §4.9): import history, exports, and the danger zone. */
export default async function DataPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const s = await getSession();
  if (s.status !== "ok") notFound();
  const workspace = s.session.workspaces.find(
    (w) => w.slug.toLowerCase() === decodeURIComponent(ws).toLowerCase(),
  );
  if (!workspace) notFound();
  if (authBypass()) {
    return <DataSettings runs={[]} investorCount={null} keyCount={null} />;
  }
  const c = await serverApi(workspace.slug);
  const [runs, investors, keys] = await Promise.all([
    optional(listImports(c).then((r) => r.data.slice(0, 5)), [] as ImportRun[]),
    optional(c.get<{ total: number }>("/v1/investors", { limit: 1 }).then((r) => r.total), null),
    workspace.role === "owner"
      ? optional(
          c
            .get<{ data: { revoked_at?: string | null }[] }>("/v1/api-keys")
            .then((r) => r.data.filter((k) => !k.revoked_at).length),
          null,
        )
      : Promise.resolve(null),
  ]);
  return <DataSettings runs={runs} investorCount={investors} keyCount={keys} />;
}
