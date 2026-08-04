/**
 * Multi-Reviewer Panel Foundation, Part B
 * (docs/governance-decision-receipts-design.md §29, §30). `{runId}` is the
 * real `runs/{runId}` panel run ID — `teamId`, actor identity, timestamps,
 * `mode`, `quorum`, `requiredReviewerCount`, and `status` are NEVER
 * accepted from the client anywhere in this route; every authoritative
 * value is server-derived, matching every other adaptive-runs route.
 *
 * PART B SCOPE ONLY (route-level auth/config; superseded for GET's response
 * shape by Part F below, and for PUT/DELETE's opt-in gating by Step 5.10
 * below): no votes, no aggregation, no finalization, no
 * `ready_to_finalize`/`finalized` status. GET does not require the
 * team's multi-reviewer opt-in to be enabled (a team may still want to
 * VIEW an existing panel's configuration after disabling opt-in).
 *
 * Production-Readiness Hardening, Step 5.10 (rollback semantics) — PUT
 * (create/reconfigure — genuinely NEW panel activity) requires BOTH the
 * team's own opt-in AND the global `MULTI_REVIEWER_GOVERNANCE_ENABLED` kill
 * switch (`lib/env.ts`). DELETE (cancel) requires NEITHER: cancelling an
 * already-open panel is a DRAIN operation, not new activity, and must
 * always remain available to an authorized admin/owner even after the team
 * (or the whole feature, globally) has been disabled — otherwise disabling
 * the feature would strand any panel that was already open, which the
 * rollback policy explicitly forbids. This mirrors the vote/finalize/
 * override routes, none of which have ever gated on the opt-in either (a
 * pre-existing inconsistency, corrected here — see
 * docs/governance-decision-receipts-design.md §35.2 for the full audit).
 */

/**
 * Multi-Reviewer Owner Override, Part F (§F10) — GET's response is
 * extended, additively, with a rich per-run read model: live vote status
 * per reviewer (status/submitted-time only — never comment/conditions text,
 * which remain exclusive to `GET .../votes`'s own established privacy
 * rule), the derived `aggregationState` (recomputed fresh from the pure
 * engine — never stored), and four capability flags
 * (`canReconfigurePanel`/`canCancelPanel`/`canVote`/`canFinalize`/`canOverride`)
 * so client UI
 * never has to re-derive team-role/eligibility logic itself. Every
 * reviewer's `voteStatus` (not their comment/conditions) is visible to
 * every other panel reviewer — a deliberate, spec-mandated exception to
 * the vote route's own "self only" rule for exactly this one compact field
 * (§F14). Bounded reads only: at most one panel read plus one vote read per
 * reviewer (≤9, matching every other adaptive-panel route in this
 * codebase) — no collection query, no N+1 growth with run count.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getRequestUid, loadUserAndTeam, memberRole, isTeamAdmin } from "@/lib/teams/teamApiAuth";
import { getAdaptiveTeamRunProjection } from "@/lib/firestore/teamRuns";
import { getAdaptiveHumanReviewPanel, submitAdaptiveHumanReviewPanel, cancelAdaptiveHumanReviewPanel, getAdaptiveHumanReviewVote } from "@/lib/firestore/runs";
import {
  MIN_ADAPTIVE_PANEL_REVIEWERS,
  MAX_ADAPTIVE_PANEL_REVIEWERS,
  normalizeAdaptivePanelReviewerUserIds,
  AdaptiveHumanReviewPanelV1,
} from "@/lib/governance/adaptiveHumanReviewPanel";
import { ELIGIBLE_REVIEWER_ROLES } from "@/lib/governance/adaptiveHumanReviewAssignment";
import { aggregateAdaptiveReviewVotes } from "@/lib/governance/adaptiveReviewAggregation";
import { parseGovernanceRecord, isHumanReviewStatusReviewable } from "@/lib/adaptiveSchema/governanceRecordParser";
import type { TeamDocument } from "@/lib/governance/teamTypes";
import type { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import type { AdaptiveHumanReviewVoteV1 } from "@/lib/governance/adaptiveHumanReviewVote";
import { maskEmail } from "@/lib/utils/maskEmail";
import { logger } from "@/lib/logger";
import { MULTI_REVIEWER_GOVERNANCE_ENABLED } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

async function resolveDisplayName(uid: string, fallbackEmail: string, callerEmail: string | undefined): Promise<string> {
  try {
    const snap = await adminDb!.collection("users").doc(uid).get();
    const name = typeof snap.data()?.name === "string" ? (snap.data()!.name as string).trim() : "";
    if (name) return name;
  } catch {
    // Fall through to the email-based fallback.
  }
  return maskEmail(fallbackEmail, callerEmail);
}

async function authorizeAndLoadContext(req: NextRequest, runId: string) {
  const uidOrRes = await getRequestUid(req);
  if (uidOrRes instanceof NextResponse) return { errorRes: uidOrRes } as const;
  const uid = uidOrRes;

  if (!runId) return { errorRes: errorResponse(400, "bad_request", "runId required") } as const;
  if (!adminDb) return { errorRes: errorResponse(503, "firestore_unavailable", "Database unavailable.") } as const;

  const ctx = await loadUserAndTeam(uid);
  if (!ctx?.team) return { errorRes: errorResponse(403, "forbidden", "Team access required") } as const;
  const team = ctx.team;
  const role = memberRole(uid, team);
  if (!isTeamAdmin(role)) return { errorRes: errorResponse(403, "insufficient_role", "Admin access required") } as const;

  const projectionResult = await getAdaptiveTeamRunProjection(team.id, runId);
  if (projectionResult.status === "firestore_unavailable" || projectionResult.status === "read_failed") {
    return { errorRes: errorResponse(503, "firestore_unavailable", "Could not verify review eligibility.") } as const;
  }
  if (projectionResult.status === "not_found") {
    return { errorRes: errorResponse(404, "projection_missing", "No adaptive review projection exists for this run.") } as const;
  }
  const projection = projectionResult.projection;
  const projectionValid =
    projection.adaptive === true &&
    typeof projection.teamId === "string" &&
    projection.teamId === team.id &&
    typeof projection.runId === "string" &&
    projection.runId === runId;
  if (!projectionValid) {
    logger.warn("[adaptive-runs/review-panel] Forged or malformed adaptive projection rejected", { runId, teamId: team.id });
    return { errorRes: errorResponse(404, "projection_invalid", "No valid adaptive review projection exists for this run.") } as const;
  }

  const runSnap = await adminDb.collection("runs").doc(runId).get();
  if (!runSnap.exists) {
    return { errorRes: errorResponse(404, "not_found", "Run not found.") } as const;
  }

  const govParse = parseGovernanceRecord(runSnap.data()?.governanceRecord);
  if (!govParse.ok) {
    if (govParse.reason === "absent") {
      return { errorRes: errorResponse(404, "governance_record_absent", "This run has no governance record.") } as const;
    }
    return { errorRes: errorResponse(500, "internal_error", "This run's governance record could not be read.") } as const;
  }

  return { uid, team, role, callerEmail: ctx.user?.email, governanceRecord: govParse.record } as const;
}

function mapPanelMutationFailure(reason: string) {
  switch (reason) {
    case "firestore_unavailable":
      return errorResponse(503, "firestore_unavailable", "Database unavailable.");
    case "run_missing":
      return errorResponse(404, "not_found", "Run not found.");
    case "governance_record_absent":
      return errorResponse(404, "governance_record_absent", "This run has no governance record.");
    case "governance_record_malformed":
    case "unsupported_version":
      return errorResponse(500, "internal_error", "This run's governance record could not be read.");
    case "not_pending":
      return errorResponse(409, "not_pending", "This review is no longer pending — the panel can only change while a review is pending.");
    case "panel_cancelled":
    case "panel_already_cancelled":
      return errorResponse(409, "panel_cancelled", "This review panel has been cancelled and cannot be reopened.");
    case "panel_finalized":
      return errorResponse(409, "panel_finalized", "This review panel has been finalized and can no longer be changed.");
    case "panel_absent":
      return errorResponse(404, "panel_absent", "No review panel exists for this run.");
    case "panel_malformed":
    case "panel_unsupported_version":
      return errorResponse(409, "adaptive_review_panel_invalid", "This run's review panel could not be read.");
    case "stale_revision":
      return errorResponse(409, "panel_stale", "This panel changed since you last viewed it. Please refresh and try again.");
    default:
      return errorResponse(500, "internal_error", "Could not update the review panel.");
  }
}

export async function GET(req: NextRequest, { params }: { params: { runId: string } }) {
  const ctx = await authorizeAndLoadContext(req, params.runId);
  if ("errorRes" in ctx) return ctx.errorRes;
  const { uid, team, role, callerEmail, governanceRecord } = ctx;

  // Hoisted above the panel-absent check (§F19) — both depend only on
  // `team`/`governanceRecord`, already resolved by `authorizeAndLoadContext`,
  // so `canCreatePanel` (no-panel case) and `canReconfigurePanel` (existing-
  // panel case, below) can share the exact same two authoritative checks
  // rather than the client re-deriving them from the global env flag or
  // team settings directly.
  const reviewable = isHumanReviewStatusReviewable((governanceRecord as GovernanceRecordV1).humanReview.status);
  const optInAndGloballyEnabled = MULTI_REVIEWER_GOVERNANCE_ENABLED && Boolean(team.adaptiveMultiReviewerSettings?.enabled);

  const panelResult = await getAdaptiveHumanReviewPanel(params.runId, team.id);
  if (panelResult.status === "firestore_unavailable" || panelResult.status === "read_failed") {
    return errorResponse(503, "firestore_unavailable", "Could not load the review panel.");
  }
  if (panelResult.status === "malformed" || panelResult.status === "unsupported_version") {
    return errorResponse(409, "adaptive_review_panel_invalid", "This run's review panel could not be read.");
  }
  if (panelResult.status === "absent") {
    // §F19 — mirrors PUT's own creation gate exactly (isTeamAdmin + reviewable
    // + global gate + team opt-in), so the client never has to re-derive
    // "can I create a panel" from the env flag or team settings itself.
    const canCreatePanel = isTeamAdmin(role) && reviewable && optInAndGloballyEnabled;
    return NextResponse.json({ ok: true, version: 1, panel: null, canCreatePanel });
  }

  const panel: AdaptiveHumanReviewPanelV1 = panelResult.panel;

  // ---- Live vote status per reviewer (§F10/§F14) — bounded, deterministic
  // reads, never a collection query (≤9, the same pattern GET .../votes
  // and the finalization transaction already use). voteStatus/submittedAt
  // are visible for EVERY reviewer here — a deliberate, spec-mandated
  // narrowing of the vote route's own "comment/conditions text is
  // self-only" rule to this one compact status field; this endpoint never
  // returns comment/conditions text for anyone, including the caller's
  // own vote.
  //
  // Step 5.16 fix, found via real seeded browser verification (never
  // caught by the fake-Firestore unit tests, none of which exercised a
  // GET immediately after a real finalize/cancel): finalization AND
  // cancellation both increment `panel.revision` by exactly 1
  // (`buildFinalizedAdaptiveHumanReviewPanel`/
  // `buildOwnerOverriddenAdaptiveHumanReviewPanel`/
  // `buildCancelledAdaptiveHumanReviewPanel`, all unchanged), but the
  // votes themselves remain stored at the revision that was ACTIVE at the
  // moment of that transition — never re-keyed to the new revision.
  // Reading votes at the panel's CURRENT `revision` for a finalized or
  // cancelled panel therefore always misses every vote, silently
  // rendering every reviewer as "no vote" even immediately after a
  // successful finalization. Only an `"open"` panel's votes live at its
  // own current revision.
  const voteRevision = panel.status === "open" ? panel.revision : panel.revision - 1;
  const voteByReviewer = new Map<string, AdaptiveHumanReviewVoteV1>();
  const votes: AdaptiveHumanReviewVoteV1[] = [];
  await Promise.all(
    panel.reviewerUserIds.map(async (reviewerId) => {
      const voteResult = await getAdaptiveHumanReviewVote(params.runId, voteRevision, reviewerId, team.id);
      if (voteResult.status === "found") {
        voteByReviewer.set(reviewerId, voteResult.vote);
        votes.push(voteResult.vote);
      } else if (voteResult.status === "malformed" || voteResult.status === "unsupported_version") {
        logger.warn("[adaptive-runs/review-panel] Skipping unreadable stored vote", { runId: params.runId, teamId: team.id });
      }
    })
  );

  const reviewers = await Promise.all(
    panel.reviewerUserIds.map(async (reviewerId) => {
      const member = (team as TeamDocument).members.find((m) => m.uid === reviewerId);
      const displayName = await resolveDisplayName(reviewerId, member?.email ?? "", callerEmail);
      const vote = voteByReviewer.get(reviewerId);
      return {
        userId: reviewerId,
        displayName,
        isCurrentUser: reviewerId === uid,
        hasSubmittedVote: vote !== undefined,
        ...(vote ? { voteStatus: vote.status, submittedAt: vote.submittedAt } : {}),
      };
    })
  );

  // ---- Aggregation state (§F10) — recomputed fresh from the pure engine
  // every time, never stored/cached. The engine itself requires
  // `panel.status === "open"` as a precondition; for "cancelled" (a
  // dead-end configuration state with no analogous member in the
  // aggregationState union) "waiting" is used as an inert, safe default —
  // no capability flag below is affected, since every one of them also
  // independently requires `panel.status === "open"`.
  let aggregationState: "waiting" | "deadlocked" | "ready" | "finalized" = "waiting";
  let readyFinalStatus: AdaptiveHumanReviewVoteV1["status"] | undefined;
  let submittedCount = votes.length;
  if (panel.status === "finalized") {
    aggregationState = "finalized";
  } else if (panel.status === "open") {
    const aggregate = aggregateAdaptiveReviewVotes({ panel, votes });
    if (aggregate.status === "waiting" || aggregate.status === "deadlocked" || aggregate.status === "ready") {
      aggregationState = aggregate.status;
      submittedCount = aggregate.submittedCount;
      if (aggregate.status === "ready") {
        readyFinalStatus = aggregate.finalStatus;
      }
    } else {
      // "invalid" should not be reachable — this route's own panel/vote
      // reads already mirror the finalization transaction's own
      // validation. Fails safe to the "waiting" default for a read-only
      // endpoint rather than surfacing an internal error.
      logger.warn("[adaptive-runs/review-panel] aggregateAdaptiveReviewVotes unexpectedly returned invalid on GET", { runId: params.runId, reason: aggregate.reason });
    }
  }

  const currentUserVoted = voteByReviewer.has(uid);
  const currentUserIsReviewer = panel.reviewerUserIds.includes(uid);

  // ---- Capability flags (§F10, split per Step 5.10's release-boundary
  // audit) — mirror each mutating route's own authorization exactly, so
  // client UI never re-derives eligibility logic independently and risks
  // drifting from the real enforcement.
  //
  // `canReconfigurePanel` mirrors PUT exactly — genuinely NEW panel
  // activity, gated on BOTH the team opt-in AND the global
  // `MULTI_REVIEWER_GOVERNANCE_ENABLED` kill switch. `canCancelPanel`
  // mirrors DELETE exactly — a DRAIN operation, gated on NEITHER, so an
  // authorized admin/owner can always cancel an open panel even after the
  // feature has been disabled (team-level or globally). These were
  // previously a single `canManagePanel` flag; splitting them is what
  // actually fixes the release-boundary bug the audit found (disabling
  // opt-in used to block cancellation too, stranding the panel).
  // `optInAndGloballyEnabled` is hoisted above (§F19) — shared with
  // `canCreatePanel` in the panel-absent branch.
  const canReconfigurePanel = isTeamAdmin(role) && panel.status === "open" && reviewable && optInAndGloballyEnabled;
  const canCancelPanel = isTeamAdmin(role) && panel.status === "open" && reviewable;
  const canVote = isTeamAdmin(role) && currentUserIsReviewer && panel.status === "open" && reviewable && !currentUserVoted;
  const canFinalize = isTeamAdmin(role) && aggregationState === "ready";
  // Owner-only (§F3) — deliberately NOT `isTeamAdmin`; mirrors the
  // override route's own exact-role check. Independent of aggregationState
  // (an owner may override a waiting, deadlocked, OR ready panel — the
  // override transaction's own precondition is just `status === "open"`)
  // AND independent of the opt-in/global guard, for the same drain-operation
  // reason as `canCancelPanel`/`canFinalize` above.
  const canOverride = role === "owner" && panel.status === "open" && reviewable;

  return NextResponse.json({
    ok: true,
    version: 1,
    panel: {
      mode: panel.mode,
      status: panel.status,
      revision: panel.revision,
      reviewers,
      requiredReviewerCount: panel.requiredReviewerCount,
      quorum: panel.quorum,
      submittedCount,
      aggregationState,
      ...(readyFinalStatus ? { readyFinalStatus } : {}),
      // Transactional Multi-Reviewer Finalization, Part E (§E17) /
      // Multi-Reviewer Owner Override, Part F (§F6/§F10) — present only
      // when finalized. Deliberately never includes finalDecisionId,
      // finalizedByUserId, overrideByUserId, overrideJustification,
      // supporting reviewer IDs, vote text, or audit IDs.
      ...(panel.status === "finalized"
        ? {
            finalStatus: panel.finalStatus,
            finalizedAt: panel.finalizedAt,
            finalizedVia: panel.finalizedVia ?? "aggregation",
            aggregationPolicyVersion: panel.aggregationPolicyVersion,
          }
        : {}),
      canReconfigurePanel,
      canCancelPanel,
      canVote,
      canFinalize,
      canOverride,
      // Preserved for backward compatibility with any existing reader of
      // this route's PRE-Part-F shape — extended safely, never replaced.
      reviewerUserIds: panel.reviewerUserIds,
      createdAt: panel.createdAt,
      updatedAt: panel.updatedAt,
    },
  });
}

export async function PUT(req: NextRequest, { params }: { params: { runId: string } }) {
  const ctx = await authorizeAndLoadContext(req, params.runId);
  if ("errorRes" in ctx) return ctx.errorRes;
  const { uid, team, governanceRecord } = ctx;

  // Step 5.10/5.11 — PUT covers BOTH creation and reconfiguration, both
  // genuinely NEW panel activity under the release policy, so BOTH gates
  // apply here (and ONLY here — never to DELETE/votes/finalize/override,
  // which must remain available to drain an already-open panel).
  if (!MULTI_REVIEWER_GOVERNANCE_ENABLED) {
    return errorResponse(403, "multi_reviewer_disabled", "Multi-reviewer panel review is not enabled for this team.");
  }
  if (!team.adaptiveMultiReviewerSettings?.enabled) {
    return errorResponse(403, "multi_reviewer_disabled", "Multi-reviewer panel review is not enabled for this team.");
  }

  if (!isHumanReviewStatusReviewable((governanceRecord as GovernanceRecordV1).humanReview.status)) {
    return errorResponse(409, "not_pending", "This review is no longer pending — the panel can only change while a review is pending.");
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON.");
  }
  const body = (rawBody ?? {}) as { reviewerUserIds?: unknown; expectedRevision?: unknown };

  if (!Array.isArray(body.reviewerUserIds) || !body.reviewerUserIds.every((v) => typeof v === "string" && v.trim().length > 0)) {
    return errorResponse(400, "validation_error", "reviewerUserIds must be a non-empty array of user IDs.");
  }
  const rawReviewerUserIds = body.reviewerUserIds as string[];
  const normalized = normalizeAdaptivePanelReviewerUserIds(rawReviewerUserIds);
  if (normalized.length !== rawReviewerUserIds.length) {
    return errorResponse(400, "validation_error", "reviewerUserIds must not contain duplicates.");
  }
  if (normalized.length < MIN_ADAPTIVE_PANEL_REVIEWERS || normalized.length > MAX_ADAPTIVE_PANEL_REVIEWERS) {
    return errorResponse(
      400,
      "validation_error",
      `reviewerUserIds must contain between ${MIN_ADAPTIVE_PANEL_REVIEWERS} and ${MAX_ADAPTIVE_PANEL_REVIEWERS} reviewers.`
    );
  }

  // Reviewer eligibility (mirrors the single-reviewer assignment route's
  // own route-layer check exactly — never inside the transaction; see
  // submitAdaptiveHumanReviewPanel's own doc comment for why).
  for (const reviewerId of normalized) {
    const member = (team as TeamDocument).members.find((m) => m.uid === reviewerId);
    if (!member) {
      return errorResponse(400, "validation_error", "One or more proposed reviewers are not members of this team.");
    }
    if (!ELIGIBLE_REVIEWER_ROLES.has(member.role)) {
      return errorResponse(400, "validation_error", "One or more proposed reviewers do not have the permission required to review.");
    }
  }

  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    return errorResponse(400, "validation_error", "expectedRevision must be a non-negative integer.");
  }

  const result = await submitAdaptiveHumanReviewPanel({
    runId: params.runId,
    teamId: team.id,
    reviewerUserIds: normalized,
    actorUserId: uid,
    expectedRevision: body.expectedRevision,
  });

  if (!result.ok) {
    return mapPanelMutationFailure(result.reason);
  }

  const panel = result.panel;
  return NextResponse.json({
    ok: true,
    version: 1,
    panel: {
      mode: panel.mode,
      reviewerUserIds: panel.reviewerUserIds,
      requiredReviewerCount: panel.requiredReviewerCount,
      quorum: panel.quorum,
      status: panel.status,
      revision: panel.revision,
      createdAt: panel.createdAt,
      updatedAt: panel.updatedAt,
    },
  });
}

export async function DELETE(req: NextRequest, { params }: { params: { runId: string } }) {
  const ctx = await authorizeAndLoadContext(req, params.runId);
  if ("errorRes" in ctx) return ctx.errorRes;
  const { uid, team, governanceRecord } = ctx;

  // Step 5.10 — deliberately NO opt-in/global-guard check here. Cancelling
  // an already-open panel is a DRAIN operation, not new activity — it must
  // remain available to an authorized admin/owner even after the team (or
  // the whole feature, globally) has been disabled, so a panel can never
  // become permanently stranded by a rollback.
  if (!isHumanReviewStatusReviewable((governanceRecord as GovernanceRecordV1).humanReview.status)) {
    return errorResponse(409, "not_pending", "This review is no longer pending — the panel can only change while a review is pending.");
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "expectedRevision is required.");
  }
  const body = (rawBody ?? {}) as { expectedRevision?: unknown };
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    return errorResponse(400, "validation_error", "expectedRevision must be a non-negative integer.");
  }

  const result = await cancelAdaptiveHumanReviewPanel({
    runId: params.runId,
    teamId: team.id,
    actorUserId: uid,
    expectedRevision: body.expectedRevision,
  });

  if (!result.ok) {
    return mapPanelMutationFailure(result.reason);
  }

  const panel = result.panel;
  return NextResponse.json({
    ok: true,
    version: 1,
    panel: {
      status: panel.status,
      revision: panel.revision,
      updatedAt: panel.updatedAt,
    },
  });
}
