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
  // Allow all routes - admin protection is handled client-side
  // This prevents unnecessary redirects for already-authenticated users
  return NextResponse.next();
}

/**
 * Middleware configuration
 * 
 * Currently no routes are protected by middleware.
 * All authentication and authorization is handled client-side and in API routes.
 */
export const config = {
  matcher: [],
};

