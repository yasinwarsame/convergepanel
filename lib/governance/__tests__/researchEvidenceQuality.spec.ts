/**
 * Research evidence-quality consistency (prerequisite of Governance Intelligence D5.2B).
 *
 * ONE canonical synthesis evidence-quality rule — `deriveSynthesisEvidenceQuality`,
 * the rule the policy rollup has always applied — now feeds both the Team policy
 * summary and System A research governance. Before this change System A re-derived
 * research quality with a different fallback (low-evidence findings vs MODEL count;
 * "strong" from any high-confidence finding), so one synthesis could be "weak" for
 * Team policy and "mixed" for System A.
 */
import {
  computeSynthesisConsensusScoring,
  deriveSynthesisEvidenceQuality,
  rollupPolicyConsensusSummary,
  type SynthesisConsensusSummaryDetail,
} from "@/lib/verification/consensusScoring";
import { governanceInputFromResearchRun, researchEvidenceQualityFromRunDoc } from "@/lib/governance/governanceInputFromDocs";
import { evaluateGovernance, getDefaultGovernancePolicy } from "@/lib/governance/evaluateGovernance";

const W = ["Apple", "Banana", "Cherry", "Damson", "Elder", "Fig"];
const FILLER = "Neutral filler text that is definitely long enough to be usable here. ";

/** A real synthesis scoring run: `supporters[i]` models mention finding i; `refs[i]` = it has an evidence ref. */
function score(models: number, supporters: number[], refs: boolean[]) {
  const results = Array.from({ length: models }, (_, m) => ({
    modelId: `m${m}`,
    status: "ok",
    rawText: FILLER + W.slice(0, supporters.length).filter((_, i) => m < supporters[i]).join(" ") + " ",
  }));
  const synthesis = {
    keyFindings: supporters.map((_, i) => ({ claim: `${W[i]} holds.`, evidenceRefs: refs[i] ? ["ref-1"] : [] })),
    disagreements: [],
    biasAndBlindSpots: [],
  } as never;
  const out = computeSynthesisConsensusScoring({ synthesis, results, sourceBacked: refs.some(Boolean), runId: "t" });
  const legacyDoc = {
    question: "Is the sky blue?",
    synthesisConsensusSummary: out.consensusSummary,
    synthesizedStructuredReport: out.enrichedSynthesis,
    results: results.map(() => ({ status: "ok" })),
  };
  return { out, legacyDoc, newDoc: { ...legacyDoc, policyConsensusSummary: out.policyConsensusSummary } };
}

/** The PRE-FIX System A fallback, frozen verbatim from main be0674b0 (governanceInputFromDocs.ts:53-61). */
function preFixSystemAFallback(sum: Record<string, unknown>): "strong" | "mixed" | "weak" {
  const low = Number(sum.lowEvidenceClaims ?? 0);
  const high = Number(sum.highConfidenceClaims ?? 0);
  const modelCount = Math.max(1, Number(sum.modelCount ?? 1));
  if (low >= modelCount * 0.5) return "weak";
  if (low === 0 && high > 0) return "strong";
  return "mixed";
}

/** The rollup's inline rule as it stood at main be0674b0, frozen — the extraction must equal it. */
function preFixRollupRule(low: number, support: number, keyFindingCount: number): "strong" | "mixed" | "weak" {
  let q: "strong" | "mixed" | "weak" = "mixed";
  const denom = Math.max(1, keyFindingCount);
  if (low === 0 && support >= 0.75) q = "strong";
  else if (low >= denom * 0.5 || support < 0.45) q = "weak";
  return q;
}

describe("deriveSynthesisEvidenceQuality — exact boundaries", () => {
  const q = (low: number, support: number, findings: number) => deriveSynthesisEvidenceQuality({ lowEvidenceClaims: low, aggregateSupportRatio: support }, findings);
  it.each([
    [0, 0.75, 3, "strong"],
    [0, 0.74, 3, "mixed"],
    [0, 0.45, 3, "mixed"],
    [0, 0.44, 3, "weak"],
    [0, 1, 3, "strong"],
    [1, 0.9, 3, "mixed"], // 1 < 1.5
    [2, 0.9, 3, "weak"], // 2 >= 1.5
    [1, 0.9, 4, "mixed"], // just below 50%
    [2, 0.9, 4, "weak"], // exactly 50%
    [2, 0.9, 5, "mixed"], // 2 < 2.5
    [3, 0.9, 5, "weak"],
    [1, 0.75, 3, "mixed"], // support alone cannot make it strong
    [1, 0.44, 3, "weak"], // weak by support though the share alone would not be
    [0, 0.5, 0, "mixed"], // denominator floored at 1
    [1, 0.5, 0, "weak"],
  ])("low=%i support=%f findings=%i → %s", (low, support, findings, expected) => {
    expect(q(low, support, findings)).toBe(expected);
  });

  it("equals the rollup's pre-extraction rule over a dense grid (Team policy semantics unchanged)", () => {
    for (let findings = 0; findings <= 7; findings++)
      for (let low = 0; low <= findings + 1; low++)
        for (let s = 0; s <= 1000; s += 5) {
          const support = s / 1000;
          expect(q(low, support, findings)).toBe(preFixRollupRule(low, support, findings));
        }
  });

  it("rollupPolicyConsensusSummary delegates to it", () => {
    const detail: SynthesisConsensusSummaryDetail = { modelsHealthy: 4, modelCount: 4, highConfidenceClaims: 1, contestedClaims: 0, lowEvidenceClaims: 1, overallConsensusScore: 80, aggregateSupportRatio: 0.9 };
    expect(rollupPolicyConsensusSummary(detail, 2).evidenceQuality).toBe("weak");
    expect(rollupPolicyConsensusSummary(detail, 3).evidenceQuality).toBe("mixed");
  });
});

describe("REGRESSION — the pre-fix disagreement, on real synthesis output", () => {
  // 3 models, 1 finding, all supporting, no evidence ref → that finding is low-evidence.
  const { out, legacyDoc, newDoc } = score(3, [3], [false]);

  it("the fixture really exhibits the old defect", () => {
    expect(out.policyConsensusSummary.evidenceQuality).toBe("weak"); // Team policy: 1 of 1 findings low-evidence
    expect(preFixSystemAFallback(out.consensusSummary as unknown as Record<string, unknown>)).toBe("mixed"); // old System A: 1 < 3 models / 2
  });

  it("System A now classifies it exactly as the Team policy summary does — new and legacy-shaped runs alike", () => {
    expect(governanceInputFromResearchRun(newDoc).evidenceQuality).toBe("weak");
    expect(governanceInputFromResearchRun(legacyDoc).evidenceQuality).toBe("weak");
  });

  it("and the governance decision follows: approved before, needs_review with the weak-evidence reason now", () => {
    const input = governanceInputFromResearchRun(newDoc);
    const mainQuality = preFixSystemAFallback(legacyDoc.synthesisConsensusSummary as unknown as Record<string, unknown>);
    expect(evaluateGovernance({ ...input, evidenceQuality: mainQuality }, getDefaultGovernancePolicy())).toEqual(
      expect.objectContaining({ status: "approved", reasons: [] })
    ); // what main decided
    const now = evaluateGovernance(input, getDefaultGovernancePolicy());
    expect(now.status).toBe("needs_review");
    expect(now.reasons).toEqual(["Evidence quality is weak"]);
  });
});

describe("new synthesis path: System A quality === policy summary quality", () => {
  it.each([
    ["STRONG (no low-evidence, support ≥ 0.75)", 3, [3], [true], "strong"],
    ["MIXED", 4, [3, 2], [true, true], "mixed"],
    ["WEAK by low-evidence share (1 of 2)", 4, [4, 4], [true, false], "weak"],
    ["WEAK by support (< 0.45) with share below half (1 of 3)", 4, [2, 2, 1], [true, true, true], "weak"],
  ] as const)("%s", (_l, models, supporters, refs, expected) => {
    const { out, newDoc, legacyDoc } = score(models, [...supporters], [...refs]);
    expect(out.policyConsensusSummary.evidenceQuality).toBe(expected);
    expect(governanceInputFromResearchRun(newDoc).evidenceQuality).toBe(expected);
    expect(governanceInputFromResearchRun(legacyDoc).evidenceQuality).toBe(expected);
  });

  it("holds across a real-scoring grid (models 1–5, findings 1–4, every supporter pattern, ref mixes)", () => {
    let n = 0;
    for (let models = 1; models <= 5; models++)
      for (let f = 1; f <= 4; f++)
        for (let pat = 0; pat < Math.pow(models + 1, f); pat++)
          for (const refMode of [0, 1, 2]) {
            const sup: number[] = [];
            let x = pat;
            for (let i = 0; i < f; i++) { sup.push(x % (models + 1)); x = Math.floor(x / (models + 1)); }
            const refs = Array.from({ length: f }, (_, i) => (refMode === 2 ? i === 0 : refMode === 1));
            const { out, newDoc, legacyDoc } = score(models, sup, refs);
            const canonical = out.policyConsensusSummary.evidenceQuality;
            if (governanceInputFromResearchRun(newDoc).evidenceQuality !== canonical) throw new Error(`new-shape drift at ${models}/${sup}/${refMode}`);
            if (governanceInputFromResearchRun(legacyDoc).evidenceQuality !== canonical) throw new Error(`legacy-shape drift at ${models}/${sup}/${refMode}`);
            n++;
          }
    expect(n).toBeGreaterThan(5000);
  });
});

describe("historical and malformed run shapes (source precedence)", () => {
  const detail = { lowEvidenceClaims: 1, aggregateSupportRatio: 0.9, highConfidenceClaims: 1, modelCount: 4, modelsHealthy: 4, contestedClaims: 0, overallConsensusScore: 85 };
  const report = { keyFindings: [{}, {}] }; // 1 of 2 low-evidence → canonical "weak"

  it.each([
    ["NEW: policy summary present → its value", { policyConsensusSummary: { evidenceQuality: "mixed" }, synthesisConsensusSummary: detail, synthesizedStructuredReport: report }, "mixed"],
    ["LEGACY reconstructable → canonical value", { synthesisConsensusSummary: detail, synthesizedStructuredReport: report }, "weak"],
    ["INSUFFICIENT: no report → null", { synthesisConsensusSummary: detail }, null],
    ["INSUFFICIENT: report without keyFindings → null", { synthesisConsensusSummary: detail, synthesizedStructuredReport: {} }, null],
    ["INSUFFICIENT: no aggregateSupportRatio → null", { synthesisConsensusSummary: { ...detail, aggregateSupportRatio: undefined }, synthesizedStructuredReport: report }, null],
    ["INSUFFICIENT: non-integer lowEvidenceClaims → null", { synthesisConsensusSummary: { ...detail, lowEvidenceClaims: 1.5 }, synthesizedStructuredReport: report }, null],
    ["INSUFFICIENT: support out of range → null", { synthesisConsensusSummary: { ...detail, aggregateSupportRatio: 1.2 }, synthesizedStructuredReport: report }, null],
    ["INSUFFICIENT: nothing at all → null", {}, null],
    ["MALFORMED policy summary → reconstructed", { policyConsensusSummary: { evidenceQuality: "excellent" }, synthesisConsensusSummary: detail, synthesizedStructuredReport: report }, "weak"],
    ["MALFORMED policy summary, nothing to reconstruct → null", { policyConsensusSummary: { evidenceQuality: 7 } }, null],
    ["CONFLICT: policy summary wins over a top-level consensusSummary", { policyConsensusSummary: { evidenceQuality: "strong" }, consensusSummary: { evidenceQuality: "weak" }, synthesisConsensusSummary: detail, synthesizedStructuredReport: report }, "strong"],
    ["top-level consensusSummary alone is NOT trusted (no canonical writer ever) → null", { consensusSummary: { evidenceQuality: "weak" } }, null],
    ["top-level consensusSummary does not override reconstruction", { consensusSummary: { evidenceQuality: "strong" }, synthesisConsensusSummary: detail, synthesizedStructuredReport: report }, "weak"],
    ["an evidenceQuality planted on the detail is ignored (the detail never carried one)", { synthesisConsensusSummary: { ...detail, evidenceQuality: "strong" }, synthesizedStructuredReport: report }, "weak"],
  ])("%s", (_l, doc, expected) => {
    expect(researchEvidenceQualityFromRunDoc(doc as Record<string, unknown>)).toBe(expected);
    expect(governanceInputFromResearchRun(doc as Record<string, unknown>).evidenceQuality).toBe(expected);
  });

  it("the old model-count fallback no longer decides anything: same detail, different modelCount → same quality", () => {
    const a = researchEvidenceQualityFromRunDoc({ synthesisConsensusSummary: { ...detail, modelCount: 1 }, synthesizedStructuredReport: report });
    const b = researchEvidenceQualityFromRunDoc({ synthesisConsensusSummary: { ...detail, modelCount: 10 }, synthesizedStructuredReport: report });
    expect([a, b]).toEqual(["weak", "weak"]);
  });

  it("highConfidenceClaims is not a strong criterion", () => {
    expect(researchEvidenceQualityFromRunDoc({ synthesisConsensusSummary: { ...detail, lowEvidenceClaims: 0, aggregateSupportRatio: 0.6, highConfidenceClaims: 9 }, synthesizedStructuredReport: report })).toBe("mixed");
  });
});

describe("decision delta vs the pre-fix fallback (characterization, live policy defaults)", () => {
  it("only the weak-evidence reason can differ; nothing becomes or stops being blocked", () => {
    const policy = getDefaultGovernancePolicy();
    const WEAK = "Evidence quality is weak";
    const tally: Record<string, number> = {};
    for (let models = 1; models <= 5; models++)
      for (let f = 1; f <= 3; f++)
        for (let pat = 0; pat < Math.pow(models + 1, f); pat++)
          for (const refMode of [0, 1, 2]) {
            const sup: number[] = [];
            let x = pat;
            for (let i = 0; i < f; i++) { sup.push(x % (models + 1)); x = Math.floor(x / (models + 1)); }
            const refs = Array.from({ length: f }, (_, i) => (refMode === 2 ? i === 0 : refMode === 1));
            const { legacyDoc, newDoc } = score(models, sup, refs);
            const input = governanceInputFromResearchRun(newDoc);
            const before = evaluateGovernance({ ...input, evidenceQuality: preFixSystemAFallback(legacyDoc.synthesisConsensusSummary as unknown as Record<string, unknown>) }, policy);
            const after = evaluateGovernance(input, policy);
            expect(after.reasons.filter((r) => r !== WEAK)).toEqual(before.reasons.filter((r) => r !== WEAK));
            expect(before.status === "blocked").toBe(after.status === "blocked");
            const key = before.status === after.status ? (before.reasons.length === after.reasons.length ? "unchanged" : `reason-only:${after.status}`) : `${before.status}->${after.status}`;
            tally[key] = (tally[key] ?? 0) + 1;
          }
    // the intended correction is visible in this grid: some approvals now need review
    expect(tally["approved->needs_review"]).toBeGreaterThan(0);
    expect(Object.keys(tally).every((k) => ["unchanged", "approved->needs_review", "needs_review->approved", "reason-only:needs_review", "reason-only:blocked"].includes(k))).toBe(true);
  });
});
