/**
 * Admin User Details Endpoint
 * 
 * Returns detailed user information including entitlements, Stripe status, and audit logs.
 * Route: GET /api/admin/users/[uid]/details
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/firebase/auth-helpers";
import { adminDb } from "@/lib/firebase/admin";
import { getUserEffectiveEntitlement, priceIdToPlan } from "@/lib/admin/entitlements";
import { stripe } from "@/lib/stripe/client";
import Stripe from "stripe";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: { uid: string } }
) {
  const auth = await requireAdmin(request);
  if (!auth) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    if (!adminDb) {
      throw new Error("Firestore is not available");
    }

    const { uid } = params;
    console.log(`[admin/users/${uid}/details] Fetching user details for UID:`, uid);
    
    if (!uid) {
      return NextResponse.json({ ok: false, error: "UID parameter is required" }, { status: 400 });
    }

    const userDoc = await adminDb.collection("users").doc(uid).get();
    console.log(`[admin/users/${uid}/details] User document exists:`, userDoc.exists);

    if (!userDoc.exists) {
      return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
    }

    const userData = userDoc.data()!;
    const entitlement = await getUserEffectiveEntitlement(uid);

    // Fetch Stripe subscription details if available
    let stripeSubscription: Stripe.Subscription | null = null;
    if (userData.stripeSubscriptionId && stripe) {
      try {
        stripeSubscription = await stripe.subscriptions.retrieve(userData.stripeSubscriptionId);
      } catch (err: any) {
        console.warn(`[admin/users/${uid}/details] Could not fetch Stripe subscription:`, err.message);
      }
    }

    // Get recent audit logs for this user (last 10)
    // Gracefully handle missing Firestore index - return empty logs with warning instead of 500
    let auditLogs: any[] = [];
    let auditWarning: string | null = null;
    
    try {
      const auditLogsSnapshot = await adminDb
        .collection("admin_audit_logs")
        .where("targetUid", "==", uid)
        .orderBy("createdAt", "desc")
        .limit(10)
        .get();

      auditLogs = auditLogsSnapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          adminUid: data.adminUid,
          adminEmail: data.adminEmail || null,
          actionType: data.actionType,
          before: data.before,
          after: data.after,
          createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt || null,
          requestId: data.requestId,
        };
      });
    } catch (error: any) {
      // Check if this is a missing index error
      const errorMessage = String(error?.message || "");
      if (
        errorMessage.includes("FAILED_PRECONDITION") &&
        (errorMessage.includes("requires an index") || errorMessage.includes("index"))
      ) {
        // Missing composite index - log warning but don't fail the request
        auditWarning = "Audit log index missing. Create a composite index on 'admin_audit_logs' with fields: targetUid (ASC) + createdAt (DESC) to enable audit log viewing.";
        console.warn(`[admin/users/${uid}/details] Missing Firestore index for audit logs query:`, error.message);
      } else {
        // Real unexpected error - log but still return user details
        console.error(`[admin/users/${uid}/details] Error fetching audit logs:`, error);
        auditWarning = "Failed to load audit logs due to an unexpected error.";
      }
    }

    // Calculate reset date
    const usageMonth = userData.usageMonth as string | undefined;
    let resetDate: string | null = null;
    if (usageMonth) {
      const [year, month] = usageMonth.split("-").map(Number);
      const nextMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
      resetDate = nextMonth.toISOString();
    }

    return NextResponse.json({
      ok: true,
      user: {
        uid,
        email: userData.email || null,
        name: userData.name || null,
        plan: userData.plan || "free",
        planFromStripe: userData.planFromStripe || null,
        subscriptionStatusFromStripe: userData.subscriptionStatusFromStripe || userData.subscriptionStatus || null,
        runsThisMonth: userData.runsThisMonth || 0,
        usageMonth: userData.usageMonth || null,
        resetDate,
        totalRuns: userData.totalRuns || 0,
        stripeCustomerId: userData.stripeCustomerId || null,
        stripeSubscriptionId: userData.stripeSubscriptionId || null,
        currentPeriodEnd: userData.currentPeriodEnd || null,
        billingInterval: userData.billingInterval || null,
        override: userData.override || null,
        entitlements: userData.entitlements || null,
        isDisabled: userData.isDisabled || false,
      },
      entitlement: {
        planEffective: entitlement.plan,
        runLimitMonthly: entitlement.runLimitMonthly,
        maxModelsPerRun: entitlement.maxModelsPerRun,
        source: entitlement.source,
      },
      stripe: stripeSubscription
        ? {
            subscriptionId: stripeSubscription.id,
            status: stripeSubscription.status,
            currentPeriodEnd: (stripeSubscription as any).current_period_end
              ? new Date((stripeSubscription as any).current_period_end * 1000).toISOString()
              : null,
            cancelAtPeriodEnd: (stripeSubscription as any).cancel_at_period_end || false,
            currentPriceId: stripeSubscription.items.data[0]?.price.id || null,
            priceIdPlan: priceIdToPlan(stripeSubscription.items.data[0]?.price.id),
          }
        : null,
      auditLogs,
      auditWarning,
    });
  } catch (error: any) {
    console.error(`[admin/users/${params.uid}/details] Error:`, error);
    return NextResponse.json(
      { ok: false, error: "Internal server error", message: error.message },
      { status: 500 }
    );
  }
}

