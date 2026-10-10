"use client";

/**
 * Client-side session and workspace context.
 *
 * - `(app)/layout.tsx` loads the session on the server and wraps the app in
 *   `<SessionProvider session=…>`; `useSession()` returns `{user, workspaces, csrf_token}`.
 * - `(app)/w/[ws]/layout.tsx` adds `<WorkspaceProvider>`; `useWorkspace()` returns the
 *   current workspace, the caller's role, the rounds list and a scoped API client
 *   (`client` sends `X-Workspace: <slug>`).
 * - `rememberWorkspace` / `readLastWorkspace` keep `localStorage["rb-last-ws"]` (SYSTEM §4),
 *   wrapped in try/catch so a blocked storage never breaks a page.
 */

import { createContext, createElement, useContext, useEffect, useMemo, type ReactNode } from "react";

import { api, setCsrfToken, type ApiClient } from "./api/client";
import type { Role, Round, SessionInfo, Workspace } from "./api/types";

export const LAST_WORKSPACE_KEY = "rb-last-ws";

export function rememberWorkspace(slug: string): void {
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, slug);
  } catch {
    /* storage unavailable */
  }
}

export function readLastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

/* ---------- session ---------- */

const SessionContext = createContext<SessionInfo | null>(null);

export function SessionProvider({
  session,
  children,
}: {
  session: SessionInfo;
  children: ReactNode;
}) {
  // The browser client sends this on unsafe requests when the rb_csrf cookie is not readable
  // (for example when the API sets it on another host in production).
  setCsrfToken(session.csrf_token);
  return createElement(SessionContext.Provider, { value: session }, children);
}

/** The signed-in user and their workspaces. Throws outside the (app) route group. */
export function useSession(): SessionInfo {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession() is only available inside the signed-in app.");
  return s;
}

/** Like useSession, but null outside the signed-in app (marketing, auth pages). */
export function useOptionalSession(): SessionInfo | null {
  return useContext(SessionContext);
}

/* ---------- workspace ---------- */

export interface WorkspaceContextValue {
  workspace: Workspace;
  role: Role;
  canWrite: boolean;
  isOwner: boolean;
  /** All rounds, open first (from `GET /v1/rounds?status=all`). Empty if the load failed. */
  rounds: Round[];
  /** API client scoped to this workspace. */
  client: ApiClient;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  workspace,
  rounds,
  children,
}: {
  workspace: Workspace;
  rounds: Round[];
  children: ReactNode;
}) {
  const value = useMemo<WorkspaceContextValue>(() => {
    const role: Role = workspace.role ?? "viewer";
    return {
      workspace,
      role,
      canWrite: role !== "viewer",
      isOwner: role === "owner",
      rounds,
      client: api.ws(workspace.slug),
    };
  }, [workspace, rounds]);

  useEffect(() => {
    rememberWorkspace(workspace.slug);
  }, [workspace.slug]);

  return createElement(WorkspaceContext.Provider, { value }, children);
}

/** The current workspace. Throws outside `/w/[ws]/…`. */
export function useWorkspace(): WorkspaceContextValue {
  const w = useContext(WorkspaceContext);
  if (!w) throw new Error("useWorkspace() is only available under /w/[ws].");
  return w;
}

export function useOptionalWorkspace(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}
