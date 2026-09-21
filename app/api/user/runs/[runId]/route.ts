/**
 * HTTP API route (user/runs/[runId]): returns a single panel run for the signed-in owner,
 * including rehydrated model rows and optional cached structured synthesis fields.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { getAdaptiveHumanReviewAssignment } from "@/lib/firestore/runs";
import { resolveAdaptiveRunAccess } from "@/lib/governance/adaptiveRunAccess";
import { expectedPersonalDecisionId, classifyDecisionScopeFromPersonalDoc } from "@/lib/governance/personalReviewScope";
import { validateRunWorkspaceAssociation } from "@/lib/workspaces/runWorkspaceIntegrity";
import { classifyRunWorkspaceBindingShape } from "@/lib/workspaces/classifyRunWorkspaceBindingShape";
import { resolveTeamRunWorkspaceAccess, type ResolveTeamRunWorkspaceAccessResult } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { classifyProjectIdFieldState } from "@/lib/projects/runProjectNormalizationEligibility";
import { deriveTeamRunViewerRole } from "@/lib/workspaces/deriveTeamRunViewerRole";
import { buildRunReadPayload, type RunReadViewerRole } from "@/lib/runs/runReadPayload";
import { resolveRunReviewRouting } from "@/lib/runs/resolveRunReviewRouting";
import { logger } from "@/lib/logger";

type TeamAccessDenied = Extract<ResolveTeamRunWorkspaceAccessResult, { granted: false }>;

/**
 * PERSONAL-RESEARCH-URL-P0 — the one sanitized response for "a read this report
 * REQUIRES could not be completed", as distinct from "the run is confirmed absent".
 *
 * The distinction is load-bearing because this endpoint is about to back a
 * durable, bookmarkable report URL. Telling someone "Run not found" because
 * Firestore was briefly unreachable invites them to conclude their research was
 * deleted; a retryable error tells the truth. Confirmed absence stays a concealed
 * 404 exactly as before.
 *
 * Deliberately LOCAL rather than importing `teamWorkspaceErrorResponse`'s
 * `internalErrorResponse()`: that module is the Team-Workspace API's error
 * vocabulary, and this route should not acquire a dependency on it merely to reuse
 * one generic string. The shape and wording match the repository's established
 * `internal_error` response, so clients see nothing new.
 *
 * Carries no Firestore error, error code, stack, Workspace id, owner uid or
 * membership detail — a transient failure must not become a disclosure channel.
 */
function internalRunReadErrorResponse() {
  return NextResponse.json(
    { ok: false, errorCode: "internal_error", message: "Something went wrong. Please try again." },
    { status: 500 }
  );
}

/**
 * Team Shared Run Detail, Phase 8C-B3.1 — public status mapping for a
 * `non_personal_bound` run's Team authorization outcome. Deliberately a
 * LOCAL, route-specific mapping, not a reuse of B2's
 * `teamRunAccessResponse` (`lib/workspaces/teamRunAccessResponse.ts`):
 * this route's own established precedent already distinguishes
 * "run/association integrity broken" (concealed 404, matching every
 * existing `validateRunWorkspaceAssociation` "invalid" outcome) from
 * "run is fine, this specific requester just isn't authorized for it"
 * (403 `forbidden`, matching the existing `personal_reviewer` denial
 * branch) — a materially different concealment posture than B2's list
 * routes, which protect Workspace-existence enumeration via a
 * client-supplied `{workspaceId}` URL param rather than an
 * already-effectively-unguessable `runId`. `membership_malformed` is
 * grouped with the integrity-failure bucket (404), not the
 * valid-requester-lacks-access bucket (403): a malformed membership
 * document is the AUTHORIZATION RECORD itself failing integrity
 * validation, not an otherwise-valid requester simply lacking a grant.
 */
function mapTeamAccessDenialToResponse(reason: TeamAccessDenied["reason"]): NextResponse {
  switch (reason) {
    case "team_workspaces_disabled":
    case "workspace_not_found":
    case "workspace_malformed":
    case "wrong_workspace_type":
    case "owner_integrity_violation":
    case "lookup_failed":
    case "membership_malformed":
      return NextResponse.json({ ok: false, errorCode: "not_found", message: "Run not found." }, { status: 404 });
    case "membership_not_found":
    case "membership_removed":
      return NextResponse.json({ ok: false, errorCode: "forbidden", message: "You do not have access to this run." }, { status: 403 });
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Auth Identity Consistency Remediation, Step 7 — resolves via the
// shared, hardened resolver rather than this route's own duplicated
// cookie-first logic. Response shape for auth failures is unchanged.
async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/user/runs/[runId]", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json(
      { ok: false, errorCode: "unauthorized", message: "Please sign in." },
      { status: 401 }
    );
  }
  return NextResponse.json(
    { ok: false, errorCode: "auth_error", message: "Authentication failed." },
    { status: 401 }
  );
}

export async function GET(req: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const { runId } = await context.params;
  // A blank/invalid run id is a confirmed non-existent address: concealed 404, unchanged.
  if (!runId?.trim()) {
    return NextResponse.json(
      { ok: false, errorCode: "not_found", message: "Run not found." },
      { status: 404 }
    );
  }
  // Firebase Admin unavailable is an AVAILABILITY failure, not evidence about this
  // run; it was previously folded into the 404 above. Authentication has already
  // happened, so an unauthenticated caller still cannot learn this.
  if (!adminDb) {
    logger.error("[user/runs/[runId]] run_read_unavailable", { runId, errorCategory: "firebase_admin_unavailable" });
    return internalRunReadErrorResponse();
  }

  // Only the REQUIRED run-document read is wrapped. A thrown lookup is not
  // absence, and the caught error is never forwarded to the client.
  let snap;
  try {
    snap = await adminDb.collection("runs").doc(runId).get();
  } catch {
    logger.error("[user/runs/[runId]] run_read_unavailable", { runId, errorCategory: "run_document_lookup_failed" });
    return internalRunReadErrorResponse();
  }
  if (!snap.exists) {
    return NextResponse.json(
      { ok: false, errorCode: "not_found", message: "Run not found." },
      { status: 404 }
    );
  }

  const data = snap.data() as Record<string, unknown>;
  const owner = String(data.userId ?? "");

  // Team Shared Run Detail, Phase 8C-B3.1 — pure, zero-I/O structural
  // classification of the run's OWN raw workspaceId/userId fields, BEFORE
  // any authorization decision. Takes `data` directly (never a
  // reconstructed `{userId, workspaceId}` literal) so field-PRESENCE is
  // preserved exactly as persisted — see
  // `classifyRunWorkspaceBindingShape`'s own doc comment. This is NOT
  // authorization: it only decides which of the two entirely separate
  // authorization branches below applies. `legacy`/`personal` fall
  // through to the ORIGINAL, byte-unchanged Personal/legacy path;
  // `non_personal_bound` is diverted to the new Team branch BEFORE it can
  // ever reach the `owner === uid` shortcut — this ordering is what
  // closes the prospective "Team-bound run's own creator bypasses Team
  // membership" risk identified in the Phase 8C-B3.0 audit.
  const classified = classifyRunWorkspaceBindingShape({
    hasWorkspaceIdField: Object.prototype.hasOwnProperty.call(data, "workspaceId"),
    workspaceIdValue: data.workspaceId,
    userId: data.userId,
  });

  if (classified.kind === "invalid") {
    logger.warn("[user/runs/[runId]] workspace_run_binding_invalid", { runId, reason: classified.reason });
    return NextResponse.json(
      { ok: false, errorCode: "not_found", message: "Run not found." },
      { status: 404 }
    );
  }

  let viewerRole: RunReadViewerRole;

  if (classified.kind === "non_personal_bound") {
    // Team candidate path — entirely separate from the Personal/legacy
    // branch below. Never reaches the `owner === uid` shortcut: run
    // creator identity is attribution only for a Team-bound run, never an
    // authorization grant. Reuses `resolveTeamRunWorkspaceAccess()`
    // unchanged (Phase 8C-B2) — rollout-before-I/O, one
    // `resolveWorkspaceAccess()` path, `workspaceType==="team"` enforced,
    // Personal-Workspace-collision closed — no duplicate Team
    // authorization logic exists here.
    const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId: classified.workspaceId });
    if (!access.granted) {
      logger.warn("[user/runs/[runId]] team_run_access_denied", { runId, reason: access.reason });
      return mapTeamAccessDenialToResponse(access.reason);
    }
    if (!access.capabilities.includes("research.read")) {
      logger.warn("[user/runs/[runId]] team_run_access_denied", { runId, reason: "insufficient_capability" });
      return NextResponse.json(
        { ok: false, errorCode: "forbidden", message: "You do not have access to this run." },
        { status: 403 }
      );
    }

    // Team run integrity, Phase 8C-B2 parity — a Team-bound run's
    // `projectId` must be explicitly `null` (canonical Unfiled) or a
    // structurally assigned string (filed); absent or malformed is an
    // integrity failure, fails closed, never reinterpreted as Unfiled.
    // Field presence/shape only — no Project document is read here; B3
    // does not expose or depend on Project metadata (that remains a B2
    // list-level or future detail-schema concern).
    const projectIdState = classifyProjectIdFieldState({
      hasProjectIdField: Object.prototype.hasOwnProperty.call(data, "projectId"),
      projectIdValue: data.projectId,
    });
    if (projectIdState === "absent" || projectIdState === "malformed") {
      logger.warn("[user/runs/[runId]] team_run_projectId_integrity_failed", { runId, projectIdState });
      return NextResponse.json(
        { ok: false, errorCode: "not_found", message: "Run not found." },
        { status: 404 }
      );
    }

    // Team reviewer eligibility — a SEPARATE, additional gate on top of
    // the base `research.read` grant above, never a substitute for it and
    // never itself sufficient alone. Team Research Parity, Phase R1 — the
    // predicate itself now lives in `deriveTeamRunViewerRole()` (shared
    // with the Team research detail API) and is unchanged: ALL of
    // `research.read` (already established above), the Workspace
    // `reviews.submit` capability, a canonical per-run assignment naming
    // this uid, and a currently-reviewable human-review status must hold
    // for `team_reviewer`; any one missing yields `team_member`.
    const assignmentResult = await getAdaptiveHumanReviewAssignment(runId);
    viewerRole = deriveTeamRunViewerRole({
      uid,
      capabilities: access.capabilities,
      assignmentResult,
      governanceRecord: data.governanceRecord,
    });
  } else {
    // classified.kind === "legacy" | "personal" — the ORIGINAL,
    // byte-unchanged Personal/legacy path. `validateRunWorkspaceAssociation()`
    // is still called exactly as before (never bypassed merely because the
    // new classifier already produced a category) — Phase 4B — Mandatory
    // Workspace Integrity. Requester-independent: runs BEFORE the
    // owner/reviewer branch below, so an invalid association denies the
    // run's own owner exactly as it denies anyone else. A truly legacy run
    // (workspaceId property absent) short-circuits with zero Firestore
    // lookup and falls through to the unchanged existing logic.
    const integrity = await validateRunWorkspaceAssociation(data);
    if (integrity.classification === "invalid") {
      logger.warn("[user/runs/[runId]] workspace_run_integrity_failed", { runId, reason: integrity.reason });
      // PERSONAL-RESEARCH-URL-P0 — `workspace_lookup_failed` is the integrity
      // checker reporting that it COULD NOT COMPLETE the Personal Workspace
      // lookup, not that the association is bad. Collapsing it into the concealed
      // 404 told a bookmarked report it no longer existed.
      //
      // Every other reason here is a confirmed integrity failure
      // (malformed_workspace_id, run_owner_invalid, deterministic_id_mismatch,
      // workspace_not_found, workspace_malformed, workspace_wrong_type,
      // workspace_owner_mismatch) or a deliberate policy state
      // (workspaces_disabled), and each keeps its existing concealed-404 posture.
      // Ordering is untouched: this still runs BEFORE any owner/reviewer grant, so
      // an invalid association denies the owner exactly as it denies anyone else.
      if (integrity.reason === "workspace_lookup_failed") {
        return internalRunReadErrorResponse();
      }
      return NextResponse.json(
        { ok: false, errorCode: "not_found", message: "Run not found." },
        { status: 404 }
      );
    }

    // Personal Reviewer Inbox + Action Flow — a non-owner is granted access
    // ONLY when the canonical per-run assignment currently names them
    // (resolveAdaptiveRunAccess never consults users/{owner}.governanceReviewerUid
    // directly — see that module's own doc comment for why). The response
    // shape below is identical for both roles (no owner-only fields exist in
    // it — results/synthesis/adaptive output/governance status are exactly
    // the content a reviewer needs to review); `viewerRole` lets the client
    // know which one it got so it can hide owner-only controls (export,
    // rerun) and show the review decision UI instead.
    viewerRole = "owner";
    if (owner !== uid) {
      const [assignmentResult, preAccessGovernance] = await Promise.all([
        getAdaptiveHumanReviewAssignment(runId),
        Promise.resolve(parseGovernanceRecord(data.governanceRecord)),
      ]);
      const access = resolveAdaptiveRunAccess({
        uid,
        runOwnerUid: owner,
        assignment: assignmentResult.status === "found" ? assignmentResult.assignment : null,
        humanReviewStatus: preAccessGovernance.ok ? preAccessGovernance.record.humanReview.status : null,
      });
      if (access.role !== "personal_reviewer") {
        return NextResponse.json(
          { ok: false, errorCode: "forbidden", message: "You do not have access to this run." },
          { status: 403 }
        );
      }
      viewerRole = "personal_reviewer";
    }
  }

  // Team Research Parity, Phase R1 — the response body is built by the ONE
  // shared, presentation-only builder (`buildRunReadPayload`), extracted
  // verbatim from this route so the Team research detail API emits the
  // identical research payload for the same run document. Authorization
  // and `viewerRole` were decided above; the builder never authorizes,
  // writes, regenerates synthesis or executes models. `reviewRouting` I/O
  // (`resolveRunReviewRouting`, likewise extracted verbatim) is injected
  // and still runs only for a still-unreviewed/pending human review.
  // PHASE 1 — Personal/Team review isolation, decision CONTENT.
  // `humanReview.conditions` can carry Team panelists' `approved_with_conditions`
  // vote text verbatim (`buildFinalConditionsUnion`), so a personal reviewer
  // gets it only for a decision proven inside their own capability. Every
  // other role here already holds owner or Team/Workspace authority over the
  // run. One point read, only for the role that needs the proof.
  let mayReadDecisionContent = true;
  if (viewerRole === "personal_reviewer") {
    const parsed = parseGovernanceRecord(data.governanceRecord);
    if (!parsed.ok) {
      mayReadDecisionContent = false;
    } else if (parsed.record.humanReview.reviewerId && parsed.record.humanReview.reviewerId === uid) {
      // Their own decision — their own conditions.
      mayReadDecisionContent = true;
    } else {
      let personalDoc: { exists: boolean; data: unknown } | null = null;
      const expectedId = expectedPersonalDecisionId({
        runId,
        reviewedAt: parsed.record.humanReview.reviewedAt,
        status: parsed.record.humanReview.status,
      });
      if (expectedId) {
        try {
          const snap = await adminDb.collection("runs").doc(runId).collection("humanReviewHistory").doc(expectedId).get();
          personalDoc = { exists: snap.exists === true, data: snap.exists ? snap.data() : null };
        } catch {
          logger.warn("[user/runs/[runId]] decision_provenance_read_failed", { runId });
          personalDoc = null;
        }
      }
      mayReadDecisionContent =
        classifyDecisionScopeFromPersonalDoc({
          decidedVia: parsed.record.humanReview.decidedVia,
          reviewerId: parsed.record.humanReview.reviewerId,
          reviewedAt: parsed.record.humanReview.reviewedAt,
          status: parsed.record.humanReview.status,
          personalDoc,
        }) === "personal";
    }
  }

  const requestId = req.headers.get("x-vercel-id") ?? req.headers.get("x-request-id") ?? undefined;
  const payload = await buildRunReadPayload({
    runId,
    mayReadDecisionContent,
    data,
    viewerRole,
    requestId,
    resolveReviewRouting: resolveRunReviewRouting,
  });

  return NextResponse.json(payload);
}
