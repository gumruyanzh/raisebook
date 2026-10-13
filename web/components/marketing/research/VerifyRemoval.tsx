"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api/client";
import { verifyRemoval } from "@/lib/api/research";

/**
 * Confirms a removal request. Nothing is spent on load: the token is sent only when the
 * person presses Confirm, so mail scanners cannot confirm on their behalf.
 */
export function VerifyRemoval({ token }: { token: string | null }) {
  const [state, setState] = useState<{ kind: "ready" | "working" | "done" | "failed"; text?: string; code?: string }>(
    token ? { kind: "ready" } : { kind: "failed", text: "This confirmation link is incomplete. Open the full link from the email.", code: "invalid_token" },
  );
  if (state.kind === "done") {
    return (
      <div role="status" className="flex flex-col gap-8">
        <p className="t-display-xs">Request confirmed.</p>
        <p className="text-muted">{state.text}</p>
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div role="alert" className="flex flex-col gap-8">
        <p className="t-display-xs">That link did not work.</p>
        <p className="text-muted">
          {state.text} {state.code ? <span className="font-mono text-micro">{state.code}</span> : null}
        </p>
        <p>
          <Link href="/research-policy#ask-us-to-remove-you" className="link">
            Send a new request
          </Link>
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-12">
      <p className="text-muted">
        Confirm that you want Raisebook to delete the research it stores about you in every workspace, and to stop researching you.
      </p>
      <div>
        <Button
          variant="primary"
          autoFocus
          busy={state.kind === "working" ? "Confirming…" : false}
          onClick={async () => {
            if (!token) return;
            setState({ kind: "working" });
            try {
              const r = await verifyRemoval(api, token);
              setState({ kind: "done", text: r.message });
            } catch (e) {
              setState({
                kind: "failed",
                text: e instanceof ApiError && e.code === "invalid_token" ? "It was already used or has expired." : errorMessage(e),
                code: e instanceof ApiError ? e.code : undefined,
              });
            }
          }}
        >
          Confirm removal
        </Button>
      </div>
    </div>
  );
}
