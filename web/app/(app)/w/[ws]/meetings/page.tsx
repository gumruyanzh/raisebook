import type { Metadata } from "next";

import { ApiErrorState } from "@/components/app/ApiErrorState";
import { load, workspaceFor } from "@/components/app/load";
import { MeetingsView } from "@/components/app/meetings/MeetingsView";
import { loadMeetings } from "@/lib/api/meetings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Meetings" };

/** The workspace's meetings (docs/SPEC.md §5.9): needing an outcome, today, this week, later, past. */
export default async function MeetingsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { client } = await workspaceFor(ws);
  const res = await load(() => loadMeetings(client));
  if (!res.ok) return <ApiErrorState error={res.error} title="Your meetings could not load" retryHref={`/w/${ws}/meetings`} />;
  return <MeetingsView initial={res.data} />;
}
