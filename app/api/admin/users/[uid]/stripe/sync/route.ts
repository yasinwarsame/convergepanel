/**
 * Admin Stripe Sync Endpoint
 * 
 * Force sync of Stripe subscription state to Firestore.
 * Route: POST /api/admin/users/[uid]/stripe/sync
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/firebase/auth-helpers";
import { adminDb } from "@/lib/firebase/admin";
import { stripe } from "@/lib/stripe/client";
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
    const customerId = userDataBefore.stripeCustomerId;
    const subscriptionId = userDataBefore.stripeSubscriptionId;

    const requestId = generateRequestId();

    if (!subscriptionId && customerId) {
      // List subscriptions for this customer
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        limit: 1,
        status: "all",
      });

      if (subscriptions.data.length > 0) {
        await syncSubscriptionToFirestore(uid, subscriptions.data[0]);
      } else {
        await syncSubscriptionToFirestore(uid, null);
      }
    } else if (subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await syncSubscriptionToFirestore(uid, subscription);
    } else {
      await syncSubscriptionToFirestore(uid, null);
    }

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
      actionType: "SYNC_STRIPE",
      before: createUserSnapshot(userDataBefore),
      after: createUserSnapshot(userDataAfter),
      requestId,
      metadata: { customerId, subscriptionId },
    });

    return NextResponse.json({
      ok: true,
      message: "Stripe subscription synced to Firestore",
    });
  } catch (error: any) {
    console.error(`[admin/users/${params.uid}/stripe/sync] Error:`, error);
    return NextResponse.json(
      { ok: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

