/**
 * Governance API access: 5-model plan or support email (policy read, etc.).
 * Run-level scoping uses resolveGovernanceVisibleUserIds (queue / audit drilldown / review).
 */

import "server-only";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAdminEmail } from "@/lib/admin/config";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { parseGovernanceReviewerFor } from "@/lib/governance/reviewerFields";

export type GovernanceAccessDenyReason = "wrong_plan" | "wrong_role" | "unauthorized";

export type GovernanceAccessResult = {
  allowed: boolean;
  role: "admin" | "reviewer" | null;
  plan: "free" | "lite" | "full";
  denyReason?: GovernanceAccessDenyReason;
  /** True when email is on support allowlist. */
  isSupportAdmin: boolean;
  /** Assigners who assigned this user as reviewer (metadata; queue uses resolveGovernanceVisibleUserIds). */
  reviewerAssignerUserIds: string[];
};

export async function checkGovernanceAccess(uid: string, email: string): Promise<GovernanceAccessResult> {
  const baseDeny = (
    plan: "free" | "lite" | "full",
    denyReason: GovernanceAccessDenyReason
  ): GovernanceAccessResult => ({
    allowed: false,
    role: null,
    plan,
    denyReason,
    isSupportAdmin: false,
    reviewerAssignerUserIds: [],
  });

  if (isAdminEmail(email)) {
    return {
      allowed: true,
      role: "admin",
      plan: "full",
      isSupportAdmin: true,
      reviewerAssignerUserIds: [],
    };
  }

  if (!adminDb) {
    return baseDeny("free", "unauthorized");
  }

  const entitlements = await getEffectiveEntitlements(uid);
  const plan = entitlements.planId;

  if (plan !== "full") {
    return baseDeny(plan, "wrong_plan");
  }

  const userDoc = await adminDb.collection("users").doc(uid).get();
  const userData = userDoc.data() as Record<string, unknown> | undefined;
  const reviewerFor = parseGovernanceReviewerFor(userData);

  return {
    allowed: true,
    role: reviewerFor.length > 0 ? "reviewer" : null,
    plan,
    isSupportAdmin: false,
    reviewerAssignerUserIds: reviewerFor,
  };
}

/** App support only — Firestore org "admin" does not grant policy edits. */
export async function checkAdminOnly(_uid: string, email: string): Promise<boolean> {
  void _uid;
  return isAdminEmail(email);
}

export function governanceAccessForbiddenResponse(access: GovernanceAccessResult): NextResponse {
  if (access.denyReason === "wrong_plan") {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "plan_required",
          message: "Governance features are available on the 5-Model plan.",
          requiredPlan: "full",
        },
      },
      { status: 403 }
    );
  }
  if (access.denyReason === "wrong_role") {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "role_required",
          message:
            "The governance dashboard is for reviewers. Ask a colleague on the 5-Model plan to assign you as their reviewer in Profile, or enable reviewer availability so others can assign you.",
          requiredRole: "reviewer",
        },
      },
      { status: 403 }
    );
  }
  return NextResponse.json(
    { ok: false, error: { code: "forbidden", message: "Access denied." } },
    { status: 403 }
  );
}

export async function resolveGovernanceRequestUser(
  request: NextRequest
): Promise<{ ok: true; uid: string; email: string } | { ok: false; status: 401 }> {
  if (!adminAuth) {
    return { ok: false, status: 401 };
  }

  let uid: string | null = null;
  try {
    const session = await verifySessionCookie(request);
    if (session?.uid) uid = session.uid;
  } catch {
    /* invalid session cookie — try bearer */
  }

  if (!uid) {
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const decoded = await verifyIdToken(authHeader.slice(7));
        uid = decoded.uid;
      } catch {
        return { ok: false, status: 401 };
      }
    }
  }

  if (!uid) {
    return { ok: false, status: 401 };
  }

  try {
    const u = await adminAuth.getUser(uid);
    return { ok: true, uid, email: u.email ?? "" };
  } catch {
    return { ok: false, status: 401 };
  }
}
