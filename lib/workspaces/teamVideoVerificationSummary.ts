/**
 * TEAM-VERIFICATION-PARITY-R5-I1 — the browser-facing Team Video verification
 * LIST summary DTO. Summary only: frames, per-model evidence, metadata
 * analysis, agreement/disagreement points and the audit trail all belong to
 * the detail read.
 *
 * Deliberately never carries the creator uid, the creator's email, reviewer or
 * membership identity, raw frame/base64 data, the metadata blob, provider
 * prompts, token totals, billing/quota state or Project internals beyond the
 * public `{ id, name, status }` label.
 *
 * STRICTNESS IS THE POINT (R5-I1 §M). `mapStoredVideoVerificationToClientPayload`
 * is tolerant PRESENTATION logic for an already-authorized single artifact: it
 * substitutes `"Uploaded video"` for a missing file name, `"inconclusive"` for
 * a missing verdict, `0` for a missing consensus score or frame count, `"Low"`
 * confidence and `"weak"` evidence quality. Those fallbacks must NOT leak into
 * a list: a row that cannot produce every required summary field is an
 * integrity failure that fails the WHOLE page, never a row silently rendered
 * with fabricated values. This module therefore returns `null` rather than
 * defaulting anything, and validates its own timestamp instead of reusing
 * `firestoreSecondsNanos()`'s tolerant `{0,0}` fallback (which would render a
 * malformed row as 1970-01-01 rather than failing).
 */

import "server-only";

export type TeamVideoVerificationProjectDto = { id: string; name: string; status: string };

export type TeamVideoVerificationSummaryDto = {
  verificationId: string;
  fileName: string;
  verdict: string;
  contentType?: string;
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality: "strong" | "mixed" | "weak";
  frameCount: number;
  createdAt: string;
  workspaceId: string;
  projectId: string | null;
  project: TeamVideoVerificationProjectDto | null;
  governanceStatus?: "approved" | "needs_review" | "blocked";
};

/**
 * The canonical aggregate Video verdicts produced by
 * `executeVideoVerification()`, plus the historical `"authentic"` label: the
 * shared `VideoVerificationResultView` still carries an explicit
 * `verdictConfig` entry for it, so a stored row using it is displayable and
 * must not be treated as corrupt.
 */
const VERDICTS: ReadonlySet<string> = new Set(["authentic_captured", "authentic_produced", "likely_manipulated", "inconclusive", "insufficient", "authentic"]);
const CONFIDENCE: ReadonlySet<string> = new Set(["High", "Medium", "Low"]);
const EVIDENCE: ReadonlySet<string> = new Set(["strong", "mixed", "weak"]);

const MAX_NANOSECONDS = 999_999_999;

/**
 * ISO string for a stored Firestore Timestamp, or `null` when the value is not
 * a usable seconds/nanoseconds pair. Same seconds/nanoseconds discipline the
 * Team Claim summary uses — never `Date.parse()` of an arbitrary stored value —
 * but strict where that one is tolerant.
 */
export function teamVideoTimestampIso(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { seconds?: unknown; nanoseconds?: unknown };
  if (typeof v.seconds !== "number" || !Number.isFinite(v.seconds) || !Number.isInteger(v.seconds)) return null;
  if (typeof v.nanoseconds !== "number" || !Number.isFinite(v.nanoseconds) || !Number.isInteger(v.nanoseconds) || v.nanoseconds < 0 || v.nanoseconds > MAX_NANOSECONDS) return null;
  const millis = v.seconds * 1000 + Math.floor(v.nanoseconds / 1_000_000);
  if (!Number.isFinite(millis)) return null;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Returns `null` when ANY required summary field is unusable, so the caller
 * fails the whole window rather than emitting a partial or fabricated row.
 *
 * `consensusScore` is required to be a finite number in `[0, 100]`: the Team
 * Video writer has exactly one source for it — `executeVideoVerification()`,
 * which clamps with `Math.min(100, Math.max(0, ...))` before
 * `saveTeamVideoVerification()` ever sees it — so the range is a genuine
 * invariant of every Team row, not an assumption.
 *
 * `frameCount` is required to be a non-negative integer for the same reason:
 * the writer persists `frames.length`.
 *
 * `contentType` and `governanceStatus` are optional; they are emitted only
 * when genuinely present and well formed, and are never manufactured.
 */
export function toTeamVideoVerificationSummary(args: {
  verificationId: string;
  data: Record<string, unknown>;
  workspaceId: string;
  projectId: string | null;
  project: TeamVideoVerificationProjectDto | null;
}): TeamVideoVerificationSummaryDto | null {
  if (typeof args.verificationId !== "string" || args.verificationId.length === 0) return null;
  if (typeof args.workspaceId !== "string" || args.workspaceId.length === 0) return null;
  if (!(args.projectId === null || (typeof args.projectId === "string" && args.projectId.length > 0))) return null;

  const d = args.data;
  if (typeof d.fileName !== "string" || d.fileName.length === 0) return null;
  if (typeof d.verdict !== "string" || !VERDICTS.has(d.verdict)) return null;
  if (typeof d.consensusScore !== "number" || !Number.isFinite(d.consensusScore) || d.consensusScore < 0 || d.consensusScore > 100) return null;
  if (typeof d.confidenceLabel !== "string" || !CONFIDENCE.has(d.confidenceLabel)) return null;
  if (typeof d.evidenceQuality !== "string" || !EVIDENCE.has(d.evidenceQuality)) return null;
  if (typeof d.frameCount !== "number" || !Number.isFinite(d.frameCount) || !Number.isInteger(d.frameCount) || d.frameCount < 0) return null;

  const createdAt = teamVideoTimestampIso(d.timestamp);
  if (createdAt === null) return null;

  // Optional, never fabricated: an absent value is omitted, a present but
  // malformed one fails the row rather than being quietly dropped.
  let contentType: string | undefined;
  if (d.contentType !== undefined) {
    if (typeof d.contentType !== "string" || d.contentType.length === 0) return null;
    contentType = d.contentType;
  }
  let governanceStatus: TeamVideoVerificationSummaryDto["governanceStatus"];
  if (d.governanceStatus !== undefined && d.governanceStatus !== null) {
    if (d.governanceStatus !== "approved" && d.governanceStatus !== "needs_review" && d.governanceStatus !== "blocked") return null;
    governanceStatus = d.governanceStatus;
  }

  return {
    verificationId: args.verificationId,
    fileName: d.fileName,
    verdict: d.verdict,
    ...(contentType !== undefined ? { contentType } : {}),
    consensusScore: d.consensusScore,
    confidenceLabel: d.confidenceLabel as TeamVideoVerificationSummaryDto["confidenceLabel"],
    evidenceQuality: d.evidenceQuality as TeamVideoVerificationSummaryDto["evidenceQuality"],
    frameCount: d.frameCount,
    createdAt,
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    project: args.project,
    ...(governanceStatus !== undefined ? { governanceStatus } : {}),
  };
}
