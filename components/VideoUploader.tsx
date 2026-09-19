"use client";

/**
 * Paid-plan video verification upload UI — the PERSONAL transport wrapper.
 *
 * TEAM-VERIFICATION-PARITY-R5-I3-A split this component in two. Everything the
 * browser does before a network call — file selection and validation, preview,
 * frame extraction, file-metadata extraction, legal acknowledgement, quota
 * presentation, progress and the single-activation guard — now lives in the
 * shared, transport-neutral `VideoUploaderSurface`. What remains here is
 * exactly the Personal half: Firebase auth, the `/api/verify-video` POST, the
 * Personal request body, the Personal error map and the tolerant Personal
 * success mapper.
 *
 * The split is a prerequisite for R5-I3-B (Team Video creation), which will add
 * a sibling Team wrapper around the same surface. Making the endpoint a
 * property of the WRAPPER is what turns "Team never posts to `/api/verify-video`"
 * into a one-line static assertion per wrapper.
 *
 * NOTHING about Personal behaviour changes: the public props, the exact request,
 * every error string and the tolerant mapper are all preserved, and the
 * characterization suite written before this refactor is what proves it.
 */

import { useCallback } from "react";
import { useAuth } from "@/components/AuthProvider";
import VideoUploaderSurface from "@/components/verification/VideoUploaderSurface";
import type { PreparedVideoUpload, VideoUploadSubmitOutcome } from "@/lib/verification/videoUploadClientContract";
import type { MetadataFlag } from "@/lib/video/videoPure";
import type { VideoVerificationClientPayload } from "@/lib/verification/videoVerificationClientPayload";

function mergeApiSuccessToPayload(
  data: Record<string, unknown>,
  fileName: string
): VideoVerificationClientPayload {
  const meta = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<
    string,
    unknown
  >;
  const mdAnalysis = (
    data.metadataAnalysis && typeof data.metadataAnalysis === "object" ? data.metadataAnalysis : {}
  ) as Record<string, unknown>;
  const flagsRaw = mdAnalysis.flags;
  const flags = Array.isArray(flagsRaw) ? flagsRaw : [];
  const meRaw = data.modelEvidence;
  const modelEvidence = Array.isArray(meRaw) ? meRaw : [];

  return {
    verificationId: String(data.verificationId ?? ""),
    fileName,
    verdict: typeof data.verdict === "string" ? data.verdict : "inconclusive",
    contentType: typeof data.contentType === "string" ? data.contentType : undefined,
    consensusScore:
      typeof data.consensusScore === "number" && Number.isFinite(data.consensusScore)
        ? Math.round(data.consensusScore)
        : 0,
    confidenceLabel:
      data.confidenceLabel === "High" || data.confidenceLabel === "Medium" || data.confidenceLabel === "Low"
        ? data.confidenceLabel
        : "Low",
    evidenceQuality:
      data.evidenceQuality === "strong" || data.evidenceQuality === "mixed" || data.evidenceQuality === "weak"
        ? data.evidenceQuality
        : "weak",
    supportRatio:
      typeof data.supportRatio === "number" && Number.isFinite(data.supportRatio)
        ? Math.round(data.supportRatio)
        : 0,
    metadata: {
      duration: typeof meta.duration === "number" ? meta.duration : 0,
      width: typeof meta.width === "number" ? meta.width : 0,
      height: typeof meta.height === "number" ? meta.height : 0,
      codec: typeof meta.codec === "string" ? meta.codec : "—",
      frameRate: typeof meta.frameRate === "number" ? meta.frameRate : 0,
      fileSize: typeof meta.fileSize === "number" ? meta.fileSize : 0,
      format: typeof meta.format === "string" ? meta.format : "—",
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : null,
      encodingSoftware: typeof meta.encodingSoftware === "string" ? meta.encodingSoftware : null,
      hasAudio: meta.hasAudio === true,
      cameraModel: typeof meta.cameraModel === "string" ? meta.cameraModel : null,
    },
    metadataAnalysis: {
      flags: flags as MetadataFlag[],
      summary: typeof mdAnalysis.summary === "string" ? mdAnalysis.summary : "",
    },
    modelEvidence: modelEvidence as VideoVerificationClientPayload["modelEvidence"],
    agreementPoints: Array.isArray(data.agreementPoints)
      ? data.agreementPoints.map((x) => String(x))
      : [],
    disagreementPoints: Array.isArray(data.disagreementPoints)
      ? data.disagreementPoints.map((x) => String(x))
      : [],
    frameCount: typeof data.frameCount === "number" ? data.frameCount : 0,
    warnings: Array.isArray(data.warnings) ? data.warnings.map((x) => String(x)) : [],
  };
}

/**
 * The Personal error map, preserved code-for-code and string-for-string from
 * the pre-split component. A non-empty server `message` wins only where it won
 * before; the fixed-copy codes stay fixed.
 */
export function personalVideoUploadErrorPresentation(code: string | undefined, msg: string | undefined, videoLimit: number): string {
  const serverMessage = typeof msg === "string" && msg.trim() ? msg : null;
  if (code === "plan_required") {
    return "Video verification is not available on the free plan.";
  }
  if (code === "video_limit_reached") {
    return serverMessage ?? `You've used all ${videoLimit} video verifications this month. Resets on the first day of next month.`;
  }
  if (code === "run_limit_reached") {
    return serverMessage ?? "You've reached your monthly panel run limit. Each video verification also uses one run from your allowance.";
  }
  if (code === "file_too_large") {
    return "File too large. Maximum size is 50MB.";
  }
  if (code === "no_frames" || code === "invalid_frame") {
    return serverMessage ?? "Could not use the extracted frames. Try another file or browser.";
  }
  if (code === "invalid_metadata" || code === "too_many_frames") {
    return serverMessage ?? "Invalid video metadata.";
  }
  if (code === "payload_too_large" || code === "frame_too_large") {
    return serverMessage ?? "Frame data is too large. Try a shorter or lower-resolution video.";
  }
  if (code === "storage_failed") {
    return serverMessage ?? "Could not save results. Your usage was not charged. Please try again.";
  }
  if (code === "processing_failed") {
    return "Could not process this video. Please try a different file.";
  }
  if (code === "invalid_request") {
    return serverMessage ?? "Invalid request. Ensure the app is updated and try again.";
  }
  if (code === "rate_limit_exceeded") {
    return serverMessage ?? "Too many requests. Please wait a moment and try again.";
  }
  if (code === "model_limit") {
    return serverMessage ?? "Your plan does not allow enough models for this verification.";
  }
  if (code === "unauthorized") {
    return serverMessage ?? "Please sign in again and retry.";
  }
  return serverMessage ?? "Video verification failed. Please try again.";
}

export type VideoUploaderProps = {
  plan: string;
  videoLimit: number;
  videoRunsThisMonth: number;
  onSuccess: (payload: VideoVerificationClientPayload) => void;
  onUsageRefresh?: () => void | Promise<void>;
};

export default function VideoUploader({
  plan,
  videoLimit,
  videoRunsThisMonth,
  onSuccess,
  onUsageRefresh,
}: VideoUploaderProps) {
  const { user, authReady } = useAuth();

  const submitPreparedVideo = useCallback(
    async (prepared: PreparedVideoUpload): Promise<VideoUploadSubmitOutcome<VideoVerificationClientPayload>> => {
      // The surface only offers submission when `submissionEnabled`, but the
      // transport stays authoritative about its own precondition.
      if (!user) {
        return { status: "rejected", message: "Please sign in again and retry." };
      }

      const token = await user.getIdToken();
      const jsonBody = JSON.stringify({
        frames: prepared.frames,
        metadata: prepared.metadata,
        warnings: prepared.warnings,
      });
      const res = await fetch("/api/verify-video", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: jsonBody,
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: { code?: string; message?: string };
        [key: string]: unknown;
      };

      if (data.ok) {
        return { status: "ok", value: mergeApiSuccessToPayload(data as Record<string, unknown>, prepared.fileName) };
      }

      const message = personalVideoUploadErrorPresentation(data.error?.code, data.error?.message, videoLimit);
      // Preserved exactly: the pre-split component decided the upgrade link from
      // the rendered COPY, not from the code, so a server message mentioning the
      // free plan showed it too.
      return { status: "rejected", message, showUpgrade: message.includes("free plan") };
    },
    // `user` is the only transport dependency that changes identity; `videoLimit`
    // feeds one default error string.
    [user, videoLimit]
  );

  return (
    <VideoUploaderSurface<VideoVerificationClientPayload>
      plan={plan}
      videoLimit={videoLimit}
      videoRunsThisMonth={videoRunsThisMonth}
      submissionEnabled={authReady && user != null}
      submitPreparedVideo={submitPreparedVideo}
      onSuccess={onSuccess}
      onUsageRefresh={onUsageRefresh}
    />
  );
}
