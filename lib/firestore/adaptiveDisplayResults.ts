/**
 * Order 40 C — the one writer of `runs/{runId}.adaptiveDisplayResults` (lib/adaptiveSchema/adoptedDisplayResults.ts).
 *
 * Called once per research POST, from lib/runPanelExecution.ts, right after the Milestone-2 adaptive output was
 * persisted (and only when it was saved). It never calls a provider and never changes any other field.
 *
 * - Guarded: the write runs inside the research deletion barrier's transaction (runResearchWrite →
 *   assertResearchWritable), so it never creates a run document and never writes to a run whose deletion started.
 * - Write-once / idempotent: the transaction reads the run and writes nothing when the field already exists, so a
 *   repeated or concurrent call leaves the first committed record exactly as it was (a contending attempt is re-run by
 *   Firestore and then sees the field).
 * - Atomic: the whole record is one field in one commit. If the write fails, the field is absent and the run reads
 *   exactly as before (#312's presentation); there is no partial record.
 * - Bounded: the record budget is the smaller of ADAPTIVE_DISPLAY_RECORD_MAX_BYTES and the headroom the CURRENT run
 *   document (read in the same transaction) leaves under FIRESTORE_DOCUMENT_BUDGET_BYTES.
 * - Never throws; logs with `logger`, never model text.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { isResearchWriteRefusedError, runResearchWrite } from "@/lib/firestore/researchDeletionBarrier";
import {
  ADAPTIVE_DISPLAY_RESULTS_FIELD,
  ADAPTIVE_DISPLAY_RECORD_MAX_BYTES,
  FIRESTORE_DOCUMENT_BUDGET_BYTES,
  buildAdaptiveDisplayResultsRecord,
  firestoreDocumentBytes,
} from "@/lib/adaptiveSchema/adoptedDisplayResults";
import type { AdaptiveModelResult } from "@/lib/adaptiveSchema/types";

/** Reserved for the document name and estimator rounding, on top of FIRESTORE_DOCUMENT_BUDGET_BYTES's own margin. */
const DOCUMENT_NAME_RESERVE_BYTES = 1_024;

export type PersistAdaptiveDisplayResultsOutcome =
  | { status: "saved"; slots: number; omittedForSize: number }
  | { status: "already_exists" }
  | { status: "refused"; reason: "deleted" | "deleting" | "missing" }
  | { status: "not_written"; reason: "firestore_unavailable" | "slot_mismatch" | "unsupported_schema" | "oversized" | "write_failed" };

export async function persistAdaptiveDisplayResults(args: {
  runId: string;
  schemaId: string;
  panelResults: ReadonlyArray<{ modelId: string; status: string }>;
  adaptiveResults: ReadonlyArray<AdaptiveModelResult>;
}): Promise<PersistAdaptiveDisplayResultsOutcome> {
  const { runId, schemaId } = args;
  try {
    if (!adminDb) {
      logger.warn("[adaptiveDisplayResults] Not written: Firestore unavailable", { runId, schemaId });
      return { status: "not_written", reason: "firestore_unavailable" };
    }
    const db = adminDb;
    const ref = db.collection("runs").doc(runId);
    const outcome = await runResearchWrite<PersistAdaptiveDisplayResultsOutcome>(db, runId, (tx, run) => {
      const existing = run.data() as Record<string, unknown> | undefined;
      if (existing && existing[ADAPTIVE_DISPLAY_RESULTS_FIELD] !== undefined) return { status: "already_exists" };
      const headroom = FIRESTORE_DOCUMENT_BUDGET_BYTES - DOCUMENT_NAME_RESERVE_BYTES - firestoreDocumentBytes(existing);
      const built = buildAdaptiveDisplayResultsRecord({
        runId,
        schemaId,
        panelResults: args.panelResults,
        adaptiveResults: args.adaptiveResults,
        maxRecordBytes: Math.min(ADAPTIVE_DISPLAY_RECORD_MAX_BYTES, headroom),
      });
      if (!built.ok) return { status: "not_written", reason: built.reason };
      tx.set(ref, { [ADAPTIVE_DISPLAY_RESULTS_FIELD]: built.record }, { merge: true });
      return { status: "saved", slots: Object.keys(built.record.bySlot).length, omittedForSize: built.omittedForSize };
    });
    if (outcome.status === "not_written") {
      logger.warn("[adaptiveDisplayResults] Not written", { runId, schemaId, reason: outcome.reason });
    } else if (outcome.status === "saved" && outcome.omittedForSize > 0) {
      logger.warn("[adaptiveDisplayResults] Saved with slots omitted at the size limit", { runId, schemaId, omittedForSize: outcome.omittedForSize });
    }
    return outcome;
  } catch (err: unknown) {
    if (isResearchWriteRefusedError(err)) {
      logger.warn("[adaptiveDisplayResults] Not written: research write refused", { runId, schemaId, refusal: err.refusal });
      return { status: "refused", reason: err.refusal };
    }
    logger.warn("[adaptiveDisplayResults] Not written: write failed", { runId, schemaId, error: (err as Error)?.message });
    return { status: "not_written", reason: "write_failed" };
  }
}
