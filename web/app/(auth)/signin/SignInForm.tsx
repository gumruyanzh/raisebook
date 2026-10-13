"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button, Field, Input } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api/client";
import { requestMagicLink, type MagicLinkRequest } from "@/lib/api/core";

/** sessionStorage key for the last request (check page: resend, and the dev link). */
export const PENDING_KEY = "rb-signin";

export interface PendingSignIn {
  request: MagicLinkRequest;
  devLink?: string | null;
}

export function savePending(p: PendingSignIn): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: the check page just has no resend or dev link */
  }
}

export function readPending(): PendingSignIn | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingSignIn) : null;
  } catch {
    return null;
  }
}

/**
 * The address this device asked a link for, so the verify page can show it in full here
 * (other devices only see the masked hint). localStorage, because the emailed link opens in a
 * new tab; it expires with the link (15 minutes) and is cleared on sign-in.
 */
const REQUESTED_KEY = "rb-signin-requested";
const REQUESTED_TTL_MS = 15 * 60 * 1000;

export function rememberRequestedEmail(email: string): void {
  try {
    localStorage.setItem(REQUESTED_KEY, JSON.stringify({ email, at: Date.now() }));
  } catch {
    /* storage unavailable: the verify page shows the masked hint */
  }
}

/** The email this device requested, if it matches `hint` (`j***@example.com`) and is fresh. */
export function requestedEmailFor(hint: string | null): string | null {
  if (!hint) return null;
  try {
    const raw = localStorage.getItem(REQUESTED_KEY);
    if (!raw) return null;
    const { email, at } = JSON.parse(raw) as { email?: string; at?: number };
    if (!email || !at || Date.now() - at > REQUESTED_TTL_MS) return null;
    const [hl, hd] = hint.toLowerCase().split("@");
    const [el, ed] = email.toLowerCase().split("@");
    if (!hl || !el || hd !== ed) return null;
    const visible = hl.replace(/\*+$/, "");
    return el.startsWith(visible) ? email : null;
  } catch {
    return null;
  }
}

export function forgetRequestedEmail(): void {
  try {
    localStorage.removeItem(REQUESTED_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Email field + "Email me a sign-in link" (SYSTEM §4.12). */
export function SignInForm({
  next,
  inviteToken,
  emailHint,
  submitLabel = "Email me a sign-in link",
}: {
  next?: string;
  inviteToken?: string;
  emailHint?: string;
  submitLabel?: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(value)) {
      setError({ message: "Enter the email address you want to sign in with." });
      return;
    }
    setBusy(true);
    setError(null);
    const request: MagicLinkRequest = { email: value };
    if (next) request.redirect_path = next;
    if (inviteToken) request.invite_token = inviteToken;
    try {
      const res = await requestMagicLink(api, request);
      savePending({ request, devLink: res.dev_link ?? null });
      rememberRequestedEmail(value);
      // The address travels in sessionStorage (savePending), never in the URL or history.
      router.push("/signin/check");
    } catch (err) {
      setError({
        message: errorMessage(err),
        code: err instanceof ApiError ? err.code : undefined,
      });
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-14">
      <Field label="Email" error={error}>
        <Input
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoFocus
          required
          placeholder={emailHint ?? "you@company.com"}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" size="lg" busy={busy ? "Sending…" : false}>
        {submitLabel}
      </Button>
      <p className="t-body-s text-muted">No password. The link works once and expires in 15 minutes.</p>
      <p className="t-body-s text-muted">
        By continuing you agree to the{" "}
        <Link href="/terms" className="link">
          Terms
        </Link>{" "}
        and the{" "}
        <Link href="/privacy" className="link">
          Privacy policy
        </Link>
        .
      </p>
    </form>
  );
}
