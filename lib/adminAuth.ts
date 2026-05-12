/**
 * Shared library module (adminAuth.ts): domain logic used by API routes and UI.
 */

import { randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const COOKIE_NAME = "admin_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// Opportunistic cleanup: deletes up to 50 expired session docs on each login.
// For zero-maintenance collection hygiene, also configure a Firestore TTL policy
// in the Firebase console: Collection "admin_sessions", field "expiresAt" (timestamp).
async function cleanupExpiredAdminSessions(): Promise<void> {
  try {
    const { adminDb } = await import("@/lib/firebase/admin");
    const { Timestamp } = await import("firebase-admin/firestore");
    if (!adminDb) return;
    const expired = await adminDb
      .collection("admin_sessions")
      .where("expiresAt", "<", Timestamp.fromMillis(Date.now()))
      .limit(50)
      .get();
    if (expired.empty) return;
    const batch = adminDb.batch();
    expired.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  } catch (err) {
    console.error("[adminAuth] Session cleanup failed:", err);
  }
}

export async function setAdminSession(): Promise<void> {
  const token = randomBytes(32).toString("hex");

  // Persist token in Firestore so it can be validated and revoked server-side.
  // Import lazily to avoid initialising Firebase Admin at module load time.
  try {
    const { adminDb } = await import("@/lib/firebase/admin");
    if (adminDb) {
      await adminDb.collection("admin_sessions").doc(token).set({
        createdAt: Date.now(),
        expiresAt: Date.now() + COOKIE_MAX_AGE * 1000,
      });
    }
  } catch (err) {
    console.error("[adminAuth] Failed to persist session token:", err);
  }

  // Fire-and-forget: don't await so cleanup never delays the login response.
  void cleanupExpiredAdminSessions();

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
}

export async function clearAdminSession(request?: NextRequest): Promise<void> {
  const token = request?.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    try {
      const { adminDb } = await import("@/lib/firebase/admin");
      if (adminDb) {
        await adminDb.collection("admin_sessions").doc(token).delete();
      }
    } catch (err) {
      console.error("[adminAuth] Failed to delete session token:", err);
    }
  }
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function isAdminSessionValid(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token || token.length !== 64) return false;
  try {
    const { adminDb } = await import("@/lib/firebase/admin");
    if (!adminDb) return false;
    const doc = await adminDb.collection("admin_sessions").doc(token).get();
    if (!doc.exists) return false;
    const { expiresAt } = doc.data() as { expiresAt: number };
    return Date.now() < expiresAt;
  } catch {
    return false;
  }
}

export function validatePassword(password: string): boolean {
  if (!ADMIN_PASSWORD) {
    console.warn("ADMIN_PASSWORD not set in environment variables");
    return false;
  }
  const a = Buffer.from(password);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
