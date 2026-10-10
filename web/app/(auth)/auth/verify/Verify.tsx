"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui";
import { ApiError, api, errorMessage, setCsrfToken } from "@/lib/api/client";
import { verifyMagicLink } from "@/lib/api/core";

type State =
  | { kind: "working" }
  | { kind: "idle" }
  | { kind: "done" }
  | { kind: "failed"; message: string; code?: string; retry: boolean };

function safePath(p: string | null | undefined): string | null {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\")) return null;
  return p;
}

/**
 * Posts the token to /v1/auth/verify once on load (a POST, so link scanners that prefetch GET
 * URLs cannot burn it), with "Continue" as the fallback (SPEC §4.1, SYSTEM §4.12).
 */
export function Verify({ token }: { token: string | null }) {
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<State>(
    token
      ? { kind: "working" }
      : {
          kind: "failed",
          message: "This sign-in link is incomplete. Open the full link from the email, or request a new one.",
          code: "invalid_token",
          retry: false,
        },
  );

  const run = useCallback(async () => {
    if (!token) return;
    setState({ kind: "working" });
    try {
      const res = await verifyMagicLink(api, token);
      setCsrfToken(res.csrf_token);
      setState({ kind: "done" });
      const target = safePath(res.redirect_path) ?? (res.workspaces.length ? "/app" : "/onboarding");
      router.replace(target);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setState({
          kind: "failed",
          message: "That link was already used or expired. Request a new one.",
          code: err.code,
          retry: false,
        });
      } else if (err instanceof ApiError && err.status === 429) {
        setState({ kind: "failed", message: err.message, code: err.code, retry: true });
      } else {
        setState({
          kind: "failed",
          message: errorMessage(err),
          code: err instanceof ApiError ? err.code : undefined,
          retry: true,
        });
      }
    }
  }, [token, router]);

  useEffect(() => {
    // Strict Mode mounts twice in dev; the token is single-use, so post it exactly once.
    if (started.current || !token) return;
    started.current = true;
    void run();
  }, [run, token]);

  if (state.kind === "failed") {
    return (
      <div className="flex flex-col gap-14">
        <h1 className="t-display-s">We couldn&apos;t sign you in</h1>
        <p role="alert">
          {state.message}
          {state.code ? <span className="ml-6 font-mono text-micro text-muted">{state.code}</span> : null}
        </p>
        <div className="flex flex-wrap items-center gap-10">
          {state.retry ? (
            <Button variant="primary" onClick={() => void run()}>
              Continue
            </Button>
          ) : null}
          <Link href="/signin" className={state.retry ? "link" : "link font-medium"}>
            Request a new link
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-14">
      <h1 className="t-display-s">{state.kind === "done" ? "Signed in" : "Signing you in…"}</h1>
      <p className="text-muted" role="status">
        {state.kind === "done"
          ? "Opening your workspace."
          : "This takes a moment. If nothing happens, press Continue."}
      </p>
      <Button
        className="self-start"
        onClick={() => void run()}
        busy={state.kind === "working" ? "Signing in…" : false}
        disabled={state.kind === "done"}
      >
        Continue
      </Button>
    </div>
  );
}
