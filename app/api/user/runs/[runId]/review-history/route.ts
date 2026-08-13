/**
 * Governance Follow-Up Hardening (post PR #33 production canary) — the
 * owner-or-assigned-personal-reviewer read path for a run's immutable
 * review history. Closes the gap where `ReviewGovernanceSection.tsx`'s
 * `ReviewHistory` component was hardwired to
 * `GET /api/teams/adaptive-runs/[runId]/history`, which correctly rejects
 * a personal (non-team) run with `403 "Team access required"` — the
 * decision and its `humanReviewHistory` entry were always recorded
 * correctly, there was simply no read path for anyone (including the
 * owner) to see it. This route is that read path.
 *
 * Reads the SAME canonical `runs/{runId}/humanReviewHistory` subcollection
 * the team route reads, via the SAME tested row classifier
 * (`classifyAdaptiveHumanReviewHistoryRow` — never reimplemented). The
 * team route's own contract deliberately excludes reviewer identity
 * ("never reviewerId, reviewerName..."); this route adds a resolved
 * `reviewerDisplayName` per item on top, reusing the same identity
 * resolver `GET /api/user/runs/[runId]/governance` already uses. That
 * widening is additive and personal-route-only — `AdaptiveReviewHistoryListItemV1`
 * and the team endpoint are never modified.
 *
 * Authorization reuses the central `resolveAdaptiveRunAccess` resolver —
 * never `loadUserAndTeam`/team-membership checks — so this can never
 * become a "fake team membership" path. Allowed: the run's owner, or the
 * currently-assigned PERSONAL reviewer (assignment.teamId === null); a
 * team-assigned reviewer is never granted access here (the resolver's own
 * `personal_reviewer` role requires `teamId === null` by construction).
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { getAdaptiveHumanReviewAssignment } from "@/lib/firestore/runs";
import { resolveAdaptiveRunAccess } from "@/lib/governance/adaptiveRunAccess";
import { classifyAdaptiveHumanReviewHistoryRow, AdaptiveReviewHistoryListItemV1 } from "@/lib/governance/adaptiveHumanReviewHistory";
import { resolveReviewerDisplayNames, REVIEWER_UNAVAILABLE_LABEL } from "@/lib/governance/reviewerIdentity";
import { loadUserAndTeam } from "@/lib/teams/teamApiAuth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type PersonalReviewHistoryItemV1 = AdaptiveReviewHistoryListItemV1 & { reviewerDisplayName: string };

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/user/runs/[runId]/review-history", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return errorResponse(401, "unauthorized", "Please sign in.");
  }
  return errorResponse(401, "auth_error", "Authentication failed.");
}

export async function GET(req: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const { runId } = await context.params;
  if (!runId?.trim() || !adminDb) {
    return errorResponse(404, "not_found", "Run not found.");
  }

  const snap = await adminDb.collection("runs").doc(runId).get();
  if (!snap.exists) {
    return errorResponse(404, "not_found", "Run not found.");
  }
  const data = snap.data() as Record<string, unknown>;
  const owner = String(data.userId ?? "");

  const [assignmentResult, govParse] = await Promise.all([
    getAdaptiveHumanReviewAssignment(runId),
    Promise.resolve(parseGovernanceRecord(data.governanceRecord)),
  ]);
  const assignment = assignmentResult.status === "found" ? assignmentResult.assignment : null;

  const access = resolveAdaptiveRunAccess({
    uid,
    runOwnerUid: owner,
    assignment,
    humanReviewStatus: govParse.ok ? govParse.record.humanReview.status : null,
  });
  if (access.role === "unauthorized") {
    return errorResponse(403, "forbidden", "You do not have access to this run.");
  }

  let historySnap;
  try {
    historySnap = await adminDb.collection("runs").doc(runId).collection("humanReviewHistory").get();
  } catch {
    return errorResponse(503, "firestore_unavailable", "Could not load review history.");
  }

  // Canonical rows only — the same tested classifier the team route uses,
  // never a derivation from current status/assignment timestamps/teamRuns.
  // reviewerId is read directly off the raw doc for identity resolution
  // only, since the classifier deliberately excludes it from the compact
  // item it returns.
  const rows: Array<{ item: AdaptiveReviewHistoryListItemV1; historyId: string; reviewerId: string | null }> = [];
  for (const doc of historySnap.docs) {
    const result = classifyAdaptiveHumanReviewHistoryRow(doc.id, doc.data());
    if (result.status === "valid") {
      const rawReviewerId = doc.data()?.reviewerId;
      rows.push({ item: result.item, historyId: result.historyId, reviewerId: typeof rawReviewerId === "string" ? rawReviewerId : null });
    } else {
      logger.warn("[user/runs/review-history] Skipped a malformed or unsupported history row", { runId, historyId: result.historyId });
    }
  }

  // Same ordering as sortAdaptiveReviewHistoryRows (reviewedAt ascending,
  // historyId tiebreak) — inlined rather than reused because that helper's
  // return type drops historyId/reviewerId, which this route still needs
  // for identity resolution.
  rows.sort((a, b) => {
    const ta = Date.parse(a.item.reviewedAt);
    const tb = Date.parse(b.item.reviewedAt);
    if (ta !== tb) return ta - tb;
    return a.historyId < b.historyId ? -1 : a.historyId > b.historyId ? 1 : 0;
  });

  // The caller (owner or personal reviewer) has no team-admin context by
  // default — sourced purely for the identity resolver's masked-email
  // fallback, never to gate authorization (already done above) and never
  // to change which rows are returned.
  const teamCtx = await loadUserAndTeam(uid).catch(() => null);
  const callerEmail = teamCtx?.user?.email;
  const emailByUid = new Map((teamCtx?.team?.members ?? []).map((m) => [m.uid, m.email] as const));

  const candidateUids = Array.from(new Set(rows.map((r) => r.reviewerId).filter((v): v is string => v !== null)));
  const resolvedNames = await resolveReviewerDisplayNames(candidateUids, emailByUid, callerEmail, REVIEWER_UNAVAILABLE_LABEL);

  const items: PersonalReviewHistoryItemV1[] = rows.map((r) => ({
    ...r.item,
    reviewerDisplayName: r.reviewerId ? resolvedNames.get(r.reviewerId) ?? REVIEWER_UNAVAILABLE_LABEL : REVIEWER_UNAVAILABLE_LABEL,
  }));

  return NextResponse.json({ ok: true, version: 1, runId, items });
}
