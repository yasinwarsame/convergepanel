"use client";

/**
 * Paid-plan video verification upload UI: validate file → extract frames + MP4 metadata in the browser → POST JSON to `/api/verify-video`.
 *
 * Drag-and-drop is optional (disabled on coarse pointers); mobile uses the hidden file input only. No `<form>` wrapper so Enter does not double-submit.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Film } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { VIDEO_VERIFICATION_DISCLAIMER } from "@/lib/legal/videoVerificationDisclaimer";
import type { MetadataFlag } from "@/lib/video/videoPure";
import type { VideoVerificationClientPayload } from "@/lib/verification/videoVerificationClientPayload";

const VALID_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
]);

const VIDEO_VERIFICATION_ACK_KEY = "video-verification-acknowledged";

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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [allowDragDrop, setAllowDragDrop] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const [hasAcknowledged, setHasAcknowledged] = useState(false);

  useEffect(() => {
    try {
      if (typeof window !== "undefined" && localStorage.getItem(VIDEO_VERIFICATION_ACK_KEY) === "true") {
        setHasAcknowledged(true);
      }
    } catch {
      /* private mode */
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const sync = () => setAllowDragDrop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!loading) {
      setProgress(0);
      return;
    }
    // Indeterminate progress: fast early steps, then slows approaching 95%; real completion sets 100% explicitly.
    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev < 30) return prev + 2;
        if (prev < 60) return prev + 1;
        if (prev < 85) return prev + 0.5;
        if (prev < 95) return prev + 0.1;
        return prev;
      });
    }, 500);
    return () => clearInterval(interval);
  }, [loading]);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const validateAndSetFile = useCallback((file: File) => {
    setError(null);
    const t = file.type || "";
    if (!VALID_TYPES.has(t)) {
      const lower = file.name.toLowerCase();
      const extOk = /\.(mp4|mov|webm|avi)$/i.test(lower);
      if (!extOk) {
        setError("Unsupported format. Please upload MP4, MOV, WebM, or AVI.");
        return;
      }
    }
    if (file.size > 50 * 1024 * 1024) {
      setError("File too large. Maximum size is 50MB.");
      return;
    }
    setSelectedFile(file);
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedFile(null);
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  function handleDrag(e: React.DragEvent) {
    if (!allowDragDrop) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    if (!allowDragDrop) return;
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) validateAndSetFile(file);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) validateAndSetFile(file);
  }

  const handleVerifyVideo = useCallback(async () => {
    if (!selectedFile || loading || !user) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setLoading(true);
    setError(null);
    setProgress(0);
    setProgressMessage("Reading video…");
    const fileName = selectedFile.name;

    try {
      setProgressMessage("Extracting frames in your browser…");
      // Dynamic import keeps heavy client-only decoding out of the main bundle and avoids SSR pulling `use client` modules.
      const { extractFramesInBrowser } = await import("@/lib/video/extractFramesClient");
      const extraction = await extractFramesInBrowser(selectedFile);
      if (extraction.frames.length === 0) {
        setError("Could not extract any frames from this video.");
        return;
      }

      setProgressMessage("Reading file metadata…");
      const { extractMp4Metadata } = await import("@/lib/video/extractFileMetadata");
      const fileMetadata = await extractMp4Metadata(selectedFile);

      const enrichedMetadata = {
        ...extraction.metadata,
        codec: fileMetadata.codec || "unknown",
        hasAudio: fileMetadata.hasAudio,
        createdAt: fileMetadata.createdAt,
        encodingSoftware: fileMetadata.encodingSoftware,
        cameraModel: fileMetadata.cameraModel,
      };

      setProgress(35);
      setProgressMessage(
        `Analyzing ${extraction.frames.length} frames with 3 AI models…`
      );

      const token = await user.getIdToken();
      const jsonBody = JSON.stringify({
        frames: extraction.frames,
        metadata: enrichedMetadata,
        warnings: extraction.warnings,
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
        setProgress(100);
        const payload = mergeApiSuccessToPayload(data as Record<string, unknown>, fileName);
        setSelectedFile(null);
        setPreview((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        if (fileInputRef.current) fileInputRef.current.value = "";
        onSuccess(payload);
        await onUsageRefresh?.();
      } else {
        const code = data.error?.code;
        const msg = data.error?.message;
        if (code === "plan_required") {
          setError("Video verification is not available on the free plan.");
        } else if (code === "video_limit_reached") {
          setError(
            typeof msg === "string" && msg.trim()
              ? msg
              : `You've used all ${videoLimit} video verifications this month. Resets on the first day of next month.`
          );
        } else if (code === "run_limit_reached") {
          setError(
            typeof msg === "string" && msg.trim()
              ? msg
              : "You've reached your monthly panel run limit. Each video verification also uses one run from your allowance."
          );
        } else if (code === "file_too_large") {
          setError("File too large. Maximum size is 50MB.");
        } else if (code === "no_frames" || code === "invalid_frame") {
          setError(
            typeof msg === "string" && msg.trim()
              ? msg
              : "Could not use the extracted frames. Try another file or browser."
          );
        } else if (code === "invalid_metadata" || code === "too_many_frames") {
          setError(typeof msg === "string" && msg.trim() ? msg : "Invalid video metadata.");
        } else if (code === "payload_too_large" || code === "frame_too_large") {
          setError(
            typeof msg === "string" && msg.trim()
              ? msg
              : "Frame data is too large. Try a shorter or lower-resolution video."
          );
        } else if (code === "storage_failed") {
          setError(
            typeof msg === "string" && msg.trim()
              ? msg
              : "Could not save results. Your usage was not charged. Please try again."
          );
        } else if (code === "processing_failed") {
          setError("Could not process this video. Please try a different file.");
        } else if (code === "invalid_request") {
          setError(
            typeof msg === "string" && msg.trim()
              ? msg
              : "Invalid request. Ensure the app is updated and try again."
          );
        } else if (code === "rate_limit_exceeded") {
          setError(
            typeof msg === "string" && msg.trim()
              ? msg
              : "Too many requests. Please wait a moment and try again."
          );
        } else if (code === "model_limit") {
          setError(
            typeof msg === "string" && msg.trim()
              ? msg
              : "Your plan does not allow enough models for this verification."
          );
        } else if (code === "unauthorized") {
          setError(typeof msg === "string" && msg.trim() ? msg : "Please sign in again and retry.");
        } else {
          setError(
            typeof msg === "string" && msg.trim()
              ? msg
              : "Video verification failed. Please try again."
          );
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setError(
        message.trim()
          ? message
          : "Failed to verify video. Please check your connection and try again."
      );
    } finally {
      setLoading(false);
      setProgressMessage(null);
      submittingRef.current = false;
    }
  }, [selectedFile, loading, user, onSuccess, onUsageRefresh, videoLimit]);

  const isFree = plan === "free";
  const atVideoLimit = videoLimit > 0 && videoRunsThisMonth >= videoLimit;

  if (isFree) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 md:p-8 shadow-sm">
        <div className="mb-4 flex items-center gap-2 text-slate-900">
          <Film className="h-8 w-8 text-indigo-500" aria-hidden />
          <h2 className="text-xl font-bold">Video Verification</h2>
        </div>
        <p className="text-slate-600 mb-4">
          Verify video authenticity with multi-model AI analysis. Available on paid plans.
        </p>
        <ul className="mb-6 space-y-2 text-sm text-slate-700">
          <li>✓ 3 vision models analyze frames independently</li>
          <li>✓ Metadata analysis and AI tool detection</li>
          <li>✓ Consensus scoring and per-model evidence</li>
          <li>✓ Governance review for flagged results</li>
        </ul>
        <Link
          href="/pricing"
          className="inline-flex rounded-xl bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-700"
        >
          Upgrade to verify videos →
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 md:p-8 shadow-sm">
      <h2 className="text-xl font-bold text-slate-900 mb-1">Verify Video Authenticity</h2>
      <p className="text-sm text-slate-600 mb-4 leading-relaxed">
        Upload a video to check for signs of AI generation or manipulation. Three vision-capable AI models
        analyze the frames independently and report where they agree and disagree.
      </p>

      {!hasAcknowledged && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-900/20">
          <p className="mb-2 text-sm font-medium text-amber-900 dark:text-amber-200">Before you verify a video</p>
          <p className="mb-3 text-xs leading-relaxed text-amber-800 dark:text-amber-300/95">
            Video verification uses AI vision models to identify potential indicators of manipulation or AI
            generation. This is not forensic analysis and results should not be used as legal evidence or the
            sole basis for consequential decisions. Results may contain false positives or false negatives. By
            proceeding, you acknowledge these limitations and agree to our{" "}
            <Link href="/terms" className="font-medium underline underline-offset-2">
              Terms of Service
            </Link>
            .
          </p>
          <button
            type="button"
            onClick={() => {
              try {
                localStorage.setItem(VIDEO_VERIFICATION_ACK_KEY, "true");
              } catch {
                /* ignore */
              }
              setHasAcknowledged(true);
            }}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700"
          >
            I understand — continue
          </button>
        </div>
      )}

      {hasAcknowledged && videoLimit > 0 && (
        <p className="text-sm text-slate-500 mb-3">
          {Math.max(0, videoLimit - videoRunsThisMonth)} video verification
          {videoLimit - videoRunsThisMonth !== 1 ? "s" : ""} remaining this month
        </p>
      )}

      {hasAcknowledged && atVideoLimit && (
        <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 mb-4">
          <p className="font-medium text-amber-800 dark:text-amber-300">
            You&apos;ve used all {videoLimit} video verifications this month.
          </p>
          <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
            Resets on the first day of the next calendar month.
            {plan === "lite" && " Upgrade to the 5-Model plan for 20 video verifications."}
          </p>
        </div>
      )}

      {hasAcknowledged && loading && (
        <div className="text-center p-8">
          <div className="animate-spin w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-lg font-medium text-slate-900 mb-2">Video verification</p>
          <p className="text-sm text-slate-500 mb-4 max-w-md mx-auto">
            {progressMessage ||
              "Processing… This usually takes 30–60 seconds after frames are extracted."}
          </p>
          <div className="w-full bg-slate-200 rounded-full h-2 max-w-md mx-auto">
            <div
              className="bg-sky-500 h-2 rounded-full transition-all duration-500"
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
          <p className="text-xs text-slate-400 mt-4">
            Do not close this page while analysis is in progress.
          </p>
        </div>
      )}

      {hasAcknowledged && !loading && (
        <>
          {!selectedFile && !atVideoLimit && (
            <div
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragEnter={allowDragDrop ? handleDrag : undefined}
              onDragOver={allowDragDrop ? handleDrag : undefined}
              onDragLeave={allowDragDrop ? handleDrag : undefined}
              onDrop={allowDragDrop ? handleDrop : undefined}
              onClick={() => fileInputRef.current?.click()}
              className={`
                border-2 border-dashed rounded-xl p-8 sm:p-12 text-center cursor-pointer w-full
                transition-all duration-200
                ${
                  dragActive && allowDragDrop
                    ? "border-sky-500 bg-sky-50"
                    : "border-slate-300 hover:border-slate-400"
                }
              `}
            >
              <Film className="w-12 h-12 mx-auto mb-4 text-slate-400" />
              <p className="text-lg font-medium text-slate-900">
                {allowDragDrop ? "Drop a video file here" : "Choose a video file"}
              </p>
              <p className="text-sm text-slate-500 mt-1">or click to browse</p>
              <p className="text-xs text-slate-400 mt-3">MP4, MOV, WebM, AVI · Max 50MB · Max 60s</p>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/mp4,video/quicktime,video/webm,video/x-msvideo,.mp4,.mov,.webm,.avi"
                onChange={handleFileSelect}
                className="hidden"
              />
            </div>
          )}

          {selectedFile && preview && !atVideoLimit && (
            <div className="flex flex-col sm:flex-row items-stretch sm:items-start gap-4 p-4 rounded-lg bg-slate-50 border border-slate-100">
              <video
                src={preview}
                className="w-full sm:w-40 h-40 sm:h-24 object-cover rounded-lg bg-black shrink-0"
                muted
                playsInline
              />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-slate-900 truncate">{selectedFile.name}</p>
                <p className="text-sm text-slate-500">
                  {(selectedFile.size / 1024 / 1024).toFixed(1)} MB ·{" "}
                  {selectedFile.type.split("/")[1]?.toUpperCase() || "VIDEO"}
                </p>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    clearSelection();
                  }}
                  className="text-sm text-red-600 hover:text-red-500 mt-2"
                >
                  ✕ Remove
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">
              <p>{error}</p>
              {error.includes("free plan") && (
                <Link href="/pricing" className="mt-2 inline-block font-semibold text-red-900 underline">
                  Upgrade →
                </Link>
              )}
            </div>
          )}

          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 mt-4">
            ⚠️ {VIDEO_VERIFICATION_DISCLAIMER} Not a substitute for specialized lab or legal-grade analysis.
          </p>

          {selectedFile && !atVideoLimit && (
            <div className="mt-4 flex flex-col sm:flex-row flex-wrap gap-2">
              <button
                type="button"
                disabled={!authReady || !user || loading}
                onClick={() => void handleVerifyVideo()}
                className="rounded-xl bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? "Verifying…" : "Verify Video"}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Clear
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
