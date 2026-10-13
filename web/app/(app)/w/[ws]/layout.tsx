import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/ui";
import { listRounds, type Round } from "@/lib/api/core";
import { authBypass, getSession, serverApi } from "@/lib/api/server";
import { WorkspaceProvider } from "@/lib/session";

import { WorkspaceTopBar } from "../../_shell/WorkspaceTopBar";

export const dynamic = "force-dynamic";

type Params = { ws: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { ws } = await params;
  const s = await getSession();
  const w = s.status === "ok" ? s.session.workspaces.find((x) => x.slug === ws) : undefined;
  return { title: { default: w?.name ?? "Workspace", template: `%s · ${w?.name ?? "Raisebook"}` }, robots: { index: false } };
}

/** Fictional rounds for RAISEBOOK_WEB_AUTH_BYPASS=1 (dev only, no API). */
const BYPASS_ROUNDS: Round[] = [
  {
    id: "00000000-0000-4000-8000-0000000000r1",
    slug: "seed",
    name: "Seed",
    status: "open",
    instrument: "safe",
    currency: "USD",
    target_amount: 2_000_000,
    valuation_cap: 16_000_000,
    target_close_on: "2026-12-05",
    stages: [],
    committed_amount: 750_000,
    participant_count: 40,
    created_at: "2026-10-01T12:00:00Z",
    updated_at: "2026-10-09T12:00:00Z",
  },
];

/**
 * Workspace frame: resolves the slug against the session's workspaces (anything else is a 404,
 * never a hint that it exists), loads the round list for the TopBar, and provides
 * `useWorkspace()` (workspace, role, rounds, a client that sends `X-Workspace`).
 */
export default async function WorkspaceLayout({
  params,
  children,
}: {
  params: Promise<Params>;
  children: React.ReactNode;
}) {
  const { ws } = await params;
  const s = await getSession();
  if (s.status !== "ok") notFound();
  const workspace = s.session.workspaces.find((w) => w.slug.toLowerCase() === decodeURIComponent(ws).toLowerCase());
  if (!workspace) notFound();

  let rounds: Round[] = [];
  if (authBypass()) {
    rounds = BYPASS_ROUNDS;
  } else {
    try {
      rounds = (await listRounds(await serverApi(workspace.slug), "all")).data;
    } catch {
      // The TopBar still renders; pages show their own errors.
      rounds = [];
    }
  }

  return (
    <WorkspaceProvider workspace={workspace} rounds={rounds}>
      <AppShell topBar={<WorkspaceTopBar />}>
        {children}
      </AppShell>
    </WorkspaceProvider>
  );
}
