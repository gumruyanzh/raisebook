// STUB by Foundation-web. Owner: App-UI (docs/OWNERSHIP.md) — replace freely.
import type { Metadata } from "next";

import { AppShell } from "@/components/ui";

import { Stub } from "@/app/_stub/Stub";

import { WorkspaceTopBar } from "../_shell/WorkspaceTopBar";

export const metadata: Metadata = { title: "Account", robots: { index: false } };

export default function AccountPage() {
  return (
    <AppShell topBar={<WorkspaceTopBar />}>
      <Stub title="Account" subline="Name, email, workspaces, sign out and account deletion." owner="App-UI" />
    </AppShell>
  );
}
