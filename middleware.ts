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

export function middleware(request: NextRequest) {
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
  matcher: ["/admin/:path*"],
};

