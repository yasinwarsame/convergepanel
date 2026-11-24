/**
 * Item 7B — output-budget exhaustion: classification (7B-2), the optional 7A cause (D1), the one bounded repair (7B-3,
 * D2), the no-same-cap-retry rule (D5) and no partial-JSON promotion (D3). Synthetic data only; every connector is a
 * double, every path runs through the real finalizeAdaptiveRun.
 */
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), ADAPTIVE_VERIFICATION_ENABLED: false }));
jest.mock("@/lib/connectors/claude", () => ({ callClaude: jest.fn(), CLAUDE_PROVIDER_MODEL: "claude-haiku-4-5-20251001" }));
jest.mock("@/lib/connectors/chatgpt", () => ({ callChatGPT: jest.fn(), CHATGPT_PROVIDER_MODEL: "gpt-4o-mini" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
jest.mock("@/lib/connectors/grok", () => ({ callGrok: jest.fn() }));
jest.mock("@/lib/connectors/perplexity", () => ({ callPerplexity: jest.fn() }));

import { callClaude } from "@/lib/connectors/claude";
import { callChatGPT } from "@/lib/connectors/chatgpt";
import { callGemini } from "@/lib/connectors/gemini";
import { callGrok } from "@/lib/connectors/grok";
import { callPerplexity } from "@/lib/connectors/perplexity";
import { finalizeAdaptiveRun, OUTPUT_BUDGET_REPAIR_INSTRUCTION } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { AdaptiveRetryUsageSink, retryStateAllowsProviderSearchEvidence } from "@/lib/adaptiveSchema/retryCorrection";
import {
  deriveStructuredOutputDisclosure,
  deriveStructuredOutputExportDisclosure,
  describeAffectedState,
  readStructuredOutputRecord,
  structuredOutputDisclosureLines,
} from "@/lib/adaptiveSchema/structuredOutputDisclosure";
import { structuredOutputCause } from "@/lib/adaptiveSchema/commonResponseMeta";
import { evaluateAdaptiveGovernance } from "@/lib/governance/evaluateAdaptiveGovernance";
import { getDefaultGovernancePolicy } from "@/lib/governance/evaluateGovernance";
import type { CommonResponseMeta, QueryClassification } from "@/lib/adaptiveSchema/types";
import type { ModelId, ModelResult } from "@/lib/types";

const calls = {
  claude: callClaude as jest.Mock,
  chatgpt: callChatGPT as jest.Mock,
  gemini: callGemini as jest.Mock,
  grok: callGrok as jest.Mock,
  perplexity: callPerplexity as jest.Mock,
};
const totalCalls = () => Object.values(calls).reduce((n, m) => n + m.mock.calls.length, 0);

const classification = {
  queryType: "decision_support", domain: "test", answerShape: "decision_support_view", quantExpected: false, timeSensitivity: "low",
  userIntent: "make_decision", confidence: 0.9, riskLevel: "professional", evidenceRequirement: "medium", freshness: "timeless",
  inputType: "text", verificationMethod: "cross_model_consistency", requestedCount: null, requiresClarification: false, rationale: "fixture",
} as QueryClassification;

const VALID = JSON.stringify({
  decisionQuestion: "Which option?", options: ["Option A"], criteria: [], userProvidedCriteria: [], assessments: [], recommendationAction: "go",
  recommendedOption: "Option A", recommendationRationale: "r", recommendationCaveats: [], assumptions: [], uncertainties: [], risks: [],
  sensitivityFindings: [], reversibleNextStep: "", sources: [],
});
/** A cut-off fenced object — never parsed into anything. */
const CUT = "```json\n{ \"decisionQuestion\": \"Which option?\", \"options\": [\"Option A\", \"Opt";
/** Valid JSON missing required fields: a validation failure. */
const INVALID_FIELDS = JSON.stringify({ decisionQuestion: "Which option?" });

const REQUESTED: Record<string, string> = { claude: "claude-haiku-4-5-20251001", chatgpt: "gpt-4o-mini", gemini: "gemini-3.5-flash-lite", grok: "grok-4-1-fast-reasoning", perplexity: "perplexity/sonar" };
const FIRST_CAP: Record<string, number> = { claude: 4000, chatgpt: 2200, gemini: 8192, grok: 2200, perplexity: 6000 };

function primary(modelId: ModelId, over: Partial<ModelResult> = {}): ModelResult {
  return {
    modelId, status: "ok", rawText: CUT, latencyMs: 30_000, requestedModel: REQUESTED[modelId],
    tokenUsage: { totalTokens: FIRST_CAP[modelId] + 100, promptTokens: 100, completionTokens: FIRST_CAP[modelId] },
    terminationReason: "output_budget", ...over,
  };
}
const completeSlot = (modelId: ModelId): ModelResult => ({ modelId, status: "ok", rawText: VALID, latencyMs: 1_000, requestedModel: REQUESTED[modelId], terminationReason: "natural" });
const reply = (modelId: ModelId, over: Partial<ModelResult> = {}): ModelResult => ({
  modelId, status: "ok", rawText: VALID, latencyMs: 20_000, terminationReason: "natural",
  tokenUsage: { totalTokens: 2100, promptTokens: 100, completionTokens: 2000 }, ...over,
});

function ctx(over: Partial<{ nowMs: number }> = {}) {
  return {
    apiKeys: { claude: "k", chatgpt: "k", gemini: "k", grok: "k", perplexity: "k" },
    promptOverrides: { claude: "BASE PROMPT", chatgpt: "BASE PROMPT", gemini: "BASE PROMPT", grok: "BASE PROMPT", perplexity: "BASE PROMPT" },
    context: null,
    budget: { startedAtMonoMs: 0, budgetMs: 300_000 },
    usageSink: new AdaptiveRetryUsageSink(),
    now: () => over.nowMs ?? 1_000,
  };
}

async function run(results: ModelResult[], c = ctx()) {
  const out: any = await finalizeAdaptiveRun(SCHEMA_REGISTRY.decision_support, results, "Which option?", c as never, classification);
  return { out, meta: out.persistedOutput.meta as CommonResponseMeta, slot: (id: string) => out.adaptiveResults.find((r: any) => r.modelId === id), ctx: c };
}

let spies: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  spies = [jest.spyOn(console, "log").mockImplementation(() => {}), jest.spyOn(console, "warn").mockImplementation(() => {})];
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

describe("confirmed exhaustion + a compliant larger cap → exactly one bounded repair", () => {
  it("Claude: one call at the pinned 4,800 with the compact instruction; a normal-finish valid repair is adopted", async () => {
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId));
    const { slot, meta } = await run([primary("claude" as ModelId), completeSlot("chatgpt" as ModelId)]);
    expect(totalCalls()).toBe(1);
    const [, , , opts] = calls.claude.mock.calls[0];
    expect(opts.outputBudgetRepairMaxTokens).toBe(4800);
    expect(opts.systemPromptOverride).toBe(`BASE PROMPT\n\n${OUTPUT_BUDGET_REPAIR_INSTRUCTION}`);
    expect(opts.systemPromptOverride).not.toContain("failed validation");
    expect(slot("claude")).toMatchObject({ ok: true, retried: true, retryOutcome: "adopted_full" });
    // Recovered: every slot complete, so no 7A record, and the call counts are honest.
    expect([meta.totalModels, meta.successfulModels, meta.modelsWithUsableOutput]).toEqual([2, 2, 2]);
    expect(meta).not.toHaveProperty("structuredOutput");
  });

  it("ChatGPT: one call at the pinned 3,300", async () => {
    calls.chatgpt.mockResolvedValueOnce(reply("chatgpt" as ModelId));
    const { slot } = await run([primary("chatgpt" as ModelId, { latencyMs: 20_000 })]);
    expect(calls.chatgpt).toHaveBeenCalledTimes(1);
    expect(calls.chatgpt.mock.calls[0][3].outputBudgetRepairMaxTokens).toBe(3300);
    expect(slot("chatgpt").retryOutcome).toBe("adopted_full");
  });

  it("records the repair call's usage exactly once", async () => {
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId));
    const c = ctx();
    const record = jest.spyOn(c.usageSink, "record");
    await run([primary("claude" as ModelId)], c);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][1]).toBe("claude");
  });
});

describe("D3 — a repair is used only when the provider reports a normal finish", () => {
  it.each([
    ["the repair also stopped at its budget", { terminationReason: "output_budget" as const }],
    ["the repair gave no termination reason", { terminationReason: undefined }],
    ["the repair stopped for another reason", { terminationReason: "other" as const }],
  ])("%s → never parsed, first attempt stands (no_change), still exactly one call", async (_n, over) => {
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId, over)); // VALID JSON — must still not be used
    const { slot, meta } = await run([primary("claude" as ModelId), completeSlot("chatgpt" as ModelId)]);
    expect(totalCalls()).toBe(1);
    expect(slot("claude")).toMatchObject({ ok: false, retryOutcome: "no_change" });
    expect(slot("claude").retried).toBeUndefined();
    expect(slot("claude").data ?? null).toBeNull();
    expect(meta.structuredOutput?.slots[0]).toEqual({ modelId: "claude", call: "completed", result: "unavailable", cause: "output_budget_exhausted" });
  });

  it("a cut-off first attempt is never promoted, whatever its prefix contains", async () => {
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId, { status: "timeout", rawText: null, terminationReason: undefined }));
    const { slot } = await run([primary("claude" as ModelId)]);
    expect(slot("claude")).toMatchObject({ ok: false, retryOutcome: "failed_call" });
    expect(slot("claude").data ?? null).toBeNull();
  });
});

describe("failed repair → truthful disclosure", () => {
  it("non-ok repair (timeout) → failed_call; the 7A line names the output limit", async () => {
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId, { status: "timeout", rawText: null, terminationReason: undefined }));
    const { meta } = await run([primary("claude" as ModelId), completeSlot("chatgpt" as ModelId)]);
    const d = deriveStructuredOutputDisclosure(meta)!;
    expect(d.callsLine).toBe("2 of 2 provider calls completed.");
    expect(describeAffectedState(d.affected![0])).toBe(
      "unavailable: the provider call completed but returned no usable structured output; the response reached the provider's output-token limit"
    );
  });

  it("a thrown repair (guard) is failed_call with its usage recorded as unavailable", async () => {
    calls.claude.mockRejectedValueOnce(new Error("boom"));
    const c = ctx();
    const record = jest.spyOn(c.usageSink, "record");
    const { slot } = await run([primary("claude" as ModelId)], c);
    expect(slot("claude").retryOutcome).toBe("failed_call");
    expect(record).toHaveBeenCalledWith(0, "claude", null);
  });
});

describe("D5 — confirmed exhaustion with no compliant larger cap or no safe time: no call at all", () => {
  it.each(["gemini", "grok", "perplexity"])("%s (no pinned repair cap) → skipped_output_budget, zero calls", async (id) => {
    const { slot, meta } = await run([primary(id as ModelId), completeSlot("chatgpt" as ModelId)]);
    expect(totalCalls()).toBe(0);
    expect(slot(id).retryOutcome).toBe("skipped_output_budget");
    expect(slot(id).retried).toBeUndefined(); // never counted as a recovery
    expect(meta.structuredOutput?.slots[0]).toEqual({ modelId: id, call: "completed", result: "unavailable", cause: "output_budget_exhausted" });
  });

  it.each([
    ["the first attempt was too slow to scale (50 s → 60 s + margin > 60 s)", { latencyMs: 50_000 }],
    ["a different provider model was sent", { requestedModel: "claude-sonnet-5-5" }],
    ["no provider model was recorded", { requestedModel: undefined }],
    ["completion tokens were not reported", { tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null } }],
    ["latency was not measured", { latencyMs: 0 }],
  ])("Claude: %s → no repair, zero calls", async (_n, over) => {
    const { slot } = await run([primary("claude" as ModelId, over as Partial<ModelResult>)]);
    expect(totalCalls()).toBe(0);
    expect(slot("claude").retryOutcome).toBe("skipped_output_budget");
  });

  it("the remaining retry window binds: a late request skips the repair it would otherwise make", async () => {
    // remaining 300 − 180 = 120 s; guard = min(65, 120 − 76 = 44) s; 30 s → 36 s projected + 5 ≤ 44 → runs.
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId));
    await run([primary("claude" as ModelId)], ctx({ nowMs: 180_000 }));
    expect(totalCalls()).toBe(1);
    jest.clearAllMocks();
    // remaining 300 − 184 = 116 s; guard = 40 s < 41 s → no call.
    const { slot } = await run([primary("claude" as ModelId)], ctx({ nowMs: 184_000 }));
    expect(totalCalls()).toBe(0);
    expect(slot("claude").retryOutcome).toBe("skipped_output_budget");
  });

  it("below the model's minimum window the existing skipped_budget still applies (no call)", async () => {
    const { slot } = await run([primary("claude" as ModelId)], ctx({ nowMs: 220_000 }));
    expect(totalCalls()).toBe(0);
    expect(slot("claude").retryOutcome).toBe("skipped_budget");
  });

  it("the first attempt stands for provider search evidence, exactly like skipped_budget", () => {
    expect(retryStateAllowsProviderSearchEvidence({ slotStatus: "ok", retryOutcome: "skipped_output_budget", retried: undefined })).toBe(true);
    expect(retryStateAllowsProviderSearchEvidence({ slotStatus: "substituted", retryOutcome: "skipped_output_budget", retried: undefined })).toBe(false);
  });
});

describe("the established validation retry is unchanged; exhaustion is never inferred from malformed JSON", () => {
  it("a normal finish with invalid fields → the validation prompt at the first-attempt cap", async () => {
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId));
    await run([primary("claude" as ModelId, { rawText: INVALID_FIELDS, terminationReason: "natural" })]);
    expect(calls.claude).toHaveBeenCalledTimes(1);
    const opts = calls.claude.mock.calls[0][3];
    expect(opts).not.toHaveProperty("outputBudgetRepairMaxTokens");
    expect(opts.systemPromptOverride).toContain("failed validation");
  });

  it.each([["no reason reported", undefined], ["another reason", "other" as const]])(
    "cut-off-looking JSON with %s → validation retry, never a repair, cause not output_budget",
    async (_n, terminationReason) => {
      calls.claude.mockResolvedValueOnce(reply("claude" as ModelId, { rawText: CUT }));
      const { meta } = await run([primary("claude" as ModelId, { terminationReason }), completeSlot("chatgpt" as ModelId)]);
      expect(calls.claude).toHaveBeenCalledTimes(1);
      expect(calls.claude.mock.calls[0][3]).not.toHaveProperty("outputBudgetRepairMaxTokens");
      expect(calls.claude.mock.calls[0][3].systemPromptOverride).toContain("failed validation");
      expect(meta.structuredOutput?.slots[0]).toEqual({ modelId: "claude", call: "completed", result: "unavailable", cause: "unknown" });
    }
  );

  it("a normal finish that still fails validation → validation_failure", async () => {
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId, { rawText: "not json" }));
    const { meta } = await run([primary("claude" as ModelId, { rawText: "not json", terminationReason: "natural" }), completeSlot("chatgpt" as ModelId)]);
    expect(meta.structuredOutput?.slots[0]).toEqual({ modelId: "claude", call: "completed", result: "unavailable", cause: "validation_failure" });
  });

  it("a correctly validated first attempt is never retried, whatever it reports", async () => {
    const { slot, meta } = await run([primary("claude" as ModelId, { rawText: VALID })]);
    expect(totalCalls()).toBe(0);
    expect(slot("claude")).toMatchObject({ ok: true });
    expect(slot("claude")).not.toHaveProperty("retryOutcome");
    expect(meta).not.toHaveProperty("structuredOutput");
  });
});

describe("provider-call completion, termination cause and usability stay distinct", () => {
  it("an EMPTY answer that hit its budget (status error) stays a FAILED call (governance counts unchanged); its cause says why", async () => {
    const empty = primary("gemini" as ModelId, { status: "error", rawText: "Gemini returned an empty response. The panel ran with the other models." });
    const { meta, slot } = await run([empty, completeSlot("chatgpt" as ModelId)]);
    expect(totalCalls()).toBe(0);
    expect(slot("gemini")).not.toHaveProperty("retryOutcome"); // a non-ok primary never gains an adaptive retry
    expect([meta.totalModels, meta.successfulModels, meta.failedModels, meta.modelsWithUsableOutput]).toEqual([2, 1, 1, 1]);
    expect(meta.structuredOutput?.slots[0]).toEqual({ modelId: "gemini", call: "failed", result: "unavailable", cause: "output_budget_exhausted" });
    expect(structuredOutputDisclosureLines(deriveStructuredOutputDisclosure(meta)!, (id) => id)).toEqual([
      "2 models selected · 1 usable structured result",
      "1 of 2 provider calls completed.",
      "gemini — unavailable: the provider stopped at its output-token limit before returning any output.",
    ]);
  });

  it("a timeout or transport failure is provider_failure, never truncation", async () => {
    const { meta } = await run([{ modelId: "claude" as ModelId, status: "timeout", rawText: null, latencyMs: 60_000 }, { modelId: "grok" as ModelId, status: "failed", rawText: "Model unavailable.", latencyMs: 1 }, completeSlot("chatgpt" as ModelId)]);
    expect(totalCalls()).toBe(0);
    expect(meta.structuredOutput?.slots.slice(0, 2)).toEqual([
      { modelId: "claude", call: "failed", result: "unavailable", cause: "provider_failure" },
      { modelId: "grok", call: "failed", result: "unavailable", cause: "provider_failure" },
    ]);
    expect(describeAffectedState(deriveStructuredOutputDisclosure(meta)!.affected![0])).toBe("unavailable: the provider call did not complete");
  });

  it("a substituted slot is never retried and never inherits a primary's reason (slot attribution)", async () => {
    const sub = { modelId: "claude" as ModelId, status: "substituted", rawText: CUT, latencyMs: 1, provider: "deepseek", requestedModel: "claude-haiku-4-5-20251001", terminationReason: "output_budget" } as ModelResult;
    const { slot, meta } = await run([sub, completeSlot("chatgpt" as ModelId)]);
    expect(totalCalls()).toBe(0);
    expect(slot("claude").retryOutcome).toBe("ineligible_substituted");
    expect(meta.structuredOutput?.slots[0]).toEqual({ modelId: "claude", call: "completed", result: "unavailable", cause: "unknown" });
  });

  it("the pure cause rule", () => {
    const m = (o: Partial<ModelResult>) => ({ modelId: "claude", status: "ok", rawText: "", latencyMs: 1, ...o }) as ModelResult;
    const a = (o: Record<string, unknown> = {}) => ({ modelId: "claude", schemaId: "decision_support", ok: true, data: {}, ...o }) as never;
    expect(structuredOutputCause(m({}), undefined, "complete", true)).toBeUndefined();
    expect(structuredOutputCause(m({ terminationReason: "natural" }), a(), "partial", false)).toBeUndefined(); // cap-only shortening is by design
    expect(structuredOutputCause(m({ terminationReason: "output_budget" }), a(), "partial", false)).toBeUndefined(); // never budget wording on a cap shortening
    expect(structuredOutputCause(m({ terminationReason: "natural" }), a(), "partial", true)).toBe("validation_failure");
    expect(structuredOutputCause(m({ terminationReason: "output_budget" }), a(), "partial", true)).toBe("unknown"); // a parsed answer was not cut
    expect(structuredOutputCause(m({ terminationReason: "output_budget" }), undefined, "unavailable", true)).toBe("output_budget_exhausted");
    expect(structuredOutputCause(m({ status: "error", terminationReason: "output_budget" }), undefined, "unavailable", true)).toBe("output_budget_exhausted");
    expect(structuredOutputCause(m({ status: "error" }), undefined, "unavailable", true)).toBe("provider_failure");
    expect(structuredOutputCause(m({ status: "substituted", terminationReason: "natural" }), undefined, "unavailable", true)).toBe("unknown");
    // adopted retry: the discarded first attempt never describes the result
    expect(structuredOutputCause(m({ terminationReason: "output_budget" }), a({ retryOutcome: "adopted_full" }), "partial", true)).toBe("validation_failure");
    expect(structuredOutputCause(m({ terminationReason: "output_budget" }), a({ retryOutcome: "adopted_full" }), "partial", false)).toBeUndefined();
    expect(structuredOutputCause(m({ terminationReason: "natural" }), a({ retryOutcome: "adopted_partial" }), "partial", true)).toBe("unknown");
  });
});

describe("R1 MAJOR-2 — the cause describes the ADOPTED answer, never the discarded first attempt", () => {
  const longStep = Array.from({ length: 45 }, (_, i) => `w${i}`).join(" "); // > reversibleNextStep's 30-word cap
  const repaired = (over: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(VALID), ...over });

  it("first attempt exhausted → repair finished normally → usable but partial only by a schema word cap: no budget cause, no budget wording", async () => {
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId, { rawText: repaired({ reversibleNextStep: longStep }) }));
    const { slot, meta } = await run([primary("claude" as ModelId), completeSlot("chatgpt" as ModelId)]);
    expect(slot("claude")).toMatchObject({ ok: true, retryOutcome: "adopted_full" });
    expect(meta.structuredOutput?.slots[0]).toEqual({ modelId: "claude", call: "completed", result: "partial", shortenedFields: ["reversibleNextStep"] });
    const lines = structuredOutputDisclosureLines(deriveStructuredOutputDisclosure(meta)!, (id) => id);
    expect(lines[2]).toBe("claude — partially used: text shortened to the word limit in 1 field.");
    expect(lines.join("\n")).not.toContain("output-token");
  });

  it("first attempt exhausted → repair finished normally but one field failed validation: validation_failure, no budget wording", async () => {
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId, { rawText: repaired({ sources: "not-an-array" }) }));
    const { slot, meta } = await run([primary("claude" as ModelId), completeSlot("chatgpt" as ModelId)]);
    expect(slot("claude")).toMatchObject({ ok: true, retryOutcome: "adopted_full" });
    const s = meta.structuredOutput!.slots[0];
    expect(s).toMatchObject({ modelId: "claude", call: "completed", result: "partial", cause: "validation_failure" });
    expect(s.invalidFields).toContain("sources");
    expect(structuredOutputDisclosureLines(deriveStructuredOutputDisclosure(meta)!, (id) => id).join("\n")).not.toContain("output-token");
  });

  it("repair failed → the first attempt stands → output_budget_exhausted (accurate final attribution)", async () => {
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId, { status: "timeout", rawText: null, terminationReason: undefined }));
    const { meta } = await run([primary("claude" as ModelId)]);
    expect(meta.structuredOutput?.slots[0]).toEqual({ modelId: "claude", call: "completed", result: "unavailable", cause: "output_budget_exhausted" });
  });
});

describe("R1 MINOR-1 — provider output budget and schema word cap are separate limitations", () => {
  it("mixed run: each slot states only its own limitation", async () => {
    const longStep = Array.from({ length: 45 }, (_, i) => `w${i}`).join(" ");
    const shortened = { ...completeSlot("chatgpt" as ModelId), rawText: JSON.stringify({ ...JSON.parse(VALID), reversibleNextStep: longStep }) };
    // gemini: provider budget, nothing usable (no repair); chatgpt: schema word cap only; claude: a parsed answer that
    // reported a budget stop and is shortened only by a schema cap → no budget wording.
    const claudeParsed = primary("claude" as ModelId, { rawText: JSON.stringify({ ...JSON.parse(VALID), reversibleNextStep: longStep }) });
    const { meta } = await run([primary("gemini" as ModelId), shortened, claudeParsed]);
    expect(totalCalls()).toBe(0);
    expect(meta.structuredOutput?.slots).toEqual([
      { modelId: "gemini", call: "completed", result: "unavailable", cause: "output_budget_exhausted" },
      { modelId: "chatgpt", call: "completed", result: "partial", shortenedFields: ["reversibleNextStep"] },
      { modelId: "claude", call: "completed", result: "partial", shortenedFields: ["reversibleNextStep"] },
    ]);
    expect(structuredOutputDisclosureLines(deriveStructuredOutputDisclosure(meta)!, (id) => id).slice(2)).toEqual([
      "gemini — unavailable: the provider call completed but returned no usable structured output; the response reached the provider's output-token limit.",
      "chatgpt — partially used: text shortened to the word limit in 1 field.",
      "claude — partially used: text shortened to the word limit in 1 field.",
    ]);
  });
});

describe("R1 MAJOR-1 — governance inputs and outcome are identical with or without an output-budget signal", () => {
  const record = { version: 1, schemaId: "decision_support", answerShape: "decision_support_view", adaptiveOutputVersion: 1, humanReview: { status: "unreviewed" }, decisionReceipt: {}, createdAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:00.000Z" } as never;
  const governance = (meta: CommonResponseMeta) =>
    evaluateAdaptiveGovernance({ governanceRecord: record, policy: getDefaultGovernancePolicy(), modelFailureCount: meta.failedModels, successfulModelCount: meta.successfulModels, evaluatedAt: "2026-11-24T00:00:00.000Z" });

  it.each([
    ["unrepaired: an empty failed answer", { status: "error" as const, rawText: null }, false],
    ["unrepaired: a cut-off answer with no cap (gemini)", {}, false],
  ])("%s → same counts, still FLAGGED by reviewIfAnyModelFailed when the connector failed", async (_n, over, _repair) => {
    const ordinary: ModelResult = { ...primary("gemini" as ModelId, over), terminationReason: undefined };
    const budget: ModelResult = primary("gemini" as ModelId, over);
    const a = await run([ordinary, completeSlot("chatgpt" as ModelId)]);
    const b = await run([budget, completeSlot("chatgpt" as ModelId)]);
    expect([b.meta.successfulModels, b.meta.failedModels]).toEqual([a.meta.successfulModels, a.meta.failedModels]);
    expect(governance(b.meta)).toEqual(governance(a.meta));
    if ((over as { status?: string }).status === "error") {
      expect(governance(b.meta).status).toBe("flagged");
      expect(governance(b.meta).reasons.join(" ")).toMatch(/failed/);
    }
  });

  it("repaired: a recovered repair and an ordinary recovered validation retry produce the same governance input", async () => {
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId));
    const repairedRun = await run([primary("claude" as ModelId), completeSlot("chatgpt" as ModelId)]);
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId));
    const validationRun = await run([primary("claude" as ModelId, { rawText: INVALID_FIELDS, terminationReason: "natural" }), completeSlot("chatgpt" as ModelId)]);
    expect([repairedRun.meta.successfulModels, repairedRun.meta.failedModels]).toEqual([2, 0]);
    expect(governance(repairedRun.meta)).toEqual(governance(validationRun.meta));
  });

  it("repaired path that failed: same counts as an ordinary failed validation retry", async () => {
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId, { status: "timeout", rawText: null, terminationReason: undefined }));
    const budgetRun = await run([primary("claude" as ModelId), completeSlot("chatgpt" as ModelId)]);
    calls.claude.mockResolvedValueOnce(reply("claude" as ModelId, { status: "timeout", rawText: null, terminationReason: undefined }));
    const ordinaryRun = await run([primary("claude" as ModelId, { terminationReason: "natural", rawText: "not json" }), completeSlot("chatgpt" as ModelId)]);
    expect([budgetRun.meta.successfulModels, budgetRun.meta.failedModels]).toEqual([ordinaryRun.meta.successfulModels, ordinaryRun.meta.failedModels]);
    expect(governance(budgetRun.meta)).toEqual(governance(ordinaryRun.meta));
  });
});

describe("D1 — the cause is strictly read, additive, and exported", () => {
  const base = { totalModels: 2, successfulModels: 1, modelsWithUsableOutput: 1, schemaId: "decision_support" } as Partial<CommonResponseMeta>;
  const rec = (slot: Record<string, unknown>) => ({ ...base, structuredOutput: { version: 1, slots: [{ modelId: "chatgpt", call: "completed", result: "complete" }, slot] } }) as never;
  it("accepts each valid cause and rejects unknown values or contradictions (fail closed); count checks unchanged", () => {
    expect(readStructuredOutputRecord(rec({ modelId: "claude", call: "failed", result: "unavailable", cause: "provider_failure" }))).not.toBeNull();
    expect(readStructuredOutputRecord(rec({ modelId: "claude", call: "failed", result: "unavailable", cause: "unknown" }))).not.toBeNull();
    expect(readStructuredOutputRecord(rec({ modelId: "claude", call: "failed", result: "unavailable", cause: "output_budget_exhausted" }))).not.toBeNull();
    expect(readStructuredOutputRecord(rec({ modelId: "claude", call: "failed", result: "unavailable" }))).not.toBeNull(); // pre-7B record
    const both = { ...base, successfulModels: 2 };
    const rec2 = (slot: Record<string, unknown>) => ({ ...both, structuredOutput: { version: 1, slots: [{ modelId: "chatgpt", call: "completed", result: "complete" }, slot] } }) as never;
    expect(readStructuredOutputRecord(rec2({ modelId: "claude", call: "completed", result: "unavailable", cause: "output_budget_exhausted" }))).not.toBeNull();
    expect(readStructuredOutputRecord(rec2({ modelId: "claude", call: "completed", result: "unavailable", cause: "validation_failure" }))).not.toBeNull();
    // the 7A count check still binds: a completed-call slot against successfulModels 1 is rejected
    expect(readStructuredOutputRecord(rec({ modelId: "claude", call: "completed", result: "unavailable", cause: "output_budget_exhausted" }))).toBeNull();
    // contradictions and unknown values reject the whole record
    expect(readStructuredOutputRecord(rec({ modelId: "claude", call: "failed", result: "unavailable", cause: "validation_failure" }))).toBeNull();
    expect(readStructuredOutputRecord(rec2({ modelId: "claude", call: "completed", result: "unavailable", cause: "provider_failure" }))).toBeNull();
    const partialBudget = { totalModels: 1, successfulModels: 1, modelsWithUsableOutput: 1, structuredOutput: { version: 1, slots: [{ modelId: "claude", call: "completed", result: "partial", invalidFields: ["risks"], cause: "output_budget_exhausted" }] } };
    expect(readStructuredOutputRecord(partialBudget as never)).toBeNull();
    expect(readStructuredOutputRecord(rec({ modelId: "claude", call: "failed", result: "unavailable", cause: "timeout" }))).toBeNull();
    expect(readStructuredOutputRecord(rec({ modelId: "claude", call: "failed", result: "unavailable", cause: "" }))).toBeNull();
    expect(readStructuredOutputRecord(rec({ modelId: "claude", call: "failed", result: "unavailable", cause: 1 }))).toBeNull();
    expect(readStructuredOutputRecord(rec({ modelId: "claude", call: "failed", result: "unavailable", cause: null }))).toBeNull();
    const withComplete = { ...base, successfulModels: 2, modelsWithUsableOutput: 2, structuredOutput: { version: 1, slots: [{ modelId: "chatgpt", call: "completed", result: "complete", cause: "unknown" }, { modelId: "claude", call: "completed", result: "partial", shortenedFields: ["risks"] }] } };
    expect(readStructuredOutputRecord(withComplete as never)).toBeNull();
  });

  it("only output_budget_exhausted adds wording, and only on an unavailable slot", () => {
    const failedCall = deriveStructuredOutputDisclosure({ totalModels: 1, successfulModels: 0, modelsWithUsableOutput: 0, structuredOutput: { version: 1, slots: [{ modelId: "claude", call: "failed", result: "unavailable", cause: "output_budget_exhausted" }] } } as never)!;
    expect(describeAffectedState(failedCall.affected![0])).toBe("unavailable: the provider stopped at its output-token limit before returning any output");
    for (const cause of ["validation_failure", "unknown"]) {
      const d = deriveStructuredOutputDisclosure({ totalModels: 1, successfulModels: 1, modelsWithUsableOutput: 0, structuredOutput: { version: 1, slots: [{ modelId: "claude", call: "completed", result: "unavailable", cause }] } } as never)!;
      expect(describeAffectedState(d.affected![0])).toBe("unavailable: the provider call completed but returned no usable structured output");
    }
    const part = deriveStructuredOutputDisclosure({ totalModels: 1, successfulModels: 1, modelsWithUsableOutput: 1, schemaId: "decision_support", structuredOutput: { version: 1, slots: [{ modelId: "claude", call: "completed", result: "partial", invalidFields: ["risks"], cause: "validation_failure" }] } } as never)!;
    expect(describeAffectedState(part.affected![0])).toBe("partially used: 1 field not recovered");
  });

  it("the export disclosure carries the cause; a pre-7B record exports exactly as before", () => {
    const meta = { totalModels: 1, successfulModels: 1, modelsWithUsableOutput: 0, structuredOutput: { version: 1, slots: [{ modelId: "claude", call: "completed", result: "unavailable", cause: "output_budget_exhausted" }] } };
    const exp = deriveStructuredOutputExportDisclosure(meta, (id) => id)!;
    expect(exp.affected![0].cause).toBe("output_budget_exhausted");
    const legacy = { ...meta, structuredOutput: { version: 1, slots: [{ modelId: "claude", call: "completed", result: "unavailable" }] } };
    const old = deriveStructuredOutputExportDisclosure(legacy, (id) => id)!;
    expect(old.affected![0]).not.toHaveProperty("cause");
    expect(old.lines).toEqual(["1 model selected · 0 usable structured results", "1 of 1 provider call completed.", "claude — unavailable: the provider call completed but returned no usable structured output."]);
  });
});
