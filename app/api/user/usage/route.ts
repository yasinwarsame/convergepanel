/**
 * User Usage API Route
 * 
 * Returns the current user's plan and usage information from Firestore.
 * Applies the same month-reset logic as checkAndIncrementUsageForRun to ensure consistency.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { PlanId, BillingInterval, getPlanConfig } from "@/lib/plans";
import { UserProfile } from "@/lib/types";
import { validateUserSubscription } from "@/lib/stripe/subscriptionValidation";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { logger } from "@/lib/logger";
import { planHasTeamGovernance } from "@/lib/plans";
import { isAdminEmail } from "@/lib/admin/config";
import { parseGovernanceReviewerFor } from "@/lib/governance/reviewerFields";

function clientGovernanceRole(
  userData: Partial<UserProfile> | undefined,
  authEmail: string
): string {
  if (authEmail && isAdminEmail(authEmail)) return "admin";
  const r = userData?.role;
  if (r === "admin" || r === "reviewer") return r;
  const email = typeof userData?.email === "string" ? userData.email : "";
  if (email && isAdminEmail(email)) return "admin";
  return "member";
}

function computeGovernanceDashboardAccess(params: {
  planId: PlanId;
  authEmail: string;
  governanceReviewerFor: string[];
}): {
  governanceDashboardEligible: boolean;
  governanceDenyReason: "wrong_plan" | "wrong_role" | null;
} {
  if (params.authEmail && isAdminEmail(params.authEmail)) {
    return { governanceDashboardEligible: true, governanceDenyReason: null };
  }
  if (params.planId !== "full") {
    return { governanceDashboardEligible: false, governanceDenyReason: "wrong_plan" };
  }
  if (params.governanceReviewerFor.length > 0) {
    return { governanceDashboardEligible: true, governanceDenyReason: null };
  }
  return { governanceDashboardEligible: false, governanceDenyReason: "wrong_role" };
}

async function authUserEmail(uid: string): Promise<string> {
  if (!adminAuth) return "";
  try {
    const rec = await adminAuth.getUser(uid);
    return rec.email ?? "";
  } catch {
    return "";
  }
}

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Get user usage from Firestore
 * 
 * Returns the user's plan, runs used this month, and monthly limit.
 * Applies month-reset logic to ensure stale months don't permanently show 8/8.
 */
export async function GET(req: NextRequest) {
  try {
    // Authenticate user
    let uid: string;
    try {
      const auth = await verifySessionCookie(req);
      
      if (auth) {
        uid = auth.uid;
      } else {
        // Fallback to Bearer token
        const authHeader = req.headers.get("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return NextResponse.json(
            {
              ok: false,
              errorCode: "unauthorized",
              message: "Please sign in to view usage.",
            },
            { status: 401 }
          );
        }
        const token = authHeader.split("Bearer ")[1];
        const decodedToken = await verifyIdToken(token);
        uid = decodedToken.uid;
      }
    } catch (authError: any) {
      logger.error("[user/usage] Authentication error", { error: authError?.message });
      return NextResponse.json(
        {
          ok: false,
          errorCode: "auth_error",
          message: "Authentication failed. Please sign in again.",
        },
        { status: 401 }
      );
    }

    if (!adminDb) {
      logger.error("[user/usage] Firestore is not available");
      return NextResponse.json(
        {
          ok: false,
          errorCode: "internal_error",
          message: "Database unavailable. Please try again later.",
        },
        { status: 500 }
      );
    }

    const authEmail = await authUserEmail(uid);

    // Get current month for calendar-based tracking
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    // Load user document
    const userDoc = await adminDb.collection("users").doc(uid).get();

    if (!userDoc.exists) {
      // Initialize new user with free plan
      await adminDb.collection("users").doc(uid).set(
        {
          plan: "free",
          runsThisMonth: 0,
          usageMonth: currentMonth,
        },
        { merge: true }
      );
      
      const config = getPlanConfig("free");
      const newUserRole = clientGovernanceRole(undefined, authEmail);
      const govNew = computeGovernanceDashboardAccess({
        planId: "free",
        authEmail,
        governanceReviewerFor: [],
      });
      return NextResponse.json(
        {
          ok: true,
          plan: "free",
          runsThisMonth: 0,
          usageMonth: currentMonth,
          monthlyLimit: config.maxRunsPerMonth,
          maxModelsPerRun: config.maxModelsPerRun,
          teamId: null,
          teamRole: null,
          teamGovernanceEligible: false,
          role: newUserRole,
          governanceDashboardEligible: govNew.governanceDashboardEligible,
          governanceDenyReason: govNew.governanceDenyReason,
          governancePolicyEditable: !!(authEmail && isAdminEmail(authEmail)),
          governanceReviewerFor: [] as string[],
          governanceReviewerEnabled: false,
          governanceAssignedReviewerEmail: null as string | null,
        },
        { status: 200 }
      );
    }

    const userData = userDoc.data() as Partial<UserProfile>;
    
    // Get effective entitlements (respects admin override > Stripe > free)
    const entitlements = await getEffectiveEntitlements(uid);
    
    // Use effective entitlements as source of truth
    const plan = entitlements.planId;
    const monthlyLimit = entitlements.monthlyLimit;
    const maxModelsPerRun = entitlements.maxModelsPerRun;
    const storedMonth = userData?.usageMonth || currentMonth;
    let currentRuns = userData?.runsThisMonth ?? 0;

    // Validate subscription status for paid plans (best-effort, non-blocking)
    // This ensures Firestore stays in sync with Stripe even if webhooks fail
    // BUT: Skip validation if admin override is active (don't downgrade override)
    if (entitlements.source !== "override" && plan !== "free" && userData?.stripeCustomerId) {
      try {
        // Run validation asynchronously - don't block the response
        validateUserSubscription(uid, userData.stripeCustomerId).catch((validationError: any) => {
          // Log but don't throw - validation is best-effort
          logger.warn("[user/usage] Subscription validation failed (non-blocking)", {
            uid,
            error: validationError?.message,
          });
        });
      } catch (validationError: any) {
        // Log but don't block - validation is best-effort
        logger.warn("[user/usage] Subscription validation error (non-blocking)", {
          uid,
          error: validationError?.message,
        });
      }
    }
    
    // Read billingInterval from Firestore (monthly or yearly subscription)
    // This is set by the webhook when subscription is created/updated
    const billingInterval = (userData?.billingInterval as BillingInterval | undefined) || null;
    
    // Apply the same month-reset logic as checkAndIncrementUsageForRun
    const isNewMonth = storedMonth !== currentMonth;
    if (isNewMonth) {
      currentRuns = 0;
      // Optionally reset in DB (but don't block the response)
      adminDb.collection("users").doc(uid).update({
        runsThisMonth: 0,
        usageMonth: currentMonth,
        billingCycleStart: now.toISOString(),
      }).catch((err) => {
        logger.error("[user/usage] Failed to reset usage for new month", { error: err?.message });
      });
    }

    // Debug: log effective entitlements source (verbose - debug level)
    logger.debug("[user/usage] Returning usage data", {
      plan,
      runsThisMonth: currentRuns,
      storedMonth,
      currentMonth,
      isNewMonth,
      monthlyLimit,
      maxModelsPerRun,
      entitlementSource: entitlements.source,
    });

    const role = clientGovernanceRole(userData, authEmail);
    const governanceReviewerFor = parseGovernanceReviewerFor(userData as Record<string, unknown>);
    const governanceReviewerEnabled = userData?.governanceReviewerEnabled === true;
    const assignedEmail =
      typeof userData?.governanceReviewerEmail === "string" && userData.governanceReviewerEmail.trim()
        ? userData.governanceReviewerEmail.trim()
        : null;

    const govDash = computeGovernanceDashboardAccess({
      planId: plan,
      authEmail,
      governanceReviewerFor,
    });

    return NextResponse.json(
      {
        ok: true,
        plan,
        runsThisMonth: currentRuns,
        usageMonth: currentMonth,
        monthlyLimit,
        maxModelsPerRun,
        billingInterval, // "month" | "year" | null - set by webhook when subscription is created/updated
        teamId: userData?.teamId ?? null,
        teamRole: userData?.teamRole ?? null,
        teamGovernanceEligible: planHasTeamGovernance(plan),
        role,
        governanceDashboardEligible: govDash.governanceDashboardEligible,
        governanceDenyReason: govDash.governanceDenyReason,
        governancePolicyEditable: !!(authEmail && isAdminEmail(authEmail)),
        governanceReviewerFor,
        governanceReviewerEnabled,
        governanceAssignedReviewerEmail: assignedEmail,
      },
      { status: 200 }
    );
  } catch (err: any) {
    // Log any unexpected error on the server for debugging.
    logger.error("[/api/user/usage] Unexpected error", { error: err?.message });

    // Return a safe default that assumes free plan with 0 usage
    // This ensures the UI doesn't break if there's an unexpected error
    return NextResponse.json(
      {
        ok: true,
        plan: "free",
        runsThisMonth: 0,
        usageMonth: new Date().toISOString().slice(0, 7),
        monthlyLimit: 8,
        teamId: null,
        teamRole: null,
        teamGovernanceEligible: false,
        role: "member",
        governanceDashboardEligible: false,
        governanceDenyReason: "wrong_plan" as const,
        governancePolicyEditable: false,
        governanceReviewerFor: [] as string[],
        governanceReviewerEnabled: false,
        governanceAssignedReviewerEmail: null as string | null,
      },
      { status: 200 }
    );
  }
}
