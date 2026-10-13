"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { Button } from "@/components/ui";
import { ApiError, api, errorMessage, setCsrfToken } from "@/lib/api/client";
import { peekMagicLink, verifyMagicLink } from "@/lib/api/core";

import { forgetRequestedEmail, requestedEmailFor } from "../../signin/SignInForm";

type State =
  | { kind: "checking" }
  | { kind: "ready"; emailHint: string | null }
  | { kind: "working"; emailHint: string | null }
  | { kind: "conflict"; signedInAs: string; linkFor: string }
  | { kind: "done" }
  | { kind: "failed"; message: string; code?: string; retry: boolean };

function safePath(p: string | null | undefined): string | null {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\")) return null;
  return p;
}

const INCOMPLETE: State = {
  kind: "failed",
  message: "This sign-in link is incomplete. Open the full link from the email, or request a new one.",
  code: "invalid_token",
  retry: false,
};
const USED: State = {
  kind: "failed",
  message: "That link was already used or expired. Request a new one.",
  code: "invalid_token",
  retry: false,
};

/**
 * The emailed link lands here. Nothing is spent on load: the page shows who the link signs in
 * (a non-consuming peek) and POSTs the token only when the person presses Continue, so mail
 * scanners that run JavaScript cannot burn it, and a forwarded link cannot silently swap a
 * signed-in person into someone else's account (SPEC §4.1, SYSTEM §4.12).
 */
export function Verify({ token }: { token: string | null }) {
  const router = useRouter();
  const [state, setState] = useState<State>(token ? { kind: "checking" } : INCOMPLETE);
  const continueRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    peekMagicLink(api, token)
      .then((p) => {
        if (!live) return;
        // On the device that asked for the link, show the whole address instead of the hint.
        const hint = p.email_hint ?? null;
        setState(p.valid ? { kind: "ready", emailHint: requestedEmailFor(hint) ?? hint } : USED);
      })
      .catch(() => {
        // The peek is only a courtesy: fall back to a plain Continue.
        if (live) setState({ kind: "ready", emailHint: null });
      });
    return () => {
      live = false;
    };
  }, [token]);

  const run = useCallback(
    async (switchAccount = false) => {
      if (!token) return;
      setState((s) => ({ kind: "working", emailHint: "emailHint" in s ? s.emailHint : null }));
      try {
        const res = await verifyMagicLink(api, token, switchAccount);
        setCsrfToken(res.csrf_token);
        forgetRequestedEmail();
        setState({ kind: "done" });
        const target =
          safePath(res.redirect_path) ?? (res.workspaces.length ? "/app" : "/onboarding");
        router.replace(target);
        router.refresh();
      } catch (err) {
        if (err instanceof ApiError && err.code === "session_conflict") {
          const d = (err.details ?? {}) as { signed_in_as?: string; link_for?: string };
          setState({
            kind: "conflict",
            signedInAs: d.signed_in_as ?? "another account",
            linkFor: d.link_for ?? "another account",
          });
        } else if (err instanceof ApiError && err.status === 400) {
          setState(USED);
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
    },
    [token, router],
  );

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
              Try again
            </Button>
          ) : null}
          <Link href="/signin" className={state.retry ? "link" : "link font-medium"}>
            Request a new link
          </Link>
        </div>
      </div>
    );
  }

  if (state.kind === "conflict") {
    return (
      <div className="flex flex-col gap-14">
        <h1 className="t-display-s">Switch accounts?</h1>
        <p>
          This browser is signed in as <span className="font-mono">{state.signedInAs}</span>. The
          link signs in <span className="font-mono">{state.linkFor}</span>.
        </p>
        <p className="text-muted">
          Only continue if you asked for this link yourself. Someone else&apos;s link would put you
          in their account.
        </p>
        <div className="flex flex-wrap items-center gap-10">
          <Button variant="primary" onClick={() => void run(true)}>
            Sign out and continue as {state.linkFor}
          </Button>
          <Link href="/app" className="link">
            Stay signed in as {state.signedInAs}
          </Link>
        </div>
      </div>
    );
  }

  const hint = state.kind === "ready" || state.kind === "working" ? state.emailHint : null;
  return (
    <VerifyReady
      state={state}
      hint={hint}
      continueRef={continueRef}
      onContinue={() => void run()}
    />
  );
}

/** "Continue as …": Continue takes focus as soon as the link checks out, so Enter signs in. */
function VerifyReady({
  state,
  hint,
  continueRef,
  onContinue,
}: {
  state: State;
  hint: string | null;
  continueRef: RefObject<HTMLButtonElement | null>;
  onContinue: () => void;
}) {
  useEffect(() => {
    if (state.kind === "ready") continueRef.current?.focus();
  }, [state.kind, continueRef]);
  return (
    <div className="flex flex-col gap-14">
      <h1 className="t-display-s">
        {state.kind === "done" ? "Signed in" : "Sign in to Raisebook"}
      </h1>
      <p className="text-muted" role="status">
        {state.kind === "done" ? (
          "Opening your workspace."
        ) : state.kind === "checking" ? (
          "Checking the link…"
        ) : hint ? (
          <>
            Continue as <span className="font-mono text-fg">{hint}</span>.
          </>
        ) : (
          "Press Continue to finish signing in."
        )}
      </p>
      {state.kind === "ready" || state.kind === "working" || state.kind === "checking" ? (
        <p className="t-body-s text-muted">
          One click keeps the link safe: email scanners open links too, and they can&apos;t press a button.
        </p>
      ) : null}
      <Button
        ref={continueRef}
        variant="primary"
        className="self-start"
        onClick={onContinue}
        busy={state.kind === "working" ? "Signing in…" : false}
        disabled={state.kind === "done" || state.kind === "checking"}
      >
        Continue
      </Button>
    </div>
  );
}
