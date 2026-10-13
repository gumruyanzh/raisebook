import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { optional } from "@/components/app/load";
import { AppShell } from "@/components/ui";
import { listRounds } from "@/lib/api/core";
import { listFollowUps, type FollowUpList } from "@/lib/api/rounds";
import { getSession, serverApi } from "@/lib/api/server";
import type { Round } from "@/lib/api/types";
import { todayIn } from "@/lib/format";

import { HomeToday, type HomeCompany } from "../_shell/HomeToday";
import { WorkspaceTopBar } from "../_shell/WorkspaceTopBar";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Today", robots: { index: false } };

const EMPTY: FollowUpList = { today: "", data: [], counts: { overdue: 0, today: 0, upcoming: 0 } };

/**
 * /app (UX-PASS-1 P2-2). One workspace: straight into it. Several: one page for every
 * company, with what is due in each and a single Today list across them, plus a way back
 * to the workspace used last.
 */
export default async function AppHome() {
  const s = await getSession();
  if (s.status !== "ok") redirect("/signin?next=%2Fapp");
  const workspaces = s.session.workspaces;
  if (workspaces.length === 0) redirect("/onboarding");
  if (workspaces.length === 1) redirect(`/w/${encodeURIComponent(workspaces[0]!.slug)}`);

  const c = await serverApi();
  const companies: HomeCompany[] = await Promise.all(
    workspaces.map(async (w) => {
      const wc = c.ws(w.slug);
      const [due, rounds] = await Promise.all([
        optional(listFollowUps(wc, { within_days: 0, include_overdue: true, limit: 200 }), EMPTY),
        optional(listRounds(wc, "open").then((r) => r.data), [] as Round[]),
      ]);
      return {
        workspace: w,
        today: todayIn(w.timezone),
        due: due.data,
        counts: due.counts,
        rounds: rounds.map((r) => ({ slug: r.slug, name: r.name, participant_count: r.participant_count })),
      };
    }),
  );

  return (
    <AppShell topBar={<WorkspaceTopBar />}>
      <HomeToday companies={companies} />
    </AppShell>
  );
}
