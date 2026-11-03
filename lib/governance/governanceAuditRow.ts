/**
 * Research deletion integrity (owner decision 2026-11-03): the `admin_audit_logs` row that `writeAuditEvent`
 * (lib/governance/auditLog.ts) writes, written for a RESEARCH RUN in a transaction guarded by the deletion barrier
 * (researchDeletionBarrier.ts).
 *
 * `writeAuditEvent` writes outside any transaction, and its rows carry research text (the question, reviewer comments).
 * A row written after a completed deletion would re-expose deleted text. `auditLog.ts` is frozen by the Order 6 boundary
 * suites, so research-run callers use `writeGuardedGovernanceAuditRow` instead. It keeps `writeAuditEvent`'s row and
 * failure contract:
 *   - the same row, field for field: `question`, when a string, is trimmed and cut to 200 characters; `at` is stamped
 *     with the current ISO time; the row passes through `sanitizeForFirestore`;
 *   - BEST-EFFORT. It never throws. A storage failure is logged with only the action, error name and error code, never
 *     the raw error, whose message and details repeat the document path (Phase FIRST-ADMIN-C8/C10). The caller's own
 *     writes are never rolled back or blocked by an audit failure.
 *
 * Two differences:
 *   - The barrier: a run that is deleted, being deleted or missing gets no row (`"refused"`).
 *   - On success it does not emit `writeAuditEvent`'s two operational `[governance/audit]` log lines (an observability
 *     difference only; reviewLogRedaction.spec.ts pins it).
 * Verification and video documents still use `writeAuditEvent` unchanged.
 */
import "server-only";
import type { DocumentData } from "firebase-admin/firestore";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { isResearchWriteRefusedError, runResearchWrite } from "@/lib/firestore/researchDeletionBarrier";
import { logger } from "@/lib/logger";

export const GOVERNANCE_AUDIT_COLLECTION = "admin_audit_logs";

export function buildGovernanceAuditRow(event: Record<string, any>, now: () => string = () => new Date().toISOString()): DocumentData {
  const q = typeof event.question === "string" ? event.question.trim().substring(0, 200) : event.question;
  return sanitizeForFirestore({ ...event, question: q, at: now() }) as DocumentData;
}

export type GuardedAuditRowOutcome = "written" | "refused" | "failed";

/** Writes the audit row for research run `runId` behind the deletion barrier. Never throws. */
export async function writeGuardedGovernanceAuditRow(db: FirebaseFirestore.Firestore, runId: string, event: Record<string, any>): Promise<GuardedAuditRowOutcome> {
  try {
    await runResearchWrite(db, runId, (tx) => {
      tx.create(db.collection(GOVERNANCE_AUDIT_COLLECTION).doc(), buildGovernanceAuditRow(event));
    });
    return "written";
  } catch (err) {
    if (isResearchWriteRefusedError(err)) return "refused";
    const code = (err as { code?: unknown } | null)?.code;
    logger.error("[governance/audit] FAILED to write audit event", {
      action: event.action,
      errorName: err instanceof Error ? err.name : typeof err,
      errorCode: typeof code === "string" || typeof code === "number" ? code : undefined,
    });
    return "failed";
  }
}
