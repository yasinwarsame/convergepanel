/**
 * Admin Stripe Subscription Cancellation Endpoint
 * 
 * Cancel a user's Stripe subscription.
 * Route: POST /api/admin/users/[uid]/stripe/cancel
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/firebase/auth-helpers";
import { adminDb } from "@/lib/firebase/admin";
import { stripe } from "@/lib/stripe/client";
import Stripe from "stripe";
import { writeAuditLog, createUserSnapshot, generateRequestId, getUserEmail } from "@/lib/admin/auditLog";
import { syncSubscriptionToFirestore } from "@/lib/admin/stripeSync";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

export async function POST(
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

    if (!stripe) {
      throw new Error("Stripe is not configured");
    }

    const { uid } = params;
    const body = await request.json();
    const { mode } = body; // "immediate" | "period_end"

    if (mode !== "immediate" && mode !== "period_end") {
      return NextResponse.json(
        { ok: false, error: "Invalid mode. Must be 'immediate' or 'period_end'" },
        { status: 400 }
      );
    }

    const userDocRef = adminDb.collection("users").doc(uid);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
    }

    const userDataBefore = userDoc.data()!;
    const subscriptionId = userDataBefore.stripeSubscriptionId;

    if (!subscriptionId) {
      return NextResponse.json(
        { ok: false, error: "User has no active Stripe subscription" },
        { status: 400 }
      );
    }

    const requestId = generateRequestId();

    // Cancel subscription in Stripe
    let updatedSubscription: Stripe.Subscription;
    if (mode === "immediate") {
      updatedSubscription = await stripe.subscriptions.cancel(subscriptionId);
    } else {
      updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      });
    }

    // Sync subscription state to Firestore
    await syncSubscriptionToFirestore(uid, updatedSubscription);

    const userDataAfter = (await userDocRef.get()).data()!;

    // Write audit log
    const [adminEmail, targetEmail] = await Promise.all([
      getUserEmail(auth.uid),
      getUserEmail(uid),
    ]);

    await writeAuditLog({
      adminUid: auth.uid,
      adminEmail,
      targetUid: uid,
      targetEmail,
      actionType: "CANCEL_SUB",
      before: createUserSnapshot(userDataBefore),
      after: createUserSnapshot(userDataAfter),
      requestId,
      metadata: {
        mode,
        subscriptionId,
        cancelAtPeriodEnd: (updatedSubscription as any).cancel_at_period_end || false,
      },
    });

    return NextResponse.json({
      ok: true,
      message: `Subscription ${mode === "immediate" ? "canceled immediately" : "scheduled for cancellation at period end"}`,
      subscription: {
        id: updatedSubscription.id,
        status: updatedSubscription.status,
        cancelAtPeriodEnd: (updatedSubscription as any).cancel_at_period_end || false,
        currentPeriodEnd: (updatedSubscription as any).current_period_end 
          ? new Date((updatedSubscription as any).current_period_end * 1000).toISOString()
          : null,
      },
    });
  } catch (error: any) {
    console.error(`[admin/users/${params.uid}/stripe/cancel] Error:`, error);
    return NextResponse.json(
      { ok: false, error: "Internal server error", message: error.message },
      { status: 500 }
    );
  }
}

