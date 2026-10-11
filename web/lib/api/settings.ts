/**
 * Workspace settings: members, invites and API keys (SPEC §5.4). Workspace detail and update
 * live in `./core` (`getWorkspace`, `updateWorkspace`, `deleteWorkspace`). Every function takes
 * a workspace-scoped client first.
 */

import { seg, type ApiClient } from "./client";
import type { ApiKey, DataList, Invite, Member, Role, Scope, Timestamp, UUID } from "./types";

/* ---------- members ---------- */

export const listMembers = (c: ApiClient) => c.get<DataList<Member>>("/v1/members");

/** Owner session. 409 `last_owner`. */
export const changeMemberRole = (c: ApiClient, userId: UUID, role: Role) =>
  c.patch<Member>(`/v1/members/${seg(userId)}`, { role });

/** Owner session, or your own user id to leave. 409 `last_owner`. */
export const removeMember = (c: ApiClient, userId: UUID) =>
  c.del<void>(`/v1/members/${seg(userId)}`);

/* ---------- invites ---------- */

export const listInvites = (c: ApiClient) => c.get<DataList<Invite>>("/v1/invites");

export type InviteCreated = Invite & { dev_link?: string | null };

/** Owner session. 409 `already_member`. A pending invite for the same email is replaced. */
export const createInvite = (c: ApiClient, email: string, role: Role) =>
  c.post<InviteCreated>("/v1/invites", { email, role });

export const revokeInvite = (c: ApiClient, id: UUID) => c.del<void>(`/v1/invites/${seg(id)}`);

/* ---------- API keys ---------- */

export const listApiKeys = (c: ApiClient) => c.get<DataList<ApiKey>>("/v1/api-keys");

export interface ApiKeyCreate {
  name: string;
  agent_name?: string | null;
  scopes: Scope[];
  expires_at?: Timestamp | null;
}

/** Owner session. `secret` is returned once: show it with SecretReveal, then drop it. */
export const createApiKey = (c: ApiClient, body: ApiKeyCreate) =>
  c.post<{ api_key: ApiKey; secret: string }>("/v1/api-keys", body);

export const revokeApiKey = (c: ApiClient, id: UUID) => c.del<void>(`/v1/api-keys/${seg(id)}`);

/** Public MCP endpoint shown in snippets (SPEC §6.5, §10). */
export const PUBLIC_API_URL = (
  process.env.NEXT_PUBLIC_PUBLIC_API_URL ?? "https://api.raisebook.org"
).replace(/\/$/, "");
export const MCP_URL = `${PUBLIC_API_URL}/mcp`;
