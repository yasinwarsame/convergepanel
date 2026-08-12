/**
 * HTTP API route (teams/runs): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import type { DocumentReference, DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import {
  getRequestUid,
  loadUserAndTeam,
  memberRole,
  isTeamAdmin,
} from "@/lib/teams/teamApiAuth";
import { logger } from "@/lib/logger";
import {
  classifyTeamRunRow,
  parseTeamRunListFilters,
  applyTeamRunListFilters,
  sortTeamRunListItems,
  paginateTeamRunListItems,
  TeamRunListItemV1,
  AdaptiveTeamRunListItemV1,
} from "@/lib/governance/teamRunListContract";
import {
  enrichLegacyTeamRunListItem,
  enrichAdaptiveTeamRunListItem,
  EnrichedTeamRunListItemV1,
  EnrichedTeamRunListResponseV1,
} from "@/lib/governance/teamReviewQueueEnrichment";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { parseAdaptiveHumanReviewPanel, AdaptiveHumanReviewPanelV1 } from "@/lib/governance/adaptiveHumanReviewPanel";
import { parseAdaptiveHumanReviewVote, buildAdaptiveHumanReviewVoteId, AdaptiveHumanReviewVoteV1 } from "@/lib/governance/adaptiveHumanReviewVote";
import type { AdaptiveHumanReviewAssignmentV1 } from "@/lib/governance/adaptiveHumanReviewAssignment";
import type { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import { resolveReviewerDisplayNames, UNKNOWN_REVIEWER_LABEL } from "@/lib/governance/reviewerIdentity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tsMillis(t: unknown): number {
  if (t && typeof t === "object" && "toMillis" in t && typeof (t as { toMillis: () => number }).toMillis === "function") {
    return (t as { toMillis: () => number }).toMillis();
  }
  return 0;
}

/** Firestore teamRuns row + client sort key (spread doc fields). */
type TeamRunListRow = {
  id: string;
  timestamp: number;
  userId?: string;
  type?: string;
  policyFlags?: string[];
  humanDecision?: unknown;
  [key: string]: unknown;
};

/**
 * Review Page Reviewer Display — batches an arbitrary set of document
 * reads into `db.getAll()` calls, chunked at 10 (matching the precedent
 * already established in `app/api/admin/runs/route.ts` and
 * `lib/governance/reviewerIdentity.ts` for the identical "many unrelated
 * doc reads, one round-trip" shape). A whole-chunk read failure degrades
 * every ref in that chunk to `undefined` (never found) rather than
 * failing the entire page — a temporary governance-data outage must never
 * take down the whole review queue, only omit enrichment for the affected
 * rows (queue items themselves came from the already-successful `teamRuns`
 * query and are never dropped because of this).
 */
type BatchReadResult = { snap: DocumentSnapshot | undefined; failed: boolean };

async function batchGetAll(db: Firestore, refs: DocumentReference[]): Promise<BatchReadResult[]> {
  if (refs.length === 0) return [];
  const CHUNK_SIZE = 10;
  const results: BatchReadResult[] = [];
  for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
    const chunk = refs.slice(i, i + CHUNK_SIZE);
    try {
      const snaps = await db.getAll(...chunk);
      results.push(...snaps.map((snap) => ({ snap, failed: false })));
    } catch (err) {
      logger.warn("[teams/runs] Batched governance-enrichment read failed for a chunk; degrading affected rows", {
        chunkSize: chunk.length,
        errorMessage: err instanceof Error ? err.message : "unknown_error",
      });
      results.push(...chunk.map(() => ({ snap: undefined, failed: true })));
    }
  }
  return results;
}

/**
 * Review Page Reviewer Display — enriches a PAGE of already-classified,
 * already-paginated list items with canonical reviewer/assignment/panel
 * detail, bounded to exactly the rows being returned (never the full
 * team's history). Every multi-row read (runs/assignment/panel/votes/
 * identity) is batched into a small, fixed number of `db.getAll()` calls
 * regardless of page size — never one Firestore read per row per field,
 * and never one identity read per reviewer per row (Step 12's explicit
 * requirement, mirroring PR #30's report-level fix).
 *
 * Never reads `teamRuns` fields as canonical for adaptive rows — the
 * adaptive item's own `teamRunId`/discovery data is already in hand from
 * the caller; this function only ever reads `runs/{runId}.governanceRecord`
 * and its subcollections. For legacy rows, `humanDecision.decidedBy` is
 * already present on the `TeamRunListItemV1` the caller passes in (no
 * extra read needed) — see teamReviewQueueEnrichment.ts for why `teamRuns`
 * IS canonical for that specific legacy sub-system.
 */
async function enrichPageItems(
  db: Firestore,
  pageItems: TeamRunListItemV1[],
  callerEmail: string | undefined,
  emailByUid: Map<string, string>
): Promise<EnrichedTeamRunListItemV1[]> {
  const adaptiveItems = pageItems.filter((i): i is AdaptiveTeamRunListItemV1 => i.kind === "adaptive");

  const runRefs = adaptiveItems.map((i) => db.collection("runs").doc(i.runId));
  const assignmentRefs = adaptiveItems.map((i) => db.collection("runs").doc(i.runId).collection("humanReviewAssignment").doc("current"));
  const panelRefs = adaptiveItems.map((i) => db.collection("runs").doc(i.runId).collection("humanReviewPanel").doc("current"));

  const [runSnaps, assignmentSnaps, panelSnaps] = await Promise.all([
    batchGetAll(db, runRefs),
    batchGetAll(db, assignmentRefs),
    batchGetAll(db, panelRefs),
  ]);

  const governanceByRunId = new Map<string, GovernanceRecordV1 | null>();
  const assignmentByRunId = new Map<string, AdaptiveHumanReviewAssignmentV1 | null>();
  const panelByRunId = new Map<string, AdaptiveHumanReviewPanelV1 | null>();
  // Step 17 — tracks a genuine read failure (never "nothing configured")
  // per runId, so the UI can show "Review details unavailable" rather
  // than an indistinguishable "not assigned" state.
  const enrichmentFailedRunIds = new Set<string>();

  adaptiveItems.forEach((item, idx) => {
    const runResult = runSnaps[idx];
    if (runResult.failed) enrichmentFailedRunIds.add(item.runId);
    const parsedGov = parseGovernanceRecord(runResult.snap?.exists ? runResult.snap.data()?.governanceRecord : undefined);
    governanceByRunId.set(item.runId, parsedGov.ok ? parsedGov.record : null);

    const assignmentResult = assignmentSnaps[idx];
    if (assignmentResult.failed) enrichmentFailedRunIds.add(item.runId);
    assignmentByRunId.set(item.runId, assignmentResult.snap?.exists ? (assignmentResult.snap.data() as AdaptiveHumanReviewAssignmentV1) : null);

    const panelResult = panelSnaps[idx];
    if (panelResult.failed) enrichmentFailedRunIds.add(item.runId);
    const parsedPanel = parseAdaptiveHumanReviewPanel(panelResult.snap?.exists ? panelResult.snap.data() : undefined, { expectedRunId: item.runId });
    panelByRunId.set(item.runId, parsedPanel.status === "valid" ? parsedPanel.panel : null);
  });

  // Votes need each row's panel revision first (resolved above), so this
  // is a second batched pass — still one db.getAll() per chunk across
  // EVERY row's votes together, never per-row.
  const voteRefEntries: { runId: string; reviewerId: string; ref: DocumentReference }[] = [];
  for (const item of adaptiveItems) {
    const panel = panelByRunId.get(item.runId);
    if (!panel || panel.status === "cancelled") continue;
    const voteRevision = panel.status === "open" ? panel.revision : panel.revision - 1;
    for (const reviewerId of panel.reviewerUserIds) {
      const voteId = buildAdaptiveHumanReviewVoteId(voteRevision, reviewerId);
      voteRefEntries.push({ runId: item.runId, reviewerId, ref: db.collection("runs").doc(item.runId).collection("humanReviewVotes").doc(voteId) });
    }
  }
  const voteResults = await batchGetAll(db, voteRefEntries.map((v) => v.ref));
  const votesByRunId = new Map<string, AdaptiveHumanReviewVoteV1[]>();
  voteRefEntries.forEach((entry, idx) => {
    const result = voteResults[idx];
    if (result.failed) enrichmentFailedRunIds.add(entry.runId);
    if (!result.snap?.exists) return;
    const parsed = parseAdaptiveHumanReviewVote(result.snap.data(), { expectedRunId: entry.runId, expectedReviewerUserId: entry.reviewerId });
    if (parsed.status !== "valid") return;
    const arr = votesByRunId.get(entry.runId) ?? [];
    arr.push(parsed.vote);
    votesByRunId.set(entry.runId, arr);
  });

  // Collect every candidate uid across the WHOLE page (adaptive + legacy)
  // for exactly ONE batched identity resolution call — the specific fix
  // Step 12 requires, reusing the shared resolver unchanged.
  const candidateUids = new Set<string>();
  for (const item of pageItems) {
    if (item.kind === "legacy") {
      if (item.humanDecision?.decidedBy) candidateUids.add(item.humanDecision.decidedBy);
      continue;
    }
    const gov = governanceByRunId.get(item.runId);
    if (gov?.humanReview.reviewerId) candidateUids.add(gov.humanReview.reviewerId);
    const assignment = assignmentByRunId.get(item.runId);
    if (assignment?.assignedReviewerUserId) candidateUids.add(assignment.assignedReviewerUserId);
    if (assignment?.assignedByUserId) candidateUids.add(assignment.assignedByUserId);
    const panel = panelByRunId.get(item.runId);
    if (panel) {
      for (const reviewerId of panel.reviewerUserIds) candidateUids.add(reviewerId);
      if (panel.overrideByUserId) candidateUids.add(panel.overrideByUserId);
    }
  }

  const resolvedNames = await resolveReviewerDisplayNames(Array.from(candidateUids), emailByUid, callerEmail);
  const resolveDisplayName = async (uid: string) => resolvedNames.get(uid) ?? UNKNOWN_REVIEWER_LABEL;

  const enriched: EnrichedTeamRunListItemV1[] = [];
  for (const item of pageItems) {
    if (item.kind === "legacy") {
      enriched.push(await enrichLegacyTeamRunListItem(item, item.humanDecision?.decidedBy, resolveDisplayName));
    } else {
      const enrichedItem = await enrichAdaptiveTeamRunListItem(
        item,
        {
          governanceRecord: governanceByRunId.get(item.runId) ?? null,
          assignment: assignmentByRunId.get(item.runId) ?? null,
          panel: panelByRunId.get(item.runId) ?? null,
          votes: votesByRunId.get(item.runId) ?? [],
        },
        resolveDisplayName
      );
      if (enrichmentFailedRunIds.has(item.runId)) enrichedItem.enrichmentUnavailable = true;
      enriched.push(enrichedItem);
    }
  }
  return enriched;
}

export async function GET(req: NextRequest) {
  const uidOrRes = await getRequestUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  if (!adminDb) {
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable." } },
      { status: 500 }
    );
  }

  const ctx = await loadUserAndTeam(uid);
  if (!ctx?.team) {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Team access required" } },
      { status: 403 }
    );
  }

  const { searchParams } = req.nextUrl;

  // ============================================
  // QUERY-ROUTING REDESIGN, PHASE 2A, STEP 7, PART E1 — versioned,
  // explicitly-discriminated list contract, opt-in via `?version=1`
  // (docs/governance-decision-receipts-design.md §25). The legacy,
  // untagged response below remains the default and is UNCHANGED — no
  // internal or external consumer of the default response has been
  // confirmed, so the default is not switched in this step (§25.10).
  // ============================================
  if (searchParams.get("version") === "1") {
    const filterResult = parseTeamRunListFilters(searchParams);
    if (!filterResult.ok) {
      return NextResponse.json(
        { ok: false, error: { code: "validation_error", message: `Invalid query parameter: ${filterResult.reason}` } },
        { status: 400 }
      );
    }
    const { filters } = filterResult;

    const role = memberRole(uid, ctx.team);
    const admin = isTeamAdmin(role);

    const snap = await adminDb.collection("teamRuns").where("teamId", "==", ctx.team.id).get();

    // Member-only scoping happens on RAW document data, before
    // classification/mapping — the mapped adaptive item never exposes
    // `userId` at all (§25.9), so scoping must not depend on the mapped
    // shape.
    const scopedDocs = admin ? snap.docs : snap.docs.filter((d) => d.data().userId === uid);

    const items: TeamRunListItemV1[] = [];
    for (const doc of scopedDocs) {
      const result = classifyTeamRunRow(doc.id, doc.data());
      if (result.status === "valid") {
        items.push(result.item);
      } else {
        // Metadata-only — never the query, receipt conclusion, or any
        // other row content.
        logger.warn("[teams/runs] Skipped a malformed teamRuns row from the versioned list", {
          teamRunId: result.teamRunId,
          detectedKind: result.detectedKind,
        });
      }
    }

    const filteredItems = applyTeamRunListFilters(items, filters);
    const sortedItems = sortTeamRunListItems(filteredItems);
    const { pageItems, pagination } = paginateTeamRunListItems(sortedItems, filters.page, filters.limit);

    // Review Page Reviewer Display — enrichment is bounded to exactly the
    // page being returned (never the full team's `teamRuns` history), and
    // is best-effort: a governance-enrichment failure never removes a row
    // from the queue or fails the whole request (see enrichPageItems'/
    // batchGetAll's own degrade-per-chunk behavior) — worst case a row's
    // reviewer/assignment/panel fields are simply absent, matching a
    // genuinely "not yet configured" row's own shape.
    const emailByUid = new Map((ctx.team.members ?? []).map((m) => [m.uid, m.email] as const));
    const enrichedItems = await enrichPageItems(adminDb, pageItems, ctx.user?.email, emailByUid);

    const response: EnrichedTeamRunListResponseV1 = {
      ok: true,
      version: 1,
      items: enrichedItems,
      pagination,
    };
    return NextResponse.json(response);
  }

  // ---- Legacy, unversioned response (unchanged) ----
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10) || 20));
  const typeFilter = searchParams.get("type") as "research" | "verification" | null;
  const flaggedOnly = searchParams.get("flagged") === "true";
  const userFilter = searchParams.get("userId");

  const role = memberRole(uid, ctx.team);
  const admin = isTeamAdmin(role);

  const snap = await adminDb.collection("teamRuns").where("teamId", "==", ctx.team.id).get();

  let rows: TeamRunListRow[] = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      timestamp: tsMillis(data.timestamp),
    } as TeamRunListRow;
  });

  if (!admin) {
    rows = rows.filter((r) => r.userId === uid);
  }

  if (typeFilter === "research" || typeFilter === "verification") {
    rows = rows.filter((r) => r.type === typeFilter);
  }

  if (userFilter && admin) {
    rows = rows.filter((r) => r.userId === userFilter);
  }

  if (flaggedOnly) {
    rows = rows.filter((r) => {
      const flags = r.policyFlags;
      return Array.isArray(flags) && flags.length > 0 && !r.humanDecision;
    });
  }

  rows.sort((a, b) => (b.timestamp as number) - (a.timestamp as number));

  const total = rows.length;
  const start = (page - 1) * limit;
  const pageRows = rows.slice(start, start + limit);

  return NextResponse.json({
    ok: true,
    runs: pageRows,
    total,
    page,
    limit,
  });
}
