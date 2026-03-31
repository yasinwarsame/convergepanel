/**
 * Pure video verification logic — no server-only or ffmpeg dependencies.
 * Safe to import from both client and server code.
 *
 * Contains: type definitions, frame timestamp calculation, metadata analysis.
 */

/**
 * One JPEG frame as raw base64 (no `data:` URL prefix), from client extraction or compatible pipelines.
 */
export interface ExtractedFrame {
  /** Monotonic index among frames sent for this verification (0-based). */
  index: number;
  /** Time in seconds within the source video where this frame was captured. */
  timestamp: number;
  /** JPEG payload, base64-encoded without prefix. */
  base64: string;
  /** Pixel width after any client-side scaling. */
  width: number;
  /** Pixel height after any client-side scaling. */
  height: number;
}

/**
 * Normalized video file metadata used for prompts, heuristics, and Firestore (no raw frames).
 */
export interface VideoMetadata {
  /** Duration in seconds (from browser or client). */
  duration: number;
  width: number;
  height: number;
  /** Human-readable codec label or `"unknown"`. */
  codec: string;
  /** Frames per second when known; `0` if not reported. */
  frameRate: number;
  /** Original file size in bytes. */
  fileSize: number;
  /** Container subtype, e.g. `mp4`, `quicktime`. */
  format: string;
  /** ISO 8601 creation time from container when available. */
  createdAt: string | null;
  /** Encoder / tool string from container or heuristics. */
  encodingSoftware: string | null;
  /** Whether an audio track was detected in the container. */
  hasAudio: boolean;
  /** Device / camera hint from container (e.g. iPhone 16 Pro). */
  cameraModel: string | null;
}

/**
 * Single heuristic finding from {@link analyzeMetadata}.
 */
export interface MetadataFlag {
  /** Logical field name (e.g. `createdAt`, `encodingSoftware`). */
  field: string;
  /** Human-readable explanation shown in UI / prompts. */
  observation: string;
  /**
   * - `info`: contextual note, low concern
   * - `warning`: missing or weak metadata signal
   * - `suspicious`: possible integrity / AI-generation cue (also reduces consensus score in API)
   */
  severity: "info" | "warning" | "suspicious";
}

/**
 * Aggregate metadata analysis: ordered flags plus a single-line summary for models.
 */
export interface MetadataAnalysis {
  flags: MetadataFlag[];
  summary: string;
}

/** Substrings (lowercase) matched against `encodingSoftware` for AI-video tool fingerprints. */
const AI_ENCODING_MARKERS = [
  "runway",
  "pika",
  "sora",
  "kling",
  "synthesia",
  "heygen",
  "d-id",
  "d_id",
  "did",
  "stable video",
  "stablevideo",
  "luma",
  "minimax",
  "hailuo",
] as const;

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function ratioLabel(w: number, h: number): { w: number; h: number } {
  const g = gcd(w, h);
  return { w: w / g, h: h / g };
}

/**
 * Computes seek timestamps (seconds) for sampling frames along a clip.
 *
 * **Algorithm**
 * - Caps effective duration at 60s (longer files are treated as 60s for sampling density).
 * - Target count: 10 by default; **4** if duration &lt; 3s; **12** if duration ≥ 55s.
 * - Builds candidates: first ~0.5s (or 5% of duration), last ~duration−0.5s, plus evenly spaced
 *   interior points at `interval = d / (targetFrames + 1)`.
 * - Sorts, rounds to ms, **dedupes** with 80ms epsilon so seeks don’t stack on the same frame.
 * - If still above the cap (e.g. many near-duplicates), **subsamples** evenly across the sorted list
 *   down to the max frame budget.
 *
 * **Edge cases**
 * - Non-finite or ≤0 duration → `[]` (caller must reject before extraction).
 * - Very short clips still get at least a spread toward 4 distinct targets when possible.
 */
export function computeFrameTimestamps(durationSec: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const d = Math.min(durationSec, 60);
  let targetFrames = 10;
  if (d < 3) targetFrames = 4;
  else if (d >= 55) targetFrames = 12;

  const interval = d / (targetFrames + 1);
  const candidates: number[] = [];

  const firstMark = Math.min(0.5, Math.max(0.02, d * 0.05));
  const lastMark = Math.max(d - 0.5, d * 0.95);
  candidates.push(firstMark, lastMark);
  for (let i = 1; i <= targetFrames; i++) {
    candidates.push(Math.min(d - 0.001, i * interval));
  }

  const sorted = [...candidates].sort((a, b) => a - b);
  const out: number[] = [];
  const eps = 0.08;
  for (const t of sorted) {
    const k = Math.round(Math.max(0, Math.min(d - 0.001, t)) * 1000) / 1000;
    if (out.some((u) => Math.abs(u - k) < eps)) continue;
    out.push(k);
  }

  const maxFrames = d >= 55 ? 12 : d < 3 ? 4 : 10;
  if (out.length <= maxFrames) return out;

  const subsampled: number[] = [];
  const lastIdx = out.length - 1;
  for (let i = 0; i < maxFrames; i++) {
    const idx = Math.round((i / Math.max(1, maxFrames - 1)) * lastIdx);
    subsampled.push(out[idx]);
  }
  const deduped: number[] = [];
  for (const t of subsampled.sort((a, b) => a - b)) {
    if (deduped.length === 0 || Math.abs(t - deduped[deduped.length - 1]) >= eps) {
      deduped.push(t);
    }
  }
  return deduped;
}

/**
 * Runs lightweight heuristics on {@link VideoMetadata} for UI flags and model context.
 *
 * **Checks (non-exhaustive)**
 * - `createdAt`: missing → `warning`; parsed future date → `suspicious`
 * - `encodingSoftware`: substring match against {@link AI_ENCODING_MARKERS} → `suspicious`
 * - Aspect ratio: not 16:9, 4:3, or 9:16 → `info`
 * - `frameRate`: 0 &lt; fps &lt; 15 → `info` (screen cap / animation hint)
 * - `hasAudio`: false → `info`
 * - `cameraModel`: any non-empty → `info` (device reported in container)
 * - Bitrate proxy `fileSize / (duration * pixels)`: very low or very high → `info`
 */
export function analyzeMetadata(metadata: VideoMetadata): MetadataAnalysis {
  const flags: MetadataFlag[] = [];

  if (!metadata.createdAt || !metadata.createdAt.trim()) {
    flags.push({
      field: "createdAt",
      observation: "No creation date in metadata",
      severity: "warning",
    });
  } else {
    const t = Date.parse(metadata.createdAt);
    if (!Number.isNaN(t) && t > Date.now()) {
      flags.push({
        field: "createdAt",
        observation: "Creation date is in the future",
        severity: "suspicious",
      });
    }
  }

  const enc = (metadata.encodingSoftware ?? "").toLowerCase();
  for (const marker of AI_ENCODING_MARKERS) {
    if (enc.includes(marker)) {
      flags.push({
        field: "encodingSoftware",
        observation: `Encoding software associated with AI video generation: ${metadata.encodingSoftware ?? marker}`,
        severity: "suspicious",
      });
      break;
    }
  }

  if (metadata.width > 0 && metadata.height > 0) {
    const { w, h } = ratioLabel(metadata.width, metadata.height);
    const standard =
      (w === 16 && h === 9) || (w === 4 && h === 3) || (w === 9 && h === 16);
    if (!standard) {
      flags.push({
        field: "resolution",
        observation: "Non-standard aspect ratio",
        severity: "info",
      });
    }
  }

  if (metadata.frameRate > 0 && metadata.frameRate < 15) {
    flags.push({
      field: "frameRate",
      observation: "Low frame rate may indicate screen recording or animation",
      severity: "info",
    });
  }

  if (!metadata.hasAudio) {
    flags.push({
      field: "audio",
      observation: "No audio track present",
      severity: "info",
    });
  }

  const cam = (metadata.cameraModel ?? "").trim();
  if (cam) {
    flags.push({
      field: "cameraModel",
      observation: `Container reports capture device: ${cam}`,
      severity: "info",
    });
  }

  if (metadata.duration > 0 && metadata.fileSize > 0 && metadata.width > 0 && metadata.height > 0) {
    const pixels = metadata.width * metadata.height;
    const bpp = metadata.fileSize / (metadata.duration * pixels);
    if (bpp < 0.02) {
      flags.push({
        field: "fileSize",
        observation: "File size is very small relative to duration and resolution (heavy compression)",
        severity: "info",
      });
    } else if (bpp > 8) {
      flags.push({
        field: "fileSize",
        observation: "File size is unusually large relative to duration and resolution",
        severity: "info",
      });
    }
  }

  const summary =
    flags.length === 0
      ? "No notable metadata flags."
      : flags.map((f) => `[${f.severity}] ${f.field}: ${f.observation}`).join(" ");

  return { flags, summary };
}
