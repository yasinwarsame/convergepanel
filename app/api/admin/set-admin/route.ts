/**
 * Set Admin Custom Claim Endpoint
 * 
 * This is a one-time setup endpoint to grant admin privileges to a user.
 * It sets the `admin: true` custom claim in Firebase Auth.
 * 
 * IMPORTANT: This endpoint is NOT linked in the UI for security.
 * It should only be called manually (e.g., via curl) during initial setup.
 * 
 * Security:
 * - Requires ADMIN_SECRET environment variable
 * - Only sets custom claims (doesn't expose sensitive data)
 * 
 * Usage — MINTS-AUTHORITY. This form GRANTS SYSTEM_ADMIN to the named uid.
 *
 *   curl -X POST http://localhost:3000/api/admin/set-admin \
 *     -H "Content-Type: application/json" \
 *     -d '{"uid": "USER_UID", "secret": "ADMIN_SECRET"}'
 *
 * SAFE-PROBE:PROHIBITION — NEVER use this form to check whether an old
 * secret is still accepted. The
 * secret is validated BEFORE the uid, so if the old secret is still live this
 * request does not report a failure — it silently mints `admin: true` on that
 * uid, with no audit record and no success log. To verify a rotation, use the
 * uid-less containment probe in docs/operations/admin-authority-tiers.md §B.6.c:
 * send `{"secret": "<OLD_SECRET>"}` with no uid, and treat only 401 as proof.
 * 
 * After calling this, the user must sign out and sign back in for
 * the admin claim to take effect (Firebase tokens are cached).
 */

import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase/admin";
import { checkRateLimit } from "@/lib/security/rateLimit";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

/**
 * Phase FIRST-ADMIN-C11 — exported so the runbook's stated limit is checked
 * against the real configuration instead of being hand-copied. It was hand-
 * copied before, and the mechanism it described did not work.
 *
 * DEFENCE IN DEPTH ONLY: this is per-IP, so a distributed source weakens it.
 * The primary boundary is a high-entropy ADMIN_SECRET used for a bootstrap
 * window and then rotated or removed.
 */
// NOT exported: a Next.js route module may only export its handlers and a
// fixed set of config names, so these are module-local and the runbook parity
// test reads them from source.
const RATE_LIMIT_MAX_REQUESTS = 3;
const RATE_LIMIT_WINDOW_SECONDS = 300;

export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const rl = await checkRateLimit({
      maxRequests: RATE_LIMIT_MAX_REQUESTS,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
      identifier: `set-admin:${ip}`,
    });
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
    }

    const body = await request.json();
    const { uid, secret } = body;

    /**
     * Phase FIRST-ADMIN-C10 — compare BYTE lengths, not character lengths.
     *
     * This previously guarded `timingSafeEqual` with `provided.length ===
     * adminSecret.length`. String `.length` counts UTF-16 code units while
     * `Buffer.from()` measures UTF-8 bytes, so inputs of equal character length
     * and unequal byte length reached `timingSafeEqual`, which throws
     * ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH — surfacing as a 500. Two problems:
     * an unauthenticated length oracle for `ADMIN_SECRET` (N multibyte
     * characters return 500 where N±1 return 401), and, worse for the operator,
     * the containment probe in the runbook returns an INCONCLUSIVE 5xx instead
     * of a conclusive 401 whenever the old secret is non-ASCII.
     *
     * Buffers are built once and their byte lengths compared, so a mismatch is
     * an ordinary authentication failure. `timingSafeEqual` is retained — it is
     * the point of this comparison, not an implementation detail.
     */
    const adminSecretBuf = Buffer.from(process.env.ADMIN_SECRET ?? "", "utf8");
    const providedBuf = Buffer.from(typeof secret === "string" ? secret : "", "utf8");
    const secretValid =
      adminSecretBuf.length > 0 &&
      providedBuf.length === adminSecretBuf.length &&
      timingSafeEqual(providedBuf, adminSecretBuf);

    if (!secretValid) {
      return NextResponse.json(
        { error: "Invalid secret" },
        { status: 401 }
      );
    }

    // Validate UID is provided
    if (!uid || typeof uid !== "string") {
      return NextResponse.json(
        { error: "UID is required" },
        { status: 400 }
      );
    }

    /**
     * Set admin custom claim
     * 
     * This adds `admin: true` to the user's ID token claims.
     * The claim will be available after the user's next token refresh
     * (they need to sign out and sign back in).
     */
    if (!adminAuth) {
      console.error("[admin/set-admin] Firebase Admin Auth is not available");
      return NextResponse.json(
        { error: "Firebase Admin Auth is not available" },
        { status: 500 }
      );
    }
    
    await adminAuth.setCustomUserClaims(uid, { admin: true });

    /**
     * Update Firestore user document
     * 
     * Also update the user's role in Firestore for consistency.
     * This allows querying users by role if needed.
     */
    const { adminDb } = await import("@/lib/firebase/admin");
    if (!adminDb) {
      console.error("[admin/set-admin] Firestore is not available");
      return NextResponse.json(
        { error: "Firestore is not available" },
        { status: 500 }
      );
    }
    
    await adminDb.collection("users").doc(uid).set(
      {
        role: "admin",
      },
      { merge: true } // Don't overwrite existing fields
    );

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Error setting admin:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

