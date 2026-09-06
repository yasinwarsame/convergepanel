/**
 * ADMIN TIER CAPABILITY PROBE.
 *
 * Returns the caller's server-derived administrator tiers so the portal UI can
 * show only what they actually hold. Before this, the client had one boolean and
 * an `ADMIN_EMAILS` member was shown user-management, credential and purge
 * controls that then returned 401 on every action.
 *
 *   adminPortal   ADMIN_PORTAL — verified ADMIN_EMAILS member, or the `admin`
 *                 custom claim.
 *   systemAdmin   SYSTEM_ADMIN — the `admin` custom claim ONLY. Never
 *                 email-derived. Gates credential access, admin-claim minting,
 *                 bulk purge, and destructive account/billing mutation.
 *
 * Both are derived server-side from the verified token and a live Firebase Auth
 * read. Never from a Firestore role, a client-supplied value, a client email, or
 * the legacy `role: "admin"` presentation string. `ok` is preserved for
 * backward compatibility and means ADMIN_PORTAL.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminPortalAccess } from "@/lib/firebase/auth-helpers";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { adminAuth } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** SYSTEM_ADMIN strictly from the verified custom claim. */
async function resolveSystemAdmin(request: NextRequest): Promise<boolean> {
  if (!adminAuth) return false;
  const header = request.headers.get("authorization");
  const raw =
    header?.replace(/^Bearer\s+/i, "")?.trim() || request.cookies.get("__session")?.value;
  if (!raw) return false;
  try {
    const decoded = await adminAuth.verifyIdToken(raw);
    return decoded.admin === true;
  } catch {
    try {
      const decoded = await adminAuth.verifySessionCookie(raw, true);
      return decoded.admin === true;
    } catch {
      return false;
    }
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAdminPortalAccess(request);
  if (!auth) {
    return NextResponse.json({ ok: false, adminPortal: false, systemAdmin: false }, { status: 401 });
  }
  void resolveRequestIdentity;
  const systemAdmin = await resolveSystemAdmin(request);
  return NextResponse.json({ ok: true, adminPortal: true, systemAdmin });
}
