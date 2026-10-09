/**
 * Step 6 D5.1 — a deterministic System A decision matrix (test helper, not a spec).
 *
 * Crosses every rule `evaluateGovernance` reads — score boundaries, sensitive
 * domain, evidence quality, model health, verification verdict, source
 * completeness — under five policies (defaults, custom values, and each rule
 * family switched off). The digest of every case's `status` + `reasons` was
 * computed by running THIS matrix against the pre-D5.1 evaluator at
 * cdbd55fd, so a D5.1-era evaluator that changes any decision fails the pin.
 * Metadata is excluded on purpose: it is the only thing D5.1 may change.
 */
import { createHash } from "crypto";
import type { GovernanceInput, GovernancePolicy } from "@/lib/governance/evaluateGovernance";

export const MATRIX_SCORES: readonly (number | null)[] = [null, 0, 50, 69, 70, 74, 75, 79, 80, 84, 85, 100];
const QUESTIONS = ["Is the sky blue at noon?", "Is this medication dosage safe for a patient?", "What is the fiscal outlook?"];
const EVIDENCE: GovernanceInput["evidenceQuality"][] = [null, "strong", "mixed", "weak"];
const HEALTH: GovernanceInput["modelHealth"][] = [
  { ok: 5, substituted: 0, failed: 0 },
  { ok: 4, substituted: 0, failed: 1 },
  { ok: 4, substituted: 1, failed: 0 },
  { ok: 3, substituted: 1, failed: 1 },
];
const SOURCES: Pick<GovernanceInput, "sourceBacked" | "missingSourcesCount">[] = [
  { sourceBacked: false, missingSourcesCount: 0 },
  { sourceBacked: true, missingSourcesCount: 0 },
  { sourceBacked: true, missingSourcesCount: 2 },
  { sourceBacked: false, missingSourcesCount: 3 },
];
const RUN_SHAPES: Pick<GovernanceInput, "runType" | "verificationVerdict" | "scoreFamily">[] = [
  { runType: "research", scoreFamily: "research_synthesis_v1" },
  { runType: "verification", verificationVerdict: null, scoreFamily: "claim_verification_v1" },
  { runType: "verification", verificationVerdict: "confirmed", scoreFamily: "claim_verification_v1" },
  { runType: "verification", verificationVerdict: "disputed", scoreFamily: "video_agreement_v1" },
  { runType: "verification", verificationVerdict: "partially_true", scoreFamily: "claim_verification_v1" },
  { runType: "verification", verificationVerdict: "unverifiable", scoreFamily: "video_agreement_v1" },
];

const DEFAULTS: GovernancePolicy = {
  policyVersion: 1,
  minConsensusToApprove: 80,
  minConsensusToAvoidReview: 70,
  blockIfSourceBackedMissingSources: true,
  reviewIfAnyModelSubstituted: true,
  reviewIfAnyModelFailed: true,
  sensitiveDomainsEnabled: true,
  sensitiveMinConsensusToApprove: 85,
  sensitiveMinConsensusToAvoidReview: 75,
  reviewIfEvidenceQualityWeak: true,
  reviewIfVerificationVerdictIn: ["Disputed", "Unverifiable", "Partially True"],
};

export const MATRIX_POLICIES: readonly GovernancePolicy[] = [
  DEFAULTS,
  { ...DEFAULTS, policyVersion: 7, minConsensusToApprove: 95, minConsensusToAvoidReview: 60, sensitiveMinConsensusToApprove: 90, sensitiveMinConsensusToAvoidReview: 50 },
  { ...DEFAULTS, sensitiveDomainsEnabled: false },
  { ...DEFAULTS, reviewIfAnyModelFailed: false, reviewIfAnyModelSubstituted: false, reviewIfEvidenceQualityWeak: false, reviewIfVerificationVerdictIn: [] },
  { ...DEFAULTS, blockIfSourceBackedMissingSources: false, minConsensusToApprove: 0 },
];

export type MatrixCase = { policy: GovernancePolicy; input: GovernanceInput };

export function buildSystemAMatrix(): MatrixCase[] {
  const out: MatrixCase[] = [];
  for (const policy of MATRIX_POLICIES)
    for (const consensusScore of MATRIX_SCORES)
      for (const question of QUESTIONS)
        for (const evidenceQuality of EVIDENCE)
          for (const modelHealth of HEALTH)
            for (const source of SOURCES)
              for (const shape of RUN_SHAPES)
                out.push({ policy, input: { ...shape, ...source, consensusScore, question, evidenceQuality, modelHealth } });
  return out;
}

/** sha256 over each case's decision — `status` and `reasons` only, in matrix order. */
export function decisionDigest(decide: (c: MatrixCase) => { status: string; reasons: string[] }): { cases: number; digest: string } {
  const cases = buildSystemAMatrix();
  const hash = createHash("sha256");
  for (const c of cases) {
    const r = decide(c);
    hash.update(JSON.stringify([r.status, r.reasons]));
    hash.update("\n");
  }
  return { cases: cases.length, digest: hash.digest("hex") };
}
