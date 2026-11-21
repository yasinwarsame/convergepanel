/**
 * Next.js Middleware - Route Protection
 * 
 * NOTE: Admin route protection is handled client-side in app/admin/layout.tsx
 * using Firebase Auth and custom claims. This middleware does NOT enforce
 * admin checks to avoid forcing already-authenticated users to log in again.
 * 
 * Server-side admin verification happens in API routes (e.g., /api/admin/*)
 * which use Firebase Admin SDK to verify ID tokens and custom claims.
 * 
 * Why this approach:
 * - Firebase Auth uses ID tokens, not session cookies
 * - Client-side auth state is managed by AuthProvider
 * - Admin layout handles redirects based on isAdmin from custom claims
 * - API routes provide server-side security
 */

import { NextRequest, NextResponse } from "next/server";

/**
 * Structural telemetry hardening (GHSA-655j-5f43-92pw follow-up): `/ingest/*` is a reverse proxy to PostHog
 * (next.config.js rewrites), and a proxy forwards the browser's request headers. Same-origin requests carry every
 * first-party cookie (`path: "/"`), including the httpOnly `__session` cookie and PostHog's own cookie with the raw
 * landing URL. Credentials and cookies are removed before the request is proxied; PostHog authenticates events by
 * the project key in the body, not by cookies.
 */
export const PROXY_STRIPPED_REQUEST_HEADERS = ["cookie", "authorization", "proxy-authorization", "x-firebase-appcheck"] as const;

export function stripProxyCredentials(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of PROXY_STRIPPED_REQUEST_HEADERS) out.delete(name);
  return out;
}

/** `/ingest` (PostHog proxy) and `/monitoring` (Sentry tunnel), in ANY letter case (review F1). */
export function isTelemetryProxyPath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return p === "/ingest" || p.startsWith("/ingest/") || p === "/monitoring" || p.startsWith("/monitoring/");
}

export function middleware(request: NextRequest) {
  if (isTelemetryProxyPath(request.nextUrl.pathname)) {
    return NextResponse.next({ request: { headers: stripProxyCredentials(request.headers) } });
  }
  // Gate /admin routes: redirect to login if no session cookie is present.
  // This prevents the admin page HTML from being served to unauthenticated visitors.
  // The real auth check (Firebase custom claims) still happens client-side in
  // app/admin/layout.tsx and server-side in every /api/admin/* route.
  if (request.nextUrl.pathname.startsWith("/admin")) {
    const session = request.cookies.get("__session")?.value;
    if (!session) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("next", request.nextUrl.pathname);
      return NextResponse.redirect(loginUrl);
    }
  }
  return NextResponse.next();
}

export const config = {
  // Case-insensitive matchers for the telemetry proxies (review F1); `/admin` gating is unchanged.
  matcher: [
    "/admin/:path*",
    "/:p([iI][nN][gG][eE][sS][tT])",
    "/:p([iI][nN][gG][eE][sS][tT])/:path*",
    "/:p([mM][oO][nN][iI][tT][oO][rR][iI][nN][gG])",
    "/:p([mM][oO][nN][iI][tT][oO][rR][iI][nN][gG])/:path*",
  ],
};

