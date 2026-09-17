/**
 * TEAM-VERIFICATION-PARITY-R3 — the browser-facing Team Claim verification
 * LIST summary DTO. Summary only: full evidence belongs to the detail read.
 *
 * Deliberately never carries the creator uid, reviewer identity, membership or
 * capability data, origin/source ids, raw Firestore timestamps, model evidence
 * or Project internals beyond the public `{ id, name, status }` label.
 */

import "server-only";
import type { ClaimVerdict } from "@/lib/verification/claimVerdict";
import { firestoreSecondsNanos } from "@/lib/runs/runSummary";

export type TeamClaimVerificationProjectDto = { id: string; name: string; status: string };

export type TeamClaimVerificationSummaryDto = {
  verificationId: string;
  claim: string;
  verdict: ClaimVerdict;
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality: "strong" | "mixed" | "weak";
  governanceStatus?: "approved" | "needs_review" | "blocked";
  createdAt: string;
  workspaceId: string;
  projectId: string | null;
  project: TeamClaimVerificationProjectDto | null;
};

const VERDICTS: ReadonlySet<string> = new Set(["confirmed", "disputed", "partially_true", "unverifiable"]);
const CONFIDENCE: ReadonlySet<string> = new Set(["High", "Medium", "Low"]);
const EVIDENCE: ReadonlySet<string> = new Set(["strong", "mixed", "weak"]);

/** ISO string for a stored Firestore Timestamp-like value (seconds + nanoseconds). */
export function teamClaimTimestampIso(value: unknown): string {
  const { seconds, nanoseconds } = firestoreSecondsNanos(value);
  return new Date(seconds * 1000 + Math.floor(nanoseconds / 1_000_000)).toISOString();
}

/**
 * Returns `null` when the summary fields a Team writer always persists are
 * unusable, so the caller can fail the whole window rather than emit a
 * partial or fabricated row. `evidenceQuality` falls back to `"mixed"`,
 * exactly like the canonical detail mapper.
 */
export function toTeamClaimVerificationSummary(args: {
  verificationId: string;
  data: Record<string, unknown>;
  workspaceId: string;
  projectId: string | null;
  project: TeamClaimVerificationProjectDto | null;
}): TeamClaimVerificationSummaryDto | null {
  const d = args.data;
  if (typeof d.claim !== "string") return null;
  if (typeof d.verdict !== "string" || !VERDICTS.has(d.verdict)) return null;
  if (typeof d.consensusScore !== "number" || !Number.isFinite(d.consensusScore)) return null;
  if (typeof d.confidenceLabel !== "string" || !CONFIDENCE.has(d.confidenceLabel)) return null;
  const evidenceQuality = typeof d.evidenceQuality === "string" && EVIDENCE.has(d.evidenceQuality) ? (d.evidenceQuality as TeamClaimVerificationSummaryDto["evidenceQuality"]) : "mixed";
  const governanceStatus = d.governanceStatus === "approved" || d.governanceStatus === "needs_review" || d.governanceStatus === "blocked" ? d.governanceStatus : undefined;
  return {
    verificationId: args.verificationId,
    claim: d.claim,
    verdict: d.verdict as ClaimVerdict,
    consensusScore: d.consensusScore,
    confidenceLabel: d.confidenceLabel as TeamClaimVerificationSummaryDto["confidenceLabel"],
    evidenceQuality,
    ...(governanceStatus ? { governanceStatus } : {}),
    createdAt: teamClaimTimestampIso(d.timestamp),
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    project: args.project,
  };
}
