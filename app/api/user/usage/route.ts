/**
 * User Usage API Route
 * 
 * Returns the current user's plan and usage information from Firestore.
 * Applies the same month-reset logic as checkAndIncrementUsageForRun to ensure consistency.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { PlanId, BillingInterval, getPlanConfig } from "@/lib/plans";
import { UserProfile } from "@/lib/types";
import { validateUserSubscription } from "@/lib/stripe/subscriptionValidation";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { logger } from "@/lib/logger";
import { planHasTeamGovernance } from "@/lib/plans";
import { isAdminEmail } from "@/lib/admin/config";
import { parseGovernanceReviewerFor } from "@/lib/governance/reviewerFields";
import { getVideoLimit } from "@/lib/billing/planConfig";
import { resolvePersonalWorkspaceUiMode } from "@/lib/workspaces/workspaceUiRollout";
import { resolveProjectsUiEligibility } from "@/lib/projects/projectsUiEligibility";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { resolveTeamWorkspacesMode } from "@/lib/workspaces/teamWorkspacesRollout";
import { resolveViewerTeamWorkspaceSelection } from "@/lib/workspaces/resolveViewerTeamWorkspaceSelection";
import {
  PERSONAL_WORKSPACE_UI_ENABLED,
  PERSONAL_WORKSPACE_UI_CANARY_UIDS,
  PROJECTS_UI_ENABLED,
  PROJECTS_UI_CANARY_UIDS,
  PROJECTS_ENABLED,
  PROJECTS_CANARY_UIDS,
  APPROVAL_WORKFLOW_ENABLED,
  APPROVAL_WORKFLOW_CANARY_UIDS,
  TEAM_WORKSPACES_ENABLED,
  TEAM_WORKSPACES_CANARY_UIDS,
} from "@/lib/env";

/**
 * Phase 5C — the single call site computing `workspaceUiEnabled` for this
 * endpoint's two success responses. Never trusts a client-supplied uid —
 * always the server-resolved `identity.uid` from `resolveRequestIdentity()`
 * above. `resolvePersonalWorkspaceUiMode()` owns all precedence/parsing
 * logic; this is never re-derived inline.
 */
function workspaceUiEnabledFor(uid: string): boolean {
  return resolvePersonalWorkspaceUiMode({
    uid,
    globalEnabled: PERSONAL_WORKSPACE_UI_ENABLED,
    canaryUidsRaw: PERSONAL_WORKSPACE_UI_CANARY_UIDS,
  }).enabled;
}

/**
 * Phase 7B — the single call site computing `projectsUiEnabled` for this
 * endpoint's two success responses. Mirrors `workspaceUiEnabledFor()`
 * exactly, except the underlying decision is the combined (UI AND
 * backend) one from `resolveProjectsUiEligibility()`, never the UI
 * resolver alone.
 */
function projectsUiEnabledFor(uid: string): boolean {
  return resolveProjectsUiEligibility({
    uid,
    uiGlobalEnabled: PROJECTS_UI_ENABLED,
    uiCanaryUidsRaw: PROJECTS_UI_CANARY_UIDS,
    backendGlobalEnabled: PROJECTS_ENABLED,
    backendCanaryUidsRaw: PROJECTS_CANARY_UIDS,
  });
}

/**
 * Phase 9C.1 — the single call site computing `workspaceReviewsUiEnabled`.
 * Mirrors `workspaceUiEnabledFor()`/`projectsUiEnabledFor()`'s own
 * established pattern (a nav-visibility signal derived from the SAME
 * rollout/admission machinery every Phase 9 route already uses, never a
 * new client-side authorization system).
 *
 * Phase 9C.1-R1C: this is now purely an EXISTENCE signal — "does this uid
 * have Approval Workflow admission, Team Workspace admission, and at
 * least one active Team Workspace membership" — never a per-Workspace
 * capability check, and never a Workspace selection. The removed
 * predecessor called `resolveTeamRunWorkspaceAccess()` here to check
 * `research.read`/`reviews.read` for ONE discovered Workspace; that no
 * longer makes sense once a uid may have several active memberships with
 * potentially different roles/capabilities in each — this boolean cannot
 * encode "for which one." `/workspace/reviews/page.tsx` remains the sole
 * authority for whether a given Workspace is actually reachable; this
 * flag only decides whether the nav link is worth showing at all.
 * `resolveApprovalWorkflowAdmission()` and `resolveTeamWorkspacesMode()`
 * are both pure/zero-I/O and checked first, so the non-canary majority of
 * requests never reach the bounded Firestore scan below — mirroring the
 * "cheapest gate first" convention used by every other Phase 9 route.
 */
async function workspaceReviewsUiEnabledFor(uid: string): Promise<boolean> {
  const admission = resolveApprovalWorkflowAdmission({ uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  if (!admission.admitted) return false;
  const teamRollout = resolveTeamWorkspacesMode({ uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS });
  if (!teamRollout.enabled) return false;
  const selection = await resolveViewerTeamWorkspaceSelection(uid);
  return selection.kind === "single" || selection.kind === "multiple";
}

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

function computeGovernanceDashboardAccess(params: { planId: PlanId; authEmail: string }): {
  governanceDashboardEligible: boolean;
  governanceDenyReason: "wrong_plan" | "wrong_role" | null;
} {
  if (params.authEmail && isAdminEmail(params.authEmail)) {
    return { governanceDashboardEligible: true, governanceDenyReason: null };
  }
  if (params.planId !== "full") {
    return { governanceDashboardEligible: false, governanceDenyReason: "wrong_plan" };
  }
  return { governanceDashboardEligible: true, governanceDenyReason: null };
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
    // Authenticate user — Auth Identity Consistency Remediation, Step 7:
    // resolves via the shared, hardened resolver (considers cookie AND
    // bearer, fails closed on a confirmed identity mismatch) rather than
    // this route's own duplicated cookie-first logic. Response shape for
    // auth failures is unchanged: {ok:false, errorCode, message}.
    const identity = await resolveRequestIdentity(req);
    if (identity.status !== "authenticated") {
      logIdentityResolutionFailure({ route: "GET /api/user/usage", method: "GET", failureCategory: identity.reason });
      if (identity.reason === "missing_credentials") {
        return NextResponse.json(
          { ok: false, errorCode: "unauthorized", message: "Please sign in to view usage." },
          { status: 401 }
        );
      }
      return NextResponse.json(
        { ok: false, errorCode: "auth_error", message: "Authentication failed. Please sign in again." },
        { status: 401 }
      );
    }
    const uid = identity.uid;

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
      const govNew = computeGovernanceDashboardAccess({ planId: "free", authEmail });
      return NextResponse.json(
        {
          ok: true,
          plan: "free",
          runsThisMonth: 0,
          usageMonth: currentMonth,
          monthlyLimit: config.maxRunsPerMonth,
          maxModelsPerRun: config.maxModelsPerRun,
          videoRunsThisMonth: 0,
          videoLimit: 0,
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
          workspaceUiEnabled: workspaceUiEnabledFor(uid),
          projectsUiEnabled: projectsUiEnabledFor(uid),
          workspaceReviewsUiEnabled: await workspaceReviewsUiEnabledFor(uid),
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
    let currentVideoRuns =
      typeof userData?.videoRunsThisMonth === "number" ? userData.videoRunsThisMonth : 0;

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
      currentVideoRuns = 0;
      // Optionally reset in DB (but don't block the response)
      adminDb.collection("users").doc(uid).update({
        runsThisMonth: 0,
        videoRunsThisMonth: 0,
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

    const govDash = computeGovernanceDashboardAccess({ planId: plan, authEmail });
    const videoLimit = getVideoLimit(plan);

    return NextResponse.json(
      {
        ok: true,
        plan,
        runsThisMonth: currentRuns,
        usageMonth: currentMonth,
        monthlyLimit,
        maxModelsPerRun,
        billingInterval, // "month" | "year" | null - set by webhook when subscription is created/updated
        videoRunsThisMonth: currentVideoRuns,
        videoLimit,
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
        workspaceUiEnabled: workspaceUiEnabledFor(uid),
        projectsUiEnabled: projectsUiEnabledFor(uid),
        workspaceReviewsUiEnabled: await workspaceReviewsUiEnabledFor(uid),
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
        videoRunsThisMonth: 0,
        videoLimit: 0,
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
        // Fails closed, matching every other flag in this degraded-safe-default
        // response — uid is out of scope here (identity resolution may not have
        // completed if the error happened before it), so this can never be
        // computed for a real identity; false is the only safe value.
        workspaceUiEnabled: false,
        projectsUiEnabled: false,
        workspaceReviewsUiEnabled: false,
      },
      { status: 200 }
    );
  }
}
