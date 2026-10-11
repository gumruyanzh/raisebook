import type { Metadata } from "next";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { load, roundOr404, workspaceFor } from "@/components/app/load";
import { RoundHeader } from "@/components/app/RoundHeader";
import { RoundSettings } from "@/components/app/RoundSettings";

export const dynamic = "force-dynamic";

type Params = { ws: string; round: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { round } = await params;
  return { title: `Round settings · ${decodeURIComponent(round)}` };
}

/** Round settings (SYSTEM §4.6). */
export default async function RoundSettingsPage({ params }: { params: Promise<Params> }) {
  const { ws, round: ref } = await params;
  const { workspace, client } = await workspaceFor(ws);
  const res = await load(() => roundOr404(client, ref));
  if (!res.ok) return <ApiErrorState error={res.error} title="Round settings could not load" retryHref={`/w/${ws}/r/${ref}/settings`} />;
  return (
    <>
      <RoundHeader wsSlug={workspace.slug} round={res.data} active="settings" />
      <RoundSettings round={res.data} />
    </>
  );
}
