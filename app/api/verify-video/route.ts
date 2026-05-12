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
import { FieldValue, type DocumentData } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { getVideoLimit } from "@/lib/billing/planConfig";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { incrementUserTokenUsage } from "@/lib/firestore/userTokens";
import { cleanJsonResponse, repairTruncatedJson } from "@/lib/verification/cleanJsonResponse";
import { evaluateAndStoreGovernance } from "@/lib/governance/evaluateAndStore";
import { mapStoredVideoVerificationToClientPayload } from "@/lib/user/mapStoredVideoVerificationToClientPayload";
import { logger } from "@/lib/logger";

import type { ExtractedFrame, VideoMetadata } from "@/lib/video/videoPure";
import { analyzeMetadata } from "@/lib/video/videoPure";
import { buildVideoVerificationPrompt } from "@/lib/video/videoVerificationPrompt";
import { callOpenAIVision, callClaudeVision, callGeminiVision } from "@/lib/video/visionCalls";
import { VIDEO_VERIFICATION_DISCLAIMER } from "@/lib/legal/videoVerificationDisclaimer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_FRAMES = 15;
const MAX_BASE64_CHARS_PER_FRAME = 900_000;
const MAX_TOTAL_BASE64_CHARS = 12_000_000;
const DEDUP_WINDOW_MS = 30_000;

const KNOWN_MODEL_VIDEO_VERDICTS = new Set([
  "authentic_captured",
  "authentic_produced",
  "likely_manipulated",
  "inconclusive",
  "insufficient",
  "authentic",
]);

const KNOWN_VIDEO_CONTENT_TYPES = new Set([
  "camera_footage",
  "animation",
  "screen_recording",
  "ai_generated_creative",
  "ai_generated_deceptive",
  "mixed",
  "unknown",
]);

function normalizeModelVideoVerdict(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, "_") : "";
  if (KNOWN_MODEL_VIDEO_VERDICTS.has(s)) return s;
  return "inconclusive";
}

function normalizeVideoContentType(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, "_") : "";
  if (KNOWN_VIDEO_CONTENT_TYPES.has(s)) return s;
  return "unknown";
}

const MODEL_REFUSAL_PATTERNS = [
  "I'm sorry",
  "I cannot assist",
  "I can't assist",
  "I'm unable to",
  "I cannot help",
  "I can't help",
  "not able to analyze",
  "cannot process this",
  "against my guidelines",
  "content policy",
] as const;

function isVisionModelRefusalResponse(text: string): boolean {
  const t = text.trim().toLowerCase();
  return MODEL_REFUSAL_PATTERNS.some((p) => t.includes(p.toLowerCase()));
}

function refusedModelRow(
  model: { id: string; name: string },
  responseText: string,
  tokens: number | undefined
): VisionModelRow {
  console.log(`[verify-video] ${model.id} refused to analyze: ${responseText.substring(0, 100)}`);
  return {
    modelId: model.id,
    modelName: model.name,
    status: "refused",
    verdict: "inconclusive",
    confidence: "low",
    contentType: "unknown",
    summary: "Model declined to analyze this content due to content policy restrictions.",
    visualIndicators: [],
    metadataIndicators: [],
    manipulationSignals: [],
    authenticitySignals: [],
    productionSignals: [],
    deceptionIndicators: [],
    compressionNotes: [],
    limitations: ["Model content policy prevented analysis of these frames."],
    reasoning: "",
    tokens,
  };
}

type VisionModelRow = {
  modelId: string;
  modelName: string;
  status: "ok" | "refused" | "parse_error" | "error";
  verdict: string;
  confidence: string;
  contentType: string;
  summary: string;
  visualIndicators: string[];
  metadataIndicators: string[];
  manipulationSignals: string[];
  authenticitySignals: string[];
  productionSignals: string[];
  deceptionIndicators: string[];
  compressionNotes: string[];
  limitations: string[];
  reasoning: string;
  tokens?: number;
};

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  let uid: string;
  let authEmail = "";
  // Same session-cookie-first, Bearer-fallback pattern as verify-claim routes.
  try {
    const auth = await verifySessionCookie(request);
    if (auth) {
      uid = auth.uid;
    } else {
      const authHeader = request.headers.get("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return NextResponse.json(
          { ok: false, error: { code: "unauthorized", message: "Please sign in to verify a video." } },
          { status: 401 }
        );
      }
      const token = authHeader.split("Bearer ")[1];
      const decodedToken = await verifyIdToken(token);
      uid = decodedToken.uid;
      authEmail = decodedToken.email || "";
    }
  } catch (authError: unknown) {
    const authMsg = authError instanceof Error ? authError.message : String(authError);
    logger.error("[verify-video] Authentication error", { error: authMsg });
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Please sign in to verify a video." } },
      { status: 401 }
    );
  }

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

  console.log(
    `[verify-video] JSON: ${fileName}, ${frames.length} frames, ${duration}s, ~${(totalB64 / 1e6).toFixed(2)}MB base64`
  );

  // --- Deduplication: reject if the same user submitted the same file within the last 30 seconds ---
  try {
    const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
    const recentSnap = await adminDb
      .collection("videoVerifications")
      .where("userId", "==", uid)
      .where("fileName", "==", fileName)
      .orderBy("timestamp", "desc")
      .limit(1)
      .get();

    if (!recentSnap.empty) {
      const recentDoc = recentSnap.docs[0];
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
        console.log(
          `[verify-video] Duplicate submission detected for ${fileName} (existing doc ${recentDoc.id}, ${Date.now() - recentMs}ms ago). Returning existing result.`
        );
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
    console.error("[verify-video] Dedup check failed, denying request:", dedupErr);
    return NextResponse.json(
      { ok: false, error: { code: "service_error", message: "Could not process request. Please try again." } },
      { status: 503 }
    );
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
  console.log(
    `[verify-video] Metadata flags: ${metadataAnalysis.flags.length} (${metadataAnalysis.flags.filter((f) => f.severity === "suspicious").length} suspicious)`
  );

  const prompt = buildVideoVerificationPrompt(metadata, metadataAnalysis, frames.length);

  const visionModels = [
    { id: "chatgpt", name: "GPT-4o", caller: callOpenAIVision },
    { id: "claude", name: "Claude", caller: callClaudeVision },
    { id: "gemini", name: "Gemini", caller: callGeminiVision },
  ];

  console.log(`[verify-video] Sending ${frames.length} frames to ${visionModels.length} vision models...`);

  const modelPromises = visionModels.map(async (model): Promise<VisionModelRow> => {
    const modelStart = Date.now();
    try {
      const response = await model.caller(prompt, frames);
      const elapsed = Date.now() - modelStart;
      console.log(`[verify-video] ${model.id} responded in ${elapsed}ms`);

      const responseText = response.text || "";
      if (isVisionModelRefusalResponse(responseText)) {
        return refusedModelRow(model, responseText, response.tokens);
      }

      let parsed: Record<string, unknown>;
      try {
        const cleaned = cleanJsonResponse(response.text);
        parsed = JSON.parse(cleaned) as Record<string, unknown>;
      } catch {
        if (isVisionModelRefusalResponse(responseText)) {
          return refusedModelRow(model, responseText, response.tokens);
        }
        try {
          const repaired = repairTruncatedJson(cleanJsonResponse(response.text));
          parsed = JSON.parse(repaired) as Record<string, unknown>;
          console.log(`[verify-video] Repaired truncated JSON for ${model.id}`);
        } catch {
          if (isVisionModelRefusalResponse(responseText)) {
            return refusedModelRow(model, responseText, response.tokens);
          }
          console.error(`[verify-video] JSON parse failed for ${model.id}:`, response.text.substring(0, 300));
          return {
            modelId: model.id,
            modelName: model.name,
            status: "parse_error",
            verdict: "insufficient",
            confidence: "low",
            contentType: "unknown",
            summary: "Model returned invalid JSON; could not parse verification result.",
            visualIndicators: [],
            metadataIndicators: [],
            manipulationSignals: [],
            authenticitySignals: [],
            productionSignals: [],
            deceptionIndicators: [],
            compressionNotes: [],
            limitations: ["Response could not be parsed"],
            reasoning: "",
            tokens: response.tokens,
          };
        }
      }

      const asStrArr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

      return {
        modelId: model.id,
        modelName: model.name,
        status: "ok",
        verdict: normalizeModelVideoVerdict(parsed.verdict),
        confidence: typeof parsed.confidence === "string" ? parsed.confidence : "low",
        contentType: normalizeVideoContentType(parsed.contentType),
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        visualIndicators: asStrArr(parsed.visualIndicators),
        metadataIndicators: asStrArr(parsed.metadataIndicators),
        manipulationSignals: asStrArr(parsed.manipulationSignals),
        authenticitySignals: asStrArr(parsed.authenticitySignals),
        productionSignals: asStrArr(parsed.productionSignals),
        deceptionIndicators: asStrArr(parsed.deceptionIndicators),
        compressionNotes: asStrArr(parsed.compressionNotes),
        limitations: asStrArr(parsed.limitations),
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
        tokens: response.tokens,
      };
    } catch (err: unknown) {
      const elapsed = Date.now() - modelStart;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[verify-video] ${model.id} failed after ${elapsed}ms:`, msg);
      return {
        modelId: model.id,
        modelName: model.name,
        status: "error",
        verdict: "insufficient",
        confidence: "low",
        contentType: "unknown",
        summary: `Model failed: ${msg}`,
        visualIndicators: [],
        metadataIndicators: [],
        manipulationSignals: [],
        authenticitySignals: [],
        productionSignals: [],
        deceptionIndicators: [],
        compressionNotes: [],
        limitations: [`Model error: ${msg}`],
        reasoning: "",
        tokens: 0,
      };
    }
  });

  const modelResults = await Promise.all(modelPromises);
  console.log(`[verify-video] All models responded. Statuses: ${modelResults.map((r) => `${r.modelId}=${r.status}`).join(", ")}`);

  const refusedCount = modelResults.filter((r) => r.status === "refused").length;
  if (refusedCount > 0) {
    console.log(
      `[verify-video] ${refusedCount} model(s) refused to analyze — excluded from consensus`
    );
  }

  const usableResults = modelResults.filter((r) => r.status === "ok");
  const totalUsable = usableResults.length;

  const verdictCounts = {
    authentic_captured: usableResults.filter((r) => r.verdict === "authentic_captured").length,
    authentic_produced: usableResults.filter((r) => r.verdict === "authentic_produced").length,
    likely_manipulated: usableResults.filter((r) => r.verdict === "likely_manipulated").length,
    inconclusive: usableResults.filter((r) => r.verdict === "inconclusive").length,
    insufficient: usableResults.filter((r) => r.verdict === "insufficient").length,
  };

  const legacyAuthentic = usableResults.filter((r) => r.verdict === "authentic").length;
  verdictCounts.authentic_captured += legacyAuthentic;

  let aggregateVerdict: string;
  if (totalUsable === 0) {
    aggregateVerdict = "insufficient";
  } else if (verdictCounts.likely_manipulated / totalUsable >= 0.67) {
    aggregateVerdict = "likely_manipulated";
  } else if (verdictCounts.authentic_captured / totalUsable >= 0.67) {
    aggregateVerdict = "authentic_captured";
  } else if (verdictCounts.authentic_produced / totalUsable >= 0.67) {
    aggregateVerdict = "authentic_produced";
  } else if (
    (verdictCounts.authentic_captured + verdictCounts.authentic_produced) / totalUsable >= 0.67
  ) {
    aggregateVerdict =
      verdictCounts.authentic_captured >= verdictCounts.authentic_produced
        ? "authentic_captured"
        : "authentic_produced";
  } else if (verdictCounts.insufficient / totalUsable >= 0.5) {
    aggregateVerdict = "insufficient";
  } else {
    aggregateVerdict = "inconclusive";
  }
  // 0.67 = 2/3 majority among models that returned parseable JSON.

  const contentTypeTally = new Map<string, number>();
  for (const r of usableResults) {
    const ct = r.contentType && r.contentType !== "unknown" ? r.contentType : null;
    if (ct) {
      contentTypeTally.set(ct, (contentTypeTally.get(ct) || 0) + 1);
    }
  }
  let aggregateContentType = "unknown";
  if (contentTypeTally.size > 0) {
    let best = "unknown";
    let bestN = 0;
    for (const [ct, n] of contentTypeTally) {
      if (n > bestN) {
        best = ct;
        bestN = n;
      }
    }
    aggregateContentType = best;
  }

  const maxAgreement = Math.max(
    verdictCounts.authentic_captured,
    verdictCounts.authentic_produced,
    verdictCounts.likely_manipulated,
    verdictCounts.inconclusive,
    verdictCounts.insufficient
  );
  const supportRatio = totalUsable > 0 ? maxAgreement / totalUsable : 0;

  let consensusScore = Math.round(supportRatio * 100);
  if (metadataAnalysis.flags.some((f) => f.severity === "suspicious")) {
    consensusScore = Math.max(0, consensusScore - 10);
  }
  if (totalUsable < 3) {
    consensusScore = Math.max(0, consensusScore - 15);
  }
  if (allWarnings.length > 2) {
    consensusScore = Math.max(0, consensusScore - 5);
  }
  // Penalties: suspicious metadata, missing model agreement, noisy client-side extraction warnings.
  consensusScore = Math.min(100, Math.max(0, consensusScore));

  const confidenceLabel = consensusScore >= 80 ? "High" : consensusScore >= 50 ? "Medium" : "Low";
  const evidenceQuality = consensusScore >= 75 ? "strong" : consensusScore >= 50 ? "mixed" : "weak";

  const agreementPoints: string[] = [];
  const disagreementPoints: string[] = [];

  if (verdictCounts.authentic_captured >= 2) {
    agreementPoints.push(
      `${verdictCounts.authentic_captured}/${totalUsable} models identified this as authentic camera footage`
    );
  }
  if (verdictCounts.authentic_produced >= 2) {
    agreementPoints.push(
      `${verdictCounts.authentic_produced}/${totalUsable} models identified this as legitimately produced content`
    );
  }
  if (verdictCounts.likely_manipulated >= 2) {
    agreementPoints.push(
      `${verdictCounts.likely_manipulated}/${totalUsable} models detected deceptive manipulation indicators`
    );
  }

  const manipSignalCounts = new Map<string, number>();
  for (const r of usableResults) {
    for (const signal of r.manipulationSignals) {
      const key = signal.toLowerCase().substring(0, 80);
      manipSignalCounts.set(key, (manipSignalCounts.get(key) || 0) + 1);
    }
  }
  for (const [signal, count] of manipSignalCounts) {
    if (count >= 2 && totalUsable > 0) {
      agreementPoints.push(`${count}/${totalUsable} models flagged: ${signal}`);
    }
  }

  if (verdictCounts.authentic_captured > 0 && verdictCounts.authentic_produced > 0) {
    const capturedModels = usableResults
      .filter((r) => r.verdict === "authentic_captured" || r.verdict === "authentic")
      .map((r) => r.modelName);
    const producedModels = usableResults
      .filter((r) => r.verdict === "authentic_produced")
      .map((r) => r.modelName);
    disagreementPoints.push(
      `${capturedModels.join(", ")} identified camera footage; ${producedModels.join(", ")} identified produced/animated content`
    );
  }

  const nonDeceptiveVerdicts = new Set(["authentic_captured", "authentic_produced", "authentic"]);
  const hasNonDeceptive = usableResults.some((r) => nonDeceptiveVerdicts.has(r.verdict));
  const hasManip = usableResults.some((r) => r.verdict === "likely_manipulated");
  if (hasNonDeceptive && hasManip) {
    const okModels = usableResults
      .filter((r) => nonDeceptiveVerdicts.has(r.verdict))
      .map((r) => r.modelName);
    const manipModels = usableResults
      .filter((r) => r.verdict === "likely_manipulated")
      .map((r) => r.modelName);
    disagreementPoints.push(
      `${okModels.join(", ")} found authentic-style content; ${manipModels.join(", ")} found deceptive manipulation indicators`
    );
  }

  if (
    verdictCounts.inconclusive > 0 &&
    (verdictCounts.authentic_captured > 0 ||
      verdictCounts.authentic_produced > 0 ||
      verdictCounts.likely_manipulated > 0)
  ) {
    const incModels = usableResults.filter((r) => r.verdict === "inconclusive").map((r) => r.modelName);
    disagreementPoints.push(
      `${incModels.join(", ")} could not determine authenticity while other models reached a verdict`
    );
  }

  const verificationId = `${uid}-${Date.now()}-vid-${Math.random().toString(36).substring(2, 9)}`;

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
    totalTokens: modelResults.reduce((sum, r) => sum + (r.tokens || 0), 0),
    timestamp: FieldValue.serverTimestamp(),
  };

  try {
    await adminDb
      .collection("videoVerifications")
      .doc(verificationId)
      .set(sanitizeForFirestore(resultDoc) as DocumentData);
    console.log(`[verify-video] Stored result: ${verificationId}`);
  } catch (err) {
    console.error("[verify-video] Firestore save failed:", err);
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
    console.log(`[verify-video] Governance evaluation complete`);
  } catch (err) {
    console.error("[verify-video] Governance evaluation failed:", err);
    try {
      await adminDb.collection("failed_governance_audits").add({
        runId: verificationId,
        collection: "videoVerifications",
        ownerUid: uid,
        failedAt: FieldValue.serverTimestamp(),
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (writeErr) {
      console.error("[verify-video] Failed to write governance failure record:", writeErr);
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
    console.log(`[verify-video] Video usage updated (transactional)`);
  } catch (err) {
    console.error("[verify-video] Usage increment failed:", err);
  }

  const totalTokens = modelResults.reduce((sum, r) => sum + (r.tokens || 0), 0);
  try {
    await incrementUserTokenUsage(uid, totalTokens);
  } catch (err) {
    logger.warn("[verify-video] Token increment failed", { error: (err as Error)?.message });
  }

  const totalElapsed = Date.now() - startTime;
  console.log(`[verify-video] Complete in ${totalElapsed}ms. Verdict: ${aggregateVerdict}, Score: ${consensusScore}`);

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
      totalModels: visionModels.length,
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
