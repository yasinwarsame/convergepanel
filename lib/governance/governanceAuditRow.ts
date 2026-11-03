/**
 * Research deletion integrity (owner decision 2026-11-03): the `admin_audit_logs` row that `writeAuditEvent`
 * (lib/governance/auditLog.ts) writes, built so that a caller can create it INSIDE a transaction guarded by the deletion
 * barrier (researchDeletionBarrier.ts).
 *
 * `writeAuditEvent` writes outside any transaction, and its rows carry research text (the question, reviewer comments).
 * A row written after a completed deletion would re-expose deleted text. `auditLog.ts` is frozen by the Order 6 boundary
 * suites, so research-run callers create the row through this builder in their own guarded transaction. The builder is
 * field-for-field the same as `writeAuditEvent`:
 *   - `question`, when a string, is trimmed and cut to 200 characters;
 *   - `at` is stamped with the current ISO time;
 *   - the row passes through `sanitizeForFirestore`.
 * Callers for verification and video documents still use `writeAuditEvent` unchanged.
 */
import "server-only";
import type { DocumentData } from "firebase-admin/firestore";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";

export const GOVERNANCE_AUDIT_COLLECTION = "admin_audit_logs";

export function buildGovernanceAuditRow(event: Record<string, any>, now: () => string = () => new Date().toISOString()): DocumentData {
  const q = typeof event.question === "string" ? event.question.trim().substring(0, 200) : event.question;
  return sanitizeForFirestore({ ...event, question: q, at: now() }) as DocumentData;
}

/** Creates the row in `tx` under a fresh auto id. */
export function createGovernanceAuditRowInTx(tx: FirebaseFirestore.Transaction, db: FirebaseFirestore.Firestore, event: Record<string, any>): FirebaseFirestore.DocumentReference {
  const ref = db.collection(GOVERNANCE_AUDIT_COLLECTION).doc();
  tx.create(ref, buildGovernanceAuditRow(event));
  return ref;
}
