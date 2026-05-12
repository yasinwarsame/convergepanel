/**
 * Session Cookie API Endpoint
 * 
 * This endpoint creates a Firebase session cookie after the user signs in.
 * The session cookie is used by middleware and API routes to verify authentication.
 * 
 * Flow:
 * 1. Client signs in with Firebase Auth (gets ID token)
 * 2. Client sends ID token to this endpoint
 * 3. Server verifies token and creates session cookie
 * 4. Client can now access protected routes
 * 
 * Route: POST /api/auth/session
 */

import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase/admin";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { idToken } = body;

    if (!idToken || typeof idToken !== "string") {
      return NextResponse.json(
        { error: "ID token is required" },
        { status: 400 }
      );
    }

    /**
     * Verify the ID token
     * 
     * This ensures the token is valid, not expired, and issued by our Firebase project.
     */
    if (!adminAuth) {
      console.error("[auth/session] Firebase Admin Auth is not available");
      return NextResponse.json(
        { error: "Authentication service unavailable" },
        { status: 500 }
      );
    }
    
    let decodedToken;
    try {
      decodedToken = await adminAuth.verifyIdToken(idToken);
    } catch (verifyError: any) {
      console.error("Token verification failed:", verifyError);
      return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
    }

    /**
     * Create session cookie
     * 
     * Session cookies are httpOnly and secure, making them safer than storing
     * tokens in localStorage. They expire after 5 days.
     */
    const expiresIn = 60 * 60 * 24 * 5 * 1000; // 5 days in milliseconds
    let sessionCookie;
    try {
      // adminAuth is already checked above
      sessionCookie = await adminAuth!.createSessionCookie(idToken, {
        expiresIn,
      });
    } catch (cookieError: any) {
      console.error("Session cookie creation failed:", cookieError);
      return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
    }

    /**
     * Set the session cookie in the response
     * 
     * The cookie will be sent to the browser and included in subsequent requests.
     */
    const response = NextResponse.json({ success: true });
    response.cookies.set("__session", sessionCookie, {
      maxAge: expiresIn / 1000, // Convert to seconds
      httpOnly: true, // Prevents JavaScript access (XSS protection)
      secure: true,
      sameSite: "lax", // CSRF protection
      path: "/",
    });

    return response;
  } catch (error: any) {
    console.error("Error creating session cookie:", error);
    
    // Provide helpful error message if Admin SDK is not configured
    if (error.message?.includes("service account") || error.message?.includes("credential")) {
      console.error("[auth/session] Firebase Admin SDK not configured");
    }

    return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
  }
}

/**
 * DELETE - Clear session cookie
 * 
 * Called when user logs out to remove the session cookie.
 */
export async function DELETE(request: NextRequest) {
  const response = NextResponse.json({ success: true });
  response.cookies.delete("__session");
  return response;
}

