import type { ReactNode } from "react";

import { EmptyState, PageHeader } from "@/components/ui";

/**
 * Placeholder for routes whose real page belongs to a Phase 3 builder (docs/OWNERSHIP.md).
 * Foundation-web created these so every SPEC route resolves and the shell can be reviewed.
 * Owners replace the page file; when no stub imports this any more, delete app/_stub/.
 */
export function Stub({
  title,
  subline,
  owner,
  children,
}: {
  title: string;
  subline?: ReactNode;
  owner: "App-UI" | "Landing+Docs" | "Import-Export+Ops";
  children?: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} subline={subline} />
      <EmptyState title="This page is not built yet">
        {children ?? <>It is part of the {owner} phase. The route, shell and data access are ready.</>}
      </EmptyState>
    </>
  );
}
