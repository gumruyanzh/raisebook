import type { Metadata } from "next";

import { ButtonLink, EmptyState, Wordmark } from "@/components/ui";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

export default function NotFound() {
  return (
    <main id="main" className="gutter mx-auto w-full max-w-read py-48">
      <Wordmark size={22} href="/" />
      <EmptyState
        className="mt-32"
        title="There is no page at this address"
        actions={
          <>
            <ButtonLink href="/" variant="primary">
              Home
            </ButtonLink>
            <ButtonLink href="/docs" variant="ghost">
              Docs
            </ButtonLink>
            <ButtonLink href="/app" variant="ghost">
              Your workspace
            </ButtonLink>
          </>
        }
      >
        The link may be old, or the item may have been deleted or belong to another workspace.
      </EmptyState>
    </main>
  );
}
