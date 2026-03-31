"use client";

/**
 * Client-side video frame extraction using the browser's native video decoder.
 *
 * This approach is more reliable than server-side ffmpeg WASM because browsers
 * have hardware-accelerated video decoders that support all common codecs.
 *
 * Flow: File → `<video>` element → seek to timestamps → `<canvas>` → JPEG base64
 */

import { computeFrameTimestamps } from "./videoPure";

/** One captured frame aligned with {@link import("./videoPure").ExtractedFrame} shape for API upload. */
export interface ClientExtractedFrame {
  index: number;
  timestamp: number;
  base64: string;
  width: number;
  height: number;
}

/** Browser-reported dimensions and file identity (no container parse). */
export interface ClientVideoMetadata {
  duration: number;
  width: number;
  height: number;
  fileSize: number;
  fileName: string;
  fileType: string;
}

export interface ClientExtractionResult {
  frames: ClientExtractedFrame[];
  metadata: ClientVideoMetadata;
  /** Non-fatal issues (e.g. skipped seeks); surfaced to API and UI. */
  warnings: string[];
}

/**
 * Max wait for `loadedmetadata` / decode readiness. Prevents a hung or unsupported file from blocking the tab indefinitely.
 */
const LOAD_TIMEOUT_MS = 15_000;

/**
 * Max wait per seek. Some browsers stall on `seeked` for corrupt or odd streams; we skip that sample rather than hang the run.
 */
const SEEK_TIMEOUT_MS = 5_000;

function loadVideoMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Video loading timed out."));
    }, LOAD_TIMEOUT_MS);
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("Failed to load video. Format may not be supported by your browser."));
    };
    function cleanup() {
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onErr);
    }
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onErr, { once: true });
    video.load();
  });
}

function seekTo(video: HTMLVideoElement, ts: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onErr);
      resolve(ok);
    };
    const onSeeked = () => finish(true);
    const onErr = () => finish(false);
    const timer = window.setTimeout(() => finish(false), SEEK_TIMEOUT_MS);
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onErr, { once: true });
    try {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      const clamped = Math.min(Math.max(0, ts), Math.max(0, d - 0.02));
      video.currentTime = clamped;
    } catch {
      finish(false);
    }
  });
}

/**
 * Decodes a local video file in-browser, seeks to timestamps from {@link computeFrameTimestamps},
 * and exports JPEG frames as raw base64.
 *
 * @param file - User-selected video (`File` from input or drop).
 * @param _targetFrames - Reserved for API compatibility; timestamps are driven entirely by {@link computeFrameTimestamps}.
 * @returns Frames plus browser metadata and any seek warnings.
 *
 * @throws If duration is missing/zero, over 60s policy limit, dimensions missing, canvas unavailable, or no frames could be captured.
 */
export async function extractFramesInBrowser(
  file: File,
  _targetFrames: number = 10
): Promise<ClientExtractionResult> {
  void _targetFrames;
  const warnings: string[] = [];
  const url = URL.createObjectURL(file);

  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;

    await loadVideoMetadata(video);

    const duration = video.duration;
    const width = video.videoWidth;
    const height = video.videoHeight;

    // Reject zero/NaN duration (no timeline) or missing video plane (audio-only mislabeled as video, etc.).
    if (!duration || duration <= 0 || !Number.isFinite(duration)) {
      throw new Error("Could not determine video duration.");
    }

    if (duration > 60) {
      throw new Error("Video must be 60 seconds or shorter.");
    }

    if (width <= 0 || height <= 0) {
      throw new Error("Could not read video dimensions.");
    }

    const uniqueTimestamps = computeFrameTimestamps(duration);
    if (uniqueTimestamps.length === 0) {
      throw new Error("Could not compute frame timestamps.");
    }

    // Downscale wide sources to cap payload size; quality 0.85 balances size vs. vision detail.
    const maxWidth = 1280;
    const scale = width > maxWidth ? maxWidth / width : 1;
    const canvasWidth = Math.round(width * scale);
    const canvasHeight = Math.round(height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not get canvas context.");
    }

    const frames: ClientExtractedFrame[] = [];

    for (let i = 0; i < uniqueTimestamps.length; i++) {
      const ts = uniqueTimestamps[i];
      const ok = await seekTo(video, ts);
      if (!ok) {
        warnings.push(`Seek failed or timed out at ${ts}s; skipped.`);
        continue;
      }

      try {
        ctx.drawImage(video, 0, 0, canvasWidth, canvasHeight);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        const prefix = "data:image/jpeg;base64,";
        const base64 = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : dataUrl.split(",")[1] ?? "";
        if (!base64) {
          warnings.push(`Empty JPEG at ${ts}s; skipped.`);
          continue;
        }
        frames.push({
          index: frames.length,
          timestamp: ts,
          base64,
          width: canvasWidth,
          height: canvasHeight,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Frame extraction failed at ${ts}s: ${msg}`);
      }
    }

    if (frames.length === 0) {
      throw new Error("Could not extract any frames from the video.");
    }

    return {
      frames,
      metadata: {
        duration,
        width,
        height,
        fileSize: file.size,
        fileName: file.name,
        fileType: file.type || "video/mp4",
      },
      warnings,
    };
  } finally {
    // Revoke blob URL to avoid retaining the full file in memory after extraction.
    URL.revokeObjectURL(url);
  }
}
