/**
 * Evidence Workspace, Phase 11A.4 — the response-shaping counterpart to
 * `buildDeepResearchClaimId()` (lib/verification/claimVerificationOrigin.ts),
 * which was reserved by 11A.1 explicitly for "a future phase's read-model,
 * at the moment a finding is first presented to a user." This is that
 * moment: called only where a `deep_research` result's JSON response is
 * being constructed for the client, never where it is persisted.
 *
 * Pure and non-mutating — always returns a NEW `DeepResearchResult` with
 * new `findings`/`lowConfidenceFindings` arrays. Callers must assign the
 * return value to the RESPONSE payload only, never write it back to
 * whatever object is (or will be) persisted to Firestore — a finding's
 * `claimId` is deterministically recomputable from stable persisted data
 * (`runId` + section + index + the finding's own `id`/`summary`), so
 * persisting it would be redundant, not merely unwanted.
 */

import "server-only";
import { buildDeepResearchClaimId, type DeepResearchClaimSection } from "./claimVerificationOrigin";
import type { AggregatedResearchFinding, DeepResearchResult } from "@/lib/adaptiveSchema/types";

function withClaimIds(
  runId: string,
  section: DeepResearchClaimSection,
  findings: AggregatedResearchFinding[]
): AggregatedResearchFinding[] {
  return findings.map((finding, index) => ({
    ...finding,
    claimId: buildDeepResearchClaimId({ runId, section, index, finding }),
  }));
}

export function attachDeepResearchClaimIds(runId: string, deepResearch: DeepResearchResult): DeepResearchResult {
  return {
    ...deepResearch,
    findings: withClaimIds(runId, "findings", deepResearch.findings),
    lowConfidenceFindings: withClaimIds(runId, "lowConfidenceFindings", deepResearch.lowConfidenceFindings),
  };
}
