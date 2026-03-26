/**
 * Append-only global governance audit log (top-level collection).
 */

import "server-only";
import type { DocumentData } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";

export type GovernanceAuditLogAction =
  | "evaluated"
  | "approved"
  | "blocked"
  | "changes_requested"
  | "policy_updated"
  | "admin_override"
  | "admin_deleted";

export async function writeAuditEvent(event: Record<string, any>): Promise<void> {
  if (!adminDb) return;
  try {
    console.log("[governance/audit] Writing audit event:", event.action, event.runId);
    const q =
      typeof event.question === "string" ? event.question.trim().substring(0, 200) : event.question;
    const ref = await adminDb.collection("admin_audit_logs").add(
      sanitizeForFirestore({
        ...event,
        question: q,
        at: new Date().toISOString(),
      }) as DocumentData
    );
    console.log("[governance/audit] Event written to admin_audit_logs:", ref.id);
  } catch (err) {
    console.error("[governance/audit] FAILED to write audit event:", err);
  }
}
