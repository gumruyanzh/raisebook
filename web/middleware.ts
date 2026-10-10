import { NextResponse, type NextRequest } from "next/server";

/**
 * Auth gate for signed-in routes. The API owns the session (HttpOnly `rb_session`, SPEC §4.2);
 * this only checks that the cookie is present and sends signed-out visitors to
 * /signin?next=<path>. An expired cookie is caught by (app)/layout.tsx, which asks the API.
 * The request path is forwarded as `x-rb-path` so layouts can build the `next` parameter.
 */

const SESSION_COOKIE = "rb_session";

function bypass(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.RAISEBOOK_WEB_AUTH_BYPASS === "1";
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
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
  matcher: ["/w/:path*", "/app", "/account/:path*", "/onboarding/:path*"],
};
