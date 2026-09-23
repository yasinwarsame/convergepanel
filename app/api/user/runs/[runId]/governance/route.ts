/**
 * Review & Governance report completion — a dedicated, decoupled-failure-
 * domain endpoint returning presentation-safe governance DETAIL (reviewer
 * identity, assignment, peer-review panel/quorum/vote progress) for a
 * run's owner. The primary run response
 * (`GET /api/user/runs/[runId]`) intentionally stays compact
 * (status/conditions/decidedVia only, "never reviewer name or comment
 * text") — this route is the deliberate, disclosed place that widens that
 * to include resolved reviewer IDENTITY (never comment/justification
 * text, which stays hidden everywhere).
 *
 * Auth mirrors `app/api/user/runs/[runId]/route.ts` exactly: same
 * `resolveRequestIdentity()` → owner-equality check against
 * `runs/{runId}.userId`. This is deliberately NOT the `isTeamAdmin` gate
 * `app/api/teams/adaptive-runs/[runId]/**` routes use — a run owner reading
 * their OWN report's governance detail is a separate authorization domain
 * from team governance management, and this route never allows mutation.
 *
 * Reads are bounded and read-only: the run document, plus (Milestone-2
 * only) `humanReviewAssignment/current`, `humanReviewPanel/current`, and
 * — only when an open/finalized panel exists — each reviewer's vote
 * (≤`MAX_ADAPTIVE_PANEL_REVIEWERS`). Never reads `teamRuns` — routing
 * stays exactly as already resolved by `/api/user/runs/[runId]`; this
 * endpoint only ever ADDS identity/assignment/panel/vote detail from
 * canonical sources, never re-derives status from a projection.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { buildReviewGovernanceViewModel } from "@/lib/adaptiveSchema/reviewGovernanceViewModel";
import { getAdaptiveHumanReviewAssignment, getAdaptiveHumanReviewPanel, getAdaptiveHumanReviewVote } from "@/lib/firestore/runs";
import type { AdaptiveHumanReviewAssignmentV1 } from "@/lib/governance/adaptiveHumanReviewAssignment";
import type { AdaptiveHumanReviewPanelV1 } from "@/lib/governance/adaptiveHumanReviewPanel";
import type { AdaptiveHumanReviewVoteV1 } from "@/lib/governance/adaptiveHumanReviewVote";
import { resolveReviewerDisplayNames, REVIEWER_UNAVAILABLE_LABEL } from "@/lib/governance/reviewerIdentity";
import { resolveAdaptiveRunAccess } from "@/lib/governance/adaptiveRunAccess";
import {
  viewerMayReadReviewPanel,
  expectedPersonalDecisionId,
  classifyDecisionScopeFromPersonalDoc,
  viewerMayReadDecisionReviewerIdentity,
} from "@/lib/governance/personalReviewScope";
import { loadUserAndTeam } from "@/lib/teams/teamApiAuth";
import { validateRunWorkspaceAssociation } from "@/lib/workspaces/runWorkspaceIntegrity";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_LEGACY_GOVERNANCE_STATUSES = new Set(["approved", "needs_review", "blocked"]);

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/user/runs/[runId]/governance", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export async function GET(req: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const { runId } = await context.params;
  if (!runId?.trim() || !adminDb) {
    return NextResponse.json({ ok: false, errorCode: "not_found", message: "Run not found." }, { status: 404 });
  }

  const snap = await adminDb.collection("runs").doc(runId).get();
  if (!snap.exists) {
    return NextResponse.json({ ok: false, errorCode: "not_found", message: "Run not found." }, { status: 404 });
  }

  const data = snap.data() as Record<string, unknown>;
  const owner = String(data.userId ?? "");

  // Phase 4B — Mandatory Workspace Integrity, requester-independent, runs
  // before every other check in this route (including the governance-
  // record-corruption check below) — an invalid association must deny
  // regardless of who is asking or what else about the run looks fine.
  const integrity = await validateRunWorkspaceAssociation(data);
  if (integrity.classification === "invalid") {
    logger.warn("[user/runs/governance] workspace_run_integrity_failed", { runId, reason: integrity.reason });
    return NextResponse.json({ ok: false, errorCode: "not_found", message: "Run not found." }, { status: 404 });
  }

  const govParse = parseGovernanceRecord(data.governanceRecord);
  if (!govParse.ok && govParse.reason !== "absent") {
    // A genuinely corrupted/unsupported Milestone-2 record is a real data
    // problem, not "no review configured" — surfacing it as not_configured
    // would make a false claim. The client renders this as "unavailable",
    // per the same discipline as a fetch failure (never flashed as
    // not_configured).
    logger.warn("[user/runs/governance] Unreadable governanceRecord", { runId, reason: govParse.reason });
    return NextResponse.json({ ok: false, errorCode: "governance_data_invalid", message: "Review information unavailable." }, { status: 500 });
  }

  let assignment: AdaptiveHumanReviewAssignmentV1 | null = null;
  let panel: AdaptiveHumanReviewPanelV1 | null = null;
  let votes: AdaptiveHumanReviewVoteV1[] = [];

  // Personal Reviewer Inbox + Action Flow — the assignment read moved
  // earlier (unconditional on govParse.ok) so it can also serve the
  // authorization check below for a non-owner caller. Same response shape
  // either way — no owner-only fields exist in this endpoint's output
  // (assignment/singleReviewer/panel are exactly what a reviewer needs to
  // see about their own review).
  const assignmentResult = await getAdaptiveHumanReviewAssignment(runId);
  if (assignmentResult.status === "found") {
    assignment = assignmentResult.assignment;
  } else if (assignmentResult.status === "read_failed" || assignmentResult.status === "firestore_unavailable") {
    logger.warn("[user/runs/governance] Assignment read failed; degrading to no-assignment", { runId, status: assignmentResult.status });
  }

  let viewerRole: "owner" | "personal_reviewer" = "owner";
  if (owner !== uid) {
    const access = resolveAdaptiveRunAccess({
      uid,
      runOwnerUid: owner,
      assignment,
      humanReviewStatus: govParse.ok ? govParse.record.humanReview.status : null,
    });
    if (access.role !== "personal_reviewer") {
      return NextResponse.json({ ok: false, errorCode: "forbidden", message: "You do not have access to this run." }, { status: 403 });
    }
    viewerRole = "personal_reviewer";
  }

  const rawLegacyStatus = data.governanceStatus;
  const legacy =
    !govParse.ok && typeof rawLegacyStatus === "string" && VALID_LEGACY_GOVERNANCE_STATUSES.has(rawLegacyStatus)
      ? {
          status: rawLegacyStatus as "approved" | "needs_review" | "blocked",
          reasons: isStringArray(data.governanceReasons) ? data.governanceReasons : [],
          reviewedByUid: typeof data.governanceReviewedBy === "string" && data.governanceReviewedBy ? data.governanceReviewedBy : null,
          reviewedAt: typeof data.governanceReviewedAt === "string" && data.governanceReviewedAt ? data.governanceReviewedAt : null,
        }
      : null;

  // PHASE 1 — Personal/Team review-panel isolation. The panel and its votes
  // are read ONLY for a viewer whose capability covers them. This used to be
  // unconditional, justified by "a panel is team-only by construction
  // (personal runs never have one)" — false: a LEGACY run carries no
  // `workspaceId` at all, passes integrity as `legacy`, and can hold a legacy
  // Team panel alongside an independent `teamId: null` Personal assignment,
  // since `submitAdaptiveHumanReviewPanel` never touches the assignment doc.
  //
  // The gate sits BEFORE the reads, not over the output: redacting Team
  // identities after resolving them would still have fetched the panel, every
  // vote, and every reviewer profile. `panel` staying null is also what keeps
  // the Team reviewer uids out of `candidateUids` below, so the identity
  // resolver is never asked about them at all.
  if (govParse.ok && viewerMayReadReviewPanel(viewerRole)) {
    const panelResult = await getAdaptiveHumanReviewPanel(runId);

    if (panelResult.status === "found") {
      panel = panelResult.panel;
      if (panel.status !== "cancelled") {
        const voteRevision = panel.status === "open" ? panel.revision : panel.revision - 1;
        const voteResults = await Promise.all(
          panel.reviewerUserIds.map((reviewerId) => getAdaptiveHumanReviewVote(runId, voteRevision, reviewerId))
        );
        votes = voteResults.filter((r): r is { status: "found"; vote: AdaptiveHumanReviewVoteV1 } => r.status === "found").map((r) => r.vote);
      }
    } else if (
      panelResult.status === "read_failed" ||
      panelResult.status === "firestore_unavailable" ||
      panelResult.status === "malformed" ||
      panelResult.status === "unsupported_version"
    ) {
      logger.warn("[user/runs/governance] Panel read failed; degrading to no-panel", { runId, status: panelResult.status });
    }
  }

  // Governance Follow-Up Hardening — this comment previously said "the run
  // owner (this endpoint's only caller)", which stopped being true once
  // Personal Reviewer Inbox + Action Flow (PR #33) extended this route to
  // an assigned personal reviewer too. Neither caller has team-admin
  // context by default; this is sourced purely to give the identity
  // resolver a roster of member emails for its masked-email fallback,
  // never to gate authorization (the resolveAdaptiveRunAccess check above
  // already did that) and never to change family classification. Worst
  // case on a miss is a less-precise display-name fallback for the
  // CALLER's own already-visible team roster — never a cross-boundary
  // leak, since emailByUid only ever contains the caller's own team.
  const teamCtx = await loadUserAndTeam(uid).catch(() => null);
  const callerEmail = teamCtx?.user?.email;
  const emailByUid = new Map((teamCtx?.team?.members ?? []).map((m) => [m.uid, m.email] as const));

  // Batch-resolve every uid this response could possibly need in ONE
  // Firestore round-trip (resolveReviewerDisplayNames -> db.getAll()),
  // rather than one independent read per reviewer — the candidate set is
  // collected up front since assignment/panel/governance are all already
  // in hand at this point. Bounded by MAX_ADAPTIVE_PANEL_REVIEWERS (9) in
  // practice; deduplicated internally by the resolver.
  // PHASE 1 — Personal/Team review isolation, the SINGLE-REVIEWER half.
  //
  // Suppressing the panel was not sufficient. A legacy Team actor can decide
  // a legacy run directly through the Team decision route, with no panel
  // involved at all; that lands in `governanceRecord.humanReview.reviewerId`.
  // Enriching it unconditionally handed a Personal reviewer the Team
  // decider's resolved display name — while the review-history sibling,
  // filtering on the persisted `teamId`, correctly hid the very same
  // decision. Two surfaces, one run, one viewer, opposite answers.
  //
  // `humanReview` carries no `teamId` and no scope field, so the decision is
  // attributed from the guaranteed persisted provenance instead: the
  // matching `humanReviewHistory` row's `teamId` — the same discriminator
  // review-history treats as canonical, which is what keeps the two
  // surfaces in agreement. The rows are read ONLY when a non-owner actually
  // faces a decided review, and an unreadable read denies rather than
  // admits.
  // The provenance lookup is a single POINT READ of the exact document a
  // PERSONAL decision on this run would have been written under —
  // `humanReviewHistory/{buildPersonalReviewDecisionId(runId, reviewedAt, status)}`.
  // The id SELECTS a candidate; it does not authenticate one. The namespaces
  // are `:`-joined prefixes, so the team builder yields the identical id when
  // its `teamId` is literally "personal". What denies an aliased document is
  // the body validation in `classifyDecisionScopeFromPersonalDoc` — the
  // Personal discriminator plus agreement with the canonical record — which
  // is also what separates Personal from WORKSPACE, since Workspace writers
  // store `teamId: null` too. A failed read denies rather than admits.
  let personalDecisionDoc: { exists: boolean; data: unknown } | null = null;
  if (viewerRole !== "owner" && govParse.ok) {
    const expectedId = expectedPersonalDecisionId({
      runId,
      reviewedAt: govParse.record.humanReview.reviewedAt,
      status: govParse.record.humanReview.status,
    });
    if (expectedId) {
      try {
        const snap = await adminDb.collection("runs").doc(runId).collection("humanReviewHistory").doc(expectedId).get();
        personalDecisionDoc = { exists: snap.exists === true, data: snap.exists ? snap.data() : null };
      } catch {
        logger.warn("[user/runs/governance] Decision-provenance read failed; denying reviewer identity", { runId });
        personalDecisionDoc = null;
      }
    }
  }
  const decisionScope = govParse.ok
    ? classifyDecisionScopeFromPersonalDoc({
        decidedVia: govParse.record.humanReview.decidedVia,
        reviewerId: govParse.record.humanReview.reviewerId,
        reviewedAt: govParse.record.humanReview.reviewedAt,
        status: govParse.record.humanReview.status,
        personalDoc: personalDecisionDoc,
      })
    : "unknown";
  const mayReadDecisionReviewer = viewerMayReadDecisionReviewerIdentity({
    role: viewerRole,
    scope: decisionScope,
    viewerUid: uid,
    reviewerId: govParse.ok ? govParse.record.humanReview.reviewerId : undefined,
  });

  const candidateUids = new Set<string>();
  // The legacy (System A) reviewer carries no recoverable scope at all, so a
  // non-owner never resolves it — fail closed, same rule.
  if (mayReadDecisionReviewer && legacy?.reviewedByUid) candidateUids.add(legacy.reviewedByUid);
  if (mayReadDecisionReviewer && govParse.ok && govParse.record.humanReview.reviewerId) {
    candidateUids.add(govParse.record.humanReview.reviewerId);
  }
  if (assignment?.assignedReviewerUserId) candidateUids.add(assignment.assignedReviewerUserId);
  if (assignment?.assignedByUserId) candidateUids.add(assignment.assignedByUserId);
  if (panel) {
    for (const reviewerId of panel.reviewerUserIds) candidateUids.add(reviewerId);
    if (panel.overrideByUserId) candidateUids.add(panel.overrideByUserId);
  }

  const resolvedNames = await resolveReviewerDisplayNames(Array.from(candidateUids), emailByUid, callerEmail, REVIEWER_UNAVAILABLE_LABEL);
  const resolveDisplayName = async (reviewerUid: string) => resolvedNames.get(reviewerUid) ?? REVIEWER_UNAVAILABLE_LABEL;

  const governance = await buildReviewGovernanceViewModel({
    suppressReviewerIdentity: !mayReadDecisionReviewer,
    governanceRecord: govParse.ok ? govParse.record : null,
    legacy,
    assignment,
    panel,
    votes,
    resolveDisplayName,
  });

  // Governance Follow-Up Hardening — a coarse routing signal (never a raw
  // teamId) so the client knows which review-history endpoint to call:
  // the team-only `/api/teams/adaptive-runs/[runId]/history` or the new
  // `/api/user/runs/[runId]/review-history`.
  //
  // This comment previously read "A panel is team-only by construction
  // (personal runs never have one)". That was false — a legacy run can carry
  // a Team panel and an independent `teamId: null` Personal assignment at
  // once — and it is the premise that produced this route's original
  // disclosure. Panel visibility is not a property of which documents can
  // coexist; it is decided by explicit viewer scope. `panel` is non-null here
  // only for a viewer `viewerMayReadReviewPanel` admits, so a personal
  // reviewer always falls through to the assignment branch, and
  // `resolveAdaptiveRunAccess` grants that role only when
  // `assignment.teamId === null` — hence "personal" for them. "unknown" only
  // when nothing is configured yet, where there is no history to fetch.
  const historyScope: "team" | "personal" | "unknown" = panel ? "team" : assignment ? (assignment.teamId === null ? "personal" : "team") : "unknown";

  return NextResponse.json({
    ok: true,
    viewerRole,
    historyScope,
    // Personal Reviewer Inbox + Action Flow — the same optimistic-
    // concurrency token the team decision form already sends as
    // `expectedUpdatedAt` (submitAdaptiveHumanReview matches it against
    // governanceRecord.updatedAt inside its own transaction). Not
    // sensitive — a plain timestamp — and required for the personal
    // decision form to function at all.
    governanceUpdatedAt: govParse.ok ? govParse.record.updatedAt : undefined,
    // The single source of truth this route's own callers (the personal
    // reviewer detail page) use to decide whether the decision form should
    // render — reads directly off the parsed governanceRecord, never
    // gated behind /api/user/runs/[runId]'s separate, stricter
    // parsePersistedAdaptiveOutput validation of the full adaptiveOutput
    // envelope. Those are two different concerns (full report content vs.
    // the compact governance record) and must not be conflated — a run
    // can have a perfectly valid, reviewable governanceRecord even if
    // some other part of its adaptiveOutput envelope is in an unexpected
    // shape.
    humanReviewStatus: govParse.ok ? govParse.record.humanReview.status : undefined,
    // Mirrors AdaptiveReviewDetailResponseV1's own decisionReceipt exposure
    // (the team detail route) — conclusion/basis/assumptions/uncertainties/
    // limitations/sourceBacked/humanReviewNeeded are exactly what a
    // reviewer needs to make a decision, and none of it is owner-only.
    decisionReceipt: govParse.ok ? govParse.record.decisionReceipt : undefined,
    schemaId: govParse.ok ? govParse.record.schemaId : undefined,
    answerShape: govParse.ok ? govParse.record.answerShape : undefined,
    // Mirrors AdaptiveReviewDetailResponseV1's own automatedGovernance
    // exposure (the team detail route, lib/governance/adaptiveReviewDetail.ts)
    // exactly — `status`/`evaluatedAt`/`policyVersion` only, never `reasons`
    // (policy-internal text, never exposed to any reviewer/owner surface).
    // `undefined` when the run genuinely has no automated-governance record
    // at all — the client must render nothing for this field then, never a
    // fabricated "Unknown" badge.
    automatedGovernance:
      govParse.ok && govParse.record.automatedGovernance
        ? {
            status: govParse.record.automatedGovernance.status,
            evaluatedAt: govParse.record.automatedGovernance.evaluatedAt,
            policyVersion: govParse.record.automatedGovernance.policyVersion,
          }
        : undefined,
    governance,
  });
}
