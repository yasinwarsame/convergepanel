/**
 * Self-service reviewer availability and assigner ↔ reviewer relationships.
 */

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { getPlanConfig } from "@/lib/plans";
import type { UserProfile } from "@/lib/types";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { logger } from "@/lib/logger";
import { parseGovernanceReviewerFor } from "@/lib/governance/reviewerFields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function planLabel(planId: "free" | "lite" | "full"): string {
  return getPlanConfig(planId).name;
}

/**
 * Auth Identity Consistency Remediation, Step 7 — resolves via the
 * shared, hardened resolver rather than this route's own duplicated
 * cookie-first logic. Note: this route's PREVIOUS implementation
 * swallowed a THROWN cookie-verification error and fell through to
 * trying the bearer token — the only one of the 14 migrated routes that
 * did so; every other route (and the shared resolver) fails closed on an
 * invalid cookie without ever trying bearer. Migrating this route onto
 * the shared resolver makes it consistent with the other 13 and with
 * `getRequestUid()` — strictly safer, not a functional regression (a
 * cookie that fails verification is not distinguishable, from this
 * route's caller's perspective, from "please sign in again").
 */
async function resolveUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "/api/governance/reviewer", failureCategory: identity.reason });
  return NextResponse.json(
    { ok: false, error: { code: "unauthorized", message: "Authentication required." } },
    { status: 401 }
  );
}

async function authEmailForUid(uid: string): Promise<string> {
  if (!adminAuth) return "";
  try {
    const u = await adminAuth.getUser(uid);
    return (u.email ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function requireFullPlanResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "plan_required",
        message: "Governance reviewer settings are available on the 5-Model plan.",
      },
    },
    { status: 403 }
  );
}

export async function GET(req: NextRequest) {
  if (!adminDb) {
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable." } },
      { status: 500 }
    );
  }

  const uidOrRes = await resolveUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const entitlements = await getEffectiveEntitlements(uid);
  if (entitlements.planId !== "full") {
    return requireFullPlanResponse();
  }

  try {
    const mySnap = await adminDb.collection("users").doc(uid).get();
    const my = (mySnap.data() ?? {}) as Partial<UserProfile>;
    const reviewerEnabled = my.governanceReviewerEnabled === true;

    const assignerSnaps = await adminDb.collection("users").where("governanceReviewerUid", "==", uid).get();
    const reviewingFor = assignerSnaps.docs.map((d) => {
      const data = d.data() as Partial<UserProfile>;
      const email = typeof data.email === "string" ? data.email : "";
      const assignedAt =
        typeof data.governanceReviewerAssignedAt === "string"
          ? data.governanceReviewerAssignedAt
          : new Date().toISOString();
      return { uid: d.id, email, assignedAt };
    });

    const hasAssigned =
      typeof my.governanceReviewerUid === "string" &&
      my.governanceReviewerUid.length > 0 &&
      typeof my.governanceReviewerEmail === "string";

    const assignedReviewer = hasAssigned
      ? {
          email: String(my.governanceReviewerEmail),
          uid: String(my.governanceReviewerUid),
          assignedAt:
            typeof my.governanceReviewerAssignedAt === "string"
              ? my.governanceReviewerAssignedAt
              : new Date().toISOString(),
        }
      : null;

    return NextResponse.json({
      ok: true,
      reviewerEnabled,
      reviewingFor,
      assignedReviewer,
    });
  } catch (e: unknown) {
    logger.error("[governance/reviewer GET]", { error: (e as Error)?.message });
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Failed to load reviewer settings." } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  if (!adminDb || !adminAuth) {
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable." } },
      { status: 500 }
    );
  }

  const uidOrRes = await resolveUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const assignerEntitlements = await getEffectiveEntitlements(uid);
  if (assignerEntitlements.planId !== "full") {
    return requireFullPlanResponse();
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "validation_error", message: "Invalid JSON body." } },
      { status: 400 }
    );
  }

  const action = typeof body.action === "string" ? body.action : "";

  if (action === "toggle_reviewer") {
    const enabled = body.enabled === true;
    const assignerRef = adminDb.collection("users").doc(uid);
    const before = await assignerRef.get();
    const prev = parseGovernanceReviewerFor(before.data() as Record<string, unknown>);
    await assignerRef.set(
      { governanceReviewerEnabled: enabled },
      { merge: true }
    );
    const stillN = enabled ? prev.length : prev.length;
    const payload: Record<string, unknown> = {
      ok: true,
      reviewerEnabled: enabled,
      message: enabled ? "Reviewer availability enabled." : "Reviewer availability disabled.",
    };
    if (!enabled && stillN > 0) {
      payload.comment = `You are still reviewing for ${stillN} user${stillN === 1 ? "" : "s"}. Remove individual assignments to stop reviewing.`;
    }
    return NextResponse.json(payload);
  }

  if (action === "assign_reviewer") {
    const rawEmail = typeof body.reviewerEmail === "string" ? body.reviewerEmail.trim() : "";
    if (!rawEmail) {
      return NextResponse.json({ ok: false, error: { message: "Email is required." } }, { status: 400 });
    }

    const reviewerEmailNorm = rawEmail.toLowerCase();
    const selfEmail = await authEmailForUid(uid);
    if (selfEmail && reviewerEmailNorm === selfEmail) {
      return NextResponse.json(
        { ok: false, error: { message: "You can't assign yourself as your own reviewer." } },
        { status: 400 }
      );
    }

    const assignerRef = adminDb.collection("users").doc(uid);
    const assignerSnap = await assignerRef.get();
    const assignerData = (assignerSnap.data() ?? {}) as Partial<UserProfile>;
    if (assignerData.governanceReviewerUid && assignerData.governanceReviewerEmail) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            message: `You already have a reviewer assigned (${assignerData.governanceReviewerEmail}). Remove them first before assigning a new one.`,
          },
        },
        { status: 400 }
      );
    }

    let reviewerUid: string;
    try {
      const authUser = await adminAuth.getUserByEmail(reviewerEmailNorm);
      reviewerUid = authUser.uid;
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: {
            message: `No account found with the email address ${rawEmail}. Your reviewer must have a ConvergePanel account.`,
          },
        },
        { status: 404 }
      );
    }

    const reviewerDoc = await adminDb.collection("users").doc(reviewerUid).get();
    if (reviewerUid === uid) {
      return NextResponse.json(
        { ok: false, error: { message: "You can't assign yourself as your own reviewer." } },
        { status: 400 }
      );
    }

    const reviewerEntitlements = await getEffectiveEntitlements(reviewerUid);
    if (reviewerEntitlements.planId !== "full") {
      return NextResponse.json(
        {
          ok: false,
          error: {
            message: `This person needs a 5-Model plan to be a reviewer. They are currently on the ${planLabel(reviewerEntitlements.planId)} plan.`,
          },
        },
        { status: 400 }
      );
    }

    const reviewerData = (reviewerDoc.data() ?? {}) as Partial<UserProfile>;
    if (reviewerData.governanceReviewerEnabled !== true) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            message: `${rawEmail} hasn't enabled reviewer availability yet. Ask them to turn it on in their Account settings.`,
          },
        },
        { status: 400 }
      );
    }

    const assignedAt = new Date().toISOString();
    await assignerRef.set(
      {
        governanceReviewerEmail: reviewerEmailNorm,
        governanceReviewerUid: reviewerUid,
        governanceReviewerAssignedAt: assignedAt,
      },
      { merge: true }
    );

    await adminDb.collection("users").doc(reviewerUid).set(
      {
        governanceReviewerFor: FieldValue.arrayUnion(uid),
      },
      { merge: true }
    );

    return NextResponse.json({
      ok: true,
      message: "Reviewer assigned successfully.",
      assignedReviewer: {
        email: reviewerEmailNorm,
        uid: reviewerUid,
        assignedAt,
      },
    });
  }

  if (action === "remove_reviewer") {
    const assignerRef = adminDb.collection("users").doc(uid);
    const assignerSnap = await assignerRef.get();
    const assignerData = (assignerSnap.data() ?? {}) as Partial<UserProfile>;
    const reviewerUid = assignerData.governanceReviewerUid;
    if (!reviewerUid || typeof reviewerUid !== "string") {
      return NextResponse.json(
        { ok: false, error: { message: "You don't have a reviewer assigned." } },
        { status: 400 }
      );
    }

    await assignerRef.set(
      {
        governanceReviewerEmail: FieldValue.delete(),
        governanceReviewerUid: FieldValue.delete(),
        governanceReviewerAssignedAt: FieldValue.delete(),
      },
      { merge: true }
    );

    await adminDb.collection("users").doc(reviewerUid).set(
      {
        governanceReviewerFor: FieldValue.arrayRemove(uid),
      },
      { merge: true }
    );

    return NextResponse.json({ ok: true, message: "Reviewer removed." });
  }

  return NextResponse.json(
    { ok: false, error: { code: "validation_error", message: "Unknown action." } },
    { status: 400 }
  );
}
