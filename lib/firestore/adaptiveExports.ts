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

/**
 * Integrity hotfix — the ONLY compatibility boundary for malformed
 * historical export records written before this fix (see
 * `markAdaptiveExportReady`'s own doc comment for the root cause: a
 * dotted-key `.set(..., {merge:true})` call stored `fileHash` as a
 * literal top-level field named `"exportMetadata.fileHash"` instead of
 * nesting it inside `exportMetadata`).
 *
 * Every raw Firestore document read anywhere in this codebase passes
 * through here before being handed back as an `AdaptiveResearchExportV1`
 * — callers (the history-list route, the regeneration route, tests) can
 * always trust `record.exportMetadata.fileHash` and never need to know
 * this history. This is deliberately NOT treated as part of the canonical
 * schema — `AdaptiveExportManifest`/`AdaptiveResearchExportV1` are not
 * changed to include the legacy literal field; it is read here, once, and
 * discarded.
 *
 * The genuinely nested field always wins if a record somehow has both
 * (should not normally happen, but a real nested value is definitionally
 * the more correct/recent write — never overwritten by a stale legacy
 * fallback).
 */
function normalizeAdaptiveExportRecord(raw: FirebaseFirestore.DocumentData): AdaptiveResearchExportV1 {
  // Final review, Step 5/8: no current caller spreads/serializes the raw
  // record wholesale (both read paths use an explicit field-by-field
  // projection), so this was never actually reachable in an API response —
  // but `{ ...raw, ... }` alone would still carry the literal
  // `"exportMetadata.fileHash"` key forward onto the returned object,
  // since object spread copies every own enumerable property regardless of
  // whether its name contains a dot. Explicitly deleting it makes the
  // compatibility boundary airtight rather than relying on "no caller
  // happens to spread this today" — a future caller (e.g. debug logging
  // via `JSON.stringify(record)`) must never be able to leak this
  // internal-only artifact.
  const legacyFileHash = raw["exportMetadata.fileHash"] as string | undefined;
  if (legacyFileHash === undefined) {
    return raw as AdaptiveResearchExportV1;
  }
  const { "exportMetadata.fileHash": _legacy, ...rest } = raw;
  if (rest.exportMetadata && rest.exportMetadata.fileHash === undefined) {
    rest.exportMetadata = { ...rest.exportMetadata, fileHash: legacyFileHash };
  }
  return rest as AdaptiveResearchExportV1;
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

/**
 * Transitions a "generating" record to "ready" once PDF generation
 * genuinely succeeded — never called before the bytes are actually
 * produced (Part 19). "Ready" describes the frozen snapshot record and the
 * fact that a PDF was successfully generated and streamed to the
 * requester at that moment — it does NOT mean the PDF bytes themselves are
 * durably stored anywhere; this repo has no object storage, and the bytes
 * are discarded once the response completes (see researchExport.ts's
 * `AdaptiveExportArtifactStatus` doc comment).
 *
 * Integrity hotfix — this previously wrote `"exportMetadata.fileHash"` as a
 * DOTTED TOP-LEVEL KEY: `.set({ "exportMetadata.fileHash": fileHash },
 * { merge: true })`. Unlike `.update()`, Firestore's `.set(data, { merge:
 * true })` does NOT parse dotted string keys in `data` as nested field
 * paths — it stores them literally, as a field genuinely named
 * `"exportMetadata.fileHash"` (a sibling of `exportMetadata`, containing a
 * literal dot character), never nested inside the `exportMetadata` map.
 * Every reader (`getAdaptiveExportRecord`, the history-list route) does
 * real nested property access — `record.exportMetadata.fileHash` — so this
 * meant `fileHash` was silently absent from every export record ever
 * created, in every environment, since Phase 1. Confirmed directly against
 * real production Firestore documents before this fix.
 *
 * The fix passes a genuinely nested plain object instead:
 * `{ exportMetadata: { fileHash } }`. `.set(data, { merge: true })` (no
 * `mergeFields` restriction) performs a RECURSIVE merge on nested maps —
 * this adds/overwrites only the `fileHash` key inside the existing
 * `exportMetadata` map, leaving every sibling field
 * (`exportId`/`reportVersion`/`schemaId`/`schemaFamily`/`requestingUser`/
 * `exportedSections`/`finalReportVersion`) completely untouched. Verified
 * directly with a dedicated regression test — see
 * `adaptiveExports.spec.ts`'s "sibling exportMetadata fields survive
 * markAdaptiveExportReady" test.
 *
 * `.update()` was considered instead (its dotted-path semantics are
 * correct) but not used, to stay consistent with every other function in
 * this file, which all use `.set(..., { merge: true })` — and because
 * `.update()` requires the target document to already exist, a guarantee
 * this function already relies on implicitly (it is only ever called
 * after `createAdaptiveExportRecord` has already written the document in
 * "generating" state), so switching write methods would add a stricter
 * failure mode for no behavioral benefit.
 */
export async function markAdaptiveExportReady(
  runId: string,
  exportId: string,
  fileHash: string
): Promise<UpdateAdaptiveExportResult> {
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };
  try {
    await exportsCollection(runId).doc(exportId).set(
      { artifactStatus: "ready", exportMetadata: { fileHash } },
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
 * content mutation). The superseded export's frozen `reportSnapshot`
 * record stays readable and unmutated via `getAdaptiveExportRecord()` —
 * that is the full extent of "historical" support in Phase 1. It does NOT
 * mean a PDF can be re-downloaded later: no PDF bytes are stored, and no
 * retrieval-by-export-ID endpoint exists that would render one from the
 * preserved snapshot on demand. Called only after the new export reaches
 * "ready".
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

/**
 * Reads back a frozen export record (metadata + `reportSnapshot`) — never
 * a PDF. Phase 1 used this only in its own immutability tests (no
 * retrieval endpoint existed yet). Phase 2's regeneration route
 * (`GET /api/user/runs/[runId]/exports/[exportId]`) now calls this
 * directly: authorize → load via this function → render the returned
 * `reportSnapshot` through the version-aware PDF dispatcher
 * (`renderAdaptiveResearchExport`) → stream bytes. The record itself is
 * never mutated by regeneration.
 */
export async function getAdaptiveExportRecord(runId: string, exportId: string): Promise<GetAdaptiveExportResult> {
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };
  try {
    const snap = await exportsCollection(runId).doc(exportId).get();
    if (!snap.exists) return { ok: false, reason: "not_found" };
    return { ok: true, record: normalizeAdaptiveExportRecord(snap.data()!) };
  } catch {
    return { ok: false, reason: "read_failed" };
  }
}

export type ListAdaptiveExportsResult =
  | { ok: true; records: AdaptiveResearchExportV1[]; hasMore: boolean }
  | { ok: false; reason: "firestore_unavailable" | "read_failed" };

/** Hard ceiling independent of whatever a caller requests — prevents a single history read from ever pulling an unbounded number of documents, regardless of route-level validation. */
const MAX_EXPORT_LIST_PAGE_SIZE = 50;
const DEFAULT_EXPORT_LIST_PAGE_SIZE = 30;

export interface ListAdaptiveExportsOptions {
  /** Caps the page at this many records (clamped to [1, MAX_EXPORT_LIST_PAGE_SIZE]). Defaults to DEFAULT_EXPORT_LIST_PAGE_SIZE. */
  limit?: number;
  /** Cursor = the `reportVersion` of the last record from the previous page. Returns records with a strictly smaller reportVersion (list stays newest-first). Omit for the first page. */
  beforeReportVersion?: number;
}

/**
 * Adaptive Research Export, Phase 2 — lists export records for a run,
 * newest `reportVersion` first, including `superseded` and `failed` ones
 * (Part 8: superseded ≠ invalid ≠ hidden). Returns FULL records — callers
 * that expose this over an API (the history-list route) are responsible for
 * projecting down to metadata-only fields before responding; this function
 * itself stays a general-purpose reader, matching `getAdaptiveExportRecord`'s
 * own shape one level up.
 *
 * Phase 5 (Part 14) — cursor-based pagination, bounded by
 * MAX_EXPORT_LIST_PAGE_SIZE regardless of caller input. Before this, the
 * query had no `.limit()` at all: a run with dozens/hundreds of exports
 * (easily reached — a single review/testing session can generate 20+) would
 * read and return every one of them on every history-panel open. `reportVersion`
 * is already the query's own sort key, so paginating on it needs no new
 * index — Firestore auto-indexes single-field range+order queries on the
 * same field.
 */
export async function listAdaptiveExportRecords(runId: string, options: ListAdaptiveExportsOptions = {}): Promise<ListAdaptiveExportsResult> {
  if (!adminDb) return { ok: false, reason: "firestore_unavailable" };
  try {
    // Final review, Step 6: this function is a general-purpose reader (per
    // its own doc comment above) — it must not assume every caller already
    // sanitized `options`. `Math.trunc` + a finite fallback guards against
    // a fractional or non-finite `limit`/`beforeReportVersion` ever
    // reaching Firestore's `.limit()`/`.where("<", ...)`, independent of
    // whatever the route layer already does.
    const rawLimit = options.limit;
    const safeLimit = rawLimit !== undefined && Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : DEFAULT_EXPORT_LIST_PAGE_SIZE;
    const limit = Math.min(Math.max(1, safeLimit), MAX_EXPORT_LIST_PAGE_SIZE);
    let query = exportsCollection(runId).orderBy("reportVersion", "desc").limit(limit + 1);
    if (options.beforeReportVersion !== undefined && Number.isFinite(options.beforeReportVersion)) {
      query = query.where("reportVersion", "<", Math.trunc(options.beforeReportVersion));
    }
    const snap = await query.get();
    const hasMore = snap.docs.length > limit;
    const records = snap.docs.slice(0, limit).map((d) => normalizeAdaptiveExportRecord(d.data()));
    return { ok: true, records, hasMore };
  } catch {
    return { ok: false, reason: "read_failed" };
  }
}
