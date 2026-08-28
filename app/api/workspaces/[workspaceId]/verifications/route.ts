/**
 * Team Claim Verification Creation, Phase 8C-E.1 —
 * `POST /api/workspaces/{workspaceId}/verifications`. Team Claim only —
 * no GET/list in this slice (deferred, see 8C-E.0 §27). No Video
 * Verification in this file (E3, separate).
 *
 * Frozen order (8C-E.0.1): identity -> rate limit (BEFORE body parsing,
 * matching Personal's own `/api/verify-claim` and Phase D's security
 * ordering) -> body validation -> pure Team rollout -> GATE 1
 * (`authorizeTeamClaimVerificationAdmission()`, no write) -> subscription
 * validation -> quota -> `runClaimVerificationPanel()` (same function
 * Personal calls, unmodified) -> scoring (same functions, unmodified) ->
 * token accounting (unconditional, same position/semantics as Personal:
 * after the persistence attempt, regardless of its outcome) -> GATE 2
 * (`saveTeamClaimVerification()`, fresh reauthorization + `tx.create()`)
 * -> (only on Gate-2 success) governance + legacy team-governance
 * pipeline -> response.
 *
 * Gate 1 never authorizes Gate 2. Gate 2 independently re-derives
 * Workspace/membership/owner-integrity/capability/Project state from
 * scratch, inside its own transaction, at the moment the artifact is
 * actually created — see lib/firestore/teamClaimVerifications.ts's own
 * module doc for the full rationale.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { ModelId } from "@/lib/types";
import { OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY, TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "@/lib/workspaces/teamWorkspaceTargetAdmission";
import { authorizeTeamClaimVerificationAdmission, saveTeamClaimVerification } from "@/lib/firestore/teamClaimVerifications";
import { validateUserSubscription } from "@/lib/stripe/subscriptionValidation";
import { checkAndIncrementUsageForRun } from "@/lib/stripe/usageCheck";
import { runClaimVerificationPanel } from "@/lib/verification/runClaimVerificationPanel";
import { buildClaimModelEvidence } from "@/lib/verification/buildClaimModelEvidence";
import { computeClaimVerdict } from "@/lib/verification/claimVerdict";
import { computeConsensusScoring } from "@/lib/verification/consensusScoring";
import { buildAgreementDisagreementDigest } from "@/lib/verification/agreementDigest";
import { buildClaimVerificationAuditBundle } from "@/lib/verification/auditBundle";
import { incrementUserTokenUsage } from "@/lib/firestore/userTokens";
import { evaluateAndStoreGovernance } from "@/lib/governance/evaluateAndStore";
import type { GovernanceInput } from "@/lib/governance/evaluateGovernance";
import { applyTeamGovernancePipeline, mergeGovernanceIntoBody } from "@/lib/governance/teamGovernancePipeline";
import { adminDb } from "@/lib/firebase/admin";
import type { UserProfile } from "@/lib/types";
import { validateNullableProjectIdValue } from "@/lib/projects/runProjectAssociationBody";
import { invalidRequestBodyResponse, unexpectedFieldResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { teamProjectAuthorizationDeniedResponse } from "@/lib/projects/teamProjectErrorResponse";
import { runProjectAssociationTargetNotFoundResponse, projectArchivedTargetResponse } from "@/lib/projects/projectErrorResponse";
import { logger } from "@/lib/logger";
import type { ModelVerdict } from "@/lib/verification/parseVerificationJson";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_MODELS = 2; // Mirrors app/api/verify-claim/route.ts's own local constant.
const MAX_CLAIM_LEN = 2000;
const DEFAULT_MODELS: ModelId[] = ["claude", "chatgpt", "gemini", "grok", "perplexity"];
const ALL_MODELS: Set<ModelId> = new Set(["chatgpt", "claude", "grok", "perplexity", "gemini"]);

const ALLOWED_BODY_KEYS = new Set(["claim", "models", "projectId"]);

function totalTokensFromResult(result: { tokenUsage?: { totalTokens?: number } | null; rawResponse?: unknown }): number {
  if (result.tokenUsage?.totalTokens !== undefined && typeof result.tokenUsage.totalTokens === "number") {
    return result.tokenUsage.totalTokens;
  }
  const rr = result.rawResponse as any;
  if (rr?.usage?.total_tokens != null) return Number(rr.usage.total_tokens) || 0;
  if (rr?.response?.usageMetadata?.totalTokenCount != null) {
    return Number(rr.response.usageMetadata.totalTokenCount) || 0;
  }
  return 0;
}

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/workspaces/[workspaceId]/verifications", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function mapGateDenial(result: { status: string; reason?: unknown }): { status: number; body: unknown } {
  switch (result.status) {
    // Phase 10C.1A: "team_workspaces_disabled" (rollout non-admission) is
    // concealed identically to "unauthorized" — previously a distinct
    // 503 that let a caller who already knows this Workspace ID
    // distinguish "not admitted" from "admitted but I have no access."
    case "team_workspaces_disabled":
    case "unauthorized":
      return teamProjectAuthorizationDeniedResponse(result.reason as any);
    case "project_not_found":
      return runProjectAssociationTargetNotFoundResponse();
    case "project_archived":
      return projectArchivedTargetResponse();
    case "firestore_unavailable":
    case "transaction_failed":
    default:
      return internalErrorResponse();
  }
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  try {
    // ============================================
    // AUTHENTICATION
    // ============================================
    const uidOrRes = await getUid(req);
    if (uidOrRes instanceof NextResponse) return uidOrRes;
    const uid = uidOrRes;
    const workspaceId = params.workspaceId;

    // ============================================
    // RATE LIMITING — BEFORE body parsing (8C-D.0.3 ordering, preserved).
    // ============================================
    const { checkRateLimit } = await import("@/lib/security/rateLimit");
    const rateLimitResult = await checkRateLimit({
      maxRequests: 30,
      windowSeconds: 60,
      identifier: `team-claim-verification:${uid}`,
    });
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { ok: false, errorCode: "rate_limit_exceeded", message: "Too many verification requests. Please wait before trying again." },
        { status: 429 }
      );
    }

    // ============================================
    // BODY PARSING
    // ============================================
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, errorCode: "invalid_request", message: "Invalid request format." }, { status: 400 });
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      const { status, body: errBody } = invalidRequestBodyResponse();
      return NextResponse.json(errBody, { status });
    }
    for (const key of Object.keys(body)) {
      if (!ALLOWED_BODY_KEYS.has(key)) {
        const { status, body: errBody } = unexpectedFieldResponse();
        return NextResponse.json(errBody, { status });
      }
    }

    const claimRaw = typeof body.claim === "string" ? body.claim.trim() : "";
    if (!claimRaw) {
      return NextResponse.json({ ok: false, errorCode: "invalid_claim", message: "Please paste a claim to verify." }, { status: 400 });
    }
    if (claimRaw.length > MAX_CLAIM_LEN) {
      return NextResponse.json(
        { ok: false, errorCode: "claim_too_long", message: `Claim must be at most ${MAX_CLAIM_LEN} characters.` },
        { status: 400 }
      );
    }

    let selectedModels: ModelId[] = DEFAULT_MODELS;
    if (Array.isArray(body.models) && body.models.length > 0) {
      selectedModels = body.models.filter((m: unknown): m is ModelId => ALL_MODELS.has(m as ModelId));
    }
    if (selectedModels.length < MIN_MODELS) {
      return NextResponse.json({ ok: false, errorCode: "not_enough_models", message: `Select at least ${MIN_MODELS} models.` }, { status: 400 });
    }

    // projectId: absent -> null; explicit null -> null; valid string ->
    // that string; empty/malformed -> 400.
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
    // TARGET-WORKSPACE ADMISSION CHECK (Phase 10B.3.2A)
    // ============================================
    const admission = resolveTeamWorkspaceTargetAdmission({
      uid,
      workspaceId,
      globalEnabled: TEAM_WORKSPACES_ENABLED,
      canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
      canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
    });
    if (!admission.enabled) {
      // Phase 10C.1A: concealed identically to the gate1/gate2 "unauthorized"
      // mapping below (mapGateDenial), not a distinct 503.
      const { status, body: errBody } = teamProjectAuthorizationDeniedResponse("team_workspaces_disabled");
      return NextResponse.json(errBody, { status });
    }

    // ============================================
    // GATE 1 — execution admission (no write). Must occur before quota
    // and before any model call.
    // ============================================
    const gate1 = await authorizeTeamClaimVerificationAdmission({ uid, workspaceId, projectId: targetProjectId });
    if (gate1.status !== "authorized") {
      const { status, body: errBody } = mapGateDenial(gate1);
      return NextResponse.json(errBody, { status });
    }

    // ============================================
    // SUBSCRIPTION VALIDATION (best-effort, non-blocking) — same
    // semantics/position as Personal (immediately before quota).
    // ============================================
    try {
      await validateUserSubscription(uid);
    } catch (e: any) {
      logger.warn("[workspaces/verifications POST] Subscription validation failed (non-blocking)", { error: e?.message });
    }

    // ============================================
    // PLAN LIMIT ENFORCEMENT
    // ============================================
    const usage = await checkAndIncrementUsageForRun(uid, selectedModels.length);
    if (!usage.allowed) {
      if (usage.reason === "MODEL_LIMIT") {
        return NextResponse.json(
          { ok: false, errorCode: "PLAN_MODEL_LIMIT_REACHED", message: `Your plan allows up to ${usage.maxModelsPerRun} models per run.`, maxModelsPerRun: usage.maxModelsPerRun },
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
            plan: usage.plan.toUpperCase(),
          },
          { status: 429 }
        );
      }
    }

    // ============================================
    // CLAIM EXECUTION — same functions Personal calls, unmodified.
    // ============================================
    const apiKeys = {
      chatgpt: OPENAI_API_KEY,
      claude: ANTHROPIC_API_KEY,
      grok: XAI_API_KEY,
      perplexity: PERPLEXITY_API_KEY,
      gemini: GEMINI_API_KEY,
    };

    const modelResults = await runClaimVerificationPanel(claimRaw, selectedModels, apiKeys);
    const modelEvidence = buildClaimModelEvidence(modelResults);

    const verdict = computeClaimVerdict(
      modelEvidence.map((m) => ({
        status: m.status,
        verdict: m.status === "ok" ? (m.verdict as ModelVerdict) : undefined,
      }))
    );

    const consensusRows = modelEvidence.map((m) => ({
      status: m.status as "ok" | "parse_error" | "failed",
      verdict: m.status === "ok" ? (m.verdict as ModelVerdict) : undefined,
      confidence: m.status === "ok" ? (m.confidence as "high" | "medium" | "low") : undefined,
    }));

    const { consensusScore, confidenceLabel, summary: consensusSummary } = computeConsensusScoring({
      mode: "verification",
      modelRows: consensusRows,
      aggregateVerdict: verdict,
    });

    const digest = buildAgreementDisagreementDigest(
      modelEvidence.map((m) => ({ modelId: m.modelId, correctParts: m.correctParts, incorrectParts: m.incorrectParts }))
    );

    const aggregateSummary = {
      totalModels: modelEvidence.length,
      modelsAgreeAccurate: modelEvidence.filter((m) => m.verdict === "accurate").length,
      modelsAgreeInaccurate: modelEvidence.filter((m) => m.verdict === "inaccurate").length,
      modelsPartial: modelEvidence.filter((m) => m.verdict === "partially_accurate").length,
      modelsUnverifiable: modelEvidence.filter((m) => m.verdict === "unverifiable" || m.verdict === "parse_error" || m.verdict === "failed").length,
    };

    const auditBundle = buildClaimVerificationAuditBundle({
      claimLength: claimRaw.length,
      modelEvidence,
      verdict,
      consensusScore,
      confidenceLabel,
      evidenceQuality: consensusSummary.evidenceQuality,
    });

    // ============================================
    // TOKEN ACCOUNTING — unconditional, same best-effort try/catch/log
    // semantics as Personal, deliberately positioned AFTER the
    // persistence attempt (Gate 2) so its own outcome never depends on
    // Gate 2's result, exactly mirroring Personal's own relative
    // ordering (token accounting after the save attempt, regardless of
    // whether that attempt succeeded).
    // ============================================
    let totalTokens = 0;
    for (const r of modelResults) {
      totalTokens += totalTokensFromResult(r);
    }

    // ============================================
    // GATE 2 — canonical persistence. Independently re-derives
    // authorization from scratch; never trusts Gate 1.
    // ============================================
    const gate2 = await saveTeamClaimVerification({
      uid,
      workspaceId,
      projectId: targetProjectId,
      claim: claimRaw.slice(0, MAX_CLAIM_LEN),
      verdict,
      consensusScore,
      confidenceLabel,
      evidenceQuality: consensusSummary.evidenceQuality,
      supportRatio: consensusSummary.supportRatio,
      modelResults: modelEvidence,
      auditBundle,
      selectedModels,
    });

    try {
      await incrementUserTokenUsage(uid, totalTokens);
    } catch (tokErr: any) {
      logger.warn("[workspaces/verifications POST] Token increment failed", { error: tokErr?.message });
    }

    if (gate2.status !== "created") {
      // No Team artifact. No Personal fallback. No governance. No legacy
      // team-governance projection. Quota and provider tokens above
      // remain consumed — the accepted, explicitly frozen tradeoff.
      const { status, body: errBody } = mapGateDenial(gate2);
      return NextResponse.json(errBody, { status });
    }

    // ============================================
    // GOVERNANCE — only after Gate 2's tx.create() has actually
    // committed. evaluateAndStoreGovernance()'s own set(...,{merge:true})
    // would CREATE a partial, malformed document if the target didn't
    // already exist — never call it before Gate 2 succeeds.
    // ============================================
    let orgGovernanceStatus: "approved" | "needs_review" | "blocked" | undefined;
    try {
      const governanceConsensusScore =
        typeof consensusScore === "number" && !Number.isNaN(consensusScore)
          ? consensusScore
          : typeof consensusSummary.overallConsensusScore === "number" && !Number.isNaN(consensusSummary.overallConsensusScore)
            ? consensusSummary.overallConsensusScore
            : null;

      const verificationGovernanceInput: GovernanceInput = {
        consensusScore: governanceConsensusScore,
        evidenceQuality: consensusSummary.evidenceQuality,
        sourceBacked: false,
        missingSourcesCount: 0,
        modelHealth: {
          ok: modelEvidence.filter((r) => r.status === "ok").length,
          substituted: 0,
          failed: modelEvidence.filter((r) => r.status !== "ok").length,
        },
        question: claimRaw.slice(0, MAX_CLAIM_LEN),
        runType: "verification",
        verificationVerdict: verdict,
      };
      const govResult = await evaluateAndStoreGovernance({
        runId: gate2.verificationId,
        collection: "verifications",
        input: verificationGovernanceInput,
        ownerUid: uid,
      });
      if (govResult) orgGovernanceStatus = govResult.governanceStatus;
    } catch (govErr: unknown) {
      logger.error("[governance] Team Claim verification evaluation failed", { error: (govErr as Error)?.message });
    }

    // ============================================
    // LEGACY OLD-TEAM GOVERNANCE PIPELINE — unchanged legacy purpose,
    // never used for Team Workspace authorization, only after Gate 2
    // success (mirrors Personal's own structural nesting, where this
    // sits after the save-attempt's try/catch too).
    // ============================================
    const usableForBanner = modelEvidence.filter((m) => m.status === "ok");
    const accurateAmongUsable = usableForBanner.filter((m) => m.verdict === "accurate").length;

    let userEmail = "";
    if (adminDb) {
      const uSnap = await adminDb.collection("users").doc(uid).get();
      userEmail = String((uSnap.data() as UserProfile | undefined)?.email ?? "");
    }

    const gov = await applyTeamGovernancePipeline({
      uid,
      userEmail,
      consensusSummary,
      consensusScore,
      type: "verification",
      query: claimRaw,
      verdict,
      auditBundle,
      verificationId: gate2.verificationId,
    });

    const responsePayload = mergeGovernanceIntoBody(
      {
        ok: true,
        verificationId: gate2.verificationId,
        claim: claimRaw,
        verdict,
        consensusScore,
        confidenceLabel,
        evidenceQuality: consensusSummary.evidenceQuality,
        supportRatio: consensusSummary.supportRatio,
        modelEvidence,
        aggregateSummary,
        whereModelsAgree: digest.whereModelsAgree,
        whereModelsDisagree: digest.whereModelsDisagree,
        auditBundle,
        accurateAmongUsable,
        usableModelCount: usableForBanner.length,
        ...(orgGovernanceStatus ? { governanceStatus: orgGovernanceStatus } : {}),
        workspaceId: gate2.workspaceId,
        projectId: gate2.projectId,
        usage: {
          runsThisMonth: usage.runsThisMonth,
          maxRunsPerMonth: usage.maxRunsPerMonth,
          maxModelsPerRun: usage.maxModelsPerRun,
        },
      },
      gov
    );

    return NextResponse.json(responsePayload, { status: 200 });
  } catch (err: any) {
    logger.error("[POST /api/workspaces/[workspaceId]/verifications] Unexpected error", { error: err?.message, stack: err?.stack });
    return NextResponse.json(
      { ok: false, errorCode: "internal_error", message: "Server error. Please try again." },
      { status: 500 }
    );
  }
}
