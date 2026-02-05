/**
 * Admin Override Management Endpoint
 * 
 * Grant or remove plan overrides for users.
 * Routes:
 * - POST /api/admin/users/[uid]/override - Grant override
 * - DELETE /api/admin/users/[uid]/override - Remove override
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/firebase/auth-helpers";
import { adminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { writeAuditLog, createUserSnapshot, generateRequestId, getUserEmail } from "@/lib/admin/auditLog";
import { getUserEffectiveEntitlement, PLAN_LIMITS, entitlementPlanToPlanId } from "@/lib/admin/entitlements";
import { getPlanConfig } from "@/lib/plans";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

/**
 * POST - Grant override
 */
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

    const { uid } = params;
    const body = await request.json();
    const { plan, reason, expiresAt } = body;

    // Validate plan
    if (plan !== "3_models" && plan !== "5_models") {
      return NextResponse.json(
        { ok: false, error: "Invalid plan. Must be '3_models' or '5_models'" },
        { status: 400 }
      );
    }

    const validatedPlan = plan as "3_models" | "5_models";

    // Validate reason
    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: "Reason is required" },
        { status: 400 }
      );
    }

    // Parse expiresAt if provided
    let expiresAtTimestamp: Timestamp | null = null;
    if (expiresAt) {
      const expiryDate = new Date(expiresAt);
      if (isNaN(expiryDate.getTime())) {
        return NextResponse.json(
          { ok: false, error: "Invalid expiresAt date format" },
          { status: 400 }
        );
      }
      expiresAtTimestamp = Timestamp.fromDate(expiryDate);
    }

    // Get user document
    const userDocRef = adminDb.collection("users").doc(uid);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
    }

    const userDataBefore = userDoc.data()!;
    const requestId = generateRequestId();
    const limits = PLAN_LIMITS[validatedPlan];

    // Create override object
    const override = {
      plan: validatedPlan,
      runLimitMonthly: limits.runsPerMonth,
      active: true,
      reason: reason.trim(),
      grantedByAdminUid: auth.uid,
      grantedAt: Timestamp.now(),
      expiresAt: expiresAtTimestamp,
    };

    const planId = entitlementPlanToPlanId(validatedPlan);
    const planConfig = getPlanConfig(planId);

    // Update user document
    await userDocRef.update({
      override,
      entitlements: {
        planEffective: validatedPlan,
        runLimitMonthly: limits.runsPerMonth,
        source: "override",
        updatedAt: Timestamp.now(),
      },
      monthlyLimit: limits.runsPerMonth,
      maxModelsPerRun: limits.maxModels,
      plan: planId,
    });

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
      actionType: "GRANT_OVERRIDE",
      before: createUserSnapshot(userDataBefore),
      after: createUserSnapshot(userDataAfter),
      requestId,
      metadata: { plan: validatedPlan, reason, expiresAt: expiresAtTimestamp?.toDate()?.toISOString() || null },
    });

    return NextResponse.json({
      ok: true,
      message: `Override granted: ${validatedPlan} plan`,
    });
  } catch (error: any) {
    console.error(`[admin/users/${params.uid}/override] Error:`, error);
    return NextResponse.json(
      { ok: false, error: "Internal server error", message: error.message },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Remove override
 */
export async function DELETE(
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
    const userDocRef = adminDb.collection("users").doc(uid);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
    }

    const userDataBefore = userDoc.data()!;

    if (!userDataBefore.override) {
      return NextResponse.json({ ok: false, error: "No override to remove" }, { status: 400 });
    }

    const requestId = generateRequestId();

    // Remove override
    await userDocRef.update({
      override: null,
    });

    // Recalculate entitlement
    const entitlement = await getUserEffectiveEntitlement(uid);
    const planId = entitlementPlanToPlanId(entitlement.plan);
    const planConfig = getPlanConfig(planId);

    await userDocRef.update({
      entitlements: {
        planEffective: entitlement.plan,
        runLimitMonthly: entitlement.runLimitMonthly,
        source: entitlement.source,
        updatedAt: Timestamp.now(),
      },
      monthlyLimit: entitlement.runLimitMonthly,
      maxModelsPerRun: entitlement.maxModelsPerRun,
      plan: planId,
    });

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
      actionType: "REMOVE_OVERRIDE",
      before: createUserSnapshot(userDataBefore),
      after: createUserSnapshot(userDataAfter),
      requestId,
    });

    return NextResponse.json({
      ok: true,
      message: "Override removed",
      entitlement: {
        plan: entitlement.plan,
        source: entitlement.source,
      },
    });
  } catch (error: any) {
    console.error(`[admin/users/${params.uid}/override] Error:`, error);
    return NextResponse.json(
      { ok: false, error: "Internal server error", message: error.message },
      { status: 500 }
    );
  }
}

