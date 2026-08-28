/**
 * HTTP API route (user/verifications/[verificationId]): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import { mapStoredVideoVerificationToClientPayload } from "@/lib/user/mapStoredVideoVerificationToClientPayload";
import { validateTeamClaimVerificationRowShape } from "@/lib/workspaces/teamClaimVerificationRowValidation";
import { validateTeamVideoVerificationRowShape } from "@/lib/workspaces/teamVideoVerificationRowValidation";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Auth Identity Consistency Remediation, Step 7 — resolves via the
// shared, hardened resolver rather than this route's own duplicated
// cookie-first logic. Response shape for auth failures is unchanged.
async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/user/verifications/[verificationId]", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json(
      { ok: false, errorCode: "unauthorized", message: "Please sign in." },
      { status: 401 }
    );
  }
  return NextResponse.json(
    { ok: false, errorCode: "auth_error", message: "Authentication failed." },
    { status: 401 }
  );
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ verificationId: string }> }
) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const { verificationId } = await context.params;
  if (!verificationId || !adminDb) {
    return NextResponse.json(
      { ok: false, errorCode: "not_found", message: "Not found." },
      { status: 404 }
    );
  }

  const collectionParam = (req.nextUrl.searchParams.get("collection") ?? "verifications").trim();
  const collection =
    collectionParam === "videoVerifications" ? "videoVerifications" : "verifications";

  if (collectionParam !== "verifications" && collectionParam !== "videoVerifications") {
    return NextResponse.json(
      {
        ok: false,
        errorCode: "validation_error",
        message: 'collection must be "verifications" or "videoVerifications".',
      },
      { status: 400 }
    );
  }

  const snap = await adminDb.collection(collection).doc(verificationId).get();
  if (!snap.exists) {
    return NextResponse.json(
      {
        ok: false,
        errorCode: "not_found",
        message: collection === "videoVerifications" ? "Video verification not found." : "Claim not found.",
      },
      { status: 404 }
    );
  }

  const raw = snap.data() as Record<string, unknown>;

  // ============================================
  // Phase 8C-E.1 — Team Claim read classification. Applies ONLY to
  // collection === "verifications"; Video's own Team classification is
  // out of scope here (deferred to E3) and always falls through to the
  // unchanged Personal owner-check path below, exactly as it does today.
  // ============================================
  const hasWorkspaceIdField = collection === "verifications" && Object.prototype.hasOwnProperty.call(raw, "workspaceId");

  if (hasWorkspaceIdField) {
    // A workspaceId field is present at all -> this row is claiming to be
    // Team-bound. It may NEVER fall back to the Personal owner-ownership
    // path below, regardless of what happens next: an absent/malformed
    // value already failed closed above conceptually, and a present-but-
    // invalid value fails closed via the row validator next.
    if (typeof raw.workspaceId !== "string" || raw.workspaceId.length === 0) {
      // Malformed workspaceId value on an otherwise-claimed-Team row —
      // concealed, never a distinguishable error, never a Personal
      // fallback.
      return NextResponse.json(
        { ok: false, errorCode: "not_found", message: "Claim not found." },
        { status: 404 }
      );
    }

    const workspaceId = raw.workspaceId;
    const validated = validateTeamClaimVerificationRowShape(raw, workspaceId);
    if (!validated.ok) {
      return NextResponse.json(
        { ok: false, errorCode: "not_found", message: "Claim not found." },
        { status: 404 }
      );
    }

    const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
    if (!access.granted) {
      if (access.reason === "lookup_failed") {
        // Genuine infrastructure failure — deliberately untouched by
        // Phase 10C.1A, kept distinct from every concealed reason below.
        return NextResponse.json(
          { ok: false, errorCode: "team_workspaces_disabled", message: "Team Workspaces are not available right now." },
          { status: 503 }
        );
      }
      // Phase 10C.1A: "team_workspaces_disabled" (rollout non-admission)
      // now joins every other denial reason (workspace absent/malformed/
      // wrong type, membership absent/removed/malformed, owner-integrity
      // violation) in the same concealed 404 — a non-member (or a caller
      // whose target Workspace isn't rollout-admitted) must never learn
      // which of those is actually true.
      return NextResponse.json(
        { ok: false, errorCode: "not_found", message: "Claim not found." },
        { status: 404 }
      );
    }
    if (!access.capabilities.includes("research.read")) {
      return NextResponse.json(
        { ok: false, errorCode: "insufficient_capability", message: "You do not have permission to view this Claim verification." },
        { status: 403 }
      );
    }

    try {
      const data = raw as ClaimVerificationFirestoreDoc;
      const payload = mapStoredVerificationToClientPayload(data, verificationId);
      return NextResponse.json({ ok: true, payload });
    } catch (e: unknown) {
      logger.error("[user/verifications/id] Team Claim map failed", { error: (e as Error)?.message });
      return NextResponse.json(
        { ok: false, errorCode: "internal_error", message: "Could not load verification." },
        { status: 500 }
      );
    }
  }

  // ============================================
  // Phase 8C-E.3.3.1 — Team Video read classification. Applies ONLY to
  // collection === "videoVerifications"; deliberately a SEPARATE block
  // from the Claim branch above (never merged/refactored together) so
  // this addition cannot alter Claim's already-Production-safe semantics.
  // A workspaceId field on a videoVerifications row may NEVER fall back
  // to the Personal owner-ownership path below.
  // ============================================
  const hasVideoWorkspaceIdField = collection === "videoVerifications" && Object.prototype.hasOwnProperty.call(raw, "workspaceId");

  if (hasVideoWorkspaceIdField) {
    if (typeof raw.workspaceId !== "string" || raw.workspaceId.length === 0) {
      // Malformed workspaceId value on an otherwise-claimed-Team row —
      // concealed, never a distinguishable error, never a Personal
      // fallback.
      return NextResponse.json(
        { ok: false, errorCode: "not_found", message: "Video verification not found." },
        { status: 404 }
      );
    }

    const workspaceId = raw.workspaceId;
    const validated = validateTeamVideoVerificationRowShape(raw, workspaceId);
    if (!validated.ok) {
      return NextResponse.json(
        { ok: false, errorCode: "not_found", message: "Video verification not found." },
        { status: 404 }
      );
    }

    const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
    if (!access.granted) {
      if (access.reason === "lookup_failed") {
        // Genuine infrastructure failure — deliberately untouched by
        // Phase 10C.1A, kept distinct from every concealed reason below.
        return NextResponse.json(
          { ok: false, errorCode: "team_workspaces_disabled", message: "Team Workspaces are not available right now." },
          { status: 503 }
        );
      }
      // Phase 10C.1A: "team_workspaces_disabled" (rollout non-admission)
      // now joins every other denial reason in the same concealed 404 —
      // a non-member (or a caller whose target Workspace isn't
      // rollout-admitted) must never learn which of those is actually true.
      return NextResponse.json(
        { ok: false, errorCode: "not_found", message: "Video verification not found." },
        { status: 404 }
      );
    }
    if (!access.capabilities.includes("research.read")) {
      return NextResponse.json(
        { ok: false, errorCode: "insufficient_capability", message: "You do not have permission to view this Video verification." },
        { status: 403 }
      );
    }

    try {
      const payload = mapStoredVideoVerificationToClientPayload(verificationId, raw);
      return NextResponse.json({ ok: true, payload });
    } catch (e: unknown) {
      logger.error("[user/verifications/id] Team Video map failed", { error: (e as Error)?.message });
      return NextResponse.json(
        { ok: false, errorCode: "internal_error", message: "Could not load verification." },
        { status: 500 }
      );
    }
  }

  // ============================================
  // Existing Personal/legacy owner path — unchanged.
  // ============================================
  const owner =
    (typeof raw.userId === "string" && raw.userId.trim()) ||
    (typeof raw.uid === "string" && raw.uid.trim()) ||
    "";
  if (owner !== uid) {
    return NextResponse.json(
      { ok: false, errorCode: "forbidden", message: "Access denied." },
      { status: 403 }
    );
  }

  try {
    if (collection === "videoVerifications") {
      if (raw.type != null && raw.type !== "video_verification") {
        return NextResponse.json(
          { ok: false, errorCode: "not_found", message: "Video verification not found." },
          { status: 404 }
        );
      }
      const payload = mapStoredVideoVerificationToClientPayload(verificationId, raw);
      return NextResponse.json({ ok: true, payload });
    }

    const data = raw as ClaimVerificationFirestoreDoc;
    const payload = mapStoredVerificationToClientPayload(data, verificationId);
    return NextResponse.json({ ok: true, payload });
  } catch (e: unknown) {
    logger.error("[user/verifications/id] map failed", { error: (e as Error)?.message });
    return NextResponse.json(
      { ok: false, errorCode: "internal_error", message: "Could not load verification." },
      { status: 500 }
    );
  }
}
