/**
 * Adaptive Research Export, Phase 1 — Firestore persistence for
 * `AdaptiveResearchExportV1` records. Storage decision (confirmed with the
 * user): no object storage exists in this codebase, and Phase 1 does not
 * introduce one — only the frozen metadata/snapshot record is persisted,
 * at `runs/{runId}/exports/{exportId}` (mirrors the existing
 * `runs/{runId}/humanReviewHistory/{decisionId}` subcollection precedent).
 * PDF bytes are never written here; they're generated on demand from the
 * persisted `reportSnapshot` (see lib/pdf/adaptiveResearchPdf.tsx).
 *
 * `reportVersion` (researchExport.ts's monotonic per-run counter) is
 * assigned via an atomic `FieldValue.increment(1)` transaction against
 * `runs/{runId}.adaptiveExportCounter` — the same pattern
 * `checkAndIncrementUsageForRun()` already uses for `runsThisMonth`
 * (lib/stripe/usageCheck.ts), reused rather than inventing a second
 * counter convention.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";

function exportsCollection(runId: string) {
  return adminDb!.collection("runs").doc(runId).collection("exports");
}

export interface CreateAdaptiveExportInput {
  runId: string;
  exportId: string;
  record: Omit<AdaptiveResearchExportV1, "reportVersion" | "exportMetadata"> & {
    exportMetadata: Omit<AdaptiveResearchExportV1["exportMetadata"], "finalReportVersion">;
  };
}

export type CreateAdaptiveExportResult =
  | { ok: true; reportVersion: number }
  | { ok: false; reason: "firestore_unavailable" | "write_failed" };

/**
 * Atomically assigns the next `reportVersion` for this run and writes the
 * new export record with `artifactStatus: "generating"` in the same
 * transaction — no two concurrent export requests for the same run can
 * ever be assigned the same reportVersion (Part 4's TOCTOU concern, same
 * discipline as the usage-quota transaction this mirrors).
 *
 * Deliberately does NOT mark older exports for this run as "superseded"
 * here — that's `supersedeOlderAdaptiveExports()` below, called only AFTER
 * this new export reaches "ready" (Part 3: a newer export existing is not
 * itself proof the new one will succeed; an older export must stay "ready"
 * until a newer one genuinely completes, never flipped to "superseded" by
 * a request that might still fail).
 */
export async function createAdaptiveExportRecord(input: CreateAdaptiveExportInput): Promise<CreateAdaptiveExportResult> {
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };

  try {
    const runRef = adminDb.collection("runs").doc(input.runId);
    const exportRef = exportsCollection(input.runId).doc(input.exportId);

    const reportVersion = await adminDb.runTransaction(async (txn) => {
      const runSnap = await txn.get(runRef);
      const currentCounter = (runSnap.data()?.adaptiveExportCounter as number | undefined) ?? 0;
      const nextVersion = currentCounter + 1;

      txn.set(runRef, { adaptiveExportCounter: FieldValue.increment(1) }, { merge: true });
      txn.set(
        exportRef,
        sanitizeForFirestore({
          ...input.record,
          reportVersion: nextVersion,
          exportMetadata: { ...input.record.exportMetadata, finalReportVersion: nextVersion },
        }) as FirebaseFirestore.DocumentData
      );

      return nextVersion;
    });

    return { ok: true, reportVersion };
  } catch {
    return { ok: false, reason: "write_failed" };
  }
}

export type UpdateAdaptiveExportResult = { ok: true } | { ok: false; reason: "firestore_unavailable" | "write_failed" };

/** Transitions a "generating" record to "ready" once PDF generation genuinely succeeded — never called before the bytes are actually produced (Part 19). */
export async function markAdaptiveExportReady(
  runId: string,
  exportId: string,
  fileHash: string
): Promise<UpdateAdaptiveExportResult> {
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };
  try {
    await exportsCollection(runId).doc(exportId).set(
      { artifactStatus: "ready", "exportMetadata.fileHash": fileHash },
      { merge: true }
    );
    return { ok: true };
  } catch {
    return { ok: false, reason: "write_failed" };
  }
}

/** Preserves the record (never deleted) with an accurate "failed" status and reason — a failed generation must never look like a successful download (Part 19). */
export async function markAdaptiveExportFailed(
  runId: string,
  exportId: string,
  failureReason: string
): Promise<UpdateAdaptiveExportResult> {
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };
  try {
    await exportsCollection(runId).doc(exportId).set({ artifactStatus: "failed", failureReason }, { merge: true });
    return { ok: true };
  } catch {
    return { ok: false, reason: "write_failed" };
  }
}

/**
 * Marks every OTHER "ready" export for this run as "superseded" — never
 * touches `reportSnapshot`/`exportMetadata` (content), only
 * `artifactStatus` (Part 3: superseded is a lifecycle transition, not a
 * content mutation; the artifact remains historically retrievable).
 * Called only after the new export reaches "ready".
 */
export async function supersedeOlderAdaptiveExports(runId: string, currentExportId: string): Promise<UpdateAdaptiveExportResult> {
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };
  try {
    const snap = await exportsCollection(runId).where("artifactStatus", "==", "ready").get();
    const batch = adminDb.batch();
    let mutated = false;
    for (const doc of snap.docs) {
      if (doc.id === currentExportId) continue;
      batch.set(doc.ref, { artifactStatus: "superseded" }, { merge: true });
      mutated = true;
    }
    if (mutated) await batch.commit();
    return { ok: true };
  } catch {
    return { ok: false, reason: "write_failed" };
  }
}

export type GetAdaptiveExportResult =
  | { ok: true; record: AdaptiveResearchExportV1 }
  | { ok: false; reason: "not_found" | "firestore_unavailable" | "read_failed" };

export async function getAdaptiveExportRecord(runId: string, exportId: string): Promise<GetAdaptiveExportResult> {
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };
  try {
    const snap = await exportsCollection(runId).doc(exportId).get();
    if (!snap.exists) return { ok: false, reason: "not_found" };
    return { ok: true, record: snap.data() as AdaptiveResearchExportV1 };
  } catch {
    return { ok: false, reason: "read_failed" };
  }
}
