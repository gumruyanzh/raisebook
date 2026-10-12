/**
 * Sign-in providers (`GET /v1/auth/providers`) and "Continue with Google".
 *
 * Google sign-in is a full-page navigation to the API (`/v1/auth/google/start`), which
 * redirects to Google and back to `/v1/auth/google/callback`. The callback sets the session
 * cookies and lands on the app, or on `/signin?error=<code>` when it is refused.
 */

import { API_URL, type ApiClient } from "./client";

/** GET /v1/auth/providers: the sign-in methods this server offers. */
export interface AuthProviders {
  magic_link: boolean;
  google: boolean;
}

export const getAuthProviders = (c: ApiClient, signal?: AbortSignal) =>
  c.get<AuthProviders>("/v1/auth/providers", undefined, { workspace: null, signal });

/**
 * Whether to offer "Continue with Google". False when the API says it is off, and also when
 * the API cannot be asked within 3 seconds (the emailed link still works).
 */
export async function googleEnabled(c: ApiClient): Promise<boolean> {
  try {
    return (await getAuthProviders(c, AbortSignal.timeout(3000))).google === true;
  } catch {
    return false;
  }
}

/** Where "Continue with Google" points. `next` must be a same-app relative path. */
export function googleSignInUrl(next?: string): string {
  const q = next ? `?${new URLSearchParams({ next })}` : "";
  return `${API_URL}/v1/auth/google/start${q}`;
}

/**
 * Messages for the `?error=` codes the Google callback sends back to `/signin`
 * (SYSTEM §6: what went wrong, then what to do).
 */
export const SIGNIN_ERRORS: Record<string, string> = {
  google_not_configured:
    "Google sign-in is not set up on this server. Use the emailed sign-in link instead.",
  google_denied: "Google sign-in was cancelled. Try again, or use the emailed sign-in link.",
  google_failed: "Google did not finish the sign-in. Try again, or use the emailed sign-in link.",
  google_state_invalid:
    "That Google sign-in expired or was started in another browser. Start it again from this page.",
  google_token_invalid: "We could not verify Google's answer. Start the Google sign-in again.",
  google_exchange_failed: "Google did not accept the sign-in code. Start the Google sign-in again.",
  google_unavailable: "Google did not respond. Try again in a minute, or use the emailed sign-in link.",
  google_email_unverified:
    "Google has not verified the email address on that account, so it cannot be used to sign in. Use the emailed sign-in link instead.",
  google_email_missing:
    "Google did not share an email address for that account. Use the emailed sign-in link instead.",
  google_account_mismatch:
    "This Raisebook account is linked to a different Google account. Sign in with that Google account, or use the emailed sign-in link.",
  rate_limited:
    "Too many sign-ins to this account in the last 15 minutes. Wait a few minutes and try again.",
};

/** The message for a `/signin?error=` code, or null when there is nothing to show. */
export function signinErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  if (Object.hasOwn(SIGNIN_ERRORS, code)) return SIGNIN_ERRORS[code]!;
  return code.startsWith("google_")
    ? "Google sign-in did not complete. Try again, or use the emailed sign-in link."
    : null;
}
