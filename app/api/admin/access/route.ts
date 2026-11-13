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
 * Both are derived server-side from ONE live Firebase Auth read made by the
 * privileged-access guard (lib/admin/privilegedAccess.ts). Never from a
 * Firestore role, a client-supplied value, a client email, or the legacy
 * `role: "admin"` presentation string. `ok` is preserved for backward
 * compatibility and means ADMIN_PORTAL.
 */

import { NextRequest, NextResponse } from "next/server";
import { privilegedDenialResponse, requirePrivilegedAccess } from "@/lib/admin/privilegedAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SEC-3 / S2-b: both tiers come from the privileged-access guard's ONE live
 * Auth snapshot. `systemAdmin` is the LIVE `customClaims.admin === true`
 * (SP-1), never the presented token's claim, so a de-claimed administrator
 * stops being reported as SYSTEM_ADMIN on the next request. A caller who holds
 * neither tier receives the guard's uniform denial (401/403/503).
 */
export async function GET(request: NextRequest) {
  const access = await requirePrivilegedAccess(request, "ADMIN_PORTAL", { route: "GET /api/admin/access" });
  if (!access.ok) return privilegedDenialResponse(access);
  return NextResponse.json({ ok: true, adminPortal: true, systemAdmin: access.actor.heldTiers.systemAdmin });
}
