"use client";

/**
 * TEAM-VERIFICATION-PARITY-R5-I3-A §I — the shared, TRANSPORT-NEUTRAL video
 * uploader surface, extracted verbatim from the Personal `VideoUploader`.
 *
 * It owns everything that happens in the browser before a network call:
 * file selection and validation, preview lifecycle, legal acknowledgement,
 * quota presentation, progress, the single-activation UI guard, browser frame
 * extraction and file-metadata extraction. It hands the result to a caller-
 * supplied `submitPreparedVideo` callback and interprets only the three
 * transport-neutral outcomes.
 *
 * IT NAMES NO ENDPOINT. There is no `useAuth`, no `authedFetch`, no Firebase
 * `User`, no `/api/verify-video`, no `/api/workspaces`, no `workspaceId` and no
 * `projectId` anywhere in this file — asserted by a source-boundary test, so a
 * future edit that reaches for one fails mechanically rather than by review
 * attention. That is what lets the same surface serve Personal Video today and
 * Team Video in R5-I3-B.
 *
 * This is an ARCHITECTURE extraction, not a redesign: the markup, copy, class
 * names, storage key, limits and progress messages are the ones already in
 * Production, and the Personal characterization suite is what holds them there.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Film } from "lucide-react";
import { VIDEO_VERIFICATION_DISCLAIMER } from "@/lib/legal/videoVerificationDisclaimer";
import type { PreparedVideoUpload, SubmitPreparedVideo } from "@/lib/verification/videoUploadClientContract";

const VALID_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
]);

const VIDEO_VERIFICATION_ACK_KEY = "video-verification-acknowledged";

export type VideoUploaderSurfaceProps<TSuccess> = {
  plan: string;
  videoLimit: number;
  videoRunsThisMonth: number;
  /**
   * Whether the caller's transport is currently able to submit (for Personal:
   * auth resolved with a user). Presentation only — the transport itself stays
   * authoritative.
   */
  submissionEnabled: boolean;
  submitPreparedVideo: SubmitPreparedVideo<TSuccess>;
  onSuccess: (value: TSuccess) => void;
  onUsageRefresh?: () => void | Promise<void>;
  /**
   * Caller-supplied copy for the `outcome_unknown` state. A generic safe
   * fallback is used when absent. Never a retry affordance: the whole point of
   * this state is that resubmitting could double-charge a completed run.
   */
  outcomeUnknownSurface?: ReactNode;
};

export default function VideoUploaderSurface<TSuccess>({
  plan,
  videoLimit,
  videoRunsThisMonth,
  submissionEnabled,
  submitPreparedVideo,
  onSuccess,
  onUsageRefresh,
  outcomeUnknownSurface,
}: VideoUploaderSurfaceProps<TSuccess>) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [allowDragDrop, setAllowDragDrop] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * Synchronous UI guard. React state alone is insufficient: a same-tick second
   * activation can precede the re-render that would disable the button. This is
   * the PRESENTATION guard only — R5-I3-B's Team mutation hook owns its own
   * single-flight guard, because transport safety must not depend on one button.
   */
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
    setShowUpgrade(false);
    setOutcomeUnknown(false);
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
    if (!selectedFile || loading || !submissionEnabled) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setLoading(true);
    setError(null);
    setShowUpgrade(false);
    setOutcomeUnknown(false);
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

      const prepared: PreparedVideoUpload = {
        fileName,
        frames: extraction.frames,
        metadata: enrichedMetadata,
        warnings: extraction.warnings,
      };

      const outcome = await submitPreparedVideo(prepared);

      if (outcome.status === "ok") {
        setProgress(100);
        setSelectedFile(null);
        setPreview((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        if (fileInputRef.current) fileInputRef.current.value = "";
        onSuccess(outcome.value);
        await onUsageRefresh?.();
      } else if (outcome.status === "rejected") {
        // A proven rejection: the selection is kept so the user can retry or
        // choose another file.
        setError(outcome.message);
        setShowUpgrade(outcome.showUpgrade === true);
      } else {
        // outcome_unknown. NEVER resubmit automatically and NEVER discard the
        // selection — the run may have completed and been charged.
        setOutcomeUnknown(true);
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
  }, [selectedFile, loading, submissionEnabled, submitPreparedVideo, onSuccess, onUsageRefresh]);

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
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="mb-2 text-sm font-medium text-amber-900">Before you verify a video</p>
          <p className="mb-3 text-xs leading-relaxed text-amber-800">
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
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-300 mb-4">
          <p className="font-medium text-amber-800">
            You&apos;ve used all {videoLimit} video verifications this month.
          </p>
          <p className="text-sm text-amber-700 mt-1">
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
              {showUpgrade && (
                <Link href="/pricing" className="mt-2 inline-block font-semibold text-red-900 underline">
                  Upgrade →
                </Link>
              )}
            </div>
          )}

          {/*
            outcome_unknown: the submission may or may not have completed. No
            retry control is offered here on purpose — resubmitting could charge
            a second run for work that already succeeded.
          */}
          {outcomeUnknown && (
            <div role="alert" className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-sm" data-testid="video-upload-outcome-unknown">
              {outcomeUnknownSurface ?? (
                <p>
                  We couldn&apos;t confirm whether this video was submitted. Check your verifications before trying
                  again, so you don&apos;t run it twice.
                </p>
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
                disabled={!submissionEnabled || loading}
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
