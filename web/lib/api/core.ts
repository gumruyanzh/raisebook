/**
 * Calls for auth, the session, the account, workspaces, invites (lookup/accept) and the round
 * list the TopBar needs. Every function takes an `ApiClient` first: `api` / `api.ws(slug)` in
 * the browser, `await serverApi(slug)` on the server. Shapes: `./types` (SPEC §5.3, §5.4).
 */

import { seg, type ApiClient } from "./client";
import type {
  DataList,
  InviteLookup,
  MagicLinkRequest,
  MagicLinkResult,
  Me,
  Round,
  RoundStatus,
  SessionInfo,
  VerifyResult,
  Workspace,
  WorkspaceCreate,
  WorkspaceDetail,
  WorkspaceUpdate,
} from "./types";

export * from "./types";

/* ---------- auth (SPEC §4.1, §4.2) ---------- */

/** Always 202 `{sent: true}`; `dev_link` only when the API runs on localhost. */
export const requestMagicLink = (c: ApiClient, body: MagicLinkRequest) =>
  c.post<MagicLinkResult>("/v1/auth/magic-link", body, { workspace: null });

/** Consumes the single-use token and sets the session cookies. 400 `invalid_token`. */
export const verifyMagicLink = (c: ApiClient, token: string) =>
  c.post<VerifyResult>("/v1/auth/verify", { token }, { workspace: null });

export const getSessionInfo = (c: ApiClient) =>
  c.get<SessionInfo>("/v1/auth/session", undefined, { workspace: null });

export const signOut = (c: ApiClient) =>
  c.post<void>("/v1/auth/signout", undefined, { workspace: null });

/* ---------- account ---------- */

export const getMe = (c: ApiClient) => c.get<Me>("/v1/me", undefined, { workspace: null });

export const updateMe = (c: ApiClient, body: { name?: string | null }) =>
  c.patch<Me>("/v1/me", body, { workspace: null });

/** 409 `transfer_ownership_first` lists the workspaces that block the delete. */
export const deleteMe = (c: ApiClient, confirmEmail: string) =>
  c.del<void>("/v1/me", { confirm_email: confirmEmail }, { workspace: null });

/* ---------- workspaces ---------- */

export const listWorkspaces = (c: ApiClient) =>
  c.get<DataList<Workspace>>("/v1/workspaces", undefined, { workspace: null });

/** `sample: true` creates the fictional sandbox workspace (SPEC §8.5). */
export const createWorkspace = (c: ApiClient, body: WorkspaceCreate) =>
  c.post<Workspace>("/v1/workspaces", body, { workspace: null });

/** Needs a workspace-scoped client. */
export const getWorkspace = (c: ApiClient) => c.get<WorkspaceDetail>("/v1/workspace");

export const updateWorkspace = (c: ApiClient, body: WorkspaceUpdate) =>
  c.patch<Workspace>("/v1/workspace", body);

/** Owner session only; `confirm` must equal the slug (422 `confirmation_required`). */
export const deleteWorkspace = (c: ApiClient, confirmSlug: string) =>
  c.del<void>("/v1/workspace", { confirm: confirmSlug });

/* ---------- invites (the org-less pair used by /invite/[token]) ---------- */

export const lookupInvite = (c: ApiClient, token: string) =>
  c.get<InviteLookup>("/v1/invites/lookup", { token }, { workspace: null });

/** 409 `invite_mismatch` when the session email differs from the invite. */
export const acceptInvite = (c: ApiClient, token: string) =>
  c.post<Workspace>("/v1/invites/accept", { token }, { workspace: null });

/* ---------- rounds (list only; the rest is lib/api/rounds.ts) ---------- */

/** Open rounds first, then by created_at. Needs a workspace-scoped client. */
export const listRounds = (c: ApiClient, status: RoundStatus | "all" = "all") =>
  c.get<DataList<Round>>("/v1/rounds", { status });

/** Path helper for round-scoped endpoints: `/v1/rounds/{round}` (id or slug). */
export const roundPath = (round: string, rest = "") => `/v1/rounds/${seg(round)}${rest}`;
