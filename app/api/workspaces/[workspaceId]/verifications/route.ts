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
 *
 * Evidence Workspace, Phase 11A.3 — added a second, DISTINCT request mode:
 * origin-linked creation (`{runId, claimId}`), classified up front exactly
 * like the Personal route (see app/api/verify-claim/route.ts's own header)
 * so a caller can never supply a competing claim/origin/project value.
 * `resolveClaimVerificationOrigin()` is NEVER treated as an authorization
 * grant — both Gate 1 and Gate 2 still run in full for an origin-linked
 * request, exactly as they do for an ordinary one; the resolver only ever
 * supplies WHICH claim/project to act on, never WHETHER the caller may act.
 * Frozen ordering for origin-linked mode (deliberately AFTER Gate 1, not
 * before): rollout admission -> Gate 1 (called with `projectId: null`,
 * since the inherited projectId isn't known yet) -> resolve origin
 * (`expectedWorkspaceId` = this route's own URL `workspaceId`, closing
 * cross-Workspace origin linkage) -> MAX_CLAIM_LEN -> shared execution
 * core, which re-derives everything authoritatively at Gate 2 with the
 * NOW-known inherited projectId. A caller whose inherited project they
 * cannot organize still passes Gate 1 (which saw `projectId: null`) but is
 * denied at Gate 2 — the same accepted "quota/tokens already spent, no
 * refund" tradeoff this module's own header already documents for the
 * identical race on the ordinary path.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { ModelId } from "@/lib/types";
import { OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY, TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "@/lib/workspaces/teamWorkspaceTargetAdmission";
import { authorizeTeamClaimVerificationAdmission, saveTeamClaimVerification, type Gate1Result } from "@/lib/firestore/teamClaimVerifications";
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
import { resolveClaimVerificationOrigin, type ClaimVerificationOrigin } from "@/lib/verification/claimVerificationOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_MODELS = 2; // Mirrors app/api/verify-claim/route.ts's own local constant.
const MAX_CLAIM_LEN = 2000;
const DEFAULT_MODELS: ModelId[] = ["claude", "chatgpt", "gemini", "grok", "perplexity"];
const ALL_MODELS: Set<ModelId> = new Set(["chatgpt", "claude", "grok", "perplexity", "gemini"]);

const ORDINARY_ALLOWED_BODY_KEYS = new Set(["claim", "models", "projectId"]);
/** Origin-linked mode's entire request contract — `projectId` is deliberately excluded: it is always server-derived from the source run, never client-supplied, for this mode. */
const ORIGIN_LINKED_ALLOWED_BODY_KEYS = new Set(["runId", "claimId", "models"]);

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

/**
 * Phase 11A.3 — origin-linked mode's own denial response: ONE generic,
 * indistinguishable shape for every resolver denial reason, mirroring
 * app/api/verify-claim/route.ts's identical `originNotEligibleResponse()`
 * and this codebase's established Team Workspace concealment convention.
 */
function originNotEligibleResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, errorCode: "origin_not_eligible", message: "This claim could not be found or is not eligible for verification." },
    { status: 404 }
  );
}

type VerifyClaimRequestMode =
  | { kind: "ordinary" }
  | { kind: "origin_linked"; runId: string; claimId: string }
  | { kind: "ambiguous" }
  | { kind: "invalid_origin_locator" };

/** Structural mirror of app/api/verify-claim/route.ts's identical classifier. */
function classifyVerifyClaimRequestMode(body: Record<string, unknown>): VerifyClaimRequestMode {
  const hasClaimKey = Object.prototype.hasOwnProperty.call(body, "claim");
  const hasRunId = Object.prototype.hasOwnProperty.call(body, "runId");
  const hasClaimId = Object.prototype.hasOwnProperty.call(body, "claimId");
  const hasOriginLocator = hasRunId || hasClaimId;

  if (hasClaimKey && hasOriginLocator) {
    return { kind: "ambiguous" };
  }
  if (hasOriginLocator) {
    if (!hasRunId || !hasClaimId) return { kind: "invalid_origin_locator" };
    if (typeof body.runId !== "string" || body.runId.length === 0) return { kind: "invalid_origin_locator" };
    if (typeof body.claimId !== "string" || body.claimId.length === 0) return { kind: "invalid_origin_locator" };
    return { kind: "origin_linked", runId: body.runId, claimId: body.claimId };
  }
  return { kind: "ordinary" };
}

function parseSelectedModels(body: Record<string, unknown>): ModelId[] | null {
  let selectedModels: ModelId[] = DEFAULT_MODELS;
  if (Array.isArray(body.models) && body.models.length > 0) {
    selectedModels = body.models.filter((m: unknown): m is ModelId => ALL_MODELS.has(m as ModelId));
  }
  if (selectedModels.length < MIN_MODELS) return null;
  return selectedModels;
}

/** Rollout admission + Gate 1, shared by both request modes. Returns a denial NextResponse, or `null` to proceed. */
async function checkAdmissionAndGate1(args: { uid: string; workspaceId: string; projectId: string | null }): Promise<NextResponse | null> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) {
    const { status, body: errBody } = teamProjectAuthorizationDeniedResponse("team_workspaces_disabled");
    return NextResponse.json(errBody, { status });
  }

  const gate1: Gate1Result = await authorizeTeamClaimVerificationAdmission({ uid: args.uid, workspaceId: args.workspaceId, projectId: args.projectId });
  if (gate1.status !== "authorized") {
    const { status, body: errBody } = mapGateDenial(gate1);
    return NextResponse.json(errBody, { status });
  }
  return null;
}

/**
 * Shared execution core for BOTH request modes — subscription check,
 * quota, model execution, scoring, Gate 2 persistence, token accounting,
 * and governance are identical regardless of where `claimText`/`projectId`/
 * `origin` came from.
 */
async function executeAndPersistTeamClaimVerification(args: {
  uid: string;
  workspaceId: string;
  claimText: string;
  selectedModels: ModelId[];
  projectId: string | null;
  origin?: ClaimVerificationOrigin;
}): Promise<NextResponse> {
  const { uid, workspaceId, claimText, selectedModels, projectId, origin } = args;

  try {
    await validateUserSubscription(uid);
  } catch (e: any) {
    logger.warn("[workspaces/verifications POST] Subscription validation failed (non-blocking)", { error: e?.message });
  }

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

  const apiKeys = {
    chatgpt: OPENAI_API_KEY,
    claude: ANTHROPIC_API_KEY,
    grok: XAI_API_KEY,
    perplexity: PERPLEXITY_API_KEY,
    gemini: GEMINI_API_KEY,
  };

  const modelResults = await runClaimVerificationPanel(claimText, selectedModels, apiKeys);
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
    claimLength: claimText.length,
    modelEvidence,
    verdict,
    consensusScore,
    confidenceLabel,
    evidenceQuality: consensusSummary.evidenceQuality,
  });

  let totalTokens = 0;
  for (const r of modelResults) {
    totalTokens += totalTokensFromResult(r);
  }

  const gate2 = await saveTeamClaimVerification({
    uid,
    workspaceId,
    projectId,
    claim: claimText.slice(0, MAX_CLAIM_LEN),
    verdict,
    consensusScore,
    confidenceLabel,
    evidenceQuality: consensusSummary.evidenceQuality,
    supportRatio: consensusSummary.supportRatio,
    modelResults: modelEvidence,
    auditBundle,
    selectedModels,
    ...(origin ? { origin } : {}),
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
      question: claimText.slice(0, MAX_CLAIM_LEN),
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
    query: claimText,
    verdict,
    auditBundle,
    verificationId: gate2.verificationId,
  });

  const responsePayload = mergeGovernanceIntoBody(
    {
      ok: true,
      verificationId: gate2.verificationId,
      claim: claimText,
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

    const mode = classifyVerifyClaimRequestMode(body);
    if (mode.kind === "ambiguous") {
      return NextResponse.json(
        { ok: false, errorCode: "ambiguous_request_mode", message: "A request may not combine a claim with an origin locator." },
        { status: 400 }
      );
    }
    if (mode.kind === "invalid_origin_locator") {
      return NextResponse.json(
        { ok: false, errorCode: "invalid_origin_locator", message: "An origin-linked request requires both runId and claimId." },
        { status: 400 }
      );
    }

    if (mode.kind === "origin_linked") {
      // ============================================
      // ORIGIN-LINKED MODE (Phase 11A.3)
      // ============================================
      for (const key of Object.keys(body)) {
        if (!ORIGIN_LINKED_ALLOWED_BODY_KEYS.has(key)) {
          const { status, body: errBody } = unexpectedFieldResponse();
          return NextResponse.json(errBody, { status });
        }
      }

      const selectedModels = parseSelectedModels(body);
      if (!selectedModels) {
        return NextResponse.json({ ok: false, errorCode: "not_enough_models", message: `Select at least ${MIN_MODELS} models.` }, { status: 400 });
      }

      // Gate 1 first, with projectId unknown (null) — see file header for
      // why this ordering is deliberate, not an oversight.
      const gateDenial = await checkAdmissionAndGate1({ uid, workspaceId, projectId: null });
      if (gateDenial) return gateDenial;

      const resolution = await resolveClaimVerificationOrigin({
        runId: mode.runId,
        claimId: mode.claimId,
        callerUid: uid,
        // Team scope — closes cross-Workspace origin linkage. The
        // resolver denies workspace_mismatch if the source run's own
        // structural binding doesn't exactly equal this URL's workspaceId.
        expectedWorkspaceId: workspaceId,
      });
      if (resolution.status !== "resolved") {
        return originNotEligibleResponse();
      }

      if (resolution.claimText.length > MAX_CLAIM_LEN) {
        return NextResponse.json(
          { ok: false, errorCode: "claim_too_long", message: `Claim must be at most ${MAX_CLAIM_LEN} characters.` },
          { status: 400 }
        );
      }

      return await executeAndPersistTeamClaimVerification({
        uid,
        workspaceId,
        claimText: resolution.claimText,
        selectedModels,
        projectId: resolution.projectId,
        origin: resolution.origin,
      });
    }

    // ============================================
    // ORDINARY MODE — unchanged from before this phase.
    // ============================================
    for (const key of Object.keys(body)) {
      if (!ORDINARY_ALLOWED_BODY_KEYS.has(key)) {
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

    const selectedModels = parseSelectedModels(body);
    if (!selectedModels) {
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

    const gateDenial = await checkAdmissionAndGate1({ uid, workspaceId, projectId: targetProjectId });
    if (gateDenial) return gateDenial;

    return await executeAndPersistTeamClaimVerification({
      uid,
      workspaceId,
      claimText: claimRaw,
      selectedModels,
      projectId: targetProjectId,
    });
  } catch (err: any) {
    logger.error("[POST /api/workspaces/[workspaceId]/verifications] Unexpected error", { error: err?.message, stack: err?.stack });
    return NextResponse.json(
      { ok: false, errorCode: "internal_error", message: "Server error. Please try again." },
      { status: 500 }
    );
  }
}
