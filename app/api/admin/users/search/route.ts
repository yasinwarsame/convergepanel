/**
 * Admin User Search Endpoint
 * 
 * Search users by email, name, or UID.
 * Route: GET /api/admin/users/search?email=...&name=...&uid=...
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/firebase/auth-helpers";
import { adminDb } from "@/lib/firebase/admin";
import { getUserEffectiveEntitlement } from "@/lib/admin/entitlements";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    if (!adminDb) {
      throw new Error("Firestore is not available");
    }

    const searchParams = request.nextUrl.searchParams;
    const emailQuery = searchParams.get("email")?.toLowerCase() || "";
    const nameQuery = searchParams.get("name")?.toLowerCase() || "";
    const uidQuery = searchParams.get("uid") || "";

    if (!emailQuery && !nameQuery && !uidQuery) {
      return NextResponse.json({ ok: true, users: [] });
    }

    let usersSnapshot;
    
    if (uidQuery) {
      const userDoc = await adminDb.collection("users").doc(uidQuery).get();
      usersSnapshot = userDoc.exists ? { docs: [userDoc] } : { docs: [] };
    } else {
      usersSnapshot = await adminDb.collection("users").get();
    }

    const users = await Promise.all(
      usersSnapshot.docs
        .filter((doc) => {
          const data = doc.data();
          if (!data) return false;
          const email = String(data.email || "").toLowerCase();
          const name = String(data.name || "").toLowerCase();
          const uid = String(doc.id).toLowerCase();

          if (uidQuery) {
            return uid.includes(uidQuery.toLowerCase());
          }

          const matchesEmail = emailQuery ? email.includes(emailQuery) : true;
          const matchesName = nameQuery ? name.includes(nameQuery) : true;

          return matchesEmail && matchesName;
        })
        .slice(0, 50)
        .map(async (doc) => {
          const data = doc.data();
          if (!data) {
            return null;
          }
          const entitlement = await getUserEffectiveEntitlement(doc.id);

          return {
            uid: doc.id,
            email: data.email || null,
            name: data.name || null,
            plan: data.plan || "free",
            planEffective: entitlement.plan,
            runLimitMonthly: entitlement.runLimitMonthly,
            maxModelsPerRun: entitlement.maxModelsPerRun,
            source: entitlement.source,
            runsThisMonth: data.runsThisMonth || 0,
            usageMonth: data.usageMonth || null,
            stripeCustomerId: data.stripeCustomerId || null,
            stripeSubscriptionId: data.stripeSubscriptionId || null,
            subscriptionStatus: data.subscriptionStatusFromStripe || data.subscriptionStatus || null,
            currentPeriodEnd: data.currentPeriodEnd || null,
            override: data.override || null,
            isDisabled: data.isDisabled || false,
          };
        })
    );

    // Filter out null entries
    const filteredUsers = users.filter((u): u is NonNullable<typeof u> => u !== null);

    return NextResponse.json({ ok: true, users: filteredUsers });
  } catch (error: any) {
    console.error("[admin/users/search] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Internal server error", message: error.message },
      { status: 500 }
    );
  }
}

