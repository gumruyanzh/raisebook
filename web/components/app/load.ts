import "server-only";

import { notFound } from "next/navigation";

import { ApiError, type ApiClient } from "@/lib/api/client";
import { getRound } from "@/lib/api/rounds";
import { serverApi, getSession } from "@/lib/api/server";
import type { Round, Workspace } from "@/lib/api/types";
import { todayIn } from "@/lib/format";

/**
 * Server-side loading for the App-UI pages. A 404 from the API (another workspace's id, a
 * deleted round) becomes the Next.js not-found page; other errors are returned so the page
 * can say what happened.
 */
export async function workspaceFor(ws: string): Promise<{ workspace: Workspace; client: ApiClient; today: string }> {
  const s = await getSession();
  if (s.status !== "ok") notFound();
  const workspace = s.session.workspaces.find((w) => w.slug.toLowerCase() === decodeURIComponent(ws).toLowerCase());
  if (!workspace) notFound();
  const client = await serverApi(workspace.slug);
  return { workspace, client, today: todayIn(workspace.timezone) };
}

export async function roundOr404(client: ApiClient, ref: string): Promise<Round> {
  try {
    return await getRound(client, decodeURIComponent(ref));
  } catch (err) {
    if (err instanceof ApiError && err.isNotFound) notFound();
    throw err;
  }
}

/** Run loaders; turn a 404 into notFound() and return other errors as a value. */
export async function load<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof ApiError && err.isNotFound) notFound();
    // notFound() and redirect() throw special errors that must propagate.
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { ok: false, error: err };
  }
}

/** Swallow a failure for optional data (an empty list instead of a broken page). */
export async function optional<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}
