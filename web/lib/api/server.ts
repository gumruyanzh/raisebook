import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { ApiError, createApiClient, CSRF_COOKIE, SESSION_COOKIE, type ApiClient } from "./client";
import type { SessionInfo } from "./types";

/**
 * API client for Server Components, Route Handlers and Server Actions. Forwards the session
 * and CSRF cookies to the API and never caches (all app data is per-user and live).
 * Pass a workspace slug to scope the client (`X-Workspace`).
 */
export async function serverApi(workspace?: string): Promise<ApiClient> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const csrf = jar.get(CSRF_COOKIE)?.value;
  const cookie = [
    session ? `${SESSION_COOKIE}=${session}` : null,
    csrf ? `${CSRF_COOKIE}=${csrf}` : null,
  ]
    .filter(Boolean)
    .join("; ");
  return createApiClient({
    baseUrl: process.env.API_URL_INTERNAL ?? process.env.NEXT_PUBLIC_API_URL,
    headers: cookie ? { Cookie: cookie } : {},
    csrfToken: csrf,
    workspace,
    defaults: { cache: "no-store" },
  });
}

/** True when the browser sent a session cookie (it may still be expired). */
export async function hasSessionCookie(): Promise<boolean> {
  return Boolean((await cookies()).get(SESSION_COOKIE)?.value);
}

/**
 * Dev-only escape hatch: `RAISEBOOK_WEB_AUTH_BYPASS=1` renders signed-in routes without an
 * API, using fictional placeholder data. Never honored in production.
 */
export function authBypass(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.RAISEBOOK_WEB_AUTH_BYPASS === "1";
}

export const BYPASS_SESSION: SessionInfo = {
  user: { id: "00000000-0000-4000-8000-000000000001", email: "founder@example.com", name: "Sam Rivera" },
  csrf_token: "dev-bypass",
  workspaces: [
    {
      id: "00000000-0000-4000-8000-0000000000aa",
      slug: "kestrel-robotics-sample",
      name: "Kestrel Robotics (sample)",
      is_sandbox: true,
      default_currency: "USD",
      timezone: "America/Los_Angeles",
      role: "owner",
      created_at: "2026-10-01T12:00:00Z",
    },
  ],
};

export type SessionResult =
  | { status: "ok"; session: SessionInfo }
  | { status: "signed_out" }
  | { status: "error"; error: ApiError };

/**
 * The current session, fetched once per request (React `cache`). `signed_out` means there is
 * no cookie or the API answered 401; `error` means the API could not be asked (show it, do
 * not sign the user out).
 */
export const getSession = cache(async (): Promise<SessionResult> => {
  if (authBypass()) return { status: "ok", session: BYPASS_SESSION };
  if (!(await hasSessionCookie())) return { status: "signed_out" };
  try {
    const c = await serverApi();
    const session = await c.get<SessionInfo>("/v1/auth/session");
    return { status: "ok", session };
  } catch (err) {
    if (err instanceof ApiError && err.isUnauthorized) return { status: "signed_out" };
    if (err instanceof ApiError) return { status: "error", error: err };
    return {
      status: "error",
      error: new ApiError(0, "network_unreachable", "Could not reach the Raisebook API."),
    };
  }
});
