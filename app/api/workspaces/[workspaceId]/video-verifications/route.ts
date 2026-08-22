/**
 * Team Video Verification Creation, Phase 8C-E.3.3.1 —
 * `POST /api/workspaces/{workspaceId}/video-verifications`. Team Video
 * only — no GET/list in this slice (deferred, matching Team Claim's own
 * §27 precedent). Detail-read support lives in the existing shared
 * `GET /api/user/verifications/[verificationId]?collection=videoVerifications`.
 *
 * Frozen architecture (Phase 8C-E.3.3.0 + its .1/.2/.3/.3.2.1 corrections):
 *
 * identity -> rate limit (team-video-verification:${uid}, BEFORE body
 * parsing) -> body read/validation (Personal Video semantics verbatim +
 * Team unknown-field rejection + projectId canonicalization) -> pure Team
 * rollout (zero Team Workspace/membership/Project/dedup Firestore reads
 * before this point — the UID rate limiter may use its own persistence
 * backend, intentionally outside this invariant) -> GATE 1
 * (`authorizeTeamVideoVerificationAdmission()`, no write — authorizes
 * research.create BEFORE any dedup lookup or provider spend) -> requester
 * entitlement -> ONE requester users/{uid} read (supplies userEmail AND
 * videoRunsThisMonth/usageMonth, Personal-identical normalization,
 * Phase 8C-E.3.3.0.1) -> free-plan block -> video monthly limit -> Team
 * -scoped dedup lookup (userId+fileName+workspaceId+projectId binding,
 * preserving Personal's own newest-candidate-only quirk).
 *
 * DEDUP SECURITY CONTRACT (Phase 8C-E.3.3.1.1 — read this before touching
 * the dedup block below): a TRUE MISS (no matching document, or the
 * newest candidate fails the window/fileSize/duration criteria) may
 * proceed to fresh creation below. But once a candidate DOES satisfy
 * those match criteria, the request has identified an EXISTING Team
 * artifact, not a miss — its row is validated
 * (`validateTeamVideoVerificationRowShape()`) and access is freshly
 * reauthorized for `research.read` (`resolveTeamRunWorkspaceAccess()`,
 * independent of Gate 1's `research.create` decision). From that point
 * every outcome is terminal and FAILS CLOSED — a matched candidate's
 * authorization failure is NEVER reinterpreted as a miss and retried as
 * fresh creation:
 *   - malformed matched row                    -> concealed 404
 *   - research.read capability missing         -> 403
 *   - concealed Workspace/membership/integrity  -> concealed 404
 *   - rollout disabled / infra lookup failure   -> 503
 *   - valid row + research.read granted         -> existing artifact, 200
 * None of those five outcomes ever reaches `checkAndIncrementUsageForRun()`
 * or `executeVideoVerification()` below. Gate 2 remains the sole
 * authority for authorizing a FRESH creation after a genuine miss — it is
 * not a fallback that "double-checks" a failed read authorization on an
 * already-identified existing artifact.
 *
 * Only past a true miss does the route continue: generic atomic
 * pre-charge (`checkAndIncrementUsageForRun(uid,2)`, Claim-style, BEFORE
 * provider execution, Phase 8C-E.3.3.0 §20 Option A) -> `analyzeMetadata()`
 * -> `executeVideoVerification()` (same shared service Personal uses,
 * unmodified) -> GATE 2 (`saveTeamVideoVerification()`, fresh
 * reauthorization + writer-owned id + `tx.create()`, Phase 8C-E.3.3.0.3)
 * -> unconditional best-effort token accounting (BEFORE branching on
 * Gate-2's result) -> (only on Gate-2 success) governance + video counter
 * -> response.
 *
 * The entire handler is wrapped in a Team-only top-level safe catch
 * (Phase 8C-E.3.3.0 §33 Option A) — Personal Video itself has no such
 * catch and remains completely untouched.
 *
 * Gate 1 never authorizes Gate 2. Gate 2 independently re-derives
 * Workspace/membership/owner-integrity/capability/Project state from
 * scratch, inside its own transaction — see
 * lib/firestore/teamVideoVerifications.ts's own module doc.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS } from "@/lib/env";
import { resolveTeamWorkspacesMode } from "@/lib/workspaces/teamWorkspacesRollout";
import {
  authorizeTeamVideoVerificationAdmission,
  findTeamVideoVerificationDedupCandidate,
  saveTeamVideoVerification,
  type TeamVideoModelResultRow,
} from "@/lib/firestore/teamVideoVerifications";
import { validateTeamVideoVerificationRowShape } from "@/lib/workspaces/teamVideoVerificationRowValidation";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { getVideoLimit } from "@/lib/billing/planConfig";
import { checkAndIncrementUsageForRun } from "@/lib/stripe/usageCheck";
import { analyzeMetadata } from "@/lib/video/videoPure";
import type { ExtractedFrame, VideoMetadata } from "@/lib/video/videoPure";
import { executeVideoVerification } from "@/lib/video/videoVerificationExecution";
import { incrementUserTokenUsage } from "@/lib/firestore/userTokens";
import { evaluateAndStoreGovernance } from "@/lib/governance/evaluateAndStore";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { validateNullableProjectIdValue } from "@/lib/projects/runProjectAssociationBody";
import { teamWorkspacesDisabledResponse, invalidRequestBodyResponse, unexpectedFieldResponse, internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { teamProjectAuthorizationDeniedResponse } from "@/lib/projects/teamProjectErrorResponse";
import { runProjectAssociationTargetNotFoundResponse, projectArchivedTargetResponse } from "@/lib/projects/projectErrorResponse";
import { mapStoredVideoVerificationToClientPayload } from "@/lib/user/mapStoredVideoVerificationToClientPayload";
import { VIDEO_VERIFICATION_DISCLAIMER } from "@/lib/legal/videoVerificationDisclaimer";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_FRAMES = 15;
const MAX_BASE64_CHARS_PER_FRAME = 900_000;
const MAX_TOTAL_BASE64_CHARS = 12_000_000;
const DEDUP_WINDOW_MS = 30_000;

const ALLOWED_BODY_KEYS = new Set(["frames", "metadata", "warnings", "projectId"]);

function mapGateDenial(result: { status: string; reason?: unknown }): { status: number; body: unknown } {
  switch (result.status) {
    case "team_workspaces_disabled":
      return teamWorkspacesDisabledResponse();
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

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "POST /api/workspaces/[workspaceId]/video-verifications", method: "POST", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Please sign in to verify a video." } }, { status: 401 });
  }
  return NextResponse.json({ ok: false, error: { code: "auth_error", message: "Authentication failed." } }, { status: 401 });
}

export async function POST(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  try {
    // ============================================
    // IDENTITY
    // ============================================
    const uidOrRes = await getUid(req);
    if (uidOrRes instanceof NextResponse) return uidOrRes;
    const uid = uidOrRes;
    const workspaceId = params.workspaceId;

    // ============================================
    // RATE LIMITING — BEFORE body parsing, requester-scoped only.
    // ============================================
    const { checkRateLimit } = await import("@/lib/security/rateLimit");
    const rateLimitResult = await checkRateLimit({
      maxRequests: 10,
      windowSeconds: 60,
      identifier: `team-video-verification:${uid}`,
    });
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { ok: false, error: { code: "rate_limit_exceeded", message: "Too many video verification requests. Please wait before trying again." } },
        { status: 429 }
      );
    }

    // ============================================
    // BODY READ — preserves Personal Video's exact reading semantics.
    // ============================================
    const contentType = (req.headers.get("content-type") || "").toLowerCase();
    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return NextResponse.json({ ok: false, error: { code: "invalid_request", message: "Could not read request body." } }, { status: 400 });
    }

    if (!rawBody.trim()) {
      return NextResponse.json({ ok: false, error: { code: "invalid_request", message: "Empty body. Send JSON with frames and metadata." } }, { status: 400 });
    }

    if (contentType.includes("multipart/form-data") || rawBody.trimStart().startsWith("--")) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "invalid_request",
            message: "Multipart upload is not supported. Extract frames in the browser and POST application/json with frames, metadata, and warnings.",
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
        { ok: false, error: { code: "invalid_request", message: "Body is not valid JSON. Use Content-Type: application/json and a JSON object with frames, metadata, and warnings." } },
        { status: 400 }
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      const { status, body: errBody } = invalidRequestBodyResponse();
      return NextResponse.json(errBody, { status });
    }

    const payload = body as Record<string, unknown>;
    for (const key of Object.keys(payload)) {
      if (!ALLOWED_BODY_KEYS.has(key)) {
        const { status, body: errBody } = unexpectedFieldResponse();
        return NextResponse.json(errBody, { status });
      }
    }

    const framesIn = payload.frames;
    const clientMetaRaw = payload.metadata;
    const clientWarningsIn = payload.warnings;

    if (!Array.isArray(framesIn) || framesIn.length === 0) {
      return NextResponse.json({ ok: false, error: { code: "no_frames", message: "No video frames provided." } }, { status: 400 });
    }
    if (framesIn.length > MAX_FRAMES) {
      return NextResponse.json({ ok: false, error: { code: "too_many_frames", message: "Maximum 15 frames allowed." } }, { status: 400 });
    }
    if (!clientMetaRaw || typeof clientMetaRaw !== "object") {
      return NextResponse.json({ ok: false, error: { code: "invalid_metadata", message: "Invalid video metadata." } }, { status: 400 });
    }

    const cm = clientMetaRaw as Record<string, unknown>;
    const duration = typeof cm.duration === "number" && Number.isFinite(cm.duration) ? cm.duration : 0;
    const vw = typeof cm.width === "number" && Number.isFinite(cm.width) ? cm.width : 0;
    const vh = typeof cm.height === "number" && Number.isFinite(cm.height) ? cm.height : 0;
    const fileSize = typeof cm.fileSize === "number" && Number.isFinite(cm.fileSize) ? cm.fileSize : 0;
    const fileName = typeof cm.fileName === "string" && cm.fileName.trim() ? cm.fileName.trim() : "upload.mp4";

    if (!(duration > 0)) {
      return NextResponse.json({ ok: false, error: { code: "invalid_metadata", message: "Invalid video metadata." } }, { status: 400 });
    }
    if (duration > 60) {
      return NextResponse.json({ ok: false, error: { code: "invalid_metadata", message: "Video must be 60 seconds or shorter." } }, { status: 400 });
    }
    if (fileSize > 50 * 1024 * 1024) {
      return NextResponse.json({ ok: false, error: { code: "file_too_large", message: "Video must be under 50MB." } }, { status: 400 });
    }

    const clientWarnings: string[] = Array.isArray(clientWarningsIn) ? clientWarningsIn.filter((w): w is string => typeof w === "string") : [];

    const frames: ExtractedFrame[] = [];
    let totalB64 = 0;
    for (let i = 0; i < framesIn.length; i++) {
      const row = framesIn[i];
      if (!row || typeof row !== "object") {
        return NextResponse.json({ ok: false, error: { code: "invalid_frame", message: "Each frame must be an object with base64 data." } }, { status: 400 });
      }
      const fr = row as Record<string, unknown>;
      let b64 = typeof fr.base64 === "string" ? fr.base64.trim() : "";
      if (!b64) {
        return NextResponse.json({ ok: false, error: { code: "invalid_frame", message: "Each frame must include base64 data." } }, { status: 400 });
      }
      if (b64.startsWith("data:")) {
        const idx = b64.indexOf("base64,");
        b64 = idx >= 0 ? b64.slice(idx + 7) : b64;
      }
      if (b64.length > MAX_BASE64_CHARS_PER_FRAME) {
        return NextResponse.json({ ok: false, error: { code: "frame_too_large", message: "A frame payload is too large." } }, { status: 400 });
      }
      totalB64 += b64.length;
      const tsVal = typeof fr.timestamp === "number" && Number.isFinite(fr.timestamp) ? fr.timestamp : i;
      const fw = typeof fr.width === "number" && Number.isFinite(fr.width) ? fr.width : vw;
      const fh = typeof fr.height === "number" && Number.isFinite(fr.height) ? fr.height : vh;
      frames.push({ index: frames.length, timestamp: tsVal, base64: b64, width: fw, height: fh });
    }

    if (totalB64 > MAX_TOTAL_BASE64_CHARS) {
      return NextResponse.json({ ok: false, error: { code: "payload_too_large", message: "Combined frame data exceeds the limit." } }, { status: 413 });
    }

    const fileType = typeof cm.fileType === "string" ? cm.fileType : "";
    const formatPart = fileType.includes("/") ? fileType.split("/")[1] || "mp4" : "mp4";
    const codecIn = typeof cm.codec === "string" && cm.codec.trim() ? cm.codec.trim() : "unknown";
    const frameRateIn = typeof cm.frameRate === "number" && Number.isFinite(cm.frameRate) && cm.frameRate > 0 ? cm.frameRate : 0;
    const createdAtIn = typeof cm.createdAt === "string" && cm.createdAt.trim() ? cm.createdAt.trim() : null;
    const encodingSoftwareIn = typeof cm.encodingSoftware === "string" && cm.encodingSoftware.trim() ? cm.encodingSoftware.trim() : null;
    const hasAudioIn = cm.hasAudio === true;
    const cameraModelIn = typeof cm.cameraModel === "string" && cm.cameraModel.trim() ? cm.cameraModel.trim() : null;

    const metadata: VideoMetadata = {
      duration, width: vw, height: vh, codec: codecIn, frameRate: frameRateIn, fileSize, format: formatPart,
      createdAt: createdAtIn, encodingSoftware: encodingSoftwareIn, hasAudio: hasAudioIn, cameraModel: cameraModelIn,
    };
    const allWarnings = [...clientWarnings];

    // projectId: absent -> null; explicit null -> null; valid string ->
    // that string; empty/malformed -> 400.
    let targetProjectId: string | null = null;
    if (Object.prototype.hasOwnProperty.call(payload, "projectId")) {
      const parsedProjectId = validateNullableProjectIdValue(payload.projectId);
      if (!parsedProjectId.ok) {
        const { status, body: errBody } = invalidRequestBodyResponse();
        return NextResponse.json(errBody, { status });
      }
      targetProjectId = parsedProjectId.value;
    }

    // ============================================
    // PURE TEAM ROLLOUT — zero Team Workspace/membership/Project/dedup
    // Firestore reads before this point.
    // ============================================
    const rollout = resolveTeamWorkspacesMode({ uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS });
    if (!rollout.enabled) {
      const { status, body: errBody } = teamWorkspacesDisabledResponse();
      return NextResponse.json(errBody, { status });
    }

    // ============================================
    // GATE 1 — execution admission (no write). Must occur before quota
    // and before any model call.
    // ============================================
    const gate1 = await authorizeTeamVideoVerificationAdmission({ uid, workspaceId, projectId: targetProjectId });
    if (gate1.status !== "authorized") {
      const { status, body: errBody } = mapGateDenial(gate1);
      return NextResponse.json(errBody, { status });
    }

    // ============================================
    // REQUESTER ENTITLEMENT — requester-scoped only.
    // ============================================
    const entitlements = await getEffectiveEntitlements(uid);
    const plan = entitlements.planId;

    // ============================================
    // REQUESTER USER RECORD — exactly ONE read, supplies userEmail AND
    // videoRunsThisMonth/usageMonth (Phase 8C-E.3.3.0.1). Explicit adminDb
    // guard here since Gate 1's own internal check does not narrow
    // adminDb's type back into this scope.
    // ============================================
    if (!adminDb) {
      const { status, body: errBody } = internalErrorResponse();
      return NextResponse.json(errBody, { status });
    }
    const userDoc = await adminDb.collection("users").doc(uid).get();
    const userData = userDoc.data() as Record<string, unknown> | undefined;
    const userEmail = (typeof userData?.email === "string" ? userData.email : null)?.trim() || "";

    if (plan === "free") {
      return NextResponse.json(
        { ok: false, error: { code: "plan_required", message: "Video verification is not available on the free plan. Upgrade to verify video content." } },
        { status: 403 }
      );
    }

    const storedUsageMonth = typeof userData?.usageMonth === "string" ? userData.usageMonth.trim() : "";
    const nowMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    let videoRunsThisMonth = typeof userData?.videoRunsThisMonth === "number" ? userData.videoRunsThisMonth : 0;
    if (storedUsageMonth && storedUsageMonth !== nowMonth) {
      videoRunsThisMonth = 0;
    }
    const videoLimit = getVideoLimit(plan);
    if (videoLimit > 0 && videoRunsThisMonth >= videoLimit) {
      return NextResponse.json(
        { ok: false, error: { code: "video_limit_reached", message: `You've used all ${videoLimit} video verifications this calendar month. Resets on the first day of next month.` } },
        { status: 429 }
      );
    }

    // ============================================
    // TEAM-SCOPED DEDUP — a Firestore query failure is NOT caught here;
    // it propagates to this route's own outer catch (fail-closed, Phase
    // 8C-E.3.3.0.2 §10), deliberately unlike Personal's best-effort catch.
    //
    // Phase 8C-E.3.3.1.1 — once the query returns a document that passes
    // the actual dedup-match criteria (newest, window, fileSize,
    // duration), the request has identified an EXISTING Team artifact,
    // not merely "no candidate." From that point on, a row-validation or
    // read-authorization failure MUST fail closed (concealed 404 / 403) —
    // it must never be reinterpreted as a miss and silently retried as a
    // fresh, expensive, provider-spending creation. Only the four true-
    // miss conditions inside findTeamVideoVerificationDedupCandidate()
    // itself (no docs / outside window / size mismatch / duration
    // mismatch) may fall through to normal creation. Mapping reused
    // verbatim from the shared Team Video detail-read branch in
    // app/api/user/verifications/[verificationId]/route.ts.
    // ============================================
    const dedupCandidate = await findTeamVideoVerificationDedupCandidate({
      uid, workspaceId, projectId: targetProjectId, fileName, fileSize, duration, windowMs: DEDUP_WINDOW_MS,
    });

    if (dedupCandidate) {
      const rowValidation = validateTeamVideoVerificationRowShape(dedupCandidate.data, workspaceId);
      if (!rowValidation.ok) {
        // Matched-but-malformed Team-bound candidate — fail closed,
        // concealed. Never falls through to creation.
        return NextResponse.json(
          { ok: false, errorCode: "not_found", message: "Video verification not found." },
          { status: 404 }
        );
      }

      const readAccess = await resolveTeamRunWorkspaceAccess({ uid, workspaceId: rowValidation.workspaceId });
      if (!readAccess.granted) {
        if (readAccess.reason === "team_workspaces_disabled" || readAccess.reason === "lookup_failed") {
          return NextResponse.json(
            { ok: false, errorCode: "team_workspaces_disabled", message: "Team Workspaces are not available right now." },
            { status: 503 }
          );
        }
        // Every other denial reason (workspace absent/malformed/wrong
        // type, membership absent/removed/malformed, owner-integrity
        // violation) collapses to the same concealed 404 — never falls
        // through to creation, and never spends provider quota waiting
        // for Gate 2 to rediscover a revocation this check already saw.
        return NextResponse.json(
          { ok: false, errorCode: "not_found", message: "Video verification not found." },
          { status: 404 }
        );
      }
      if (!readAccess.capabilities.includes("research.read")) {
        return NextResponse.json(
          { ok: false, errorCode: "insufficient_capability", message: "You do not have permission to view this Video verification." },
          { status: 403 }
        );
      }

      const existing = mapStoredVideoVerificationToClientPayload(dedupCandidate.id, dedupCandidate.data);
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
        workspaceId: rowValidation.workspaceId,
        projectId: rowValidation.projectId,
      });
    }

    // ============================================
    // GENERIC USAGE — atomic pre-charge, BEFORE provider execution
    // (Phase 8C-E.3.3.0 §20 Option A).
    // ============================================
    const usageCharge = await checkAndIncrementUsageForRun(uid, 2);
    if (!usageCharge.allowed) {
      if (usageCharge.reason === "MODEL_LIMIT") {
        return NextResponse.json(
          { ok: false, error: { code: "model_limit", message: `Your plan allows up to ${usageCharge.maxModelsPerRun} models per run.` } },
          { status: 403 }
        );
      }
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "run_limit_reached",
            message: "You've reached your monthly panel run limit. Each video verification also uses one run from your monthly allowance.",
            runsUsed: usageCharge.runsThisMonth,
            runsLimit: usageCharge.maxRunsPerMonth,
            resetsAt: usageCharge.resetsAt.toISOString(),
          },
        },
        { status: 429 }
      );
    }

    // ============================================
    // EXECUTION — same shared service Personal uses, unmodified.
    // ============================================
    const metadataAnalysis = analyzeMetadata(metadata);
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
      totalTokens,
    } = await executeVideoVerification(frames, metadata, metadataAnalysis, allWarnings);

    const truncatedModelResults: TeamVideoModelResultRow[] = modelResults.map((m) => ({
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
    }));

    // ============================================
    // GATE 2 — canonical persistence. Independently re-derives
    // authorization from scratch; never trusts Gate 1. Generates its own
    // verificationId internally (Phase 8C-E.3.3.0.3) — this route never
    // does.
    // ============================================
    const gate2 = await saveTeamVideoVerification({
      uid,
      userEmail,
      workspaceId,
      projectId: targetProjectId,
      fileName,
      verdict: aggregateVerdict,
      contentType: aggregateContentType,
      consensusScore,
      confidenceLabel,
      evidenceQuality,
      supportRatio: Math.round(supportRatio * 100),
      metadata,
      metadataAnalysis: { flags: metadataAnalysis.flags, summary: metadataAnalysis.summary },
      modelResults: truncatedModelResults,
      agreementPoints,
      disagreementPoints,
      frameCount: frames.length,
      warnings: allWarnings,
      totalTokens,
    });

    // ============================================
    // TOKEN ACCOUNTING — unconditional, BEFORE branching on Gate-2's
    // result, so Gate-2 denial/infra failure never suppresses it (real
    // provider spend already happened either way).
    // ============================================
    try {
      await incrementUserTokenUsage(uid, totalTokens);
    } catch (tokErr: any) {
      logger.warn("[workspaces/video-verifications POST] Token increment failed", { error: tokErr?.message });
    }

    if (gate2.status !== "created") {
      // No Team artifact. No Personal fallback. No governance. No video
      // counter. Generic run charge above remains consumed — no refund.
      const { status, body: errBody } = mapGateDenial(gate2);
      return NextResponse.json(errBody, { status });
    }

    // ============================================
    // GOVERNANCE — only after Gate 2's tx.create() has actually
    // committed.
    // ============================================
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
        runId: gate2.verificationId,
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
    } catch (err) {
      logger.error("[workspaces/video-verifications POST] Governance evaluation failed", { error: (err as Error)?.message });
      try {
        await adminDb.collection("failed_governance_audits").add({
          runId: gate2.verificationId,
          collection: "videoVerifications",
          ownerUid: uid,
          failedAt: FieldValue.serverTimestamp(),
          error: err instanceof Error ? err.message : String(err),
        });
      } catch (writeErr) {
        logger.error("[workspaces/video-verifications POST] Failed to write governance failure record", { error: (writeErr as Error)?.message });
      }
    }

    // ============================================
    // VIDEO USAGE COUNTER — only after Gate 2 success.
    // ============================================
    try {
      const userRef = adminDb.collection("users").doc(uid);
      await adminDb.runTransaction(async (txn) => {
        const snap = await txn.get(userRef);
        const data = snap.data();
        const storedMonth = typeof data?.usageMonth === "string" ? data.usageMonth.trim() : "";
        const monthRolled = storedMonth !== nowMonth;
        txn.set(
          userRef,
          monthRolled
            ? { usageMonth: nowMonth, videoRunsThisMonth: 1, updatedAt: FieldValue.serverTimestamp() }
            : { videoRunsThisMonth: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
      });
    } catch (err) {
      logger.error("[workspaces/video-verifications POST] Video usage increment failed", { error: (err as Error)?.message });
    }

    return NextResponse.json({
      ok: true,
      verificationId: gate2.verificationId,
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
      frameCount: frames.length,
      warnings: allWarnings,
      disclaimer: VIDEO_VERIFICATION_DISCLAIMER,
      workspaceId: gate2.workspaceId,
      projectId: gate2.projectId,
    });
  } catch (err: any) {
    logger.error("[POST /api/workspaces/[workspaceId]/video-verifications] Unexpected error", { error: err?.message, stack: err?.stack });
    const { status, body: errBody } = internalErrorResponse();
    return NextResponse.json(errBody, { status });
  }
}
