import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ButtonLink, EmptyState, Wordmark } from "@/components/ui";
import { API_URL } from "@/lib/api/client";
import { getSession } from "@/lib/api/server";
import { SessionProvider } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Signed-in frame. Loads the session once per request: 401 (or no cookie) → /signin?next=…;
 * an unreachable API renders a plain explanation instead of signing the user out. Pages read
 * the session with `useSession()` (client) or `getSession()` (server).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const result = await getSession();

  if (result.status === "signed_out") {
    const path = (await headers()).get("x-rb-path");
    redirect(path && path.startsWith("/") && !path.startsWith("//") ? `/signin?next=${encodeURIComponent(path)}` : "/signin");
  }

  if (result.status === "error") {
    return (
      <main id="main" className="gutter mx-auto w-full max-w-read py-48">
        <Wordmark size={22} href="/" />
        <EmptyState
          className="mt-32"
          title="Raisebook can't reach its API right now"
          actions={<ButtonLink href="/app">Try again</ButtonLink>}
        >
          {result.error.message}{" "}
          <span className="font-mono text-micro">{result.error.code}</span>
          {process.env.NODE_ENV !== "production" ? (
            <>
              {" "}
              In development, start it with <code className="text-sm">uv run uvicorn --factory raisebook.main:create_app</code> (expected at{" "}
              <code className="text-sm">{API_URL}</code>).
            </>
          ) : null}
        </EmptyState>
      </main>
    );
  }

  return <SessionProvider session={result.session}>{children}</SessionProvider>;
}
