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
  if (owner !== uid) {
    return NextResponse.json(
      { ok: false, errorCode: "forbidden", message: "You do not have access to this run." },
      { status: 403 }
    );
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
      const teamCtx = await loadUserAndTeam(uid);
      if (!teamCtx?.team) {
        reviewRouting = "not_configured";
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

  return NextResponse.json({
    ok: true,
    runId,
    question,
    selectedModels,
    status,
    results,
    synthesisCache,
    governance,
    governanceStatus: orgGovernanceStatus,
    adaptive,
    legacyAdaptive,
  });
}
