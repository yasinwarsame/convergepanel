/**
 * Item 7A — structured-output degradation disclosure (G1-G4). Synthetic data only.
 *
 * The run-2d2e2b35 shape: five models selected, one (claude) with no usable structured output, four usable.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import DecisionSupportView from "@/components/adaptive/DecisionSupportView";
import { validateAdaptiveResponse } from "@/lib/adaptiveSchema/validator";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { mergeAdaptiveRetry } from "@/lib/adaptiveSchema/retryCorrection";
import { buildCommonResponseMeta, buildStructuredOutputRecord } from "@/lib/adaptiveSchema/commonResponseMeta";
import { buildDecisionSupportResult, type DecisionSupportFields } from "@/lib/adaptiveSchema/decisionSupportAlignment";
import { buildAdaptiveDecisionReceipt } from "@/lib/adaptiveSchema/decisionReceiptBuilder";
import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import {
  deriveStructuredOutputDisclosure,
  describeAffectedState,
  readStructuredOutputRecord,
  STRUCTURED_OUTPUT_DETAIL_NOT_RECORDED,
} from "@/lib/adaptiveSchema/structuredOutputDisclosure";
import type { AdaptiveModelResult, CommonResponseMeta, QueryClassification } from "@/lib/adaptiveSchema/types";
import type { PersistedAdaptiveOutputV1 } from "@/lib/adaptiveSchema/persistedOutput";
import type { ModelId, ModelResult } from "@/lib/types";

const FIVE: ModelId[] = ["chatgpt", "claude", "gemini", "grok", "perplexity"] as ModelId[];

function classification(): QueryClassification {
  return {
    queryType: "decision_support", domain: "test", answerShape: "decision_support_view", quantExpected: false, timeSensitivity: "low",
    userIntent: "make_decision", confidence: 0.9, riskLevel: "professional", evidenceRequirement: "medium", freshness: "timeless",
    inputType: "text", verificationMethod: "cross_model_consistency", requestedCount: null, requiresClarification: false, rationale: "fixture",
  } as QueryClassification;
}

function fields(over: Partial<DecisionSupportFields> = {}): DecisionSupportFields {
  return {
    decisionQuestion: "Which option?", options: [], criteria: [], userProvidedCriteria: [], assessments: [], recommendationAction: "defer",
    recommendedOption: "none", recommendationRationale: "r", recommendationCaveats: [], assumptions: [], uncertainties: [], risks: [],
    sensitivityFindings: [], reversibleNextStep: "", sources: [], ...over,
  };
}

const modelResult = (modelId: ModelId): ModelResult => ({ modelId, status: "ok", rawText: "{}", latencyMs: 1 });
const usable = (modelId: ModelId, extra: Partial<AdaptiveModelResult> = {}): AdaptiveModelResult => ({ modelId, schemaId: "decision_support", ok: true, data: {}, ...extra });
const failed = (modelId: ModelId): AdaptiveModelResult => ({ modelId, schemaId: "decision_support", ok: false, data: null, parseError: "Invalid JSON: x" });

/** The 2d2e shape: every call completed at the provider, claude's structured output was not usable. */
function twoDTwoEMeta(): CommonResponseMeta {
  const result = buildDecisionSupportResult(FIVE.filter((m) => m !== "claude").map((modelId) => ({ modelId, fields: fields() })), 5, "professional");
  return buildCommonResponseMeta({
    schema: SCHEMA_REGISTRY.decision_support,
    classification: classification(),
    modelResults: FIVE.map(modelResult),
    adaptiveResults: FIVE.map((m) => (m === "claude" ? failed(m) : usable(m))),
    schemaResult: result,
  });
}

function dsOutput(meta: CommonResponseMeta): PersistedAdaptiveOutputV1 {
  const result = buildDecisionSupportResult(FIVE.filter((m) => m !== "claude").map((modelId) => ({ modelId, fields: fields() })), 5, "professional");
  return { version: 1, schemaId: "decision_support", answerShape: "decision_support_view", classification: classification(), meta, generatedAt: "2026-11-23T00:00:00.000Z", result } as unknown as PersistedAdaptiveOutputV1;
}

const SALVAGE_RAW = JSON.stringify({
  summary: "s",
  settledClaims: [],
  disputedClaims: [
    { id: "a", claim: "Valid claim one.", stance: "asserts", confidence: "majority_view", evidenceType: "empirical" },
    { id: "b", claim: "SECRET-DROPPED-CONTENT should never be kept.", stance: "definitely-yes", confidence: "settled", evidenceType: "empirical" },
  ],
  keyMetrics: [],
  openQuestions: [],
});

describe("G3 — dropped-item counts (validator, retry merge)", () => {
  it("counts items discarded by salvage per kept field, and keeps no discarded content", () => {
    const r = validateAdaptiveResponse("gemini", SCHEMA_REGISTRY.contested_empirical, SALVAGE_RAW, { silent: true });
    expect(r.ok).toBe(true);
    expect((r.data?.disputedClaims as unknown[]).length).toBe(1);
    expect(r.droppedItems).toEqual({ disputedClaims: 1 });
    expect(JSON.stringify(r)).not.toContain("SECRET-DROPPED-CONTENT");
  });

  it("is absent when nothing was discarded", () => {
    const clean = JSON.stringify({ summary: "s", settledClaims: [], disputedClaims: [], keyMetrics: [], openQuestions: [] });
    const r = validateAdaptiveResponse("gemini", SCHEMA_REGISTRY.contested_empirical, clean, { silent: true });
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty("droppedItems");
  });

  it("a partially adopted retry keeps the count of the attempt each field came from", () => {
    const first: AdaptiveModelResult = { modelId: "claude" as ModelId, schemaId: "contested_empirical", ok: true, data: { disputedClaims: [] }, invalidFields: ["summary"], droppedItems: { disputedClaims: 2 }, itemsOverLimit: { disputedClaims: 3 } };
    const retried: AdaptiveModelResult = { modelId: "claude" as ModelId, schemaId: "contested_empirical", ok: true, data: { summary: "s", disputedClaims: [] }, droppedItems: { disputedClaims: 9, summary: 1 }, itemsOverLimit: { disputedClaims: 7, summary: 4 } };
    const { result, outcome } = mergeAdaptiveRetry(first, retried);
    expect(outcome).toBe("adopted_partial");
    expect(result.droppedItems).toEqual({ disputedClaims: 2, summary: 1 });
    expect(result.itemsOverLimit).toEqual({ disputedClaims: 3, summary: 4 });
  });
});

describe("structured-output record (persisted meta)", () => {
  it("2d2e shape: one slot per selected model, claude unavailable, others complete", () => {
    const meta = twoDTwoEMeta();
    expect(meta.totalModels).toBe(5);
    expect(meta.successfulModels).toBe(5); // every provider call completed
    expect(meta.modelsWithUsableOutput).toBe(4); // ...but only four were usable
    expect(meta.structuredOutput).toEqual({
      version: 1,
      slots: FIVE.map((m) => ({ modelId: m, call: "completed", result: m === "claude" ? "unavailable" : "complete" })),
    });
  });

  it("is absent for a complete run", () => {
    expect(buildStructuredOutputRecord(FIVE.map(modelResult), FIVE.map((m) => usable(m)))).toBeUndefined();
  });

  it("records partial salvage as field keys and counts only, and keeps provider-call status separate", () => {
    const rec = buildStructuredOutputRecord(
      [modelResult("chatgpt" as ModelId), modelResult("claude" as ModelId), { ...modelResult("grok" as ModelId), status: "timeout", rawText: null }],
      [usable("chatgpt" as ModelId), usable("claude" as ModelId, { invalidFields: ["sources"], droppedItems: { risks: 1 } }), failed("grok" as ModelId)]
    );
    expect(rec).toEqual({
      version: 1,
      slots: [
        { modelId: "chatgpt", call: "completed", result: "complete" },
        { modelId: "claude", call: "completed", result: "partial", invalidFields: ["sources"], droppedItems: { risks: 1 } },
        { modelId: "grok", call: "failed", result: "unavailable" },
      ],
    });
  });

  it("material shortening rule: items cut by an item cap are recorded; prose trimmed to a word cap is not", () => {
    const pair = [modelResult("chatgpt" as ModelId), modelResult("claude" as ModelId)];
    const wordOnly = buildStructuredOutputRecord(pair, [usable("chatgpt" as ModelId, { truncatedFields: ["reversibleNextStep"] }), usable("claude" as ModelId)]);
    expect(wordOnly).toBeUndefined();
    const itemCap = buildStructuredOutputRecord(pair, [usable("chatgpt" as ModelId, { truncatedFields: ["risks"], itemsOverLimit: { risks: 2 } }), usable("claude" as ModelId)]);
    expect(itemCap).toEqual({
      version: 1,
      slots: [
        { modelId: "chatgpt", call: "completed", result: "partial", itemsOverLimit: { risks: 2 } },
        { modelId: "claude", call: "completed", result: "complete" },
      ],
    });
  });

  it("validator counts items cut by an item cap (counts only)", () => {
    const schema = SCHEMA_REGISTRY.contested_empirical;
    const field = schema.fields.find((f) => f.key === "disputedClaims")!;
    const cap = field.maxItems ?? 0;
    expect(cap).toBeGreaterThan(0);
    const claims = Array.from({ length: cap + 2 }, (_, i) => ({ id: `c${i}`, claim: `Claim ${i}.`, stance: "asserts", confidence: "majority_view", evidenceType: "empirical" }));
    const r = validateAdaptiveResponse("gemini", schema, JSON.stringify({ summary: "s", settledClaims: [], disputedClaims: claims, keyMetrics: [], openQuestions: [] }), { silent: true });
    expect(r.itemsOverLimit).toEqual({ disputedClaims: 2 });
    expect((r.data?.disputedClaims as unknown[]).length).toBe(cap);
  });
});

describe("end to end through finalizeAdaptiveRun (real validation, slot order, substitution, failures)", () => {
  it("records each slot in order with its own provider status and usability", async () => {
    const valid = JSON.stringify(fields({ options: ["Option A"], recommendationAction: "go" }));
    const results: ModelResult[] = [
      { modelId: "chatgpt" as ModelId, status: "ok", rawText: valid, latencyMs: 1 },
      { modelId: "claude" as ModelId, status: "substituted", rawText: valid, latencyMs: 1, provider: "deepseek", requestedModel: "claude" } as ModelResult,
      { modelId: "gemini" as ModelId, status: "ok", rawText: "```json\n{ \"decisionQuestion\": \"cut off", latencyMs: 1 },
      { modelId: "grok" as ModelId, status: "timeout", rawText: null, latencyMs: 1 },
    ];
    const out: any = await finalizeAdaptiveRun(SCHEMA_REGISTRY.decision_support, results, "Which option?", undefined, classification());
    expect(out.adaptiveResults.map((r: AdaptiveModelResult) => [r.modelId, r.ok])).toEqual([["chatgpt", true], ["claude", true], ["gemini", false], ["grok", false]]);
    const meta = out.persistedOutput.meta as CommonResponseMeta;
    expect([meta.totalModels, meta.successfulModels, meta.modelsWithUsableOutput]).toEqual([4, 3, 2]);
    expect(meta.structuredOutput).toEqual({
      version: 1,
      slots: [
        { modelId: "chatgpt", call: "completed", result: "complete" },
        { modelId: "claude", call: "completed", result: "complete" },
        { modelId: "gemini", call: "completed", result: "unavailable" },
        { modelId: "grok", call: "failed", result: "unavailable" },
      ],
    });
    expect(deriveStructuredOutputDisclosure(meta)!.affected!.map((m) => [m.modelId, describeAffectedState(m)])).toEqual([
      ["gemini", "unavailable — the provider call completed but returned no usable structured output"],
      ["grok", "unavailable — the provider call did not complete"],
    ]);
  });

  it("a complete run through finalizeAdaptiveRun persists no record", async () => {
    const valid = JSON.stringify(fields({ options: ["Option A"], recommendationAction: "go" }));
    const results: ModelResult[] = ["chatgpt", "claude"].map((m) => ({ modelId: m as ModelId, status: "ok", rawText: valid, latencyMs: 1 }));
    const out: any = await finalizeAdaptiveRun(SCHEMA_REGISTRY.decision_support, results, "Which option?", undefined, classification());
    expect(out.persistedOutput.meta).not.toHaveProperty("structuredOutput");
  });
});

describe("shared disclosure", () => {
  it("2d2e shape: '5 models selected · 4 usable structured results', claude named unavailable", () => {
    const d = deriveStructuredOutputDisclosure(twoDTwoEMeta())!;
    expect(d.headline).toBe("5 models selected · 4 usable structured results");
    expect(d.affected).toEqual([{ modelId: "claude", state: "unavailable", providerCall: "completed", fieldsNotRecovered: 0, itemsDiscarded: 0, itemsOverLimit: 0 }]);
    expect(describeAffectedState(d.affected![0])).toBe("unavailable — the provider call completed but returned no usable structured output");
    expect(d.callsLine).toBe("5 of 5 provider calls completed.");
  });

  it("complete run: nothing to disclose", () => {
    expect(deriveStructuredOutputDisclosure({ totalModels: 5, successfulModels: 5, modelsWithUsableOutput: 5 })).toBeNull();
  });

  it("legacy run with a shortfall but no per-slot record: counts shown, affected models NOT guessed", () => {
    const d = deriveStructuredOutputDisclosure({ totalModels: 5, successfulModels: 5, modelsWithUsableOutput: 4 })!;
    expect(d.headline).toBe("5 models selected · 4 usable structured results");
    expect(d.affected).toBeNull();
  });

  it("a malformed or inconsistent record is ignored, never trusted", () => {
    const base = { totalModels: 2, successfulModels: 2, modelsWithUsableOutput: 1 };
    const slots = [{ modelId: "chatgpt", call: "completed", result: "complete" }, { modelId: "claude", call: "completed", result: "unavailable" }];
    expect(readStructuredOutputRecord({ ...base, structuredOutput: { version: 1, slots } } as never)).not.toBeNull();
    expect(readStructuredOutputRecord({ ...base, structuredOutput: { version: 2, slots } } as never)).toBeNull();
    expect(readStructuredOutputRecord({ ...base, structuredOutput: { version: 1, slots: slots.slice(0, 1) } } as never)).toBeNull();
    expect(readStructuredOutputRecord({ ...base, modelsWithUsableOutput: 2, structuredOutput: { version: 1, slots } } as never)).toBeNull();
    expect(readStructuredOutputRecord({ ...base, structuredOutput: { version: 1, slots: [slots[0], { modelId: "claude", call: "completed", result: "gone" }] } } as never)).toBeNull();
    expect(readStructuredOutputRecord({ ...base, structuredOutput: { version: 1, slots: [slots[0], { modelId: "claude", call: "completed", result: "unavailable", droppedItems: { risks: -1 } }] } } as never)).toBeNull();
    expect(readStructuredOutputRecord({ ...base, structuredOutput: { version: 1, slots: [slots[0], { modelId: "claude", result: "unavailable" }] } } as never)).toBeNull(); // no call status
    expect(readStructuredOutputRecord({ ...base, successfulModels: 1, structuredOutput: { version: 1, slots } } as never)).toBeNull(); // call count mismatch
    // A missing slot is rejected even when the usable and call counts happen to match.
    expect(readStructuredOutputRecord({ totalModels: 3, successfulModels: 2, modelsWithUsableOutput: 1, structuredOutput: { version: 1, slots } } as never)).toBeNull();
    expect(deriveStructuredOutputDisclosure({ ...base, structuredOutput: { version: 1, slots: slots.slice(0, 1) } } as never)!.affected).toBeNull();
  });

  it("partial salvage, items cut by a limit, and a failed provider call are each described", () => {
    const meta = {
      totalModels: 3, successfulModels: 2, modelsWithUsableOutput: 2,
      structuredOutput: {
        version: 1,
        slots: [
          { modelId: "chatgpt", call: "completed", result: "partial", itemsOverLimit: { risks: 2 } },
          { modelId: "claude", call: "completed", result: "partial", invalidFields: ["sources"], droppedItems: { risks: 1 } },
          { modelId: "grok", call: "failed", result: "unavailable" },
        ],
      },
    } as unknown as CommonResponseMeta;
    const d = deriveStructuredOutputDisclosure(meta)!;
    expect(d.headline).toBe("3 models selected · 2 usable structured results");
    expect(d.callsLine).toBe("2 of 3 provider calls completed.");
    expect(d.affected!.map(describeAffectedState)).toEqual([
      "partially used — 2 items beyond field limits not included",
      "partially used — 1 field not recovered; 1 item discarded as invalid",
      "unavailable — the provider call did not complete",
    ]);
  });
});

describe("G1/G2 — live and reopened report presentation (real AdaptivePanelResponse)", () => {
  const results: AdaptiveModelResult[] = FIVE.map((m) => (m === "claude" ? failed(m) : usable(m)));
  const render = (meta: Partial<CommonResponseMeta> | undefined, rs: AdaptiveModelResult[] = results) =>
    renderToStaticMarkup(
      createElement(AdaptivePanelResponse, {
        schema: SCHEMA_REGISTRY.decision_support,
        classification: classification(),
        results: rs,
        decisionSupport: dsOutput(twoDTwoEMeta()).result as never,
        question: "Which option?",
        meta: meta as CommonResponseMeta,
      } as never)
    );

  it("2d2e shape: the report shows the headline, names claude as unavailable, and the panel detail agrees", () => {
    const html = render(twoDTwoEMeta());
    expect(html).toContain('data-testid="structured-output-notice"');
    expect(html).toContain('role="note"');
    expect(html.split("5 models selected · 4 usable structured results").length - 1).toBe(2); // notice + panel detail
    expect(html).toMatch(/data-testid="structured-output-affected"[^]*Claude[^]*unavailable — the provider call completed but returned no usable structured output/);
    expect(html).toContain("5 of 5 provider calls completed.");
    expect(html).toContain("Panel detail (5 models selected · 4 usable structured results)");
    expect(html).toMatch(/data-testid="ds-unavailable-models"[^]*Unavailable:[^]*Claude/);
  });

  it("complete run: no notice and the established panel detail", () => {
    const meta = { totalModels: 5, successfulModels: 5, modelsWithUsableOutput: 5 } as CommonResponseMeta;
    const html = render(meta, FIVE.map((m) => usable(m)));
    expect(html).not.toContain("structured-output-notice");
    expect(html).not.toContain("ds-unavailable-models");
    expect(html).toContain("Panel detail (5 models)");
  });

  it("no meta at all (pre-Phase-1 shape): no notice, nothing inferred", () => {
    const html = render(undefined);
    expect(html).not.toContain("structured-output-notice");
    expect(html).toContain("Panel detail (5 models)");
  });

  it("legacy shortfall without a per-slot record: counts shown, affected models not guessed", () => {
    const html = render({ totalModels: 5, successfulModels: 5, modelsWithUsableOutput: 4 }, []);
    expect(html).toContain("5 models selected · 4 usable structured results");
    expect(html).toContain(STRUCTURED_OUTPUT_DETAIL_NOT_RECORDED);
    expect(html).not.toContain("ds-unavailable-models");
  });

  it("DecisionSupportView without a disclosure is unchanged", () => {
    const html = renderToStaticMarkup(createElement(DecisionSupportView, { decisionSupport: dsOutput(twoDTwoEMeta()).result as never }));
    expect(html).toContain("Panel detail (5 models)");
    expect(html).not.toContain("ds-unavailable-models");
  });
});

describe("G4 parity — Receipt and exports use the same counts", () => {
  it("the Receipt keeps its existing limitation, with the same counts as the disclosure", () => {
    const meta = twoDTwoEMeta();
    const receipt = buildAdaptiveDecisionReceipt(dsOutput(meta));
    expect(receipt.limitations).toContain("1 of 5 selected models did not produce usable structured output.");
    const d = deriveStructuredOutputDisclosure(meta)!;
    expect(d.selected - d.usable).toBe(1);
  });

  it("the export snapshot itself is unchanged: no model is marked failed from the record", () => {
    const { reportSnapshot } = buildExportSnapshot({ question: "q", selectedModels: FIVE, runDocument: {}, milestone2: { output: dsOutput(twoDTwoEMeta()) } } as never);
    expect((reportSnapshot as { models: { ok?: boolean }[] }).models.every((m) => m.ok === undefined)).toBe(true);
  });
});
