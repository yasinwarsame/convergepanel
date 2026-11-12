/**
 * Claim verification pipeline: parsing, scoring, audit bundles, and prompts.
 */

import type { AuditBundle } from "@/lib/verification/auditBundle";
import type { StoredConsensusIndependence } from "@/lib/panel/independentVoices";

export type ClaimVerdictUi = "confirmed" | "disputed" | "partially_true" | "unverifiable";

/**
 * Phase 11A.5B — the durable, client-safe navigation DTO for "this
 * verification came from this Deep Research run/finding." Deliberately a
 * SEPARATE type from the internal persisted `ClaimVerificationOrigin`
 * (lib/verification/claimVerificationOrigin.ts), not a re-export or
 * alias of it — persistence model != automatically public client
 * contract. Never carries `projectId` (a source run's project
 * association can legitimately change after the verification was
 * created; the durable relationship is runId+claimId, not a frozen
 * project equality) or `workspaceId` (Personal-only in this phase) or
 * any claim/finding text (`verification.claim` is already the immutable
 * snapshot — this DTO exists purely to navigate back, not to restate
 * content).
 */
export type ClaimVerificationSourceResearch = {
  type: "deep_research_claim";
  runId: string;
  claimId: string;
};

export type ClaimVerificationClientPayload = {
  /** Firestore document id / server verification id (for audit display & export). */
  verificationId?: string;
  claim: string;
  verdict: ClaimVerdictUi;
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality?: "strong" | "mixed" | "weak";
  supportRatio?: number;
  modelEvidence: Array<{
    modelId: string;
    status?: "ok" | "parse_error" | "failed";
    verdict: string;
    confidence: string;
    summary: string;
    correctParts: string[];
    incorrectParts: string[];
    unverifiableParts: string[];
    /**
     * C-b: the row's recorded execution facts, present only when recorded (a substitute answered the slot; the
     * executing provider — since Order 33 also the own provider of a successful answer, stamped by the claim dispatch). Read only through the shared gate (lib/panel/storedVerificationIndependence.ts
     * `claimPresentedIndependence`); a model count is never inferred from the slot.
     */
    substituted?: true;
    provider?: string;
  }>;
  /** Slot counts (rows / rows with a usable verdict), never model counts. */
  aggregateSummary: {
    totalModels: number;
    modelsAgreeAccurate: number;
    modelsAgreeInaccurate: number;
    modelsPartial: number;
    modelsUnverifiable: number;
  };
  whereModelsAgree: string[];
  whereModelsDisagree: Array<{ point: string; models: string[] }>;
  auditBundle: AuditBundle;
  accurateAmongUsable?: number;
  usableModelCount?: number;
  governanceReviewRequired?: boolean;
  blockedByPolicy?: boolean;
  policyBlockMessage?: string;
  policyFlags?: string[];
  /** Org governance evaluation (paid plans). */
  governanceStatus?: "approved" | "needs_review" | "blocked";
  /**
   * Whether the stored rows prove >= 2 independent executing models with a usable answer
   * (`storedVerificationConsensusIndependence`, computed server-side from the persisted record). Only "independent"
   * presents `consensusScore` as a multi-model consensus (lib/verification/claimConsensusPresentation.ts); absent is
   * treated as "unverified" (fail closed). `consensusScore` itself stays the stored value.
   */
  modelIndependence?: StoredConsensusIndependence;
  /**
   * Phase 11A.5B — present (as an object or explicit `null`) on a
   * PERSONAL verification DETAIL read only; absent on every other
   * caller/response shape (list/history rows, Team reads not yet wired
   * in this phase, and any pre-11A.5B consumer), which keeps this a
   * purely additive, backward-compatible field. `null` covers every
   * source-unavailable case uniformly (missing/foreign/malformed run,
   * unsupported schema, fingerprint mismatch) — no distinguishable
   * reason is ever exposed.
   */
  sourceResearch?: ClaimVerificationSourceResearch | null;
};
