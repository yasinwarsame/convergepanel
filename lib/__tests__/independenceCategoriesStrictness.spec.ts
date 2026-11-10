/**
 * Review of 8584211 (NOT CLEAN 0/1/2/3) — regressions for:
 *  - MAJOR: stored claim verifications are judged by actual executing-model independence
 *    (lib/panel/storedVerificationIndependence.ts); substitution is recorded on the stored claim row.
 *  - MINOR 1: reduced independent coverage never makes the gate verdict more permissive (property over many inputs).
 *  - MINOR 2: single-model contested / uncertain signals are relabelled, never erased; four categories stay distinct
 *    (genuine disagreement / single-model uncertainty / insufficient coverage / unknown execution provenance).
 *  - NITs: a stored disagreement naming one slot, or a slot that did not answer, is never a cross-model disagreement.
 */

import {
  computeVerificationGate,
  INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL,
  INSUFFICIENT_INDEPENDENT_MODELS_GATE_REASON,
  NON_INDEPENDENT_DISAGREEMENTS_REASON,
  SINGLE_MODEL_UNCERTAIN_CLAIMS_REASON,
  SINGLE_MODEL_UNCERTAIN_CLAIMS_STEP,
  UNVERIFIED_INDEPENDENT_COVERAGE_GATE_LABEL,
  UNVERIFIED_INDEPENDENT_COVERAGE_GATE_REASON,
  type VerificationGateInput,
  type VerificationGateStatus,
} from "@/lib/verificationGate/verificationGate";
import {
  storedVerificationConsensusIndependence,
  storedVerificationIndependentAnswerCount,
} from "@/lib/panel/storedVerificationIndependence";
import { classifyStoredDisagreement, storedRunIndependenceContext } from "@/lib/panel/storedDisagreementIndependence";
import { buildClaimModelEvidence } from "@/lib/verification/buildClaimModelEvidence";
import type { ModelResult } from "@/lib/types";

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  jest.restoreAllMocks();
});

const SEVERITY: Record<VerificationGateStatus, number> = { SAFE_TO_EXPLORE: 0, NEEDS_HUMAN_REVIEW: 1, DO_NOT_RELY_YET: 2 };

// ---------------------------------------------------------------------------------------------------------------------
// MAJOR — stored claim verification independence
// ---------------------------------------------------------------------------------------------------------------------

const vrow = (modelId: string, status: "ok" | "parse_error" | "failed", extra: Record<string, unknown> = {}) => ({
  modelId,
  status,
  verdict: status === "ok" ? "accurate" : status,
  confidence: "high",
  summary: "s",
  correctParts: [],
  incorrectParts: [],
  unverifiableParts: [],
  ...extra,
});
const ds = { substituted: true, provider: "deepseek" };

describe("storedVerificationConsensusIndependence", () => {
  // C-b (CB-01): judged by the shared gate — an own-provider `ok` row counts only when it records its provider.
  const openai = { provider: "openai" };
  const anthropic = { provider: "anthropic" };
  it("three requested models, only one answered → insufficient (1 independent answer)", () => {
    const doc = { modelResults: [vrow("chatgpt", "ok", openai), vrow("claude", "failed"), vrow("grok", "parse_error")], selectedModels: ["chatgpt", "claude", "grok"] };
    expect(storedVerificationIndependentAnswerCount(doc)).toBe(1);
    expect(storedVerificationConsensusIndependence(doc)).toBe("insufficient");
    // The same record without the answering row's provider (every stored own-provider claim row, m-B): unverified.
    const providerless = { modelResults: [vrow("chatgpt", "ok"), vrow("claude", "failed"), vrow("grok", "parse_error")], selectedModels: ["chatgpt", "claude", "grok"] };
    expect([storedVerificationIndependentAnswerCount(providerless), storedVerificationConsensusIndependence(providerless)]).toEqual([null, "unverified"]);
  });

  it("multiple slots answered by DeepSeek count as ONE executing model", () => {
    const two = { modelResults: [vrow("chatgpt", "ok", ds), vrow("claude", "ok", ds)] };
    expect([storedVerificationIndependentAnswerCount(two), storedVerificationConsensusIndependence(two)]).toEqual([1, "insufficient"]);
    const three = { modelResults: [vrow("chatgpt", "ok", ds), vrow("claude", "ok", ds), vrow("grok", "ok", ds)] };
    expect(storedVerificationConsensusIndependence(three)).toBe("insufficient");
    // An unrecorded substitute does not inherit any independence and is never merged (C-b): unverified.
    const unrecorded = { modelResults: [vrow("chatgpt", "ok", ds), vrow("claude", "ok", { substituted: true })] };
    expect(storedVerificationConsensusIndependence(unrecorded)).toBe("unverified");
    // DeepSeek + an own-provider answer that records its provider: two independent models.
    const mixed = { modelResults: [vrow("chatgpt", "ok", ds), vrow("claude", "ok", ds), vrow("grok", "ok", { provider: "xai" })] };
    expect([storedVerificationIndependentAnswerCount(mixed), storedVerificationConsensusIndependence(mixed)]).toEqual([2, "independent"]);
    // …and without it: unverified.
    const mixedProviderless = { modelResults: [vrow("chatgpt", "ok", ds), vrow("claude", "ok", ds), vrow("grok", "ok")] };
    expect(storedVerificationConsensusIndependence(mixedProviderless)).toBe("unverified");
  });

  it("two independent own-provider answers → independent; errored slots are never counted as answers", () => {
    expect(storedVerificationConsensusIndependence({ modelResults: [vrow("chatgpt", "ok", openai), vrow("claude", "ok", anthropic)] })).toBe("independent");
    expect(storedVerificationConsensusIndependence({ modelResults: [vrow("chatgpt", "ok", openai), vrow("claude", "failed"), vrow("grok", "failed")] })).toBe("insufficient");
    // No answering row (K = 0) is never presented as a verified run (shared gate rule 4): unverified.
    expect(storedVerificationConsensusIndependence({ modelResults: [vrow("chatgpt", "parse_error"), vrow("claude", "failed")] })).toBe("unverified");
    // Provider-less own-provider rows: unverified, never independent.
    expect(storedVerificationConsensusIndependence({ modelResults: [vrow("chatgpt", "ok"), vrow("claude", "ok")] })).toBe("unverified");
  });

  it("missing / incomplete executing attribution → unverified (never presumed independent)", () => {
    const cases: unknown[] = [
      null,
      {},
      { modelResults: [] },
      { modelResults: "x" },
      { modelResults: [vrow("chatgpt", "ok"), null] },
      { modelResults: [vrow("chatgpt", "ok"), { ...vrow("claude", "ok"), modelId: "" }] },
      { modelResults: [vrow("chatgpt", "ok"), vrow("not-a-panel-slot", "ok")] },
      { modelResults: [vrow("chatgpt", "ok"), { ...vrow("claude", "ok"), status: undefined }] },
      { modelResults: [vrow("chatgpt", "ok"), { ...vrow("claude", "ok"), status: "substituted" }] },
      { modelResults: [vrow("chatgpt", "ok"), vrow("claude", "ok")], selectedModels: ["chatgpt", "claude", "grok"] },
      { modelResults: [vrow("chatgpt", "ok"), vrow("claude", "ok")], selectedModels: "chatgpt" },
    ];
    for (const c of cases) expect([c, storedVerificationConsensusIndependence(c as never)]).toEqual([c, "unverified"]);
  });

  it("never mutates the stored document", () => {
    const doc = { modelResults: [vrow("chatgpt", "ok", ds), vrow("claude", "ok")], selectedModels: ["chatgpt", "claude"] };
    const before = JSON.stringify(doc);
    storedVerificationConsensusIndependence(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("buildClaimModelEvidence records substitution (execution attribution)", () => {
  const body = JSON.stringify({ verdict: "accurate", confidence: "high", summary: "ok", correctParts: [], incorrectParts: [], unverifiableParts: [] });
  const res = (modelId: string, status: string, extra: Partial<ModelResult> = {}): ModelResult =>
    ({ modelId, status, rawText: body, latencyMs: 1, ...extra }) as ModelResult;
  it("a substituted result is stored with substituted + its executing provider; an own-provider result carries neither", () => {
    const ev = buildClaimModelEvidence([
      res("chatgpt", "substituted", { provider: "deepseek" }),
      res("claude", "substituted", { provider: "deepseek" }),
      res("grok", "ok", { provider: "grok" }),
    ]);
    expect(ev.map((e) => [e.modelId, e.status, (e as any).substituted, (e as any).provider])).toEqual([
      ["chatgpt", "ok", true, "deepseek"],
      ["claude", "ok", true, "deepseek"],
      ["grok", "ok", undefined, undefined],
    ]);
    expect("substituted" in ev[2] || "provider" in ev[2]).toBe(false);
    // …and the stored rows never judge as three models. The own-provider row records no provider (m-B), so the shared
    // gate does not verify the record (C-b CB-01): no count. With Grok's provider recorded: DeepSeek once + Grok = 2.
    expect(storedVerificationIndependentAnswerCount({ modelResults: ev })).toBe(null);
    expect(storedVerificationIndependentAnswerCount({ modelResults: [ev[0], ev[1], { ...ev[2], provider: "xai" }] })).toBe(2);
    // Substituted without a recorded provider: flagged, provider absent.
    const [unrec] = buildClaimModelEvidence([res("chatgpt", "substituted")]);
    expect([(unrec as any).substituted, "provider" in unrec]).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// MINOR 1 — stricter-only verdict under reduced coverage (property over generated inputs)
// ---------------------------------------------------------------------------------------------------------------------

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const CONF = ["High", "Medium", "Low", "Mixed"] as const;
const MATERIAL = { topic: "The founding date of the company", positionsByModel: { chatgpt: "1789", claude: "1792", grok: "1801" }, whyTheyDiffer: "x".repeat(90) };
const NUANCE = { topic: "terminology", positionsByModel: { chatgpt: "a", claude: "b" }, whyTheyDiffer: "wording" };

function genInput(rand: () => number): VerificationGateInput {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const n = (max: number) => Math.floor(rand() * (max + 1));
  const keyFindings = Array.from({ length: n(4) }, (_, i) => ({
    claim: `Claim ${i} about Paris`,
    confidence: pick(CONF),
    evidenceRefs: rand() < 0.5 ? [] : ["ref"],
    modelsSupporting: ["chatgpt"],
  }));
  const disagreements = Array.from({ length: n(4) }, () => (rand() < 0.6 ? MATERIAL : NUANCE));
  return {
    keyFindings,
    disagreements,
    biasAndBlindSpots: Array.from({ length: n(4) }, () => ({ biasType: "b", description: "d", modelsImplicated: [] })),
    openQuestions: Array.from({ length: n(4) }, (_, i) => `q${i}`),
    trustSummary: rand() < 0.7 ? { strongConsensus: n(3), contestedAreas: n(5), uncertainPoints: n(5) } : undefined,
    sourceBacked: rand() < 0.5,
    questionLength: rand() < 0.5 ? 40 : 200,
  };
}

describe("gate: reduced independent coverage is stricter-only", () => {
  const rand = prng(20261106);
  const inputs = Array.from({ length: 1500 }, () => genInput(rand));

  // Phase 0 (L07 + S-c22-1; owner Option C): reduced coverage relabels only — the status EQUALS the full-signal gate
  // (35933c8), in both directions, for every generated input and every reduced coverage.
  it("for every generated input and every reduced coverage, status equals the full-signal gate (35933c8)", () => {
    let sawDoNotRely = 0;
    for (const input of inputs) {
      const full = computeVerificationGate(input).status;
      if (full === "DO_NOT_RELY_YET") sawDoNotRely++;
      const reduced: VerificationGateInput[] = [
        { ...input, independentModelCount: 0 },
        { ...input, independentModelCount: 1 },
        { ...input, independentModelCount: Number.NaN },
        { ...input, executionProvenanceUnverified: true },
        { ...input, executionProvenanceUnverified: true, independentModelCount: 3 },
        // ≥ 2 independent models but only some disagreements genuine (others: one model in several slots).
        { ...input, independentModelCount: 2, independentDisagreements: (input.disagreements ?? []).slice(0, 1) },
        { ...input, independentModelCount: 2, independentDisagreements: [] },
      ];
      for (const r of reduced) {
        const g = computeVerificationGate(r);
        expect(SEVERITY[g.status]).toBe(SEVERITY[full]);
      }
    }
    // The property was exercised on the status that used to be weakened (DO_NOT_RELY_YET → NEEDS_HUMAN_REVIEW).
    expect(sawDoNotRely).toBeGreaterThan(20);
  });

  it("concrete: missing sources + a material disagreement → DO_NOT_RELY_YET stays DO_NOT_RELY_YET with one independent model", () => {
    const input: VerificationGateInput = {
      keyFindings: [{ claim: "Founded in 1789", confidence: "High", evidenceRefs: [], modelsSupporting: ["chatgpt"] }],
      disagreements: [MATERIAL],
      sourceBacked: true,
      questionLength: 200,
    };
    expect(computeVerificationGate(input).status).toBe("DO_NOT_RELY_YET");
    const one = computeVerificationGate({ ...input, independentModelCount: 1 });
    expect([one.status, one.label]).toEqual(["DO_NOT_RELY_YET", INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL]);
    // The one-model positions are not presented as a model disagreement.
    expect(one.reasons.join("\n")).not.toMatch(/Model disagreement|Contested claims detected/);
    expect(one.reasons).toContain(`${NON_INDEPENDENT_DISAGREEMENTS_REASON} (1)`);
  });

  it("unaffected rows (≥ 2 independent, every disagreement genuine) are byte-identical to the gate without coverage input", () => {
    for (const input of inputs.slice(0, 400)) {
      const plain = JSON.stringify(computeVerificationGate(input));
      expect(JSON.stringify(computeVerificationGate({ ...input, independentModelCount: 2 }))).toBe(plain);
      expect(JSON.stringify(computeVerificationGate({ ...input, independentModelCount: 5, independentDisagreements: input.disagreements }))).toBe(plain);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// MINOR 2 — four categories, relabelled not erased
// ---------------------------------------------------------------------------------------------------------------------

describe("gate: four distinct categories", () => {
  const findings = [{ claim: "Paris is the capital of France.", confidence: "High" as const, evidenceRefs: ["r"], modelsSupporting: ["chatgpt"] }];

  it("(1) genuine independent disagreement is the only 'model disagreement'; one-model positions in the same run are relabelled", () => {
    const g = computeVerificationGate({
      keyFindings: [...findings, { claim: "Mixed claim", confidence: "Mixed", evidenceRefs: ["r"], modelsSupporting: ["chatgpt", "grok"] }],
      disagreements: [MATERIAL, NUANCE],
      independentDisagreements: [MATERIAL],
      independentModelCount: 3,
      questionLength: 200,
    });
    expect([g.metrics.disagreementsCount, g.metrics.materialDisagreementsCount, g.metrics.nonIndependentDisagreementsCount]).toEqual([1, 1, 1]);
    expect(g.reasons).toContain("Model disagreement on a core conclusion (1)");
    expect(g.reasons).toContain("Contested claims detected (1)");
    expect(g.reasons).toContain(`${NON_INDEPENDENT_DISAGREEMENTS_REASON} (1)`);
    expect("independentCoverage" in g).toBe(false);
    expect(g.metrics.singleModelContestedCount).toBeUndefined();
  });

  it("(2) single-model contested / uncertain signals are preserved and relabelled (never 'Contested claims detected')", () => {
    const g = computeVerificationGate({
      keyFindings: findings,
      disagreements: [NUANCE],
      trustSummary: { strongConsensus: 0, contestedAreas: 2, uncertainPoints: 0 },
      independentModelCount: 1,
      questionLength: 200,
    });
    expect(g.metrics.contestedCount).toBe(0);
    expect(g.metrics.singleModelContestedCount).toBe(2);
    expect(g.metrics.nonIndependentDisagreementsCount).toBe(1);
    expect(g.reasons).toContain(`${SINGLE_MODEL_UNCERTAIN_CLAIMS_REASON} (2)`);
    expect(g.reasons).toContain(`${NON_INDEPENDENT_DISAGREEMENTS_REASON} (1)`);
    expect(g.recommendedNextSteps).toContain(SINGLE_MODEL_UNCERTAIN_CLAIMS_STEP);
    expect(g.reasons.join("\n")).not.toMatch(/Contested claims detected|Model disagreement|Minor nuance/);
  });

  it("(3) insufficient coverage and (4) unknown execution provenance are distinct labels, reasons and data", () => {
    const ins = computeVerificationGate({ keyFindings: findings, independentModelCount: 1 });
    const unv = computeVerificationGate({ keyFindings: findings, executionProvenanceUnverified: true, independentModelCount: 4 });
    expect([ins.label, ins.reasons[0], ins.independentCoverage]).toEqual([INSUFFICIENT_INDEPENDENT_MODELS_GATE_LABEL, INSUFFICIENT_INDEPENDENT_MODELS_GATE_REASON, "insufficient"]);
    expect([unv.label, unv.reasons[0], unv.independentCoverage]).toEqual([UNVERIFIED_INDEPENDENT_COVERAGE_GATE_LABEL, UNVERIFIED_INDEPENDENT_COVERAGE_GATE_REASON, "unverified"]);
    // Phase 0 (L07): the status is the 35933c8 status over the full signals; only label / reasons / data differ.
    const fullStatus = computeVerificationGate({ keyFindings: findings }).status;
    expect([ins.status, unv.status]).toEqual([fullStatus, fullStatus]);
    expect(unv.recommendedNextSteps.join(" ")).not.toMatch(/broad agreement/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// NITs — stored disagreement classification
// ---------------------------------------------------------------------------------------------------------------------

describe("classifyStoredDisagreement — established classification with >= 2 independent executing models (review of 262ef64, B3)", () => {
  // A run whose usable slots are all independent models (grok failed): the classification is the one established before
  // executing-model attribution (every item genuine), identical to the live panel's crossModelDisagreements.
  const row = (modelId: string, status: string, text = `${modelId} text`) => ({ modelId, status, rawTextTruncated: text });
  const ctx = storedRunIndependenceContext({ runDocument: { perModel: [row("chatgpt", "ok"), row("claude", "ok"), row("grok", "failed", "")] } });

  it("an item naming ONE slot in a non-collapsed run stays cross_model (no 'same executing model' without a collapse)", () => {
    expect(classifyStoredDisagreement({ topic: "t", positionsByModel: { chatgpt: "a" } }, ctx)).toBe("cross_model");
    expect(classifyStoredDisagreement({ topic: "t", models: ["ChatGPT", "chatgpt"] }, ctx)).toBe("cross_model");
  });

  it("an item also naming a slot that did not answer stays cross_model in a non-collapsed run (established behaviour)", () => {
    expect(classifyStoredDisagreement({ topic: "t", positionsByModel: { chatgpt: "a", grok: "b" } }, ctx)).toBe("cross_model");
    expect(classifyStoredDisagreement({ topic: "t", positionsByModel: { chatgpt: "a", claude: "b", grok: "c" } }, ctx)).toBe("cross_model");
  });

  it("controls: two answering independent slots stay cross_model; an unattributed line in a non-collapsed run stays cross_model", () => {
    expect(classifyStoredDisagreement({ topic: "t", positionsByModel: { chatgpt: "a", claude: "b" } }, ctx)).toBe("cross_model");
    expect(classifyStoredDisagreement("plain stored line", ctx)).toBe("cross_model");
  });

  it("same_executing_model only when the named slots actually collapsed onto one executing model", () => {
    const collapsed = storedRunIndependenceContext({
      runDocument: {
        perModel: [
          { modelId: "chatgpt", status: "substituted", provider: "deepseek", rawTextTruncated: "x" },
          { modelId: "claude", status: "substituted", provider: "deepseek", rawTextTruncated: "y" },
          row("grok", "ok"),
        ],
      },
    });
    expect(classifyStoredDisagreement({ topic: "t", positionsByModel: { chatgpt: "a", claude: "b" } }, collapsed)).toBe("same_executing_model");
    expect(classifyStoredDisagreement({ topic: "t", positionsByModel: { chatgpt: "a" } }, collapsed)).toBe("independence_unverified");
    expect(classifyStoredDisagreement({ topic: "t", positionsByModel: { chatgpt: "a", grok: "b" } }, collapsed)).toBe("cross_model");
  });
});
