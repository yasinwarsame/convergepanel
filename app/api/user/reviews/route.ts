/**
 * Personal Reviewer Inbox + Action Flow — GET /api/user/reviews. The
 * discovery mechanism for a personal reviewer's assignments (Part 6/7).
 *
 * Source of truth: the canonical `humanReviewAssignment` subcollection
 * itself, queried across every run via a Firestore collectionGroup query
 * (Part 7 — no denormalized projection is introduced; unlike the team
 * review queue's `teamRuns` projection tradeoff, canonical assignment
 * records are directly queryable here). The uid comes exclusively from
 * authentication — never accepted from any request parameter — so a
 * reviewer can never enumerate another reviewer's assignments (Part 8).
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolveReviewerDisplayNames, UNKNOWN_REVIEWER_LABEL } from "@/lib/governance/reviewerIdentity";
import {
  buildPersonalReviewInboxItem,
  filterPersonalReviewInboxItems,
  PersonalReviewInboxFilter,
  PersonalReviewInboxItemV1,
} from "@/lib/governance/personalReviewInbox";
import { createRunWorkspaceIntegrityBatch } from "@/lib/workspaces/runWorkspaceIntegrityBatch";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/user/reviews", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return errorResponse(401, "unauthorized", "Please sign in.");
  }
  return errorResponse(401, "auth_error", "Authentication failed.");
}

const CHUNK_SIZE = 10;
async function batchGetAll<T extends FirebaseFirestore.DocumentReference>(refs: T[]): Promise<FirebaseFirestore.DocumentSnapshot[]> {
  if (!adminDb || refs.length === 0) return [];
  const out: FirebaseFirestore.DocumentSnapshot[] = [];
  for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
    const chunk = refs.slice(i, i + CHUNK_SIZE);
    const snaps = await adminDb.getAll(...chunk);
    out.push(...snaps);
  }
  return out;
}

export async function GET(req: NextRequest) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  if (!adminDb) {
    return errorResponse(500, "internal_error", "Database unavailable.");
  }

  const { searchParams } = req.nextUrl;
  const filterRaw = searchParams.get("filter") ?? "all";
  if (!["pending", "completed", "all"].includes(filterRaw)) {
    return errorResponse(400, "validation_error", 'filter must be "pending", "completed", or "all"');
  }
  const filter = filterRaw as PersonalReviewInboxFilter;

  // ---- Step 1: canonical assignment discovery — the uid comes ONLY from
  // the authenticated identity, never a query/body param (Part 8). ----
  let assignmentDocs: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const snap = await adminDb
      .collectionGroup("humanReviewAssignment")
      .where("assignedReviewerUserId", "==", uid)
      .where("teamId", "==", null)
      .orderBy("assignedAt", "desc")
      .limit(100)
      .get();
    assignmentDocs = snap.docs;
  } catch (err: unknown) {
    logger.warn("[user/reviews] Assignment collectionGroup query failed", { errorMessage: err instanceof Error ? err.message : "unknown" });
    return errorResponse(503, "firestore_unavailable", "Could not load your reviews. Please try again.");
  }

  if (assignmentDocs.length === 0) {
    return NextResponse.json({ ok: true, filter, items: [] });
  }

  // ---- Step 2: batch-fetch the parent run docs (Part 18 — one batched
  // round-trip, never one read per assignment). `doc.ref.parent.parent` is
  // the runs/{runId} document reference — humanReviewAssignment is always
  // a direct subcollection of a single run. ----
  type Candidate = { runId: string; assignedAt: string; runRef: FirebaseFirestore.DocumentReference };
  const candidates: Candidate[] = [];
  for (const doc of assignmentDocs) {
    const runRef = doc.ref.parent.parent;
    if (!runRef) continue; // structurally impossible, but never trust a Firestore ref shape blindly
    const assignedAt = typeof doc.data().assignedAt === "string" ? doc.data().assignedAt : new Date(0).toISOString();
    candidates.push({ runId: runRef.id, assignedAt, runRef });
  }

  const runSnaps = await batchGetAll(candidates.map((c) => c.runRef));
  const runDataByRunId = new Map<string, FirebaseFirestore.DocumentData>();
  const ownerUidByRunId = new Map<string, string>();
  for (const snap of runSnaps) {
    if (!snap.exists) continue;
    const data = snap.data()!;
    runDataByRunId.set(snap.id, data);
    if (typeof data.userId === "string" && data.userId) {
      ownerUidByRunId.set(snap.id, data.userId);
    }
  }

  // ---- Step 3: batch-resolve every owner's display name in ONE round-trip
  // (Part 17/18) — reuses the SAME resolver every other governance surface
  // in this codebase uses, never a second implementation. A personal
  // reviewer has no team roster to source an email fallback from, so
  // emailByUid is empty here — the resolver still degrades safely to
  // UNKNOWN_REVIEWER_LABEL rather than ever showing a raw uid or throwing. ----
  const ownerUids = Array.from(new Set(ownerUidByRunId.values()));
  // No emailByUid source exists here (a personal reviewer has no "roster"
  // of owners' emails the way a team roster provides one) — the resolver
  // degrades to UNKNOWN_REVIEWER_LABEL whenever a name isn't set, never a
  // raw uid or an unmasked email pulled from nowhere.
  const resolvedOwnerNames = await resolveReviewerDisplayNames(ownerUids, new Map(), undefined);

  // ---- Step 3.5 (Phase 4B): Workspace integrity, requester-independent,
  // before any row is built. A valid reviewer assignment (already proven by
  // Step 1's query) is never sufficient on its own — the run it points to
  // must independently pass Layer A. Rows come from potentially many
  // different owners, so the batch validator's per-(owner, workspaceId)
  // memoization caps the actual Firestore read count at the number of
  // DISTINCT owners represented on this page, not the number of
  // assignments, while still validating every row individually. ----
  const validateWorkspace = createRunWorkspaceIntegrityBatch();
  const integrityByRunId = new Map<string, Awaited<ReturnType<typeof validateWorkspace>>>();
  await Promise.all(
    candidates.map(async (c) => {
      const runData = runDataByRunId.get(c.runId);
      if (!runData) return; // already handled as "run no longer exists" below
      const result = await validateWorkspace(runData);
      integrityByRunId.set(c.runId, result);
    })
  );

  // ---- Step 4: build safe DTOs, skip malformed rows (never fabricate) ----
  const items: PersonalReviewInboxItemV1[] = [];
  for (const c of candidates) {
    const runData = runDataByRunId.get(c.runId);
    if (!runData) {
      logger.warn("[user/reviews] Assignment references a run that no longer exists or could not be read", { runId: c.runId });
      continue;
    }
    const integrity = integrityByRunId.get(c.runId);
    if (integrity?.classification === "invalid") {
      logger.warn("[user/reviews] workspace_run_integrity_failed", { runId: c.runId, reason: integrity.reason });
      continue;
    }
    const ownerUid = ownerUidByRunId.get(c.runId);
    const ownerDisplayName = ownerUid ? (resolvedOwnerNames.get(ownerUid) ?? UNKNOWN_REVIEWER_LABEL) : UNKNOWN_REVIEWER_LABEL;
    const item = buildPersonalReviewInboxItem({
      runId: c.runId,
      assignedAt: c.assignedAt,
      ownerDisplayName,
      runData,
    });
    if (!item) {
      logger.warn("[user/reviews] Skipped a run with a malformed/missing governance record", { runId: c.runId });
      continue;
    }
    items.push(item);
  }

  return NextResponse.json({ ok: true, filter, items: filterPersonalReviewInboxItems(items, filter) });
}
