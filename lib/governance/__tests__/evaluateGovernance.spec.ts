/**
 * Step 6 D5.1 — the first DIRECT tests of the System A evaluator.
 *
 * Every case calls the real `evaluateGovernance`. They pin the decision logic
 * as it stood at cdbd55fd (status + reasons) and the additive score-semantics
 * provenance D5.1 records beside it. Pinning `minConsensusToApprove`'s
 * non-effect is a characterization of current behaviour, not an endorsement:
 * changing it is the separate owner decision D5.2.
 */
import {
  evaluateGovernance,
  getDefaultGovernancePolicy,
  GOVERNANCE_SCORE_FAMILIES,
  type GovernanceInput,
  type GovernancePolicy,
  type GovernanceResult,
} from "@/lib/governance/evaluateGovernance";
import { governanceInputFromResearchRun, governanceInputFromVerificationDoc } from "@/lib/governance/governanceInputFromDocs";
import { buildSystemAMatrix, decisionDigest, type MatrixCase } from "./systemAGovernanceMatrix";

const PLAIN = "Is the sky blue at noon?";
const MEDICAL = "Is this medication dosage safe?";

/** An input on which NO rule other than the score fires. */
function clean(overrides: Partial<GovernanceInput> = {}): GovernanceInput {
  return {
    scoreFamily: "research_synthesis_v1",
    consensusScore: 90,
    evidenceQuality: "strong",
    sourceBacked: false,
    missingSourcesCount: 0,
    modelHealth: { ok: 5, substituted: 0, failed: 0 },
    question: PLAIN,
    runType: "research",
    ...overrides,
  };
}

const policy = (overrides: Partial<GovernancePolicy> = {}): GovernancePolicy => ({ ...getDefaultGovernancePolicy(), ...overrides });
const decide = (input: GovernanceInput, p: GovernancePolicy = policy()) => {
  const r = evaluateGovernance(input, p);
  return { status: r.status, reasons: r.reasons };
};

/** Digest of every matrix decision computed against the PRE-D5.1 evaluator at cdbd55fd. */
const BASELINE_MATRIX = { cases: 69120, digest: "015dbbb8022a94a425f6bcf21ad34f1e7e42b6d79f2c1a181516e7d0e6141ffb" };

describe("default policy — the values the evaluator is characterized against", () => {
  it("is 80 / 70 / 85 / 75 with every review rule on", () => {
    expect(getDefaultGovernancePolicy()).toEqual({
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
    });
  });
});

describe("general score boundary (minConsensusToAvoidReview = 70)", () => {
  it("69 → needs_review with exactly the score reason", () => {
    expect(decide(clean({ consensusScore: 69 }))).toEqual({ status: "needs_review", reasons: ["Consensus 69 below 70"] });
  });
  it.each([70, 79, 80, 100])("%i → approved with no reasons", (score) => {
    expect(decide(clean({ consensusScore: score }))).toEqual({ status: "approved", reasons: [] });
  });
  it("79 and 80 are decided identically — nothing happens at the stored 80", () => {
    expect(decide(clean({ consensusScore: 79 }))).toEqual(decide(clean({ consensusScore: 80 })));
  });
  it("the threshold is read from the policy, not hard-coded", () => {
    expect(decide(clean({ consensusScore: 65 }), policy({ minConsensusToAvoidReview: 60 }))).toEqual({ status: "approved", reasons: [] });
    expect(decide(clean({ consensusScore: 59 }), policy({ minConsensusToAvoidReview: 60 }))).toEqual({ status: "needs_review", reasons: ["Consensus 59 below 60"] });
  });
});

describe("minConsensusToApprove — stored and configurable, but no effect on any decision", () => {
  it.each([0, 50, 71, 80, 95, 100])("approve threshold %i leaves 70–79 approved and 69 in review", (approve) => {
    const p = policy({ minConsensusToApprove: approve });
    expect(decide(clean({ consensusScore: 70 }), p)).toEqual({ status: "approved", reasons: [] });
    expect(decide(clean({ consensusScore: 79 }), p)).toEqual({ status: "approved", reasons: [] });
    expect(decide(clean({ consensusScore: 69 }), p)).toEqual({ status: "needs_review", reasons: ["Consensus 69 below 70"] });
  });

  it("across the whole matrix, setting it to 0 or 100 changes no status and no reason", () => {
    for (const approve of [0, 100]) {
      const d = decisionDigest((c) => decide(c.input, { ...c.policy, minConsensusToApprove: approve }));
      expect(d).toEqual(BASELINE_MATRIX);
    }
  });

  it("NEGATIVE CONTROL — an evaluator that ENFORCED the 80 would be caught by the baseline pin", () => {
    // The same evaluator plus the one rule D5.1 must not add: review below minConsensusToApprove.
    const enforcing = (c: MatrixCase) => {
      const r = decide(c.input, c.policy);
      const s = c.input.consensusScore;
      if (r.status === "approved" && s !== null && s < c.policy.minConsensusToApprove) {
        return { status: "needs_review", reasons: [...r.reasons, `Consensus ${s} below ${c.policy.minConsensusToApprove}`] };
      }
      return r;
    };
    expect(decisionDigest(enforcing).digest).not.toBe(BASELINE_MATRIX.digest);
  });
});

describe("sensitive-domain boundary (85 approve / 75 avoid-review)", () => {
  const med = (score: number | null) => clean({ consensusScore: score, question: MEDICAL });
  it("84 → needs_review: below the sensitive approval threshold only", () => {
    expect(decide(med(84))).toEqual({ status: "needs_review", reasons: ["Sensitive domain (medical): consensus 84 below approval threshold 85"] });
  });
  it("85 passes both sensitive checks", () => {
    expect(decide(med(85))).toEqual({ status: "approved", reasons: [] });
  });
  it.each([75, 80])("%i (75–84) stays needs_review because the 85 rule still applies", (score) => {
    expect(decide(med(score))).toEqual({ status: "needs_review", reasons: [`Sensitive domain (medical): consensus ${score} below approval threshold 85`] });
  });
  it("below 75 adds the sensitive avoid-review reason before the approval reason", () => {
    expect(decide(med(74))).toEqual({
      status: "needs_review",
      reasons: ["Sensitive domain (medical): consensus 74 below 75", "Sensitive domain (medical): consensus 74 below approval threshold 85"],
    });
  });
  it("below 70 also adds the general reason, last", () => {
    expect(decide(med(60)).reasons).toEqual([
      "Sensitive domain (medical): consensus 60 below 75",
      "Sensitive domain (medical): consensus 60 below approval threshold 85",
      "Consensus 60 below 70",
    ]);
  });
  it("disabled sensitive evaluation leaves a medical question on the general rule", () => {
    expect(decide(med(72), policy({ sensitiveDomainsEnabled: false }))).toEqual({ status: "approved", reasons: [] });
  });
});

describe("null score", () => {
  it("→ needs_review with 'Consensus score not available'", () => {
    expect(decide(clean({ consensusScore: null }))).toEqual({ status: "needs_review", reasons: ["Consensus score not available"] });
  });
  it("on a sensitive question it is treated as 0 for the sensitive checks and displayed as N/A", () => {
    expect(decide(clean({ consensusScore: null, question: MEDICAL })).reasons).toEqual([
      "Sensitive domain (medical): consensus N/A below 75",
      "Sensitive domain (medical): consensus N/A below approval threshold 85",
      "Consensus score not available",
    ]);
  });
});

describe("other rules, each in isolation", () => {
  it("weak evidence", () => {
    expect(decide(clean({ evidenceQuality: "weak" }))).toEqual({ status: "needs_review", reasons: ["Evidence quality is weak"] });
  });
  it("failed model", () => {
    expect(decide(clean({ modelHealth: { ok: 4, substituted: 0, failed: 1 } }))).toEqual({ status: "needs_review", reasons: ["1 model(s) failed"] });
  });
  it("substituted model", () => {
    expect(decide(clean({ modelHealth: { ok: 4, substituted: 2, failed: 0 } }))).toEqual({ status: "needs_review", reasons: ["2 model(s) substituted"] });
  });
  it.each([
    ["disputed", "needs_review"],
    ["partially_true", "needs_review"],
    ["unverifiable", "needs_review"],
    ["confirmed", "approved"],
  ] as const)("verification verdict %s → %s", (verdict, status) => {
    const r = decide(clean({ runType: "verification", scoreFamily: "claim_verification_v1", verificationVerdict: verdict }));
    expect(r.status).toBe(status);
    expect(r.reasons).toEqual(status === "approved" ? [] : [`Claim verification verdict: ${verdict}`]);
  });
  it("a verdict on a research run is ignored", () => {
    expect(decide(clean({ verificationVerdict: "disputed" }))).toEqual({ status: "approved", reasons: [] });
  });
  it("source-backed run with missing sources → blocked", () => {
    expect(decide(clean({ sourceBacked: true, missingSourcesCount: 2 }))).toEqual({ status: "blocked", reasons: ["Missing sources in source-backed run (2 missing)"] });
  });
  it("blocked takes precedence over simultaneous review reasons, which are all still recorded", () => {
    const r = decide(clean({ sourceBacked: true, missingSourcesCount: 1, evidenceQuality: "weak", consensusScore: 10, modelHealth: { ok: 3, substituted: 1, failed: 1 } }));
    expect(r).toEqual({
      status: "blocked",
      reasons: ["Missing sources in source-backed run (1 missing)", "Evidence quality is weak", "1 model(s) failed", "1 model(s) substituted", "Consensus 10 below 70"],
    });
  });
});

describe("zero-outcome pin — the whole decision matrix matches the pre-D5.1 evaluator", () => {
  it("every status and every reason is identical to cdbd55fd", () => {
    expect(decisionDigest((c) => decide(c.input, c.policy))).toEqual(BASELINE_MATRIX);
  });
  it("the score family does not participate in any decision", () => {
    for (const family of GOVERNANCE_SCORE_FAMILIES) {
      expect(decisionDigest((c) => decide({ ...c.input, scoreFamily: family }, c.policy))).toEqual(BASELINE_MATRIX);
    }
  });
  it("the matrix reaches all three statuses (it is not a constant)", () => {
    const seen = new Set(buildSystemAMatrix().map((c) => decide(c.input, c.policy).status));
    expect([...seen].sort()).toEqual(["approved", "blocked", "needs_review"]);
  });
});

describe("evaluation provenance — GovernanceResult.meta", () => {
  const meta = (input: GovernanceInput, p: GovernancePolicy = policy()): GovernanceResult["meta"] => evaluateGovernance(input, p).meta;

  it("non-sensitive: exact family and the general avoid-review threshold only", () => {
    const m = meta(clean({ scoreFamily: "video_agreement_v1", runType: "verification" }));
    expect(m.scoreFamily).toBe("video_agreement_v1");
    expect(m.policyVersion).toBe(1);
    expect(typeof m.evaluatedAt).toBe("string");
    expect(m.scoreThresholdsInEffect).toEqual({ minConsensusToAvoidReview: 70, minConsensusToAvoidReviewSource: "shared" });
  });

  it("the unused general approval threshold is never recorded as in effect", () => {
    const m = meta(clean(), policy({ minConsensusToApprove: 93 }));
    expect(Object.keys(m.scoreThresholdsInEffect)).toEqual(["minConsensusToAvoidReview", "minConsensusToAvoidReviewSource"]);
    // Scoped to the threshold object: `evaluatedAt` is an ISO timestamp that can contain any digit run.
    expect(JSON.stringify(m.scoreThresholdsInEffect)).not.toContain("93");
  });

  it("sensitive: exact family, detected domain, and both sensitive thresholds", () => {
    const m = meta(clean({ scoreFamily: "claim_verification_v1", runType: "verification", question: "Review this employment contract clause" }));
    expect(m.scoreFamily).toBe("claim_verification_v1");
    expect(m.scoreThresholdsInEffect).toEqual({
      minConsensusToAvoidReview: 70,
      minConsensusToAvoidReviewSource: "shared",
      sensitive: { domain: "legal", minConsensusToAvoidReview: 75, minConsensusToApprove: 85 },
    });
  });

  it("records the SUPPLIED policy values, not the defaults", () => {
    const p = policy({ policyVersion: 9, minConsensusToAvoidReview: 61, sensitiveMinConsensusToAvoidReview: 52, sensitiveMinConsensusToApprove: 88, minConsensusToApprove: 99 });
    expect(meta(clean({ question: "What is the fiscal outlook?" }), p)).toEqual(
      expect.objectContaining({
        policyVersion: 9,
        scoreFamily: "research_synthesis_v1",
        scoreThresholdsInEffect: { minConsensusToAvoidReview: 61, minConsensusToAvoidReviewSource: "shared", sensitive: { domain: "financial", minConsensusToAvoidReview: 52, minConsensusToApprove: 88 } },
      })
    );
  });

  it("no sensitive block when the domain is detected but sensitive evaluation is disabled", () => {
    expect(meta(clean({ question: MEDICAL }), policy({ sensitiveDomainsEnabled: false })).scoreThresholdsInEffect).toEqual({ minConsensusToAvoidReview: 70, minConsensusToAvoidReviewSource: "shared" });
  });

  it("a null score still records what was in effect (the comparison itself is not reached)", () => {
    const r = evaluateGovernance(clean({ consensusScore: null }), policy());
    expect(r.reasons).toEqual(["Consensus score not available"]);
    expect(r.meta.scoreThresholdsInEffect).toEqual({ minConsensusToAvoidReview: 70, minConsensusToAvoidReviewSource: "shared" });
  });

  it("the sensitive block has no undefined-valued key", () => {
    const m = meta(clean());
    expect("sensitive" in m.scoreThresholdsInEffect).toBe(false);
  });

  it.each(GOVERNANCE_SCORE_FAMILIES)("passes %s through unchanged", (family) => {
    expect(meta(clean({ scoreFamily: family })).scoreFamily).toBe(family);
  });

  it("the family set is closed and exact", () => {
    expect([...GOVERNANCE_SCORE_FAMILIES]).toEqual(["claim_verification_v1", "video_agreement_v1", "research_synthesis_v1"]);
  });
});

describe("persisted-document builders assign the family of the artifact they read", () => {
  it("governanceInputFromResearchRun → research_synthesis_v1", () => {
    expect(governanceInputFromResearchRun({ question: "q", synthesisConsensusSummary: { overallConsensusScore: 72 } }).scoreFamily).toBe("research_synthesis_v1");
  });
  it("governanceInputFromVerificationDoc → claim_verification_v1", () => {
    expect(governanceInputFromVerificationDoc({ claim: "c", consensusScore: 72, verdict: "confirmed" }).scoreFamily).toBe("claim_verification_v1");
  });
  it("the family ignores any stored field that tries to name another family", () => {
    expect(governanceInputFromVerificationDoc({ claim: "c", scoreFamily: "video_agreement_v1" }).scoreFamily).toBe("claim_verification_v1");
    expect(governanceInputFromResearchRun({ question: "q", scoreFamily: "claim_verification_v1" }).scoreFamily).toBe("research_synthesis_v1");
  });
});
