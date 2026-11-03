/**
 * Admin Purge Runs API Route
 * 
 * Allows admins to delete Firestore run documents based on age or date range.
 * Supports dry-run mode for preview before deletion.
 * 
 * Security:
 * - Admin-only access (verified via requireSystemAdminAccess())
 * - Batch deletes with hard caps (max 2000 docs per request)
 * - Input validation and bounds checking
 * 
 * Route: POST /api/admin/purge-runs
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSystemAdminAccess } from "@/lib/firebase/auth-helpers";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { Timestamp } from "firebase-admin/firestore";
import { deleteResearchRun, listUnfinishedResearchDeletions } from "@/lib/firestore/researchDeletion";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

const MAX_DELETE_PER_REQUEST = 2000; // Hard cap on total documents to delete
const BATCH_SIZE = 500; // Firestore batch limit
const MAX_DATE_RANGE_DAYS = 730; // 2 years maximum

interface PurgeRunsRequest {
  mode: "olderThan" | "between";
  days?: number;
  start?: string;
  end?: string;
  dryRun: boolean;
  status?: "any" | "success" | "failed";
  maxToDelete?: number;
}

interface PurgeRunsResponse {
  ok: true;
  dryRun: boolean;
  scannedCount: number;
  matchedCount: number;
  deletedCount: number;
  errorsCount: number;
  sampleIds: string[];
  collectionsTouched: string[];
  capped?: boolean; // true if hit maxToDelete limit
  /** Order A / S1: runs whose durable deletion did not complete (counted in errorsCount, never in deletedCount). */
  incompleteRunIds?: string[];
  /** Not started within the time budget; purge again to continue (counted in errorsCount). */
  notStartedRunIds?: string[];
  notStartedCount?: number;
}

/**
 * Convert ISO string or Date to Firestore Timestamp
 */
function toTimestamp(value: string | Date | Timestamp): Timestamp {
  if (value instanceof Timestamp) {
    return value;
  }
  if (value instanceof Date) {
    return Timestamp.fromDate(value);
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return Timestamp.fromDate(date);
}

/**
 * Parse and validate request body
 */
function validateRequest(body: any): { valid: boolean; error?: string; data?: PurgeRunsRequest } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body is required" };
  }

  if (body.mode !== "olderThan" && body.mode !== "between") {
    return { valid: false, error: "mode must be 'olderThan' or 'between'" };
  }

  if (body.mode === "olderThan") {
    if (typeof body.days !== "number" || body.days < 1 || body.days > 3650) {
      return { valid: false, error: "days must be a number between 1 and 3650" };
    }
  } else {
    if (!body.start || !body.end) {
      return { valid: false, error: "start and end dates are required for 'between' mode" };
    }
    try {
      const startDate = new Date(body.start);
      const endDate = new Date(body.end);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return { valid: false, error: "start and end must be valid ISO date strings" };
      }
      if (endDate < startDate) {
        return { valid: false, error: "end date must be >= start date" };
      }
      const rangeDays = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
      if (rangeDays > MAX_DATE_RANGE_DAYS) {
        return { valid: false, error: `Date range exceeds ${MAX_DATE_RANGE_DAYS} days (2 years)` };
      }
    } catch (err: any) {
      return { valid: false, error: `Invalid date format: ${err.message}` };
    }
  }

  if (typeof body.dryRun !== "boolean") {
    return { valid: false, error: "dryRun must be a boolean" };
  }

  if (body.status && !["any", "success", "failed"].includes(body.status)) {
    return { valid: false, error: "status must be 'any', 'success', or 'failed'" };
  }

  if (body.maxToDelete !== undefined) {
    if (typeof body.maxToDelete !== "number" || body.maxToDelete < 1 || body.maxToDelete > MAX_DELETE_PER_REQUEST) {
      return { valid: false, error: `maxToDelete must be between 1 and ${MAX_DELETE_PER_REQUEST}` };
    }
  }

  return {
    valid: true,
    data: {
      mode: body.mode,
      days: body.days,
      start: body.start,
      end: body.end,
      dryRun: body.dryRun,
      status: body.status || "any",
      maxToDelete: body.maxToDelete || MAX_DELETE_PER_REQUEST,
    },
  };
}

/**
 * Get status filter for Firestore query
 */
function getStatusFilter(status: "any" | "success" | "failed"): string | null {
  if (status === "any") {
    return null;
  }
  if (status === "success") {
    return "complete";
  }
  if (status === "failed") {
    return "error";
  }
  return null;
}

/**
 * Durable per-run deletion with bounded concurrency (10 at a time). Order A / S1 review fixes:
 *   - unfinished deletion jobs (e.g. a run whose final step failed after its document was removed) are resumed first;
 *   - a time budget stops STARTING new deletions well before the function limit; runs not started are reported in
 *     `notStartedRunIds` (purge again to continue) — never silently skipped, never reported as deleted.
 */
export const PURGE_TIME_BUDGET_MS = 240_000;
async function deleteRunsDurably(refs: FirebaseFirestore.DocumentReference[], actorUid: string, startedAt = Date.now()): Promise<{ deletedCount: number; errorsCount: number; incompleteRunIds: string[]; notStartedRunIds: string[] }> {
  let deletedCount = 0;
  const incompleteRunIds: string[] = [];
  const pending = [...(await listUnfinishedResearchDeletions()), ...refs.map((r) => r.id)].filter((id, i, all) => all.indexOf(id) === i);
  let i = 0;
  for (; i < pending.length; i += 10) {
    if (Date.now() - startedAt > PURGE_TIME_BUDGET_MS) break;
    const results = await Promise.all(pending.slice(i, i + 10).map((runId) => deleteResearchRun({ runId, actorUid, reason: "admin_purge" })));
    for (const r of results) {
      if (r.status === "deleted") deletedCount++;
      else incompleteRunIds.push(r.runId);
    }
  }
  const notStartedRunIds = pending.slice(i);
  return { deletedCount, errorsCount: incompleteRunIds.length + notStartedRunIds.length, incompleteRunIds, notStartedRunIds };
}

/**
 * Delete documents in batches
 */
async function deleteDocuments(
  docRefs: FirebaseFirestore.DocumentReference[],
  dryRun: boolean
): Promise<{ deletedCount: number; errorsCount: number }> {
  if (dryRun || docRefs.length === 0) {
    return { deletedCount: 0, errorsCount: 0 };
  }

  let deletedCount = 0;
  let errorsCount = 0;

  // Process in batches of 500 (Firestore batch limit)
  for (let i = 0; i < docRefs.length; i += BATCH_SIZE) {
    const batch = docRefs.slice(i, i + BATCH_SIZE);
    const firestoreBatch = adminDb!.batch();

    for (const docRef of batch) {
      firestoreBatch.delete(docRef);
    }

    try {
      await firestoreBatch.commit();
      deletedCount += batch.length;
    } catch (error: any) {
      logger.error("[admin/purge-runs] Batch delete failed", {
        batchIndex: i,
        batchSize: batch.length,
        error: error?.message,
      });
      errorsCount += batch.length;
    }
  }

  return { deletedCount, errorsCount };
}

// Order A / S1 review m-1: durable deletion is slower than a batch delete; allow the full function duration.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    // Verify admin authentication
    const auth = await requireSystemAdminAccess(req);
    if (!auth) {
      logger.error("[admin/purge-runs] Unauthorized access attempt");
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    if (!adminDb) {
      logger.error("[admin/purge-runs] Firestore not available");
      return NextResponse.json({ ok: false, error: "Firestore not available" }, { status: 500 });
    }

    // Parse and validate request body
    const body = await req.json().catch(() => null);
    const validation = validateRequest(body);
    if (!validation.valid || !validation.data) {
      return NextResponse.json(
        { ok: false, error: validation.error || "Invalid request" },
        { status: 400 }
      );
    }

    const { mode, days, start, end, dryRun, status = "any", maxToDelete } = validation.data;

    // Determine timestamp range
    let startTimestamp: Timestamp;
    let endTimestamp: Timestamp;

    if (mode === "olderThan") {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days!);
      endTimestamp = Timestamp.fromDate(cutoffDate);
      // For "older than", we query from beginning of time to cutoff
      startTimestamp = Timestamp.fromDate(new Date(0)); // Unix epoch start
    } else {
      startTimestamp = toTimestamp(start!);
      endTimestamp = toTimestamp(end!);
    }

    logger.info("[admin/purge-runs] Starting purge", {
      mode,
      dryRun,
      status,
      maxToDelete,
      startTimestamp: startTimestamp.toDate().toISOString(),
      endTimestamp: endTimestamp.toDate().toISOString(),
      adminUid: auth.uid,
    });

    // Query runs collection
    // Build query based on mode and filters
    let query: FirebaseFirestore.Query = adminDb.collection("runs");

    // For "between" mode, add both bounds
    if (mode === "between") {
      query = query
        .where("createdAt", ">=", startTimestamp)
        .where("createdAt", "<=", endTimestamp);
    } else {
      // For "olderThan" mode, only upper bound
      query = query.where("createdAt", "<=", endTimestamp);
    }

    // Add status filter if specified
    const statusFilter = getStatusFilter(status);
    if (statusFilter) {
      query = query.where("status", "==", statusFilter);
    }

    // Execute query with pagination and cap
    const allDocRefs: FirebaseFirestore.DocumentReference[] = [];
    const sampleIds: string[] = [];
    let scannedCount = 0;
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    let capped = false;

    // Paginate through results with hard cap
    while (allDocRefs.length < maxToDelete!) {
      let queryPage: FirebaseFirestore.Query = query.limit(500);

      if (lastDoc) {
        queryPage = queryPage.startAfter(lastDoc);
      }

      const snapshot = await queryPage.get();

      if (snapshot.empty) {
        break; // No more documents
      }

      for (const doc of snapshot.docs) {
        scannedCount++;
        if (allDocRefs.length < maxToDelete!) {
          allDocRefs.push(doc.ref);
          // Collect sample IDs (up to 10)
          if (sampleIds.length < 10) {
            sampleIds.push(doc.id);
          }
        } else {
          capped = true;
          break;
        }
      }

      // Update lastDoc for next iteration
      lastDoc = snapshot.docs[snapshot.docs.length - 1];

      // If we got fewer than 500 docs, we're done
      if (snapshot.docs.length < 500) {
        break;
      }

      if (capped) {
        break;
      }
    }

    const matchedCount = allDocRefs.length;

    // Delete (or simulate). Order A / S1: each run goes through the durable research-deletion workflow (whole subtree +
    // redaction of research text copied elsewhere, verified); a run whose deletion is incomplete is counted as an error,
    // never as deleted, and can be retried safely by purging again.
    const { deletedCount, errorsCount, incompleteRunIds, notStartedRunIds } = dryRun ? { ...(await deleteDocuments(allDocRefs, true)), incompleteRunIds: [] as string[], notStartedRunIds: [] as string[] } : await deleteRunsDurably(allDocRefs, auth.uid);

    logger.info("[admin/purge-runs] Purge completed", {
      dryRun,
      scannedCount,
      matchedCount,
      deletedCount,
      errorsCount,
      capped,
      adminUid: auth.uid,
    });

    const response: PurgeRunsResponse = {
      ok: true,
      dryRun,
      scannedCount,
      matchedCount,
      deletedCount,
      errorsCount,
      sampleIds,
      ...(incompleteRunIds.length > 0 ? { incompleteRunIds: incompleteRunIds.slice(0, 50) } : {}),
      ...(notStartedRunIds.length > 0 ? { notStartedRunIds: notStartedRunIds.slice(0, 50), notStartedCount: notStartedRunIds.length } : {}),
      collectionsTouched: ["runs"],
      ...(capped && { capped: true }),
    };

    return NextResponse.json(response, { status: 200 });
  } catch (error: any) {
    logger.error("[admin/purge-runs] Error during purge", {
      error: error?.message,
      stack: error?.stack,
    });
    return NextResponse.json(
      { ok: false, error: error?.message || "Internal server error" },
      { status: 500 }
    );
  }
}