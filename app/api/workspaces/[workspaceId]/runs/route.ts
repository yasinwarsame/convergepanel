/**
 * Team Run Lists, Phase 8C-B2 — `GET /api/workspaces/{workspaceId}/runs`
 * (general list, `research.read` scoped to the whole Workspace) and
 * `GET /api/workspaces/{workspaceId}/runs?scope=unfiled` (same route,
 * `projectId==null` only). Read-only; no run creation, no mutation, no
 * Project association of any kind.
 *
 * Authorization is `resolveTeamRunWorkspaceAccess()` (rollout-first,
 * reuses `resolveWorkspaceAccess()` exactly once, rejects any non-Team
 * grant) followed by an explicit `research.read` capability check —
 * never a creator/ownership check of any kind. `run.userId` plays no
 * role in whether this route returns a row.
 *
 * Team Run Creation, Phase 8C-D — `POST /api/workspaces/{workspaceId}/runs`
 * added beside the GET above; GET's own code/imports/behavior are
 * unchanged. Order (frozen 8C-D.0.3, Corrections 1/2/3/4):
 *   identity -> rate limit (`team-run-create:${uid}`, BEFORE body parsing,
 *   matching Personal's `/api/run-panel` security ordering exactly) ->
 *   body parse/validate -> pure Team rollout check -> adaptive
 *   classification/routing guard (non-active short-circuits before any
 *   quota/creation/execution, identically to Personal) -> best-effort
 *   subscription validation -> quota (Option A: charged before the
 *   authoritative Team transaction) -> `createTeamWorkspaceRun()` ->
 *   shared `executeOrdinaryRun()` (the same engine
 *   `/api/run-panel` calls, extracted to `lib/runPanelExecution.ts`).
 *
 * A quota success followed by a Team-transaction denial/failure leaves
 * the quota unit consumed — the explicitly accepted 8C-D.0/0.1 tradeoff,
 * not a bug: no orphan-run compensation, delete, or refund semantics
 * exist for this route.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunInsufficientCapabilityResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { internalErrorResponse, invalidRequestBodyResponse, unexpectedFieldResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { listTeamWorkspaceRuns, type TeamWorkspaceRunsScope } from "@/lib/workspaces/listTeamWorkspaceRuns";
import { ModelId, RunPanelApiResponse } from "@/lib/types";
import { splitQuestionAndContext } from "@/lib/questionContext";
import { ADAPTIVE_SCHEMAS_ENABLED, ADAPTIVE_SCHEMAS_CANARY_UIDS, TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "@/lib/workspaces/teamWorkspaceTargetAdmission";
import { resolveAdaptiveSchemasAdmission } from "@/lib/adaptiveSchema/adaptiveSchemasRollout";
import { planAdaptiveRun, AdaptivePromptPlan, buildNonExecutionPayload } from "@/lib/adaptiveSchema/orchestrate";
import { trackQueryClassified, trackRoutingOutcome } from "@/lib/adaptiveSchema/analytics";
import { validateUserSubscription } from "@/lib/stripe/subscriptionValidation";
import { checkAndIncrementUsageForRun } from "@/lib/stripe/usageCheck";
import { createTeamWorkspaceRun } from "@/lib/firestore/teamWorkspaceRuns";
import { executeOrdinaryRun } from "@/lib/runPanelExecution";
import { teamProjectAuthorizationDeniedResponse } from "@/lib/projects/teamProjectErrorResponse";
import { runProjectAssociationTargetNotFoundResponse, projectArchivedTargetResponse } from "@/lib/projects/projectErrorResponse";
import { validateNullableProjectIdValue } from "@/lib/projects/runProjectAssociationBody";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MIN_MODELS = 2; // Mirrors app/api/run-panel/route.ts's own local constant.

/**
 * Phase 8C-D.1.1 — `route`/`method` are caller-supplied telemetry
 * metadata, not re-derived from `req` itself: this route now has two
 * HTTP methods (GET, POST) sharing this one identity helper, and each
 * caller passes its own accurate values so `logIdentityResolutionFailure()`
 * never attributes a POST failure to GET (or vice versa). Identity
 * resolution/response behavior is otherwise unchanged.
 */
async function getUid(req: NextRequest, telemetry: { route: string; method: string }): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: telemetry.route, method: telemetry.method, failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function parseScope(searchParams: URLSearchParams): { ok: true; scope: TeamWorkspaceRunsScope } | { ok: false } {
  const raw = searchParams.get("scope");
  if (raw === null) return { ok: true, scope: "all" };
  if (raw === "unfiled") return { ok: true, scope: "unfiled" };
  return { ok: false };
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const uidOrRes = await getUid(req, { route: "GET /api/workspaces/[workspaceId]/runs", method: "GET" });
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const workspaceId = params.workspaceId;

  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    const { status, body } = teamRunAccessDeniedResponse(access.reason);
    return NextResponse.json(body, { status });
  }
  // Centralized capability map only — never a hardcoded role comparison,
  // never `run.userId === uid`, never a creator check.
  if (!access.capabilities.includes("research.read")) {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }

  const { searchParams } = req.nextUrl;
  const scopeResult = parseScope(searchParams);
  if (!scopeResult.ok) {
    return NextResponse.json({ ok: false, errorCode: "invalid_scope", message: "Unsupported scope value." }, { status: 400 });
  }

  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const cursorRaw = searchParams.get("cursor");

  const result = await listTeamWorkspaceRuns({ workspaceId, scope: scopeResult.scope, limit, cursorRaw });
  switch (result.status) {
    case "ok":
      return NextResponse.json({
        ok: true,
        items: result.items,
        hasMore: result.hasMore,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        scope: scopeResult.scope,
      });
    case "invalid_cursor":
      return NextResponse.json({ ok: false, errorCode: "invalid_cursor", message: "This page link is no longer valid." }, { status: 400 });
    case "integrity_violation":
    case "query_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}

const ALLOWED_POST_BODY_KEYS = new Set(["question", "selectedModels", "projectId"]);

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  // Top-level try/catch mirrors /api/run-panel's own outer catch — this
  // route ALWAYS returns JSON, never throws.
  try {
    // ============================================
    // AUTHENTICATION
    // ============================================
    const uidOrRes = await getUid(req, { route: "POST /api/workspaces/[workspaceId]/runs", method: "POST" });
    if (uidOrRes instanceof NextResponse) return uidOrRes;
    const uid = uidOrRes;
    const workspaceId = params.workspaceId;

    // ============================================
    // RATE LIMITING — BEFORE body parsing, matching Personal's
    // /api/run-panel ordering exactly (Phase 8C-D.0.3 Correction 1/2).
    // ============================================
    const { checkRateLimit } = await import("@/lib/security/rateLimit");
    const rateLimitResult = await checkRateLimit({
      maxRequests: 30,
      windowSeconds: 60,
      identifier: `team-run-create:${uid}`,
    });
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: "rate_limit_exceeded",
          message: "Too many panel runs. Please wait before trying again.",
          details: {
            retryAfter: rateLimitResult.retryAfter,
            resetAt: rateLimitResult.resetAt.toISOString(),
          },
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateLimitResult.retryAfter || 60),
            "X-RateLimit-Limit": "30",
            "X-RateLimit-Remaining": String(rateLimitResult.remaining),
            "X-RateLimit-Reset": String(Math.floor(rateLimitResult.resetAt.getTime() / 1000)),
          },
        }
      );
    }

    // ============================================
    // BODY PARSING
    // ============================================
    let body: any;
    try {
      body = await req.json();
    } catch {
      const response: RunPanelApiResponse = { ok: false, errorCode: "invalid_request", message: "Invalid request format. Please try again." };
      return NextResponse.json(response, { status: 400 });
    }

    // ============================================
    // REQUEST SIZE VALIDATION
    // ============================================
    const { validateRunPanelRequest, validateRequestBodySize, MAX_REQUEST_BODY_SIZE } = await import("@/lib/security/requestValidation");
    try {
      const bodyString = JSON.stringify(body);
      const sizeValidation = validateRequestBodySize(bodyString, MAX_REQUEST_BODY_SIZE);
      if (!sizeValidation.valid) {
        return NextResponse.json(
          { ok: false, errorCode: "request_too_large", message: sizeValidation.message || "Request body is too large", details: sizeValidation.details },
          { status: 413 }
        );
      }
    } catch (sizeError: any) {
      logger.warn("[workspaces/runs POST] Could not validate request size", { error: sizeError?.message });
    }

    // ============================================
    // ACCEPTED FIELD SET (Phase 8C-D.0.2/0.3 Correction 5)
    // ============================================
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      const { status, body: errBody } = invalidRequestBodyResponse();
      return NextResponse.json(errBody, { status });
    }
    for (const key of Object.keys(body)) {
      if (!ALLOWED_POST_BODY_KEYS.has(key)) {
        const { status, body: errBody } = unexpectedFieldResponse();
        return NextResponse.json(errBody, { status });
      }
    }

    const inputValidation = validateRunPanelRequest(body);
    if (!inputValidation.valid) {
      return NextResponse.json(
        { ok: false, errorCode: inputValidation.errorCode || "validation_failed", message: inputValidation.message || "Invalid request", details: inputValidation.details },
        { status: 400 }
      );
    }

    const { question, selectedModels } = body ?? {};

    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return NextResponse.json(
        { ok: false, errorCode: "invalid_question", message: "Please enter a question before running the panel." },
        { status: 400 }
      );
    }

    const { question: parsedQuestion, context } = splitQuestionAndContext(question);
    const trimmedQuestion = parsedQuestion.trim();

    if (!Array.isArray(selectedModels) || selectedModels.length < MIN_MODELS) {
      return NextResponse.json(
        { ok: false, errorCode: "not_enough_models", message: "Select at least two models before running the panel." },
        { status: 400 }
      );
    }
    const requestedModelCount = selectedModels.length;

    // projectId: absent -> null; explicit null -> null; valid string ->
    // that string; empty/malformed -> 400. Never accepted: workspaceId
    // (URL only), context, uid, capabilities, membership, runId.
    let targetProjectId: string | null = null;
    if (Object.prototype.hasOwnProperty.call(body, "projectId")) {
      const parsedProjectId = validateNullableProjectIdValue(body.projectId);
      if (!parsedProjectId.ok) {
        const { status, body: errBody } = invalidRequestBodyResponse();
        return NextResponse.json(errBody, { status });
      }
      targetProjectId = parsedProjectId.value;
    }

    // ============================================
    // TARGET-WORKSPACE ADMISSION CHECK — before adaptive planning
    // (Correction 2): the Workspace-qualified Team endpoint must be
    // dark/disabled as a Team feature before any ordinary Team execution
    // planning happens. Phase 10B.3.2A: target-aware (global OR uid-canary
    // OR THIS Workspace's own canary admission), evaluated against the
    // same `workspaceId` that will be written as this run's own canonical
    // `workspaceId` field below — never a different value.
    // ============================================
    const admission = resolveTeamWorkspaceTargetAdmission({
      uid,
      workspaceId,
      globalEnabled: TEAM_WORKSPACES_ENABLED,
      canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
      canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
    });
    if (!admission.enabled) {
      // Phase 10C.1A: concealed identically to the "unauthorized" mapping
      // below, not a distinct 503.
      const { status, body: errBody } = teamProjectAuthorizationDeniedResponse("team_workspaces_disabled");
      return NextResponse.json(errBody, { status });
    }

    // ============================================
    // ADAPTIVE RESULT SCHEMA — CLASSIFICATION (flag-gated, never blocks the run)
    // ============================================
    let adaptivePlan: AdaptivePromptPlan | null = null;
    const adaptiveSchemasAdmission = resolveAdaptiveSchemasAdmission({ uid, globalEnabled: ADAPTIVE_SCHEMAS_ENABLED, canaryUidsRaw: ADAPTIVE_SCHEMAS_CANARY_UIDS });
    if (adaptiveSchemasAdmission.admitted) {
      try {
        adaptivePlan = await planAdaptiveRun(trimmedQuestion, selectedModels as ModelId[], context);
      } catch (adaptiveError: any) {
        logger.warn("[workspaces/runs POST] Adaptive planning failed, continuing with legacy prompt", { error: adaptiveError?.message });
        adaptivePlan = null;
      }
    }

    // ============================================
    // NON-ACTIVE ADAPTIVE ROUTING — identical to Personal: zero quota,
    // zero Team transaction, zero run creation, zero model execution.
    // ============================================
    if (adaptivePlan && adaptivePlan.routing.kind !== "active") {
      trackQueryClassified(uid, adaptivePlan.classification);
      trackRoutingOutcome(uid, adaptivePlan.classification, adaptivePlan.routing);
      return NextResponse.json(buildNonExecutionPayload(adaptivePlan.classification, adaptivePlan.routing));
    }
    if (adaptivePlan) {
      trackQueryClassified(uid, adaptivePlan.classification);
    }

    // ============================================
    // SUBSCRIPTION VALIDATION (best-effort, non-blocking) — same
    // semantics as Personal, same position (after active routing is
    // established, before quota).
    // ============================================
    try {
      await validateUserSubscription(uid);
    } catch (validationError: any) {
      logger.warn("[workspaces/runs POST] Subscription validation failed (non-blocking)", { uid, error: validationError?.message });
    }

    // ============================================
    // PLAN LIMIT ENFORCEMENT — Option A: charged before the authoritative
    // Team create transaction (frozen 8C-D.0/0.1).
    // ============================================
    const usage = await checkAndIncrementUsageForRun(uid, requestedModelCount);
    if (!usage.allowed) {
      if (usage.reason === "MODEL_LIMIT") {
        let message: string;
        if (usage.maxModelsPerRun === 2) {
          message = "Free tier allows up to 2 models per run. Upgrade to run 3 or 5 models.";
        } else if (usage.maxModelsPerRun === 3) {
          message = "Your plan allows up to 3 models per run. Upgrade to run 5 models.";
        } else {
          message = `Your plan allows up to ${usage.maxModelsPerRun} models per run.`;
        }
        return NextResponse.json(
          { ok: false, errorCode: "PLAN_MODEL_LIMIT_REACHED", message, maxModelsPerRun: usage.maxModelsPerRun },
          { status: 403 }
        );
      }
      if (usage.reason === "RUN_LIMIT") {
        return NextResponse.json(
          {
            ok: false,
            error: "RUN_LIMIT_REACHED",
            errorCode: "RUN_LIMIT_REACHED",
            message: "You've reached your monthly run limit.",
            runsUsed: usage.runsThisMonth,
            runsLimit: usage.maxRunsPerMonth,
            resetsAt: usage.resetsAt.toISOString(),
            plan: usage.plan.toUpperCase().replace("-", "_"),
          },
          { status: 429 }
        );
      }
    }

    // ============================================
    // AUTHORITATIVE TEAM RUN CREATION — quota has already been consumed
    // above; a denial/failure here leaves it consumed (frozen tradeoff,
    // no refund/decrement/compensation).
    // ============================================
    const created = await createTeamWorkspaceRun({
      uid,
      workspaceId,
      question: trimmedQuestion,
      selectedModels: selectedModels as ModelId[],
      projectId: targetProjectId,
    });

    if (created.status !== "created") {
      switch (created.status) {
        case "team_workspaces_disabled": {
          // Phase 10C.1A: concealed identically to "unauthorized" below.
          const { status, body: errBody } = teamProjectAuthorizationDeniedResponse("team_workspaces_disabled");
          return NextResponse.json(errBody, { status });
        }
        case "unauthorized": {
          const { status, body: errBody } = teamProjectAuthorizationDeniedResponse(created.reason);
          return NextResponse.json(errBody, { status });
        }
        case "project_not_found": {
          const { status, body: errBody } = runProjectAssociationTargetNotFoundResponse();
          return NextResponse.json(errBody, { status });
        }
        case "project_archived": {
          const { status, body: errBody } = projectArchivedTargetResponse();
          return NextResponse.json(errBody, { status });
        }
        case "firestore_unavailable":
        case "transaction_failed": {
          const { status, body: errBody } = internalErrorResponse();
          return NextResponse.json(errBody, { status });
        }
      }
    }

    // ============================================
    // SHARED ORDINARY RUN EXECUTION — same engine Personal calls.
    // ============================================
    const debugRawResponseRequested = req.headers.get("x-debug-raw") === "1";
    const execution = await executeOrdinaryRun({
      uid,
      runId: created.runId,
      trimmedQuestion,
      context,
      selectedModels: selectedModels as ModelId[],
      adaptivePlan,
      debugRawResponseRequested,
    });

    return NextResponse.json(
      {
        ...execution.body,
        workspaceId: created.workspaceId,
        projectId: created.projectId,
        usage: {
          runsThisMonth: usage.runsThisMonth,
          maxRunsPerMonth: usage.maxRunsPerMonth,
          maxModelsPerRun: usage.maxModelsPerRun,
        },
      },
      { status: execution.status }
    );
  } catch (err: any) {
    logger.error("[POST /api/workspaces/[workspaceId]/runs] Unexpected error", { error: err?.message, stack: err?.stack });
    const baseResponse: any = { ok: false, errorCode: "internal_error", message: "Server error. Please try again. If this keeps happening, contact support." };
    if (process.env.NODE_ENV !== "production") {
      baseResponse.devDetails = `${err?.message || String(err)}\n\nStack: ${err?.stack || "No stack trace available"}`;
    }
    return NextResponse.json(baseResponse, { status: 500 });
  }
}
