import { AppShell, ButtonLink, EmptyState } from "@/components/ui";

import { WorkspaceTopBar } from "./_shell/WorkspaceTopBar";

/**
 * A 404 inside the signed-in app (a round, investor or workspace you can't see) keeps the app
 * shell and the theme, so it reads as "not here", not as leaving Raisebook.
 */
export default function AppNotFound() {
  return (
    <AppShell topBar={<WorkspaceTopBar />}>
      <EmptyState
        className="mx-auto mt-32 max-w-read"
        title="There is nothing at this address"
        actions={
          <>
            <ButtonLink href="/app" variant="primary">
              Go to your workspace
            </ButtonLink>
            <ButtonLink href="/" variant="ghost">
              Marketing site
            </ButtonLink>
          </>
        }
      >
        The link may be old, or the item was deleted, or it belongs to a workspace you are not a
        member of. <span className="font-mono text-micro text-muted">not_found</span>
      </EmptyState>
    </AppShell>
  );
}
