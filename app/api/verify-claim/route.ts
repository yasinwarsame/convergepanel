/**
 * HTTP API route (verify-claim): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { ModelId, ModelResult } from "@/lib/types";
import { OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY } from "@/lib/env";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { checkAndIncrementUsageForRun } from "@/lib/stripe/usageCheck";
import { validateUserSubscription } from "@/lib/stripe/subscriptionValidation";
import { runClaimVerificationPanel } from "@/lib/verification/runClaimVerificationPanel";
import { parsedModelVerificationFromObject } from "@/lib/verification/parseVerificationJson";
import { cleanJsonResponse, repairTruncatedJson } from "@/lib/verification/cleanJsonResponse";
import type { ModelVerdict } from "@/lib/verification/parseVerificationJson";
import { computeClaimVerdict } from "@/lib/verification/claimVerdict";
import { computeConsensusScoring } from "@/lib/verification/consensusScoring";
import { buildAgreementDisagreementDigest } from "@/lib/verification/agreementDigest";
import { buildClaimVerificationAuditBundle } from "@/lib/verification/auditBundle";
import { saveClaimVerification, type ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { incrementUserTokenUsage } from "@/lib/firestore/userTokens";
import { logger } from "@/lib/logger";
import { adminDb } from "@/lib/firebase/admin";
import type { UserProfile } from "@/lib/types";
import { applyTeamGovernancePipeline, mergeGovernanceIntoBody } from "@/lib/governance/teamGovernancePipeline";
import { evaluateAndStoreGovernance } from "@/lib/governance/evaluateAndStore";
import type { GovernanceInput } from "@/lib/governance/evaluateGovernance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_MODELS = 2;
const MAX_CLAIM_LEN = 2000;

const DEFAULT_MODELS: ModelId[] = ["claude", "chatgpt", "gemini", "grok", "perplexity"];

const ALL_MODELS: Set<ModelId> = new Set([
  "chatgpt",
  "claude",
  "grok",
  "perplexity",
  "gemini",
]);

function isConnectorSuccess(r: ModelResult): boolean {
  return r.status === "ok" || r.status === "substituted";
}

function totalTokensFromResult(result: ModelResult): number {
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

export async function POST(req: NextRequest) {
  try {
    let uid: string;
    try {
      const auth = await verifySessionCookie(req);
      if (auth) {
        uid = auth.uid;
      } else {
        const authHeader = req.headers.get("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return NextResponse.json(
            { ok: false, errorCode: "unauthorized", message: "Please sign in to verify a claim." },
            { status: 401 }
          );
        }
        const token = authHeader.split("Bearer ")[1];
        const decodedToken = await verifyIdToken(token);
        uid = decodedToken.uid;
      }
    } catch (authError: any) {
      logger.error("[verify-claim] Authentication error", { error: authError?.message });
      return NextResponse.json(
        { ok: false, errorCode: "unauthorized", message: "Please sign in to verify a claim." },
        { status: 401 }
      );
    }

    const { checkRateLimit } = await import("@/lib/security/rateLimit");
    const rateLimitResult = await checkRateLimit({
      maxRequests: 30,
      windowSeconds: 60,
      identifier: `verify-claim:${uid}`,
    });
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: "rate_limit_exceeded",
          message: "Too many verification requests. Please wait before trying again.",
        },
        { status: 429 }
      );
    }

    let body: { claim?: string; models?: string[] };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, errorCode: "invalid_request", message: "Invalid request format." },
        { status: 400 }
      );
    }

    const claimRaw = typeof body.claim === "string" ? body.claim.trim() : "";
    if (!claimRaw) {
      return NextResponse.json(
        { ok: false, errorCode: "invalid_claim", message: "Please paste a claim to verify." },
        { status: 400 }
      );
    }
    if (claimRaw.length > MAX_CLAIM_LEN) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: "claim_too_long",
          message: `Claim must be at most ${MAX_CLAIM_LEN} characters.`,
        },
        { status: 400 }
      );
    }

    let selectedModels: ModelId[] = DEFAULT_MODELS;
    if (Array.isArray(body.models) && body.models.length > 0) {
      selectedModels = body.models.filter((m): m is ModelId => ALL_MODELS.has(m as ModelId));
    }
    if (selectedModels.length < MIN_MODELS) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: "not_enough_models",
          message: `Select at least ${MIN_MODELS} models.`,
        },
        { status: 400 }
      );
    }

    try {
      await validateUserSubscription(uid);
    } catch (e: any) {
      logger.warn("[verify-claim] Subscription validation failed (non-blocking)", { error: e?.message });
    }

    const usage = await checkAndIncrementUsageForRun(uid, selectedModels.length);
    if (!usage.allowed) {
      if (usage.reason === "MODEL_LIMIT") {
        return NextResponse.json(
          {
            ok: false,
            errorCode: "PLAN_MODEL_LIMIT_REACHED",
            message: `Your plan allows up to ${usage.maxModelsPerRun} models per run.`,
            maxModelsPerRun: usage.maxModelsPerRun,
          },
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

    const modelResults = await runClaimVerificationPanel(claimRaw, selectedModels, apiKeys);

    type EvRow = {
      modelId: string;
      status: "ok" | "parse_error" | "failed";
      verdict: string;
      confidence: string;
      summary: string;
      correctParts: string[];
      incorrectParts: string[];
      unverifiableParts: string[];
    };

    const modelEvidence: EvRow[] = modelResults.map((r) => {
      if (!isConnectorSuccess(r)) {
        return {
          modelId: r.modelId,
          status: "failed" as const,
          verdict: "failed",
          confidence: "low",
          summary: r.errorMessage || "Model request failed.",
          correctParts: [] as string[],
          incorrectParts: [] as string[],
          unverifiableParts: [] as string[],
        };
      }
      const modelId = r.modelId;
      const rawText = r.rawText ?? "";
      logger.debug(`[verify-claim] Raw response from ${modelId}`, { length: rawText.length });

      const cleaned = cleanJsonResponse(rawText);
      const trimmedRaw = rawText.trim();
      if (cleaned !== trimmedRaw) {
        logger.debug(
          `[verify-claim] Cleaned JSON response for ${modelId}`,
          { removedChars: rawText.length - cleaned.length }
        );
      }
      let d: ReturnType<typeof parsedModelVerificationFromObject>;
      try {
        const obj = JSON.parse(cleaned) as Record<string, unknown>;
        d = parsedModelVerificationFromObject(obj);
      } catch {
        try {
          const repaired = repairTruncatedJson(cleaned);
          const obj = JSON.parse(repaired) as Record<string, unknown>;
          d = parsedModelVerificationFromObject(obj);
          logger.debug(`[verify-claim] Repaired truncated JSON for ${modelId}`);
        } catch {
          logger.error(
            `[verify-claim] JSON parse failed even after repair for ${modelId}`,
            { cleanedPreview: cleaned.substring(0, 100) }
          );
          return {
            modelId,
            status: "parse_error" as const,
            verdict: "parse_error",
            confidence: "low",
            summary: "Model returned invalid JSON; could not parse verification result.",
            correctParts: [],
            incorrectParts: [],
            unverifiableParts: ["Non-JSON or malformed response"],
          };
        }
      }
      return {
        modelId,
        status: "ok" as const,
        verdict: d.verdict,
        confidence: d.confidence,
        summary: d.summary,
        correctParts: d.correctParts,
        incorrectParts: d.incorrectParts,
        unverifiableParts: d.unverifiableParts,
      };
    });

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
      modelEvidence.map((m) => ({
        modelId: m.modelId,
        correctParts: m.correctParts,
        incorrectParts: m.incorrectParts,
      }))
    );

    const aggregateSummary = {
      totalModels: modelEvidence.length,
      modelsAgreeAccurate: modelEvidence.filter((m) => m.verdict === "accurate").length,
      modelsAgreeInaccurate: modelEvidence.filter((m) => m.verdict === "inaccurate").length,
      modelsPartial: modelEvidence.filter((m) => m.verdict === "partially_accurate").length,
      modelsUnverifiable: modelEvidence.filter(
        (m) =>
          m.verdict === "unverifiable" || m.verdict === "parse_error" || m.verdict === "failed"
      ).length,
    };

    const auditBundle = buildClaimVerificationAuditBundle({
      claimLength: claimRaw.length,
      modelEvidence,
      verdict,
      consensusScore,
      confidenceLabel,
      evidenceQuality: consensusSummary.evidenceQuality,
    });

    const verificationId = `vcl-${randomUUID()}`;

    let orgGovernanceStatus: "approved" | "needs_review" | "blocked" | undefined;

    try {
      const verificationDoc: Omit<ClaimVerificationFirestoreDoc, "timestamp"> = {
        userId: uid,
        claim: claimRaw.slice(0, MAX_CLAIM_LEN),
        type: "claim_verification",
        verdict,
        consensusScore,
        confidenceLabel,
        evidenceQuality: consensusSummary.evidenceQuality,
        supportRatio: consensusSummary.supportRatio,
        modelResults: modelEvidence,
        auditBundle,
        selectedModels,
      };
      await saveClaimVerification(
        verificationId,
        sanitizeForFirestore(verificationDoc) as Omit<ClaimVerificationFirestoreDoc, "timestamp">
      );

      const governanceConsensusScore =
        typeof consensusScore === "number" && !Number.isNaN(consensusScore)
          ? consensusScore
          : typeof consensusSummary.overallConsensusScore === "number" &&
              !Number.isNaN(consensusSummary.overallConsensusScore)
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
      {
        const evidenceQuality = consensusSummary.evidenceQuality;
        logger.debug("[verify-claim] Governance input being sent", {
          consensusScore,
          evidenceQuality,
          verdict,
        });
      }
      try {
        const govResult = await evaluateAndStoreGovernance({
          runId: verificationId,
          collection: "verifications",
          input: verificationGovernanceInput,
          ownerUid: uid,
        });
        if (govResult) orgGovernanceStatus = govResult.governanceStatus;
      } catch (govErr: unknown) {
        logger.error("[governance] Verification evaluation failed", {
          error: (govErr as Error)?.message,
        });
      }
    } catch (fsErr: any) {
      logger.error("[verify-claim] Firestore save failed", { error: fsErr?.message });
    }

    let totalTokens = 0;
    for (const r of modelResults) {
      totalTokens += totalTokensFromResult(r);
    }
    try {
      await incrementUserTokenUsage(uid, totalTokens);
    } catch (tokErr: any) {
      logger.warn("[verify-claim] Token increment failed", { error: tokErr?.message });
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
      query: claimRaw,
      verdict,
      auditBundle,
      verificationId,
    });

    const responsePayload = mergeGovernanceIntoBody(
      {
        ok: true,
        verificationId,
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
    logger.error("[verify-claim] Unexpected error", { error: err?.message, stack: err?.stack });
    return NextResponse.json(
      {
        ok: false,
        errorCode: "internal_error",
        message: "Server error. Please try again.",
        ...(process.env.NODE_ENV !== "production" ? { devDetails: err?.message } : {}),
      },
      { status: 500 }
    );
  }
}
