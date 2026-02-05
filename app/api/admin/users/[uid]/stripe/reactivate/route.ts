/**
 * Admin Stripe Subscription Reactivation Endpoint
 * 
 * Reactivate a subscription scheduled for cancellation.
 * Route: POST /api/admin/users/[uid]/stripe/reactivate
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
    const userDocRef = adminDb.collection("users").doc(uid);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
    }

    const userDataBefore = userDoc.data()!;
    const subscriptionId = userDataBefore.stripeSubscriptionId;

    if (!subscriptionId) {
      return NextResponse.json(
        { ok: false, error: "User has no Stripe subscription" },
        { status: 400 }
      );
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    if (!subscription.cancel_at_period_end) {
      return NextResponse.json(
        { ok: false, error: "Subscription is not scheduled for cancellation" },
        { status: 400 }
      );
    }

    const requestId = generateRequestId();

    // Remove cancellation flag
    const updatedSubscription: Stripe.Subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });

    // Sync to Firestore
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
      actionType: "REACTIVATE_SUB",
      before: createUserSnapshot(userDataBefore),
      after: createUserSnapshot(userDataAfter),
      requestId,
      metadata: { subscriptionId },
    });

    return NextResponse.json({
      ok: true,
      message: "Subscription reactivated",
      subscription: {
        id: updatedSubscription.id,
        status: updatedSubscription.status,
        cancelAtPeriodEnd: updatedSubscription.cancel_at_period_end,
      },
    });
  } catch (error: any) {
    console.error(`[admin/users/${params.uid}/stripe/reactivate] Error:`, error);
    return NextResponse.json(
      { ok: false, error: "Internal server error", message: error.message },
      { status: 500 }
    );
  }
}

