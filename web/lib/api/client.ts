/**
 * Fetch wrapper for the Raisebook API (`/v1`). Every `/v1` call in the web app goes through a
 * client made here (SPEC §2, §4.2, §5.1):
 *
 * - Base URL: `NEXT_PUBLIC_API_URL` (default http://localhost:8000). On the server,
 *   `API_URL_INTERNAL` wins when set (see `lib/api/server.ts`).
 * - Browser requests send cookies (`credentials: "include"`). Unsafe methods carry
 *   `X-CSRF-Token`, read from the `rb_csrf` cookie or from the token the session/verify
 *   response returned (`setCsrfToken`).
 * - Workspace-scoped calls carry `X-Workspace: <slug>`; get a scoped client with
 *   `client.ws(slug)`. Org-less calls (auth, me, workspace list) need no header.
 * - Non-2xx responses are `{error: {code, message, details, request_id}}` and are thrown as
 *   `ApiError`. A network failure is `ApiError(0, "network_unreachable")`.
 *
 * Feature modules (`lib/api/rounds.ts`, …) export plain functions that take a client first:
 * `listRounds(c, …)`. In client components use `api.ws(slug)`; in server components use
 * `await serverApi(slug)`.
 */

import type { ApiErrorBody } from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(
  /\/$/,
  "",
);

/** HttpOnly session cookie set by the API (SPEC §4.2). */
export const SESSION_COOKIE = "rb_session";
/** Readable CSRF cookie set beside the session. */
export const CSRF_COOKIE = "rb_csrf";
export const CSRF_HEADER = "X-CSRF-Token";
/** Selects the workspace for a session request (SPEC §4.3). */
export const WORKSPACE_HEADER = "X-Workspace";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    requestId?: string | null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId ?? null;
  }

  /** No session or a bad key: send the user to /signin. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }

  /** Field errors of a 422 `validation_error`, keyed by the last `loc` segment. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.code !== "validation_error" || !Array.isArray(this.details)) return out;
    for (const item of this.details as Array<{ loc?: unknown[]; msg?: string }>) {
      const loc = Array.isArray(item.loc) ? item.loc : [];
      const key = String(loc[loc.length - 1] ?? "_");
      if (!out[key] && item.msg) out[key] = item.msg;
    }
    return out;
  }
}

export function isErrorBody(x: unknown): x is ApiErrorBody {
  if (!x || typeof x !== "object" || !("error" in x)) return false;
  const e = (x as { error: unknown }).error;
  return !!e && typeof e === "object" && "code" in e && "message" in e;
}

export type QueryValue = string | number | boolean | null | undefined;
/** Arrays become repeated keys (`?stage=a&stage=b`); null/undefined/"" are dropped. */
export type Query = Record<string, QueryValue | readonly QueryValue[]>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Query;
  /** JSON-encoded unless it is a string, FormData or Blob. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Overrides the client's workspace for this call; `null` drops the header. */
  workspace?: string | null;
  /** Sent as `Idempotency-Key`. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  cache?: RequestCache;
  next?: { revalidate?: number | false; tags?: string[] };
}

export interface ClientConfig {
  baseUrl?: string;
  /** Extra headers on every request (the server variant forwards `Cookie`). */
  headers?: Record<string, string>;
  /** CSRF token for unsafe methods; the browser client falls back to the cookie. */
  csrfToken?: string;
  /** Workspace slug or id sent as `X-Workspace`. */
  workspace?: string;
  defaults?: Pick<RequestOptions, "cache" | "next">;
}

export interface ApiClient {
  readonly baseUrl: string;
  readonly workspace: string | undefined;
  request<T>(path: string, opts?: RequestOptions): Promise<T>;
  /** Raw response for file downloads (CSV/JSON exports). Throws ApiError on non-2xx. */
  raw(path: string, opts?: RequestOptions): Promise<Response>;
  get<T>(path: string, query?: Query, opts?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  del<T = void>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  /** A copy of this client scoped to a workspace (slug or id). */
  ws(workspace: string): ApiClient;
}

/* ---------- CSRF token memory (browser) ---------- */

let csrfMemory: string | undefined;

/** Remember the CSRF token returned by `/v1/auth/session` or `/v1/auth/verify`. */
export function setCsrfToken(token: string | null | undefined): void {
  csrfMemory = token ?? undefined;
}

export function readBrowserCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const p = part.trim();
    if (p.startsWith(prefix)) return decodeURIComponent(p.slice(prefix.length));
  }
  return undefined;
}

export function buildUrl(base: string, path: string, query?: Query): string {
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  if (!query) return url;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    const values = Array.isArray(v) ? v : [v];
    for (const item of values as readonly QueryValue[]) {
      if (item === undefined || item === null || item === "") continue;
      sp.append(k, String(item));
    }
  }
  const qs = sp.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

/** URL path segment encoding, for ids and slugs in paths. */
export const seg = (s: string): string => encodeURIComponent(s);

export function createApiClient(config: ClientConfig = {}): ApiClient {
  const base = (config.baseUrl ?? API_URL).replace(/\/$/, "");

  function prepare(path: string, reqOpts: RequestOptions) {
    const opts: RequestOptions = { ...config.defaults, ...reqOpts };
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...config.headers,
      ...opts.headers,
    };
    const workspace = opts.workspace === undefined ? config.workspace : opts.workspace;
    if (workspace) headers[WORKSPACE_HEADER] = workspace;
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    if (UNSAFE.has(method) && !headers[CSRF_HEADER]) {
      const csrf = config.csrfToken ?? csrfMemory ?? readBrowserCookie(CSRF_COOKIE);
      if (csrf) headers[CSRF_HEADER] = csrf;
    }
    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      if (
        typeof opts.body === "string" ||
        (typeof FormData !== "undefined" && opts.body instanceof FormData) ||
        (typeof Blob !== "undefined" && opts.body instanceof Blob)
      ) {
        body = opts.body as BodyInit;
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
    }
    const init: RequestInit & { next?: RequestOptions["next"] } = {
      method,
      headers,
      body,
      credentials: "include",
      signal: opts.signal,
      cache: opts.cache,
    };
    if (opts.next) init.next = opts.next;
    return { url: buildUrl(base, path, opts.query), init };
  }

  async function send(path: string, reqOpts: RequestOptions): Promise<Response> {
    const { url, init } = prepare(path, reqOpts);
    try {
      return await fetch(url, init);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ApiError(
        0,
        "network_unreachable",
        `Could not reach the Raisebook API at ${base}. Check that it is running and try again.`,
        undefined,
      );
    }
  }

  async function failure(res: Response, path: string): Promise<ApiError> {
    const text = await res.text().catch(() => "");
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (isErrorBody(data)) {
      const e = data.error;
      return new ApiError(res.status, e.code, e.message, e.details, e.request_id);
    }
    return new ApiError(
      res.status,
      `http_${res.status}`,
      `The API answered ${res.status} for ${path}.`,
      data,
      res.headers.get("x-request-id"),
    );
  }

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await send(path, opts);
    if (!res.ok) throw await failure(res, path);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("json")) return JSON.parse(text) as T;
    return text as T;
  }

  async function raw(path: string, opts: RequestOptions = {}): Promise<Response> {
    const res = await send(path, opts);
    if (!res.ok) throw await failure(res, path);
    return res;
  }

  return {
    baseUrl: base,
    workspace: config.workspace,
    request,
    raw,
    get: (path, query, o) => request(path, { ...o, method: "GET", query }),
    post: (path, body, o) => request(path, { ...o, method: "POST", body }),
    put: (path, body, o) => request(path, { ...o, method: "PUT", body }),
    patch: (path, body, o) => request(path, { ...o, method: "PATCH", body }),
    del: (path, body, o) => request(path, { ...o, method: "DELETE", body }),
    ws: (workspace) => createApiClient({ ...config, workspace }),
  };
}

/** Browser client (also usable on the server for unauthenticated calls). */
export const api: ApiClient = createApiClient();

/** One-line, user-facing text for any thrown value (SYSTEM §6: say what to do next). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.name === "AbortError") return "The request was canceled.";
  return "The request failed before the API answered. Check your connection and try again.";
}
