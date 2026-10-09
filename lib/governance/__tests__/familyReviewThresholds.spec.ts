/**
 * Step 6 D5.2A — score-type (family) review thresholds.
 *
 * Contract under test:
 * - only video_agreement_v1 / research_synthesis_v1 may be overridden; claims always use the shared value;
 * - absent / malformed overrides degrade to the shared value (source "shared"), never to a stricter decision;
 * - with no map, or a map equal to the shared value, every decision equals the pre-D5.2A baseline digest;
 * - one family's override cannot change another family's decision.
 */
import {
  evaluateGovernance,
  getDefaultGovernancePolicy,
  GOVERNANCE_SCORE_FAMILIES,
  type GovernanceInput,
  type GovernancePolicy,
  type GovernanceScoreFamily,
} from "@/lib/governance/evaluateGovernance";
import {
  applyFamilyReviewThresholdsMutation,
  FAMILY_REVIEW_THRESHOLD_FAMILIES,
  familyReviewThresholdChangeNames,
  readPersistedFamilyReviewThresholds,
  resolveGeneralReviewThreshold,
  validateFamilyReviewThresholdsMutation,
} from "@/lib/governance/familyReviewThresholds";
import { buildSystemAMatrix, decisionDigest, type MatrixCase } from "./systemAGovernanceMatrix";

/** The D5.1 pin: every matrix decision of the evaluator at cdbd55fd (and at 64be8a86). */
const BASELINE_MATRIX = { cases: 69120, digest: "015dbbb8022a94a425f6bcf21ad34f1e7e42b6d79f2c1a181516e7d0e6141ffb" };

const policy = (over: Partial<GovernancePolicy> = {}): GovernancePolicy => ({ ...getDefaultGovernancePolicy(), ...over });
const input = (family: GovernanceScoreFamily, score: number | null, over: Partial<GovernanceInput> = {}): GovernanceInput => ({
  scoreFamily: family,
  consensusScore: score,
  evidenceQuality: "strong",
  sourceBacked: false,
  missingSourcesCount: 0,
  modelHealth: { ok: 5, substituted: 0, failed: 0 },
  question: "Is the sky blue at noon?",
  runType: family === "research_synthesis_v1" ? "research" : "verification",
  ...(family === "research_synthesis_v1" ? {} : { verificationVerdict: "confirmed" as const }),
  ...over,
});
const decide = (i: GovernanceInput, p: GovernancePolicy) => {
  const r = evaluateGovernance(i, p);
  return { status: r.status, reasons: r.reasons };
};
/** A matrix digest with a policy transform applied to every case. */
const digestWith = (transform: (p: GovernancePolicy, c: MatrixCase) => GovernancePolicy) =>
  decisionDigest((c) => decide(c.input, transform(c.policy, c)));

describe("the closed family set", () => {
  it("is exactly video and research — never claim", () => {
    expect([...FAMILY_REVIEW_THRESHOLD_FAMILIES]).toEqual(["video_agreement_v1", "research_synthesis_v1"]);
  });
  it("the default policy carries no family map (absence = uses shared)", () => {
    expect("scoreFamilyReviewThresholds" in getDefaultGovernancePolicy()).toBe(false);
  });
});

describe("resolveGeneralReviewThreshold", () => {
  it("no map → shared for every family", () => {
    for (const f of GOVERNANCE_SCORE_FAMILIES) expect(resolveGeneralReviewThreshold(policy(), f)).toEqual({ value: 70, source: "shared" });
  });
  it("video override → video only", () => {
    const p = policy({ scoreFamilyReviewThresholds: { video_agreement_v1: 75 } });
    expect(resolveGeneralReviewThreshold(p, "video_agreement_v1")).toEqual({ value: 75, source: "family" });
    expect(resolveGeneralReviewThreshold(p, "research_synthesis_v1")).toEqual({ value: 70, source: "shared" });
    expect(resolveGeneralReviewThreshold(p, "claim_verification_v1")).toEqual({ value: 70, source: "shared" });
  });
  it("research override → research only", () => {
    const p = policy({ scoreFamilyReviewThresholds: { research_synthesis_v1: 64 } });
    expect(resolveGeneralReviewThreshold(p, "research_synthesis_v1")).toEqual({ value: 64, source: "family" });
    expect(resolveGeneralReviewThreshold(p, "video_agreement_v1")).toEqual({ value: 70, source: "shared" });
    expect(resolveGeneralReviewThreshold(p, "claim_verification_v1")).toEqual({ value: 70, source: "shared" });
  });
  it("0 and 100 are valid overrides (falsy 0 is not 'absent')", () => {
    expect(resolveGeneralReviewThreshold(policy({ scoreFamilyReviewThresholds: { video_agreement_v1: 0 } }), "video_agreement_v1")).toEqual({ value: 0, source: "family" });
    expect(resolveGeneralReviewThreshold(policy({ scoreFamilyReviewThresholds: { video_agreement_v1: 100 } }), "video_agreement_v1")).toEqual({ value: 100, source: "family" });
  });
  it("a claim entry is never honoured, even if one reaches the runtime object", () => {
    const p = { ...policy(), scoreFamilyReviewThresholds: { claim_verification_v1: 95 } } as unknown as GovernancePolicy;
    expect(resolveGeneralReviewThreshold(p, "claim_verification_v1")).toEqual({ value: 70, source: "shared" });
  });
  it.each([
    ["string", "75"],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-1", -1],
    ["101", 101],
    ["null", null],
    ["array", [75]],
    ["object", { v: 75 }],
  ])("malformed runtime value (%s) → shared", (_l, value) => {
    const p = { ...policy(), scoreFamilyReviewThresholds: { video_agreement_v1: value } } as unknown as GovernancePolicy;
    expect(resolveGeneralReviewThreshold(p, "video_agreement_v1")).toEqual({ value: 70, source: "shared" });
  });
  it.each([["null map", null], ["array map", [75]], ["string map", "75"]])("malformed map (%s) → shared", (_l, map) => {
    const p = { ...policy(), scoreFamilyReviewThresholds: map } as unknown as GovernancePolicy;
    expect(resolveGeneralReviewThreshold(p, "research_synthesis_v1")).toEqual({ value: 70, source: "shared" });
  });
  it("an inherited (prototype) key is not an override", () => {
    const map = Object.create({ video_agreement_v1: 90 });
    const p = { ...policy(), scoreFamilyReviewThresholds: map } as unknown as GovernancePolicy;
    expect(resolveGeneralReviewThreshold(p, "video_agreement_v1")).toEqual({ value: 70, source: "shared" });
  });
});

describe("readPersistedFamilyReviewThresholds (read path: discard, never throw)", () => {
  it("absent → undefined, nothing discarded", () => {
    expect(readPersistedFamilyReviewThresholds(undefined)).toEqual({ thresholds: undefined, discarded: [] });
  });
  it("keeps only recognized families with valid values; names everything dropped", () => {
    expect(
      readPersistedFamilyReviewThresholds({
        video_agreement_v1: 75,
        research_synthesis_v1: "80",
        claim_verification_v1: 90,
        bogus: 50,
      })
    ).toEqual({
      thresholds: { video_agreement_v1: 75 },
      discarded: ["scoreFamilyReviewThresholds.bogus", "scoreFamilyReviewThresholds.claim_verification_v1", "scoreFamilyReviewThresholds.research_synthesis_v1"],
    });
  });
  it.each([
    ["NaN", { video_agreement_v1: NaN }],
    ["-1", { video_agreement_v1: -1 }],
    ["101", { research_synthesis_v1: 101 }],
    ["null entry", { research_synthesis_v1: null }],
    ["nested array", { video_agreement_v1: [75] }],
    ["only a claim key", { claim_verification_v1: 80 }],
  ])("fully malformed (%s) → no active override", (_l, raw) => {
    const out = readPersistedFamilyReviewThresholds(raw);
    expect(out.thresholds).toBeUndefined();
    expect(out.discarded.length).toBe(1);
  });
  it.each([["null", null], ["array", [1]], ["string", "x"], ["number", 7]])("a non-object map (%s) is discarded whole", (_l, raw) => {
    expect(readPersistedFamilyReviewThresholds(raw)).toEqual({ thresholds: undefined, discarded: ["scoreFamilyReviewThresholds"] });
  });
});

describe("validateFamilyReviewThresholdsMutation (POST: strict)", () => {
  it("accepts numbers (set) and null (clear) for the two families", () => {
    expect(validateFamilyReviewThresholdsMutation({ video_agreement_v1: 72, research_synthesis_v1: null })).toEqual({
      ok: true,
      mutation: { video_agreement_v1: 72, research_synthesis_v1: null },
    });
  });
  it.each([
    ["claim key", { claim_verification_v1: 80 }, "scoreFamilyReviewThresholds.claim_verification_v1"],
    ["unknown key", { other_v1: 80 }, "scoreFamilyReviewThresholds.other_v1"],
    ["string", { video_agreement_v1: "75" }, "scoreFamilyReviewThresholds.video_agreement_v1"],
    ["NaN", { video_agreement_v1: NaN }, "scoreFamilyReviewThresholds.video_agreement_v1"],
    ["Infinity", { research_synthesis_v1: Infinity }, "scoreFamilyReviewThresholds.research_synthesis_v1"],
    ["-1", { video_agreement_v1: -1 }, "scoreFamilyReviewThresholds.video_agreement_v1"],
    ["101", { video_agreement_v1: 101 }, "scoreFamilyReviewThresholds.video_agreement_v1"],
    ["array value", { video_agreement_v1: [70] }, "scoreFamilyReviewThresholds.video_agreement_v1"],
  ])("rejects %s", (_l, raw, field) => {
    const r = validateFamilyReviewThresholdsMutation(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fields)).toEqual([field]);
  });
  it.each([["array", [1]], ["null", null], ["string", "x"], ["empty object", {}]])("rejects a malformed map (%s)", (_l, raw) => {
    const r = validateFamilyReviewThresholdsMutation(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fields)).toEqual(["scoreFamilyReviewThresholds"]);
  });
  it("one bad entry rejects the whole mutation (nothing partially applied)", () => {
    expect(validateFamilyReviewThresholdsMutation({ video_agreement_v1: 72, research_synthesis_v1: 500 }).ok).toBe(false);
  });
});

describe("applyFamilyReviewThresholdsMutation (set / clear per family)", () => {
  it("updating video keeps research", () => {
    expect(applyFamilyReviewThresholdsMutation({ video_agreement_v1: 75, research_synthesis_v1: 80 }, { video_agreement_v1: 72 })).toEqual({
      video_agreement_v1: 72,
      research_synthesis_v1: 80,
    });
  });
  it("clearing video keeps research", () => {
    expect(applyFamilyReviewThresholdsMutation({ video_agreement_v1: 75, research_synthesis_v1: 80 }, { video_agreement_v1: null })).toEqual({
      research_synthesis_v1: 80,
    });
  });
  it("clearing the last override yields absence, not an empty map", () => {
    expect(applyFamilyReviewThresholdsMutation({ video_agreement_v1: 75 }, { video_agreement_v1: null })).toBeUndefined();
  });
  it("change names are dotted and ordered", () => {
    expect(familyReviewThresholdChangeNames({ research_synthesis_v1: 1, video_agreement_v1: null })).toEqual([
      "scoreFamilyReviewThresholds.video_agreement_v1",
      "scoreFamilyReviewThresholds.research_synthesis_v1",
    ]);
  });
});

describe("zero-outcome compatibility over the D5.1 decision matrix", () => {
  it("no family map → identical to the pre-D5.2A baseline", () => {
    expect(digestWith((p) => p)).toEqual(BASELINE_MATRIX);
  });
  it("family map equal to the shared value → identical to baseline", () => {
    expect(
      digestWith((p) => ({ ...p, scoreFamilyReviewThresholds: { video_agreement_v1: p.minConsensusToAvoidReview, research_synthesis_v1: p.minConsensusToAvoidReview } }))
    ).toEqual(BASELINE_MATRIX);
  });
  it.each([
    ["malformed values", { video_agreement_v1: "99", research_synthesis_v1: NaN }],
    ["out of range", { video_agreement_v1: 101, research_synthesis_v1: -5 }],
    ["claim key only", { claim_verification_v1: 100 }],
    ["null map", null],
  ])("a malformed runtime map (%s) → identical to baseline (never stricter)", (_l, map) => {
    expect(digestWith((p) => ({ ...p, scoreFamilyReviewThresholds: map }) as unknown as GovernancePolicy)).toEqual(BASELINE_MATRIX);
  });
  it("NEGATIVE CONTROL — a real override is detected by the same digest", () => {
    expect(digestWith((p) => ({ ...p, scoreFamilyReviewThresholds: { video_agreement_v1: 95 } })).digest).not.toBe(BASELINE_MATRIX.digest);
  });
});

describe("family isolation", () => {
  const byFamily = (p: GovernancePolicy) => {
    const out: Record<string, string[]> = {};
    for (const c of buildSystemAMatrix()) {
      const r = decide(c.input, { ...c.policy, ...p.scoreFamilyReviewThresholds ? { scoreFamilyReviewThresholds: p.scoreFamilyReviewThresholds } : {} });
      (out[c.input.scoreFamily] ??= []).push(JSON.stringify([r.status, r.reasons]));
    }
    return out;
  };
  const base = byFamily(policy());

  it("a video-only override changes video decisions and nothing else", () => {
    const v = byFamily(policy({ scoreFamilyReviewThresholds: { video_agreement_v1: 90 } }));
    expect(v.video_agreement_v1).not.toEqual(base.video_agreement_v1);
    expect(v.research_synthesis_v1).toEqual(base.research_synthesis_v1);
    expect(v.claim_verification_v1).toEqual(base.claim_verification_v1);
  });
  it("a research-only override changes research decisions and nothing else", () => {
    const r = byFamily(policy({ scoreFamilyReviewThresholds: { research_synthesis_v1: 90 } }));
    expect(r.research_synthesis_v1).not.toEqual(base.research_synthesis_v1);
    expect(r.video_agreement_v1).toEqual(base.video_agreement_v1);
    expect(r.claim_verification_v1).toEqual(base.claim_verification_v1);
  });

  it("direct boundaries: video override 75 — 74 review / 75 approved; research and claim stay on 70", () => {
    const p = policy({ scoreFamilyReviewThresholds: { video_agreement_v1: 75 } });
    expect(decide(input("video_agreement_v1", 74), p)).toEqual({ status: "needs_review", reasons: ["Consensus 74 below 75"] });
    expect(decide(input("video_agreement_v1", 75), p)).toEqual({ status: "approved", reasons: [] });
    expect(decide(input("research_synthesis_v1", 70), p)).toEqual({ status: "approved", reasons: [] });
    expect(decide(input("research_synthesis_v1", 69), p)).toEqual({ status: "needs_review", reasons: ["Consensus 69 below 70"] });
    expect(decide(input("claim_verification_v1", 70), p)).toEqual({ status: "approved", reasons: [] });
  });
  it("direct boundaries: research override 65 — 64 review / 65 approved; video stays on 70", () => {
    const p = policy({ scoreFamilyReviewThresholds: { research_synthesis_v1: 65 } });
    expect(decide(input("research_synthesis_v1", 64), p)).toEqual({ status: "needs_review", reasons: ["Consensus 64 below 65"] });
    expect(decide(input("research_synthesis_v1", 65), p)).toEqual({ status: "approved", reasons: [] });
    expect(decide(input("video_agreement_v1", 69), p)).toEqual({ status: "needs_review", reasons: ["Consensus 69 below 70"] });
  });
  it("sensitive rules are untouched by a family override", () => {
    const p = policy({ scoreFamilyReviewThresholds: { video_agreement_v1: 50, research_synthesis_v1: 50 } });
    expect(decide(input("research_synthesis_v1", 80, { question: "Is this medication safe?" }), p)).toEqual({
      status: "needs_review",
      reasons: ["Sensitive domain (medical): consensus 80 below approval threshold 85"],
    });
  });
});

describe("provenance — resolved value and source", () => {
  const thresholds = (i: GovernanceInput, p: GovernancePolicy) => evaluateGovernance(i, p).meta.scoreThresholdsInEffect;
  it.each(["video_agreement_v1", "research_synthesis_v1"] as const)("%s: shared fallback → 70 / shared", (f) => {
    expect(thresholds(input(f, 80), policy())).toEqual({ minConsensusToAvoidReview: 70, minConsensusToAvoidReviewSource: "shared" });
  });
  it.each(["video_agreement_v1", "research_synthesis_v1"] as const)("%s: override 75 → 75 / family", (f) => {
    expect(thresholds(input(f, 80), policy({ scoreFamilyReviewThresholds: { [f]: 75 } }))).toEqual({
      minConsensusToAvoidReview: 75,
      minConsensusToAvoidReviewSource: "family",
    });
  });
  it("claim: always shared, whatever overrides exist", () => {
    expect(thresholds(input("claim_verification_v1", 95), policy({ scoreFamilyReviewThresholds: { video_agreement_v1: 80, research_synthesis_v1: 80 } }))).toEqual({
      minConsensusToAvoidReview: 70,
      minConsensusToAvoidReviewSource: "shared",
    });
  });
  it("malformed stored value → shared value / shared source", () => {
    const p = { ...policy(), scoreFamilyReviewThresholds: { video_agreement_v1: "75" } } as unknown as GovernancePolicy;
    expect(thresholds(input("video_agreement_v1", 80), p)).toEqual({ minConsensusToAvoidReview: 70, minConsensusToAvoidReviewSource: "shared" });
  });
  it("a family override with a sensitive question records both blocks", () => {
    expect(thresholds(input("video_agreement_v1", 90, { question: "medical clip" }), policy({ scoreFamilyReviewThresholds: { video_agreement_v1: 77 } }))).toEqual({
      minConsensusToAvoidReview: 77,
      minConsensusToAvoidReviewSource: "family",
      sensitive: { domain: "medical", minConsensusToAvoidReview: 75, minConsensusToApprove: 85 },
    });
  });
});
