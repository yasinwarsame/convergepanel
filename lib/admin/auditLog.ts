/**
 * Admin Audit Logging
 * 
 * Logs all admin actions to Firestore for audit trail.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";

/**
 * Admin action types
 */
export type AdminActionType =
  | "GRANT_OVERRIDE"
  | "REMOVE_OVERRIDE"
  | "CANCEL_SUB"
  | "REACTIVATE_SUB"
  | "SYNC_STRIPE"
  | "UPDATE_ENTITLEMENTS"
  | "OTHER";

/**
 * Audit log entry
 */
export interface AuditLogEntry {
  adminUid: string;
  adminEmail?: string;
  targetUid: string;
  targetEmail?: string;
  actionType: AdminActionType;
  before: Record<string, any>;
  after: Record<string, any>;
  createdAt: Timestamp;
  requestId: string;
  metadata?: Record<string, any>;
}

/**
 * Write audit log entry
 */
export async function writeAuditLog(entry: Omit<AuditLogEntry, "createdAt">): Promise<void> {
  if (!adminDb) {
    console.error("[auditLog] Firestore not available");
    return;
  }

  try {
    const auditEntry: AuditLogEntry = {
      ...entry,
      createdAt: Timestamp.now(),
    };

    await adminDb.collection("admin_audit_logs").add(auditEntry);
    
    console.log("[auditLog] ✅ Audit log written:", {
      actionType: entry.actionType,
      adminUid: entry.adminUid,
      targetUid: entry.targetUid,
    });
  } catch (error: any) {
    console.error("[auditLog] ❌ Failed to write audit log:", error.message);
  }
}

/**
 * Generate a request ID for tracking
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Get user email from UID
 */
export async function getUserEmail(uid: string): Promise<string | undefined> {
  if (!adminDb) return undefined;

  try {
    const userDoc = await adminDb.collection("users").doc(uid).get();
    return userDoc.data()?.email;
  } catch {
    return undefined;
  }
}

/**
 * Create user snapshot for audit logging
 */
export function createUserSnapshot(userData: any): Record<string, any> {
  return {
    plan: userData?.plan || null,
    planFromStripe: userData?.planFromStripe || null,
    subscriptionStatusFromStripe: userData?.subscriptionStatusFromStripe || userData?.subscriptionStatus || null,
    stripeCustomerId: userData?.stripeCustomerId || null,
    stripeSubscriptionId: userData?.stripeSubscriptionId || null,
    currentPeriodEnd: userData?.currentPeriodEnd || null,
    override: userData?.override || null,
    entitlements: userData?.entitlements || null,
    monthlyLimit: userData?.monthlyLimit || null,
    maxModelsPerRun: userData?.maxModelsPerRun || null,
  };
}

