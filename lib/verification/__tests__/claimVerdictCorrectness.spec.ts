/**
 * Claim-verification correctness — PR-1 regression spec (evidence doc 14, 2026-11-17; moved from the local proposal
 * branch proposal/claim-verdict-correctness @5d672d9, claimVerdictCorrectness.proposal.spec.ts).
 *
 * PR-1 fixes D-1 (an unrecognised / missing per-model verdict is a `parse_error` row, not a usable "unverifiable"
 * judgement) and D-5 (the digest never reports a conflict between models on the same side; it does report a part one
 * model calls correct and another calls incorrect). Those blocks are moved here unchanged and must pass.
 *
 * The proposal's D-2 logic, D-3, D-4 score and D-6 tests assert verdict / score / confidence semantics that belong to
 * PR-2b (owner decisions OD-1, OD-3, OD-4, OD-5) and are NOT in this file; their [CONTROL] tests are kept and pin that
 * PR-1 does not change computeClaimVerdict / computeConsensusScoring.
 *
 * Pure functions only: no provider, no Firestore, no credentials, no customer data. All rows are synthetic.
 */
import { computeClaimVerdict, type ModelVerificationResult } from "@/lib/verification/claimVerdict";
import { computeConsensusScoring } from "@/lib/verification/consensusScoring";
import { parsedModelVerificationFromObject, type ModelVerdict } from "@/lib/verification/parseVerificationJson";
import { buildClaimModelEvidence } from "@/lib/verification/buildClaimModelEvidence";
import { buildAgreementDisagreementDigest } from "@/lib/verification/agreementDigest";
import type { ModelId, ModelResult } from "@/lib/types";

type Dist = [accurate: number, partial: number, inaccurate: number, unverifiable: number];

function rows([a, p, i, u]: Dist): Array<ModelVerificationResult & { confidence: "high" }> {
  const out: Array<ModelVerificationResult & { confidence: "high" }> = [];
  const push = (v: ModelVerdict, n: number) => {
    for (let k = 0; k < n; k++) out.push({ status: "ok", verdict: v, confidence: "high" });
  };
  push("accurate", a);
  push("partially_accurate", p);
  push("inaccurate", i);
  push("unverifiable", u);
  return out;
}

function score(d: Dist) {
  const r = rows(d);
  return computeConsensusScoring({ mode: "verification", modelRows: r, aggregateVerdict: computeClaimVerdict(r) });
}


function connectorOk(modelId: string, rawText: string): ModelResult {
  return { modelId: modelId as ModelId, status: "ok", rawText, latencyMs: 1 } as unknown as ModelResult;
}

const json = (verdict: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...(verdict === undefined ? {} : { verdict }), confidence: "high", summary: "s", correctParts: [], incorrectParts: [], unverifiableParts: [], reasoning: "r", ...extra });

// ─── D-1: unrecognised per-model verdict strings ────────────────────────────────────────────────────────────────────

describe("D-1 parser: an unrecognised verdict is malformed model output, not a judgement of 'unverifiable'", () => {
  it.each([
    ["an unknown word", "mostly true"],
    ["a boolean-ish string", "true"],
    ["an empty string", ""],
    ["a non-string value", 42],
  ])("%s (%p) is not stored as a usable 'ok' row", (_label, verdict) => {
    const [row] = buildClaimModelEvidence([connectorOk("chatgpt", json(verdict))]);
    expect(row.status).not.toBe("ok");
    expect(row.verdict).not.toBe("unverifiable");
  });

  it("a response with no verdict field at all is not stored as a usable 'ok' row", () => {
    const [row] = buildClaimModelEvidence([connectorOk("chatgpt", json(undefined))]);
    expect(row.status).not.toBe("ok");
  });

  it("a response truncated inside the verdict value is not stored as a usable 'unverifiable' row", () => {
    const [row] = buildClaimModelEvidence([connectorOk("chatgpt", '{"verdict": "accur')]);
    expect(row.status === "ok" && row.verdict === "unverifiable").toBe(false);
  });

  it("formatting variants of a known verdict are recognised (hyphen / surrounding whitespace)", () => {
    // normalizeVerdict (parseVerificationJson.ts:25) lower-cases and maps inner whitespace to "_" but neither trims
    // nor maps "-": " Inaccurate " becomes "inaccurate_" and "Partially-Accurate" stays hyphenated — both fall to
    // the `return "unverifiable"` default (:28).
    expect(parsedModelVerificationFromObject({ verdict: "Partially-Accurate" }).verdict).toBe("partially_accurate");
    expect(parsedModelVerificationFromObject({ verdict: " Inaccurate " }).verdict).toBe("inaccurate");
  });

  it("malformed rows do not dilute the aggregate: 3 accurate + 2 unrecognised is judged on the 3 usable answers", () => {
    const evidence = buildClaimModelEvidence([
      connectorOk("chatgpt", json("accurate")),
      connectorOk("claude", json("accurate")),
      connectorOk("gemini", json("accurate")),
      connectorOk("grok", json("correct-ish")),
      connectorOk("perplexity", json("n/a")),
    ]);
    const verdict = computeClaimVerdict(
      evidence.map((m) => ({ status: m.status, verdict: m.status === "ok" ? (m.verdict as ModelVerdict) : undefined }))
    );
    expect(verdict).toBe("confirmed");
  });

  it("[CONTROL] a genuine 'unverifiable' verdict stays a usable unverifiable row", () => {
    const [row] = buildClaimModelEvidence([connectorOk("chatgpt", json("unverifiable"))]);
    expect(row.status).toBe("ok");
    expect(row.verdict).toBe("unverifiable");
  });

  it("[CONTROL] the documented alias 'partial' still maps to partially_accurate", () => {
    expect(parsedModelVerificationFromObject({ verdict: "partial" }).verdict).toBe("partially_accurate");
  });
});

// ─── D-2: a panel that does not support the claim at all is labelled 'disputed' ─────────────────────────────────────

describe("[CONTROL] D-2 verdict label: PR-1 leaves computeClaimVerdict unchanged", () => {
  // DEFERRED to PR-2 (needs OD-1): 8 no-support distributions (0A/0P/{2..5}I/0U, 0A/0P/{2,3,4}I/1U, 0A/0P/3I/2U) and the
  // 1A/4I mirror case assert a value outside today's vocabulary. PR-1 keeps the stored label and fixes its PRESENTATION
  // (claimVerdictPresentation.spec.tsx). These controls pin the label behaviour PR-1 must not change.
  it("[CONTROL] a genuine accurate-vs-inaccurate split stays 'disputed' (2A/1P/2I, 1A/1I, 2A/2I)", () => {
    expect(computeClaimVerdict(rows([2, 1, 2, 0]))).toBe("disputed");
    expect(computeClaimVerdict(rows([1, 0, 1, 0]))).toBe("disputed");
    expect(computeClaimVerdict(rows([2, 0, 2, 0]))).toBe("disputed");
  });

  it("[CONTROL] unanimous accurate stays 'confirmed' and majority-unverifiable stays 'unverifiable'", () => {
    expect(computeClaimVerdict(rows([5, 0, 0, 0]))).toBe("confirmed");
    expect(computeClaimVerdict(rows([0, 0, 0, 5]))).toBe("unverifiable");
    expect(computeClaimVerdict(rows([0, 0, 1, 1]))).toBe("unverifiable");
  });
});

// ─── D-3: high confidence on contradictory mixes ────────────────────────────────────────────────────────────────────

describe("[CONTROL] D-3 confidence: PR-1 leaves stored confidence unchanged", () => {
  // DEFERRED to PR-2b (OD-4): 0A/2P/3I is not partially_true / not High, and no >= 2-vs->= 2 mix is High. PR-1 does not
  // change stored confidence; it shows the split next to the label (claimVerdictPresentation.spec.tsx).
  it("[CONTROL] unanimous accurate is High; a genuine 2-2 split is not", () => {
    expect(score([5, 0, 0, 0]).confidenceLabel).toBe("High");
    expect(score([2, 1, 2, 0]).confidenceLabel).not.toBe("High");
  });
});

// ─── D-4: 'confirmed' hides model dissent ───────────────────────────────────────────────────────────────────────────

describe("[CONTROL] D-4 score: PR-1 leaves the stored score and label unchanged", () => {
  // DEFERRED to PR-2b (OD-3): 4A/1I scoring strictly below 5A / below 100. PR-1 discloses the dissent next to the
  // stored score instead (Team list and history counts, confidence qualifier).
  it("[CONTROL] 4A/1I keeps the aggregate label 'confirmed' (threshold unchanged unless OD-3 says otherwise)", () => {
    expect(computeClaimVerdict(rows([4, 0, 1, 0]))).toBe("confirmed");
  });
});

// ─── D-5: disagreement digest ───────────────────────────────────────────────────────────────────────────────────────

describe("D-5 digest: 'Conflicting assessments' requires an actual conflict between models", () => {
  it("two models that both rate the claim inaccurate, with differently worded reasons, are not in conflict", () => {
    const d = buildAgreementDisagreementDigest([
      { modelId: "chatgpt", verdict: "inaccurate", correctParts: [], incorrectParts: ["The tower was finished in 1889, not 1901 as the claim states"] },
      { modelId: "claude", verdict: "inaccurate", correctParts: [], incorrectParts: ["Construction concluded during March of eighteen eighty-nine"] },
    ] as never);
    expect(d.whereModelsDisagree).toEqual([]);
  });

  it("a part one model calls correct and another calls incorrect IS reported as a conflict", () => {
    const point = "The Eiffel Tower was completed in 1889 for the World's Fair";
    const d = buildAgreementDisagreementDigest([
      { modelId: "chatgpt", verdict: "accurate", correctParts: [point], incorrectParts: [] },
      { modelId: "claude", verdict: "inaccurate", correctParts: [], incorrectParts: [point] },
    ] as never);
    expect(d.whereModelsDisagree.length).toBeGreaterThan(0);
    expect(d.whereModelsDisagree[0].models.sort()).toEqual(["chatgpt", "claude"]);
  });

  it("[CONTROL] shared correct parts still produce an agreement point", () => {
    const d = buildAgreementDisagreementDigest([
      { modelId: "chatgpt", correctParts: ["The tower is located in Paris France"], incorrectParts: [] },
      { modelId: "claude", correctParts: ["The tower is located in Paris, France"], incorrectParts: [] },
    ]);
    expect(d.whereModelsAgree.length).toBe(1);
  });
});

// ─── D-6: 'evidence quality' is a support-ratio heuristic ───────────────────────────────────────────────────────────

describe("[CONTROL] D-6 evidence quality: PR-1 leaves the computation unchanged", () => {
  // DEFERRED to PR-2b (OD-5): direction-independent evidence quality (n x inaccurate == n x accurate; 5 x inaccurate not
  // weak). Only the control is kept here.
  it("[CONTROL] low-confidence / parse-error rows still lower the value", () => {
    const r = [
      { status: "ok" as const, verdict: "accurate" as const, confidence: "low" as const },
      { status: "ok" as const, verdict: "accurate" as const, confidence: "low" as const },
      { status: "parse_error" as const },
    ];
    const s = computeConsensusScoring({ mode: "verification", modelRows: r, aggregateVerdict: computeClaimVerdict(r) });
    expect(s.summary.evidenceQuality).toBe("weak");
  });
});
