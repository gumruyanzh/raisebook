"use client";

import { useEffect } from "react";

import { Button, ButtonLink, EmptyState, Wordmark } from "@/components/ui";

/**
 * Any unhandled error while rendering a page (a server component threw, the API answered
 * something unexpected). Shown inside the root layout, so the theme and fonts still apply.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main id="main" className="gutter mx-auto w-full max-w-read py-48">
      <Wordmark size={22} href="/" />
      <EmptyState
        className="mt-32"
        title="Something went wrong on our side"
        actions={
          <>
            <Button variant="primary" onClick={reset}>
              Try again
            </Button>
            <ButtonLink href="/" variant="ghost">
              Home
            </ButtonLink>
            <ButtonLink href="/docs" variant="ghost">
              Docs
            </ButtonLink>
          </>
        }
      >
        The page could not be shown. Your data is safe. Try again in a moment, and if it keeps
        happening, open an issue with this reference.
        {error.digest ? (
          <span className="mt-8 block font-mono text-micro text-muted">ref {error.digest}</span>
        ) : null}
      </EmptyState>
    </main>
  );
}
