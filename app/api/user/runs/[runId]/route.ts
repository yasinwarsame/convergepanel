/**
 * HTTP API route (user/runs/[runId]): returns a single panel run for the signed-in owner,
 * including rehydrated model rows and optional cached structured synthesis fields.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import type { RunDocument } from "@/lib/panel/schemas";
import type { ModelId } from "@/lib/types";
import { runDocumentToPublicResults } from "@/lib/user/runDocumentToPublicResults";
import { publicizePanelResults } from "@/lib/panel/publicize";
import { parsePersistedAdaptiveOutput, parsePersistedLegacyAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { loadUserAndTeam } from "@/lib/teams/teamApiAuth";
import { getAdaptiveTeamRunProjection } from "@/lib/firestore/teamRuns";
import { getAdaptiveHumanReviewAssignment } from "@/lib/firestore/runs";
import { resolveAdaptiveRunAccess } from "@/lib/governance/adaptiveRunAccess";
import { validateRunWorkspaceAssociation } from "@/lib/workspaces/runWorkspaceIntegrity";
import { logger } from "@/lib/logger";

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
  if (!runId?.trim() || !adminDb) {
    return NextResponse.json(
      { ok: false, errorCode: "not_found", message: "Run not found." },
      { status: 404 }
    );
  }

  const snap = await adminDb.collection("runs").doc(runId).get();
  if (!snap.exists) {
    return NextResponse.json(
      { ok: false, errorCode: "not_found", message: "Run not found." },
      { status: 404 }
    );
  }

  const data = snap.data() as Record<string, unknown>;
  const owner = String(data.userId ?? "");

  // Phase 4B — Mandatory Workspace Integrity. Requester-independent: runs
  // BEFORE the owner/reviewer branch below, so an invalid association
  // denies the run's own owner exactly as it denies anyone else. A truly
  // legacy run (workspaceId property absent) short-circuits with zero
  // Firestore lookup and falls through to the unchanged existing logic.
  const integrity = await validateRunWorkspaceAssociation(owner, data);
  if (integrity.classification === "invalid") {
    logger.warn("[user/runs/[runId]] workspace_run_integrity_failed", { runId, reason: integrity.reason });
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
  let viewerRole: "owner" | "personal_reviewer" = "owner";
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

  const runDocument = data.runDocument as RunDocument | undefined;
  let results = runDocumentToPublicResults(runDocument);
  if (results.length === 0 && Array.isArray(data.results)) {
    results = publicizePanelResults(data.results as unknown[]) as unknown as typeof results;
  }

  const question = String(data.question ?? "");
  const selectedModels = (Array.isArray(data.selectedModels) ? data.selectedModels : []) as ModelId[];
  const status = typeof data.status === "string" ? data.status : undefined;

  const synthesisCache =
    data.synthesizedStructuredReport && data.schemaVersion === 1
      ? {
          report: data.synthesizedStructuredReport,
          schemaVersion: 1 as const,
          synthesizedBy: (data.synthesizedBy as string) || "cached",
          consensusSummary: data.synthesisConsensusSummary ?? null,
        }
      : null;

  const rawGovStatus = data.governanceStatus;
  const orgGovernanceStatus =
    rawGovStatus === "approved" || rawGovStatus === "needs_review" || rawGovStatus === "blocked"
      ? rawGovStatus
      : null;

  const g = data.teamGovernance as
    | {
        policyFlags?: string[];
        blocked?: boolean;
        blockMessage?: string;
        governanceReviewRequired?: boolean;
      }
    | undefined;

  const governance =
    g &&
    (g.policyFlags?.length ||
      g.blocked ||
      g.governanceReviewRequired ||
      (g.blockMessage && String(g.blockMessage).length > 0))
      ? {
          governanceReviewRequired: !!g.governanceReviewRequired,
          blockedByPolicy: !!g.blocked,
          policyBlockMessage: g.blockMessage ? String(g.blockMessage) : undefined,
          policyFlags: Array.isArray(g.policyFlags) ? g.policyFlags : undefined,
        }
      : null;

  // Query-Routing Redesign, Phase 1 — validate the persisted adaptive
  // envelope (if any) through the real runtime parser, never an unchecked
  // cast of Firestore data. Never reruns models or reclassifies to recover
  // from absent/malformed/unsupported-version data — those three states
  // are all legitimate, non-error outcomes the client renders distinctly.
  const parsedAdaptive = parsePersistedAdaptiveOutput(data.adaptiveOutput);

  // Adaptive Synthesis Report, Phase 1 (docs/adaptive-synthesis-report-design.md
  // §4.1) — the top summary bar's "Status" field needs the real human-review
  // state on reload, not just whether a record exists. Only ever meaningful
  // when a real adaptiveOutput was persisted (governance is never initialized
  // otherwise — see governanceInitialization.ts). Compact fields only, same
  // discipline as humanReviewHistory: never reviewer name or comment text.
  const parsedGovernance = parsedAdaptive.ok ? parseGovernanceRecord(data.governanceRecord) : { ok: false as const };
  const humanReview = parsedGovernance.ok
    ? {
        status: parsedGovernance.record.humanReview.status,
        conditions: parsedGovernance.record.humanReview.conditions,
        decidedVia: parsedGovernance.record.humanReview.decidedVia,
      }
    : null;

  // `reviewRouting` distinguishes "still awaiting a reviewer" from "no
  // review was ever configured for this run" (see reportStatus.ts) — only
  // resolved when it actually changes the displayed status (still
  // unreviewed/pending); a decided run's status is unambiguous without it,
  // so this skips the extra reads for the common case of an already-decided
  // reload. Checks the SAME persisted teamRuns projection the live run
  // response's "in_queue" was derived from (getAdaptiveTeamRunProjection),
  // rather than a discarded/"unknown" placeholder — a team run's queue
  // membership is real, durable Firestore state, not something only known
  // at the moment the run completed.
  //
  // "not_configured" is returned ONLY when the absence of review routing is
  // positively confirmed (no team, or a confirmed-missing projection).
  // Every other outcome — a Firestore read failure
  // (getAdaptiveTeamRunProjection never throws; "firestore_unavailable"/
  // "read_failed" come back as ordinary return values, not exceptions, so
  // they must be checked explicitly here, not just caught), a malformed or
  // forged projection document (same defensive field-checking
  // getAdaptiveTeamRunProjection's own doc comment requires of every
  // caller, mirroring app/api/teams/adaptive-runs/[runId]/route.ts's
  // authorization check), or an unexpected thrown error — resolves to
  // "unknown", never "not_configured". reportStatus.ts already renders
  // "unknown" identically to "in_queue" ("Unreviewed — in queue"), so this
  // fails closed toward "still needs attention" rather than the false
  // "no review configured" claim a positive-sounding default would make.
  // This block is read-only: it never creates or mutates a teamRuns
  // projection, and never touches governanceRecord.
  let reviewRouting: "in_queue" | "not_configured" | "unknown" = "unknown";
  if (humanReview && (humanReview.status === "unreviewed" || humanReview.status === "pending")) {
    const requestId = req.headers.get("x-vercel-id") ?? req.headers.get("x-request-id") ?? undefined;
    try {
      // Always the RUN OWNER's team/assignment context, never the
      // viewer's — reviewRouting describes the run's own review-routing
      // state, which is identical no matter who is looking at it. Using
      // `uid` here would be wrong whenever the viewer is an assigned
      // personal reviewer (a different account from the owner): it would
      // resolve the REVIEWER's own team membership instead, which has
      // nothing to do with this run.
      const teamCtx = await loadUserAndTeam(owner);
      if (!teamCtx?.team) {
        // Reviewer Assignment Propagation — a personal (non-team) run can
        // still have a real, canonical humanReviewAssignment (see
        // lib/governance/personalReviewerAssignment.ts). Checked here too,
        // not just at run-completion time, so a reload never regresses to
        // the false "no review configured" claim for a run that already
        // has one. A genuine read failure degrades to "unknown" (fails
        // closed), never "not_configured" — same discipline as the team
        // branch below.
        const assignmentResult = await getAdaptiveHumanReviewAssignment(runId);
        if (assignmentResult.status === "found" && assignmentResult.assignment.assignedReviewerUserId) {
          reviewRouting = "in_queue";
        } else if (assignmentResult.status === "unassigned") {
          reviewRouting = "not_configured";
        } else {
          logger.warn("[user/runs] Personal reviewer-assignment lookup failed during history reload", {
            runId,
            errorCategory: assignmentResult.status,
          });
          reviewRouting = "unknown";
        }
      } else {
        const projectionResult = await getAdaptiveTeamRunProjection(teamCtx.team.id, runId);
        if (projectionResult.status === "not_found") {
          reviewRouting = "not_configured";
        } else if (projectionResult.status === "found") {
          const projection = projectionResult.projection;
          const projectionValid =
            projection.projectionVersion === 1 &&
            projection.adaptive === true &&
            typeof projection.teamId === "string" &&
            projection.teamId === teamCtx.team.id &&
            typeof projection.runId === "string" &&
            projection.runId === runId;
          if (projectionValid) {
            reviewRouting = "in_queue";
          } else {
            logger.warn("[user/runs] Malformed or forged adaptive team-run projection during history reload", {
              runId,
              teamId: teamCtx.team.id,
              errorCategory: "malformed_projection",
              requestId,
            });
            reviewRouting = "unknown";
          }
        } else {
          // "firestore_unavailable" / "read_failed" — a genuine, unresolved
          // lookup failure, not a confirmed absence of review config.
          logger.warn("[user/runs] Adaptive team-run projection lookup failed during history reload", {
            runId,
            teamId: teamCtx.team.id,
            errorCategory: projectionResult.status,
            requestId,
          });
          reviewRouting = "unknown";
        }
      }
    } catch (err: unknown) {
      logger.warn("[user/runs] reviewRouting resolution threw during history reload", {
        runId,
        errorCategory: "unresolved_lookup_error",
        errorMessage: err instanceof Error ? err.message : "unknown_error",
        requestId,
      });
      reviewRouting = "unknown";
    }
  }

  const adaptive = parsedAdaptive.ok
    ? { status: "valid" as const, output: parsedAdaptive.output, humanReview, reviewRouting }
    : { status: parsedAdaptive.reason, output: null, humanReview: null, reviewRouting: "unknown" as const };

  // Phase 2 pilot history-reload fix, widened in Batch 3 persistence
  // foundation (2C-1) — validate the SEPARATE `legacyAdaptiveOutput` field
  // (the 8-member legacy-active schema family; see persistedOutput.ts's
  // PersistedLegacyAdaptiveOutputV1 doc) through its own real runtime
  // parser, same discipline as `adaptive` above. Never conflated with
  // `adaptive.status` — a run can be `adaptive.status === "absent"` (no
  // Milestone-2 envelope, correctly, since this family never has one) while
  // `legacyAdaptive.status === "valid"` at the same time; the client uses
  // `legacyAdaptive` as the true signal that this WAS a schema-routed run,
  // never `adaptive.status` alone (see app/page.tsx's openHistoryItem). No
  // change needed here or in the adapter/client — both already read
  // `schemaId` generically off the parsed output.
  const parsedLegacyAdaptive = parsePersistedLegacyAdaptiveOutput(data.legacyAdaptiveOutput);
  const legacyAdaptive = parsedLegacyAdaptive.ok
    ? { status: "valid" as const, output: parsedLegacyAdaptive.output }
    : { status: parsedLegacyAdaptive.reason, output: null };

  // Governance Follow-Up Hardening — a personal reviewer needs each
  // model's answer text to make a review decision, but not per-model
  // token/latency counts (operational metadata, not review content; found
  // during the PR #33 production canary). Owner behavior is completely
  // unchanged. Field-by-field removal, not a schema change: `results`
  // stays the same shape and length either way, just missing these two
  // keys for a personal_reviewer response.
  const resultsForResponse =
    viewerRole === "personal_reviewer"
      ? results.map(({ tokenUsage: _tokenUsage, latencyMs: _latencyMs, ...rest }) => rest)
      : results;

  return NextResponse.json({
    ok: true,
    runId,
    // Personal Reviewer Inbox + Action Flow — lets the client distinguish
    // "this is my own report" from "I am reviewing someone else's report"
    // so it can hide owner-only controls (export, rerun) and show the
    // review decision UI instead. The rest of the response is otherwise
    // identical, except `results[].tokenUsage`/`latencyMs` are omitted for
    // personal_reviewer (see resultsForResponse above).
    viewerRole,
    question,
    selectedModels,
    status,
    results: resultsForResponse,
    synthesisCache,
    governance,
    governanceStatus: orgGovernanceStatus,
    adaptive,
    legacyAdaptive,
  });
}
