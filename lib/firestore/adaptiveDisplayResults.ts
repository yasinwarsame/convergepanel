/**
 * Order 40 C — the one writer, and the one loader, of the display record `runs/{runId}/adaptiveDisplayResults/v1`
 * (lib/adaptiveSchema/adoptedDisplayResults.ts).
 *
 * Called once per research POST, from lib/runPanelExecution.ts, AFTER the run's mandatory writes: the adaptive output,
 * governance initialization and automated governance, and supplemental retry accounting (owner ruling O-2). It never
 * calls a provider and never writes the run document.
 *
 * - Separate document (O-2): the record is never a field of `runs/{runId}`, so it never consumes capacity that a later
 *   required write to the run document (governance, review, accounting) needs; those writes see exactly the document
 *   size they would without this feature.
 * - Guarded: the write runs inside the research deletion barrier's transaction (runResearchWrite →
 *   assertResearchWritable), so it is never written for a missing run or one whose deletion started. Research deletion
 *   removes the run's whole subtree (listCollections), this document included.
 * - Write-once / idempotent: the transaction reads the display document and writes nothing when it exists, so a
 *   repeated or concurrent call leaves the first committed record exactly as it was. `create` also refuses at the
 *   storage level.
 * - Atomic: the whole record is one document in one commit. If the write fails, the document is absent and the run
 *   reads exactly as before (#312's presentation); there is no partial record.
 * - Bounded: per-slot and per-record bounds in the builder, and the document's exact Firestore size (name + fields +
 *   32) at most FIRESTORE_DOCUMENT_BUDGET_BYTES (950,000), checked before the write.
 * - Never throws; logs with `logger`, never model text.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { isResearchWriteRefusedError, runResearchWrite } from "@/lib/firestore/researchDeletionBarrier";
import {
  ADAPTIVE_DISPLAY_RESULTS_COLLECTION,
  ADAPTIVE_DISPLAY_RESULTS_DOC_ID,
  FIRESTORE_DOCUMENT_BUDGET_BYTES,
  adaptiveDisplayDocumentBytes,
  buildAdaptiveDisplayResultsRecord,
} from "@/lib/adaptiveSchema/adoptedDisplayResults";
import type { AdaptiveModelResult } from "@/lib/adaptiveSchema/types";

type Db = FirebaseFirestore.Firestore;

export function adaptiveDisplayResultsRef(db: Db, runId: string): FirebaseFirestore.DocumentReference {
  return db.collection("runs").doc(runId).collection(ADAPTIVE_DISPLAY_RESULTS_COLLECTION).doc(ADAPTIVE_DISPLAY_RESULTS_DOC_ID);
}

export type PersistAdaptiveDisplayResultsOutcome =
  | { status: "saved"; slots: number; omittedForSize: number; documentBytes: number }
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
    const ref = adaptiveDisplayResultsRef(db, runId);
    const outcome = await runResearchWrite<PersistAdaptiveDisplayResultsOutcome>(db, runId, async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return { status: "already_exists" };
      const built = buildAdaptiveDisplayResultsRecord({ runId, schemaId, panelResults: args.panelResults, adaptiveResults: args.adaptiveResults });
      if (!built.ok) return { status: "not_written", reason: built.reason };
      const documentBytes = adaptiveDisplayDocumentBytes(runId, built.record as unknown as Record<string, unknown>);
      if (!(documentBytes <= FIRESTORE_DOCUMENT_BUDGET_BYTES)) return { status: "not_written", reason: "oversized" };
      tx.create(ref, built.record);
      return { status: "saved", slots: Object.keys(built.record.bySlot).length, omittedForSize: built.omittedForSize, documentBytes };
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

/**
 * The raw stored record for an ALREADY-AUTHORIZED read, or undefined when absent or unreadable. Read-only, never throws.
 * The value is untrusted: callers pass it to buildRunReadPayload, which verifies it (readAdoptedDisplayResults) against
 * the run, schema and saved slots. A read failure only means the report shows #312's presentation.
 */
export async function loadAdaptiveDisplayResults(runId: string): Promise<unknown> {
  try {
    if (!adminDb) return undefined;
    const snap = await adaptiveDisplayResultsRef(adminDb, runId).get();
    return snap.exists ? snap.data() : undefined;
  } catch (err: unknown) {
    logger.warn("[adaptiveDisplayResults] Read failed; showing the saved first answers", { runId, error: (err as Error)?.message });
    return undefined;
  }
}
