/**
 * POST `/api/verify-video` — multi-model video authenticity pipeline (Node runtime).
 *
 * Flow:
 * 1. **Auth** — session cookie or `Authorization: Bearer` ID token (same pattern as claim verification).
 * 2. **Rate limit** — per-user window for abuse protection.
 * 3. **Plan** — free plan blocked; paid limits from `getVideoLimit` (e.g. lite 5 / full 20 per calendar month).
 * 4. **Video quota** — compare `videoRunsThisMonth` to limit; month rollover treats stale counts as 0 for this check.
 * 5. **Parse body** — `request.text()` then `JSON.parse`; reject empty, multipart, and invalid JSON with clear errors.
 * 6. **Validate** — metadata (duration 0–60s, size ≤50MB), frames (1–15, required base64, per-frame and total payload caps).
 * 7. **Analyze metadata** — `analyzeMetadata` for heuristic flags.
 * 8. **Prompt** — `buildVideoVerificationPrompt`.
 * 9. **Vision** — `Promise.all` parallel calls to OpenAI, Claude, Gemini; parse JSON via `cleanJsonResponse` / `repairTruncatedJson`.
 * 10. **Verdict** — majority rules on five video verdicts (plus legacy model output `authentic` counted as `authentic_captured`); governance maps to claim-style labels.
 * 11. **Consensus score** — base = dominant fraction × 100; penalties for suspicious metadata (−10), &lt;3 usable models (−15), &gt;2 client warnings (−5).
 * 12. **Firestore** — write to `videoVerifications`: **no** frame blobs or base64; only metadata, flags, trimmed model text fields, counts.
 * 13. **Panel usage** — `checkAndIncrementUsageForRun` (counts toward monthly panel runs).
 * 14. **Governance** — map video verdict to claim-like labels for the policy engine (`videoVerifications` collection).
 * 15. **Video usage counter** — increment `videoRunsThisMonth` **after** successful Firestore save; align `usageMonth` on calendar rollover so increments do not stack on a previous month.
 * 16. **Tokens** — `incrementUserTokenUsage` for cost tracking.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { getVideoLimit } from "@/lib/billing/planConfig";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { incrementUserTokenUsage } from "@/lib/firestore/userTokens";
import { evaluateAndStoreGovernance } from "@/lib/governance/evaluateAndStore";
import { mapStoredVideoVerificationToClientPayload } from "@/lib/user/mapStoredVideoVerificationToClientPayload";
import { logger } from "@/lib/logger";

import type { ExtractedFrame, VideoMetadata } from "@/lib/video/videoPure";
import { analyzeMetadata } from "@/lib/video/videoPure";
import { executeVideoVerification, VIDEO_VISION_MODEL_COUNT } from "@/lib/video/videoVerificationExecution";
import { VIDEO_VERIFICATION_DISCLAIMER } from "@/lib/legal/videoVerificationDisclaimer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_FRAMES = 15;
const MAX_BASE64_CHARS_PER_FRAME = 900_000;
const MAX_TOTAL_BASE64_CHARS = 12_000_000;
const DEDUP_WINDOW_MS = 30_000;

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  // Auth Identity Consistency Remediation, Step 7 — resolves via the
  // shared, hardened resolver (considers cookie AND bearer, fails closed
  // on a confirmed identity mismatch) rather than this route's own
  // duplicated cookie-first logic. Video verification business logic
  // below (upload handling, vision-model dispatch, verdict computation,
  // quota, token accounting, audit) is completely untouched — only
  // identity resolution changed. `authEmail` (a rare fallback used only
  // when Firestore's own `users/{uid}.email` is ALSO absent — see line
  // ~214) is now always "", matching what the cookie-authenticated path
  // already did in every common case; the shared resolver does not
  // expose the bearer token's own claims back to callers.
  const identity = await resolveRequestIdentity(request);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: "POST /api/verify-video", method: "POST", failureCategory: identity.reason });
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Please sign in to verify a video." } },
      { status: 401 }
    );
  }
  const uid = identity.uid;
  const authEmail = "";

  if (!adminDb) {
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable." } },
      { status: 500 }
    );
  }

  const { checkRateLimit } = await import("@/lib/security/rateLimit");
  const rateLimitResult = await checkRateLimit({
    maxRequests: 10,
    windowSeconds: 60,
    identifier: `verify-video:${uid}`,
  });
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "rate_limit_exceeded",
          message: "Too many video verification requests. Please wait before trying again.",
        },
      },
      { status: 429 }
    );
  }

  const entitlements = await getEffectiveEntitlements(uid);
  const plan = entitlements.planId;

  const userDoc = await adminDb.collection("users").doc(uid).get();
  const userData = userDoc.data() as Record<string, unknown> | undefined;
  const userEmail =
    (typeof userData?.email === "string" ? userData.email : null)?.trim() || authEmail || "";

  if (plan === "free") {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "plan_required",
          message: "Video verification is not available on the free plan. Upgrade to verify video content.",
        },
      },
      { status: 403 }
    );
  }

  const storedUsageMonth =
    typeof userData?.usageMonth === "string" ? userData.usageMonth.trim() : "";
  const nowMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  let videoRunsThisMonth =
    typeof userData?.videoRunsThisMonth === "number" ? userData.videoRunsThisMonth : 0;
  if (storedUsageMonth && storedUsageMonth !== nowMonth) {
    videoRunsThisMonth = 0;
  }
  const videoLimit = getVideoLimit(plan);

  if (videoLimit > 0 && videoRunsThisMonth >= videoLimit) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "video_limit_reached",
          message: `You've used all ${videoLimit} video verifications this calendar month. Resets on the first day of next month.`,
        },
      },
      { status: 429 }
    );
  }

  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "invalid_request", message: "Could not read request body." },
      },
      { status: 400 }
    );
  }

  if (!rawBody.trim()) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "invalid_request", message: "Empty body. Send JSON with frames and metadata." },
      },
      { status: 400 }
    );
  }

  if (contentType.includes("multipart/form-data") || rawBody.trimStart().startsWith("--")) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "invalid_request",
          message:
            "Multipart upload is not supported. Extract frames in the browser and POST application/json with frames, metadata, and warnings.",
        },
      },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "invalid_request",
          message:
            "Body is not valid JSON. Use Content-Type: application/json and a JSON object with frames, metadata, and warnings.",
        },
      },
      { status: 400 }
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_request", message: "Invalid request body." } },
      { status: 400 }
    );
  }

  const payload = body as Record<string, unknown>;
  const framesIn = payload.frames;
  const clientMetaRaw = payload.metadata;
  const clientWarningsIn = payload.warnings;

  if (!Array.isArray(framesIn) || framesIn.length === 0) {
    return NextResponse.json(
      { ok: false, error: { code: "no_frames", message: "No video frames provided." } },
      { status: 400 }
    );
  }

  if (framesIn.length > MAX_FRAMES) {
    return NextResponse.json(
      { ok: false, error: { code: "too_many_frames", message: "Maximum 15 frames allowed." } },
      { status: 400 }
    );
  }

  if (!clientMetaRaw || typeof clientMetaRaw !== "object") {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_metadata", message: "Invalid video metadata." } },
      { status: 400 }
    );
  }

  const cm = clientMetaRaw as Record<string, unknown>;
  const duration = typeof cm.duration === "number" && Number.isFinite(cm.duration) ? cm.duration : 0;
  const vw = typeof cm.width === "number" && Number.isFinite(cm.width) ? cm.width : 0;
  const vh = typeof cm.height === "number" && Number.isFinite(cm.height) ? cm.height : 0;
  const fileSize = typeof cm.fileSize === "number" && Number.isFinite(cm.fileSize) ? cm.fileSize : 0;
  const fileName =
    typeof cm.fileName === "string" && cm.fileName.trim() ? cm.fileName.trim() : "upload.mp4";

  if (!(duration > 0)) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_metadata", message: "Invalid video metadata." } },
      { status: 400 }
    );
  }

  if (duration > 60) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_metadata", message: "Video must be 60 seconds or shorter." } },
      { status: 400 }
    );
  }

  if (fileSize > 50 * 1024 * 1024) {
    return NextResponse.json(
      { ok: false, error: { code: "file_too_large", message: "Video must be under 50MB." } },
      { status: 400 }
    );
  }

  const clientWarnings: string[] = Array.isArray(clientWarningsIn)
    ? clientWarningsIn.filter((w): w is string => typeof w === "string")
    : [];

  const frames: ExtractedFrame[] = [];
  let totalB64 = 0;

  for (let i = 0; i < framesIn.length; i++) {
    const row = framesIn[i];
    if (!row || typeof row !== "object") {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "invalid_frame", message: "Each frame must be an object with base64 data." },
        },
        { status: 400 }
      );
    }
    const fr = row as Record<string, unknown>;
    let b64 = typeof fr.base64 === "string" ? fr.base64.trim() : "";
    if (!b64) {
      return NextResponse.json(
        { ok: false, error: { code: "invalid_frame", message: "Each frame must include base64 data." } },
        { status: 400 }
      );
    }
    if (b64.startsWith("data:")) {
      const idx = b64.indexOf("base64,");
      b64 = idx >= 0 ? b64.slice(idx + 7) : b64;
    }
    if (b64.length > MAX_BASE64_CHARS_PER_FRAME) {
      return NextResponse.json(
        { ok: false, error: { code: "frame_too_large", message: "A frame payload is too large." } },
        { status: 400 }
      );
    }
    totalB64 += b64.length;
    const ts = typeof fr.timestamp === "number" && Number.isFinite(fr.timestamp) ? fr.timestamp : i;
    const fw = typeof fr.width === "number" && Number.isFinite(fr.width) ? fr.width : vw;
    const fh = typeof fr.height === "number" && Number.isFinite(fr.height) ? fr.height : vh;
    frames.push({ index: frames.length, timestamp: ts, base64: b64, width: fw, height: fh });
  }

  if (totalB64 > MAX_TOTAL_BASE64_CHARS) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "payload_too_large", message: "Combined frame data exceeds the limit." },
      },
      { status: 413 }
    );
  }

  const fileType = typeof cm.fileType === "string" ? cm.fileType : "";
  const formatPart = fileType.includes("/") ? fileType.split("/")[1] || "mp4" : "mp4";

  const codecIn =
    typeof cm.codec === "string" && cm.codec.trim() ? cm.codec.trim() : "unknown";
  const frameRateIn =
    typeof cm.frameRate === "number" && Number.isFinite(cm.frameRate) && cm.frameRate > 0
      ? cm.frameRate
      : 0;
  const createdAtIn =
    typeof cm.createdAt === "string" && cm.createdAt.trim() ? cm.createdAt.trim() : null;
  const encodingSoftwareIn =
    typeof cm.encodingSoftware === "string" && cm.encodingSoftware.trim()
      ? cm.encodingSoftware.trim()
      : null;
  const hasAudioIn = cm.hasAudio === true;
  const cameraModelIn =
    typeof cm.cameraModel === "string" && cm.cameraModel.trim() ? cm.cameraModel.trim() : null;

  const metadata: VideoMetadata = {
    duration,
    width: vw,
    height: vh,
    codec: codecIn,
    frameRate: frameRateIn,
    fileSize,
    format: formatPart,
    createdAt: createdAtIn,
    encodingSoftware: encodingSoftwareIn,
    hasAudio: hasAudioIn,
    cameraModel: cameraModelIn,
  };

  const allWarnings = [...clientWarnings];

  logger.debug(`[verify-video] Parsed request`, {
    frames: frames.length,
    duration,
    base64Mb: (totalB64 / 1e6).toFixed(2),
  });

  // --- Deduplication: reject if the same user submitted the same file within the last 30 seconds ---
  // Uses equality-only filters (no orderBy) to avoid requiring a composite index.
  try {
    const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
    const recentSnap = await adminDb
      .collection("videoVerifications")
      .where("userId", "==", uid)
      .where("fileName", "==", fileName)
      .get();

    const sortedDocs = recentSnap.docs.sort((a, b) => {
      const aTs = a.data().timestamp;
      const bTs = b.data().timestamp;
      const aMs = aTs && typeof aTs.toMillis === "function" ? aTs.toMillis() : 0;
      const bMs = bTs && typeof bTs.toMillis === "function" ? bTs.toMillis() : 0;
      return bMs - aMs;
    });

    if (sortedDocs.length > 0) {
      const recentDoc = sortedDocs[0];
      const recentData = recentDoc.data() as Record<string, unknown>;
      const ts = recentData.timestamp;
      let recentMs = 0;
      if (ts && typeof ts === "object" && "toMillis" in ts && typeof (ts as { toMillis: () => number }).toMillis === "function") {
        recentMs = (ts as { toMillis: () => number }).toMillis();
      }
      const meta = recentData.metadata as Record<string, unknown> | undefined;
      const recentFileSize =
        typeof meta?.fileSize === "number" ? meta.fileSize : -1;
      const recentDuration =
        typeof meta?.duration === "number" ? meta.duration : -1;

      if (
        recentMs > 0 &&
        new Date(recentMs) > cutoff &&
        recentFileSize === fileSize &&
        Math.abs(recentDuration - duration) < 0.5
      ) {
        logger.info(`[verify-video] Duplicate submission detected, returning cached result`, {
          docId: recentDoc.id,
          ageMs: Date.now() - recentMs,
        });
        const existing = mapStoredVideoVerificationToClientPayload(recentDoc.id, recentData);
        return NextResponse.json({
          ok: true,
          verificationId: existing.verificationId,
          verdict: existing.verdict,
          contentType: existing.contentType,
          consensusScore: existing.consensusScore,
          confidenceLabel: existing.confidenceLabel,
          evidenceQuality: existing.evidenceQuality,
          supportRatio: existing.supportRatio,
          metadata: existing.metadata,
          metadataAnalysis: existing.metadataAnalysis,
          modelEvidence: existing.modelEvidence,
          agreementPoints: existing.agreementPoints,
          disagreementPoints: existing.disagreementPoints,
          frameCount: existing.frameCount,
          warnings: existing.warnings,
          disclaimer: VIDEO_VERIFICATION_DISCLAIMER,
          _deduplicated: true,
        });
      }
    }
  } catch (dedupErr) {
    // Dedup is best-effort — a transient Firestore error should not block the request.
    logger.warn("[verify-video] Dedup check failed, proceeding without dedup", {
      error: (dedupErr as Error)?.message,
    });
  }

  const { checkUsageAllowanceForRun, checkAndIncrementUsageForRun } = await import("@/lib/stripe/usageCheck");
  const usagePrecheck = await checkUsageAllowanceForRun(uid, 2);
  if (!usagePrecheck.allowed) {
    if (usagePrecheck.reason === "MODEL_LIMIT") {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "model_limit",
            message: `Your plan allows up to ${usagePrecheck.maxModelsPerRun} models per run.`,
          },
        },
        { status: 403 }
      );
    }
    if (usagePrecheck.reason === "RUN_LIMIT") {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "run_limit_reached",
            message:
              "You've reached your monthly panel run limit. Each video verification also uses one run from your monthly allowance.",
            runsUsed: usagePrecheck.runsThisMonth,
            runsLimit: usagePrecheck.maxRunsPerMonth,
            resetsAt: usagePrecheck.resetsAt.toISOString(),
          },
        },
        { status: 429 }
      );
    }
  }

  const metadataAnalysis = analyzeMetadata(metadata);
  logger.debug(`[verify-video] Metadata analysis`, {
    flags: metadataAnalysis.flags.length,
    suspicious: metadataAnalysis.flags.filter((f) => f.severity === "suspicious").length,
  });

  // Phase 8C-E.3.1B — pure Video analysis (prompt, 3-provider dispatch,
  // parse/repair, aggregation) extracted to lib/video/videoVerificationExecution.ts.
  // Everything before this call and everything after it is unchanged route logic.
  const {
    modelResults,
    aggregateVerdict,
    aggregateContentType,
    consensusScore,
    confidenceLabel,
    evidenceQuality,
    supportRatio,
    agreementPoints,
    disagreementPoints,
    verdictCounts,
    totalTokens,
  } = await executeVideoVerification(frames, metadata, metadataAnalysis, allWarnings);

  const verificationId = `vid-${randomUUID()}`;

  const resultDoc = {
    userId: uid,
    userEmail,
    type: "video_verification",
    fileName,
    verdict: aggregateVerdict,
    contentType: aggregateContentType,
    consensusScore,
    confidenceLabel,
    evidenceQuality,
    supportRatio: Math.round(supportRatio * 100),
    metadata,
    metadataAnalysis: {
      flags: metadataAnalysis.flags,
      summary: metadataAnalysis.summary,
    },
    modelResults: modelResults.map((m) => ({
      modelId: m.modelId,
      modelName: m.modelName,
      status: m.status,
      verdict: m.verdict,
      confidence: m.confidence,
      contentType: m.contentType,
      summary: m.summary,
      visualIndicators: (m.visualIndicators || []).slice(0, 10),
      metadataIndicators: (m.metadataIndicators || []).slice(0, 5),
      manipulationSignals: (m.manipulationSignals || []).slice(0, 10),
      authenticitySignals: (m.authenticitySignals || []).slice(0, 10),
      productionSignals: (m.productionSignals || []).slice(0, 10),
      deceptionIndicators: (m.deceptionIndicators || []).slice(0, 10),
      compressionNotes: (m.compressionNotes || []).slice(0, 5),
      limitations: (m.limitations || []).slice(0, 5),
    })),
    agreementPoints,
    disagreementPoints,
    frameCount: frames.length,
    warnings: allWarnings,
    totalTokens,
    timestamp: FieldValue.serverTimestamp(),
  };

  try {
    await adminDb
      .collection("videoVerifications")
      .doc(verificationId)
      .set(sanitizeForFirestore(resultDoc) as DocumentData);
    logger.info(`[verify-video] Result stored`, { verificationId });
  } catch (err) {
    logger.error("[verify-video] Firestore save failed", { error: (err as Error)?.message });
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "storage_failed",
          message: "Could not save verification results. Your monthly usage was not charged. Please try again.",
        },
      },
      { status: 500 }
    );
  }

  const usageCharge = await checkAndIncrementUsageForRun(uid, 2);
  if (!usageCharge.allowed) {
    logger.warn("[verify-video] Panel run increment denied after successful save (concurrent limit race)", {
      uid,
      reason: usageCharge.reason,
    });
  }

  // Map video labels to claim-style verdicts expected by governance / policy helpers.
  const govVerdict =
    aggregateVerdict === "likely_manipulated"
      ? "disputed"
      : aggregateVerdict === "inconclusive"
        ? "unverifiable"
        : aggregateVerdict === "authentic_captured"
          ? "confirmed"
          : aggregateVerdict === "authentic_produced"
            ? "confirmed"
            : aggregateVerdict === "authentic"
              ? "confirmed"
              : "unverifiable";

  try {
    await evaluateAndStoreGovernance({
      runId: verificationId,
      collection: "videoVerifications",
      ownerUid: uid,
      input: {
        consensusScore,
        evidenceQuality,
        sourceBacked: false,
        missingSourcesCount: 0,
        modelHealth: {
          ok: modelResults.filter((r) => r.status === "ok").length,
          substituted: 0,
          failed: modelResults.filter((r) => r.status !== "ok").length,
        },
        question: `Video verification: ${fileName} (${metadata.duration}s, ${metadata.width}x${metadata.height})`,
        runType: "verification",
        verificationVerdict: govVerdict,
      },
    });
    logger.debug(`[verify-video] Governance evaluation complete`);
  } catch (err) {
    logger.error("[verify-video] Governance evaluation failed", { error: (err as Error)?.message });
    try {
      await adminDb.collection("failed_governance_audits").add({
        runId: verificationId,
        collection: "videoVerifications",
        ownerUid: uid,
        failedAt: FieldValue.serverTimestamp(),
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (writeErr) {
      logger.error("[verify-video] Failed to write governance failure record", { error: (writeErr as Error)?.message });
    }
  }

  try {
    const userRef = adminDb.collection("users").doc(uid);
    await adminDb.runTransaction(async (txn) => {
      const snap = await txn.get(userRef);
      const data = snap.data();
      const storedMonth =
        typeof data?.usageMonth === "string" ? data.usageMonth.trim() : "";
      const monthRolled = storedMonth !== nowMonth;
      txn.set(
        userRef,
        monthRolled
          ? { usageMonth: nowMonth, videoRunsThisMonth: 1, updatedAt: FieldValue.serverTimestamp() }
          : { videoRunsThisMonth: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    });
    logger.debug(`[verify-video] Video usage counter incremented`);
  } catch (err) {
    logger.error("[verify-video] Video usage increment failed", { error: (err as Error)?.message });
  }

  try {
    await incrementUserTokenUsage(uid, totalTokens);
  } catch (err) {
    logger.warn("[verify-video] Token increment failed", { error: (err as Error)?.message });
  }

  const totalElapsed = Date.now() - startTime;
  logger.info(`[verify-video] Complete`, { elapsedMs: totalElapsed, verdict: aggregateVerdict, consensusScore });

  return NextResponse.json({
    ok: true,
    verificationId,
    verdict: aggregateVerdict,
    contentType: aggregateContentType,
    consensusScore,
    confidenceLabel,
    evidenceQuality,
    supportRatio: Math.round(supportRatio * 100),
    metadata,
    metadataAnalysis,
    modelEvidence: modelResults.map((m) => ({
      modelId: m.modelId,
      modelName: m.modelName,
      status: m.status,
      verdict: m.verdict,
      confidence: m.confidence,
      contentType: m.contentType,
      summary: m.summary,
      visualIndicators: m.visualIndicators,
      metadataIndicators: m.metadataIndicators,
      manipulationSignals: m.manipulationSignals,
      authenticitySignals: m.authenticitySignals,
      productionSignals: m.productionSignals,
      deceptionIndicators: m.deceptionIndicators,
      compressionNotes: m.compressionNotes,
      limitations: m.limitations,
    })),
    agreementPoints,
    disagreementPoints,
    aggregateSummary: {
      totalModels: VIDEO_VISION_MODEL_COUNT,
      modelsAuthenticCaptured: verdictCounts.authentic_captured,
      modelsAuthenticProduced: verdictCounts.authentic_produced,
      modelsAuthentic: verdictCounts.authentic_captured + verdictCounts.authentic_produced,
      modelsManipulated: verdictCounts.likely_manipulated,
      modelsInconclusive: verdictCounts.inconclusive,
      modelsInsufficient: verdictCounts.insufficient,
    },
    frameCount: frames.length,
    warnings: allWarnings,
    disclaimer: VIDEO_VERIFICATION_DISCLAIMER,
  });
}
