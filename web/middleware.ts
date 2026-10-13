import { NextResponse, type NextRequest } from "next/server";

/**
 * Two jobs, both before rendering:
 *
 * 1. Auth gate for signed-in routes. The API owns the session (HttpOnly `rb_session`, SPEC
 *    §4.2); this only checks that the cookie is present and sends signed-out visitors to
 *    /signin?next=<path>. An expired cookie is caught by (app)/layout.tsx, which asks the API.
 *    The request path is forwarded as `x-rb-path` so layouts can build the `next` parameter.
 * 2. "/" for signed-in visitors goes to /app. Doing it here keeps the landing page static
 *    (no cookies() call while rendering), so Next serves it from its cache instead of
 *    rendering it per visit. Only requests that carry a session cookie ask the API, and a
 *    stale cookie falls through to the landing page instead of bouncing to sign-in.
 */

const SESSION_COOKIE = "rb_session";

function bypass(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.RAISEBOOK_WEB_AUTH_BYPASS === "1";
}

async function landing(req: NextRequest): Promise<NextResponse> {
  const session = req.cookies.get(SESSION_COOKIE)?.value;
  const base = process.env.API_URL_INTERNAL ?? process.env.NEXT_PUBLIC_API_URL;
  if (!session || !base) return NextResponse.next();
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/v1/auth/session`, {
      headers: { Cookie: `${SESSION_COOKIE}=${session}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) return NextResponse.redirect(new URL("/app", req.url));
  } catch {
    // API unreachable: show the landing page rather than an error.
  }
  return NextResponse.next();
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (pathname === "/") return landing(req);

  const headers = new Headers(req.headers);
  headers.set("x-rb-path", `${pathname}${search}`);

  if (req.cookies.get(SESSION_COOKIE)?.value || bypass()) {
    return NextResponse.next({ request: { headers } });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/signin";
  url.search = "";
  url.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/", "/w/:path*", "/app", "/account/:path*", "/onboarding/:path*"],
};
