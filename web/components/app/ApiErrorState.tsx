import type { ReactNode } from "react";

import { ButtonLink, EmptyState } from "@/components/ui";
import { ApiError } from "@/lib/api/client";

/**
 * A page-level load failure (SYSTEM §6: say what went wrong and what to do, with the code in
 * mono). Used by server pages when the API answers with an error other than 404.
 */
export function ApiErrorState({
  error,
  title = "This page could not load",
  retryHref,
  children,
}: {
  error: unknown;
  title?: string;
  retryHref?: string;
  children?: ReactNode;
}) {
  const e =
    error instanceof ApiError
      ? error
      : new ApiError(0, "unexpected", "The page failed before the API answered. Reload to try again.");
  return (
    <EmptyState
      title={title}
      actions={retryHref ? <ButtonLink href={retryHref}>Try again</ButtonLink> : null}
    >
      {children ?? e.message} <span className="font-mono text-micro">{e.code}</span>
      {e.requestId && !e.message.includes(e.requestId) ? <span className="font-mono text-micro"> · {e.requestId}</span> : null}
    </EmptyState>
  );
}
