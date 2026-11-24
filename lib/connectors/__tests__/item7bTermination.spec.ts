/**
 * Item 7B — provider termination reasons (7B-1). Synthetic data only; no real provider call is ever made.
 *
 * The pure mapping is checked value by value, and every connector is exercised for real with only its SDK / fetch
 * doubled: the provider-reported reason is captured, the connector status is NEVER changed by it, a timeout or
 * transport failure never gains a termination reason, and a repair cap is honoured only when it is the pinned one.
 */
const mockOpenAICreate = jest.fn();
jest.mock("openai", () => ({ __esModule: true, default: function OpenAI() { return { chat: { completions: { create: (...a: unknown[]) => mockOpenAICreate(...a) } } }; } }));
const mockAnthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: function Anthropic() { return { messages: { create: (...a: unknown[]) => mockAnthropicCreate(...a) } }; } }));
const mockGenerateContent = jest.fn();
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: function GoogleGenerativeAI() { return { getGenerativeModel: () => ({ generateContent: (...a: unknown[]) => mockGenerateContent(...a) }) }; },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), PERPLEXITY_API_KEY: "", GROK_MODEL: "grok-test-model", XAI_API_KEY: "" }));

import { callClaude } from "@/lib/connectors/claude";
import { callChatGPT } from "@/lib/connectors/chatgpt";
import { callGrok } from "@/lib/connectors/grok";
import { callGemini } from "@/lib/connectors/gemini";
import { callPerplexity } from "@/lib/connectors/perplexity";
import { claudeTermination, geminiTermination, openAiCompatibleTermination, perplexityTermination } from "@/lib/connectors/termination";
import {
  connectorMaxTokens,
  entrySatisfiesRepairBounds,
  OUTPUT_BUDGET_REPAIR_CAPS,
  OUTPUT_BUDGET_REPAIR_POLICY_CEILING,
  outputBudgetRepairCap,
  outputBudgetRepairFitsWindow,
} from "@/lib/outputBudgetRepairPolicy";
import { MODEL_LIMITS, MODEL_TIMEOUTS } from "@/lib/modelConfig";
import { readFileSync } from "fs";
import { join } from "path";

const KEY = "sk-FAKE-test-key-never-real-0000";
const env = process.env as Record<string, string | undefined>;
let spies: jest.SpyInstance[] = [];
const realFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  env.GEMINI_API_KEY = KEY;
  spies = [jest.spyOn(console, "log").mockImplementation(() => {}), jest.spyOn(console, "warn").mockImplementation(() => {}), jest.spyOn(console, "error").mockImplementation(() => {})];
});
afterEach(() => {
  spies.forEach((s) => s.mockRestore());
  global.fetch = realFetch;
  delete env.GEMINI_API_KEY;
});

describe("pure mapping — only the provider's own documented values", () => {
  it("Anthropic stop_reason", () => {
    expect(claudeTermination("max_tokens")).toBe("output_budget");
    expect(claudeTermination("end_turn")).toBe("natural");
    expect(claudeTermination("stop_sequence")).toBe("natural");
    for (const other of ["refusal", "tool_use", "pause_turn", "model_context_window_exceeded", "something_new"]) expect(claudeTermination(other)).toBe("other");
    for (const unknown of [undefined, null, "", 3, {}]) expect(claudeTermination(unknown)).toBeUndefined();
  });
  it("OpenAI-compatible finish_reason (OpenAI, xAI)", () => {
    expect(openAiCompatibleTermination("length")).toBe("output_budget");
    expect(openAiCompatibleTermination("stop")).toBe("natural");
    for (const other of ["content_filter", "tool_calls", "function_call", "max_tokens"]) expect(openAiCompatibleTermination(other)).toBe("other");
    for (const unknown of [undefined, null, ""]) expect(openAiCompatibleTermination(unknown)).toBeUndefined();
  });
  it("Gemini finishReason — MAX_TOKENS only (the undocumented MAX_OUTPUT_TOKENS is not evidence)", () => {
    expect(geminiTermination("MAX_TOKENS")).toBe("output_budget");
    expect(geminiTermination("STOP")).toBe("natural");
    for (const other of ["SAFETY", "RECITATION", "OTHER", "MALFORMED_RESPONSE", "MAX_OUTPUT_TOKENS"]) expect(geminiTermination(other)).toBe("other");
    for (const unknown of [undefined, "", "FINISH_REASON_UNSPECIFIED"]) expect(geminiTermination(unknown)).toBeUndefined();
  });
  it("Perplexity Agent run status", () => {
    expect(perplexityTermination("completed", null)).toBe("natural");
    expect(perplexityTermination("incomplete", "max_output_tokens")).toBe("output_budget");
    expect(perplexityTermination("incomplete", "content_filter")).toBe("other");
    expect(perplexityTermination("incomplete", null)).toBeUndefined();
    for (const s of ["failed", "cancelled", "in_progress", null]) expect(perplexityTermination(s, "max_output_tokens")).toBeUndefined();
  });
});

const claudeMessage = (text: string, stop_reason: unknown) => ({ content: text ? [{ type: "text", text }] : [], stop_reason, usage: { input_tokens: 10, output_tokens: 4000 } });
const openAiCompletion = (text: string | null, finish_reason: unknown) => ({ choices: [{ message: { content: text }, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 2200, total_tokens: 2210 } });
const jsonResponse = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body, clone() { return this; }, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("Claude connector", () => {
  it("captures max_tokens as output_budget and keeps status ok when text came back", async () => {
    mockAnthropicCreate.mockResolvedValueOnce(claudeMessage("```json\n{\"a\":", "max_tokens"));
    const r = await callClaude("q", null, KEY);
    expect(r.status).toBe("ok");
    expect(r.terminationReason).toBe("output_budget");
    expect(r.wasTruncated).toBeUndefined(); // the pre-7B flag is untouched
  });
  it("an EMPTY max_tokens answer stays status error (substitution contract unchanged) but records output_budget", async () => {
    mockAnthropicCreate.mockResolvedValueOnce(claudeMessage("", "max_tokens"));
    const r = await callClaude("q", null, KEY);
    expect(r.status).toBe("error");
    expect(r.terminationReason).toBe("output_budget");
  });
  it("end_turn is natural; a missing stop_reason is unknown", async () => {
    mockAnthropicCreate.mockResolvedValueOnce(claudeMessage("{}", "end_turn"));
    expect((await callClaude("q", null, KEY)).terminationReason).toBe("natural");
    mockAnthropicCreate.mockResolvedValueOnce(claudeMessage("{}", undefined));
    expect(await callClaude("q", null, KEY)).not.toHaveProperty("terminationReason");
  });
  it("a timeout or transport error never carries a termination reason", async () => {
    mockAnthropicCreate.mockRejectedValueOnce(new Error("timeout"));
    const t = await callClaude("q", null, KEY);
    expect(t.status).toBe("timeout");
    expect(t).not.toHaveProperty("terminationReason");
    mockAnthropicCreate.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { status: 502 }));
    const e = await callClaude("q", null, KEY);
    expect(e.status).toBe("error");
    expect(e).not.toHaveProperty("terminationReason");
  });
  it("sends the first-attempt cap by default and the pinned repair cap only when exactly requested", async () => {
    for (const [requested, sent] of [[undefined, 4000], [4800, 4800], [4801, 4000], [6000, 4000], [8192, 4000], ["4800", 4000]] as const) {
      mockAnthropicCreate.mockResolvedValueOnce(claudeMessage("{}", "end_turn"));
      await callClaude("q", null, KEY, requested === undefined ? undefined : { outputBudgetRepairMaxTokens: requested as never });
      expect(mockAnthropicCreate.mock.calls.at(-1)[0].max_tokens).toBe(sent);
      expect(mockAnthropicCreate.mock.calls.at(-1)[0].model).toBe("claude-haiku-4-5-20251001");
    }
  });
});

describe("ChatGPT connector", () => {
  it("captures length / stop and keeps status unchanged", async () => {
    mockOpenAICreate.mockResolvedValueOnce(openAiCompletion("{\"a\":", "length"));
    const cut = await callChatGPT("q", null, KEY);
    expect([cut.status, cut.terminationReason]).toEqual(["ok", "output_budget"]);
    mockOpenAICreate.mockResolvedValueOnce(openAiCompletion(null, "length"));
    const empty = await callChatGPT("q", null, KEY);
    expect([empty.status, empty.terminationReason]).toEqual(["error", "output_budget"]);
    mockOpenAICreate.mockResolvedValueOnce(openAiCompletion("{}", "stop"));
    expect((await callChatGPT("q", null, KEY)).terminationReason).toBe("natural");
    mockOpenAICreate.mockResolvedValueOnce(openAiCompletion("{}", "content_filter"));
    expect((await callChatGPT("q", null, KEY)).terminationReason).toBe("other");
  });
  it("repair cap: only the pinned 3,300", async () => {
    for (const [requested, sent] of [[undefined, 2200], [3300, 3300], [3301, 2200], [4800, 2200]] as const) {
      mockOpenAICreate.mockResolvedValueOnce(openAiCompletion("{}", "stop"));
      await callChatGPT("q", null, KEY, requested === undefined ? undefined : { outputBudgetRepairMaxTokens: requested });
      expect(mockOpenAICreate.mock.calls.at(-1)[0].max_tokens).toBe(sent);
      expect(mockOpenAICreate.mock.calls.at(-1)[0].model).toBe("gpt-4o-mini");
    }
  });
});

describe("Grok connector (detection only — no repair)", () => {
  it("captures length on a returned answer and on an empty one (which still fails exactly as before)", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "{\"a\":" }, finish_reason: "length" }], usage: {} })) as never;
    const cut = await callGrok("q", null, KEY);
    expect([cut.status, cut.terminationReason]).toEqual(["ok", "output_budget"]);
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: {} })) as never;
    const empty = await callGrok("q", null, KEY);
    expect(empty.status).toBe("error");
    expect(empty.errorMessage).toBe("Grok API returned an empty response.");
    expect(empty.terminationReason).toBe("output_budget");
  });
  it("ignores a repair cap entirely and never gains a reason from an HTTP or network failure", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: {} })) as never;
    const ok = await callGrok("q", null, KEY, { outputBudgetRepairMaxTokens: 3300 });
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).max_tokens).toBe(MODEL_LIMITS.grok.maxTokens);
    expect(ok.terminationReason).toBe("natural");
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ error: { message: "bad gateway" } }, 502)) as never;
    const http = await callGrok("q", null, KEY);
    expect(http.status).toBe("error");
    expect(http).not.toHaveProperty("terminationReason");
    global.fetch = jest.fn().mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" })) as never;
    const t = await callGrok("q", null, KEY);
    expect(t.status).toBe("timeout");
    expect(t).not.toHaveProperty("terminationReason");
  });
});

describe("Gemini connector (detection and disclosure only — no repair)", () => {
  const geminiResponse = (text: string, finishReason: string) => ({ response: { text: async () => text, candidates: [{ finishReason }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 8192, totalTokenCount: 8193 } } });
  it("captures MAX_TOKENS, keeps the existing wasTruncated flag, and an empty MAX_TOKENS answer stays status error", async () => {
    mockGenerateContent.mockResolvedValueOnce(geminiResponse("{\"a\":", "MAX_TOKENS"));
    const cut = await callGemini("q", null, KEY);
    expect([cut.status, cut.terminationReason, cut.wasTruncated]).toEqual(["ok", "output_budget", true]);
    mockGenerateContent.mockResolvedValueOnce(geminiResponse("", "MAX_TOKENS"));
    const empty = await callGemini("q", null, KEY);
    expect([empty.status, empty.terminationReason, empty.wasTruncated]).toEqual(["error", "output_budget", false]);
    mockGenerateContent.mockResolvedValueOnce(geminiResponse("{}", "STOP"));
    expect((await callGemini("q", null, KEY)).terminationReason).toBe("natural");
    mockGenerateContent.mockResolvedValueOnce(geminiResponse("", "SAFETY"));
    const safety = await callGemini("q", null, KEY);
    expect([safety.status, safety.terminationReason]).toEqual(["refused", "other"]);
  });
});

describe("Perplexity connector (detection only — no repair)", () => {
  const agent = (status: string, text: string | null, incomplete?: string) => ({
    object: "response", status, model: "perplexity/sonar",
    output: text === null ? [] : [{ type: "message", content: [{ type: "output_text", text }] }],
    ...(incomplete ? { incomplete_details: { reason: incomplete } } : {}),
    usage: { input_tokens: 1, output_tokens: 6000, total_tokens: 6001 },
  });
  it("completed → natural; incomplete/max_output_tokens → output_budget with or without text; statuses unchanged", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(agent("completed", "{}"))) as never;
    expect(await callPerplexity("q", null, KEY)).toMatchObject({ status: "ok", terminationReason: "natural" });
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(agent("incomplete", "{\"a\":", "max_output_tokens"))) as never;
    expect(await callPerplexity("q", null, KEY)).toMatchObject({ status: "ok", terminationReason: "output_budget" });
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(agent("incomplete", null, "max_output_tokens"))) as never;
    expect(await callPerplexity("q", null, KEY)).toMatchObject({ status: "error", terminationReason: "output_budget" });
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(agent("failed", null))) as never;
    const failed = await callPerplexity("q", null, KEY);
    expect(failed.status).toBe("error");
    expect(failed).not.toHaveProperty("terminationReason");
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "{}" }, finish_reason: "length" }] })) as never;
    expect(await callPerplexity("q", null, KEY)).not.toHaveProperty("terminationReason"); // legacy shape: not evidence
  });
});

describe("repair-cap policy (D2) — every pinned entry satisfies every bound", () => {
  it("pins exactly Claude 4,800 and ChatGPT 3,300; nothing else gets a repair", () => {
    expect(Object.keys(OUTPUT_BUDGET_REPAIR_CAPS).sort()).toEqual(["chatgpt", "claude"]);
    expect(OUTPUT_BUDGET_REPAIR_CAPS.claude).toEqual({ providerModel: "claude-haiku-4-5-20251001", firstAttemptCap: 4000, documentedOutputLimit: 64000, repairCap: 4800 });
    expect(OUTPUT_BUDGET_REPAIR_CAPS.chatgpt).toEqual({ providerModel: "gpt-4o-mini", firstAttemptCap: 2200, documentedOutputLimit: 16384, repairCap: 3300 });
    for (const [id, e] of Object.entries(OUTPUT_BUDGET_REPAIR_CAPS)) {
      const first = MODEL_LIMITS[id as keyof typeof MODEL_LIMITS].maxTokens;
      expect(e!.firstAttemptCap).toBe(first); // characterized against the live config
      expect(e!.repairCap).toBeGreaterThan(first);
      expect(e!.repairCap).toBeLessThanOrEqual(Math.floor(first * 1.5));
      expect(e!.repairCap).toBeLessThanOrEqual(OUTPUT_BUDGET_REPAIR_POLICY_CEILING);
      expect(e!.repairCap).toBeLessThanOrEqual(e!.documentedOutputLimit);
      expect(entrySatisfiesRepairBounds(e!, first)).toBe(true);
    }
    expect(OUTPUT_BUDGET_REPAIR_POLICY_CEILING).toBe(8192);
  });
  it("each bound is enforced on its own", () => {
    const base = { providerModel: "m", firstAttemptCap: 4000, documentedOutputLimit: 64000, repairCap: 4800 };
    expect(entrySatisfiesRepairBounds(base, 4000)).toBe(true);
    expect(entrySatisfiesRepairBounds({ ...base, repairCap: 4000 }, 4000)).toBe(false); // not larger
    expect(entrySatisfiesRepairBounds({ ...base, repairCap: 6001 }, 4000)).toBe(false); // > 1.5×
    expect(entrySatisfiesRepairBounds({ ...base, repairCap: 6000 }, 4000)).toBe(true); // = 1.5×
    expect(entrySatisfiesRepairBounds({ ...base, firstAttemptCap: 6000, repairCap: 8193 }, 6000)).toBe(false); // > ceiling
    expect(entrySatisfiesRepairBounds({ ...base, firstAttemptCap: 6000, repairCap: 8192 }, 6000)).toBe(true);
    expect(entrySatisfiesRepairBounds({ ...base, documentedOutputLimit: 4500 }, 4000)).toBe(false); // > model limit
    expect(entrySatisfiesRepairBounds(base, 4100)).toBe(false); // first-attempt cap changed since characterization
    expect(entrySatisfiesRepairBounds({ ...base, repairCap: 4800.5 }, 4000)).toBe(false);
  });
  it("fails closed on another model id, a different provider model, a changed first cap, or a prototype key", () => {
    expect(outputBudgetRepairCap("claude", "claude-haiku-4-5-20251001", 4000)).toBe(4800);
    expect(outputBudgetRepairCap("chatgpt", "gpt-4o-mini", 2200)).toBe(3300);
    expect(outputBudgetRepairCap("claude", "claude-sonnet-5-5", 4000)).toBeNull();
    expect(outputBudgetRepairCap("claude", undefined, 4000)).toBeNull();
    expect(outputBudgetRepairCap("claude", "claude-haiku-4-5-20251001", 4500)).toBeNull();
    for (const id of ["gemini", "grok", "perplexity", "deepseek", "toString", "__proto__", undefined]) expect(outputBudgetRepairCap(id, "x", 2200)).toBeNull();
    expect(connectorMaxTokens("claude", "claude-haiku-4-5-20251001", 4000, 4800)).toBe(4800);
    expect(connectorMaxTokens("claude", "claude-haiku-4-5-20251001", 4000, 4799)).toBe(4000);
  });
  it("the connectors send the very model id the policy is pinned to", () => {
    const src = (f: string) => readFileSync(join(process.cwd(), "lib/connectors", f), "utf8");
    // The model literal each connector sends (the same oracle truthfulModelLabels.spec.ts reads), the constant its
    // repair-cap guard uses, and the policy's pinned provider model must all be the same string.
    for (const [file, id, constant] of [["claude.ts", "claude", "CLAUDE_PROVIDER_MODEL"], ["chatgpt.ts", "chatgpt", "CHATGPT_PROVIDER_MODEL"]] as const) {
      const sent = /model:\s*"([^"]+)"/.exec(src(file))![1];
      expect(sent).toBe(OUTPUT_BUDGET_REPAIR_CAPS[id]!.providerModel);
      expect(src(file)).toContain(`export const ${constant} = "${sent}";`);
    }
    const panel = readFileSync(join(process.cwd(), "lib/panel.ts"), "utf8");
    expect(panel).toContain('chatgpt: "gpt-4o-mini",');
    expect(panel).toContain('claude: "claude-haiku-4-5-20251001",');
  });
});

describe("repair timing (fits the existing hard timeout and the remaining guard, never extends them)", () => {
  const hard = MODEL_TIMEOUTS.claude.hardTimeoutMs; // 60 s, unchanged
  it("scales the first attempt's own latency and keeps a 5 s margin", () => {
    // 45 s for 4,000 tokens → 54 s projected for 4,800; 54 + 5 ≤ 60.
    expect(outputBudgetRepairFitsWindow({ firstLatencyMs: 45_000, firstCompletionTokens: 4000, repairCap: 4800, hardTimeoutMs: hard, guardMs: 65_000 })).toBe(true);
    // Boundary: 45,833 ms → 54,999.6 projected → fits; 45,834 → 55,000.8 → does not.
    expect(outputBudgetRepairFitsWindow({ firstLatencyMs: 45_833, firstCompletionTokens: 4000, repairCap: 4800, hardTimeoutMs: hard, guardMs: 65_000 })).toBe(true);
    expect(outputBudgetRepairFitsWindow({ firstLatencyMs: 45_834, firstCompletionTokens: 4000, repairCap: 4800, hardTimeoutMs: hard, guardMs: 65_000 })).toBe(false);
  });
  it("the remaining guard binds when it is shorter than the hard timeout", () => {
    expect(outputBudgetRepairFitsWindow({ firstLatencyMs: 30_000, firstCompletionTokens: 4000, repairCap: 4800, hardTimeoutMs: hard, guardMs: 41_000 })).toBe(true); // 36 + 5 = 41
    expect(outputBudgetRepairFitsWindow({ firstLatencyMs: 30_000, firstCompletionTokens: 4000, repairCap: 4800, hardTimeoutMs: hard, guardMs: 40_999 })).toBe(false);
  });
  it("cannot be shown to fit without a real measurement", () => {
    for (const bad of [{ firstLatencyMs: undefined }, { firstLatencyMs: 0 }, { firstLatencyMs: NaN }, { firstCompletionTokens: null }, { firstCompletionTokens: 0 }, { firstCompletionTokens: 3999.5 }]) {
      expect(outputBudgetRepairFitsWindow({ firstLatencyMs: 10_000, firstCompletionTokens: 4000, repairCap: 4800, hardTimeoutMs: hard, guardMs: 65_000, ...bad })).toBe(false);
    }
  });
  it("hard timeouts are unchanged by Item 7B", () => {
    expect([MODEL_TIMEOUTS.claude.hardTimeoutMs, MODEL_TIMEOUTS.chatgpt.hardTimeoutMs]).toEqual([60_000, 60_000]);
    expect([MODEL_LIMITS.claude.maxTokens, MODEL_LIMITS.chatgpt.maxTokens, MODEL_LIMITS.grok.maxTokens, MODEL_LIMITS.perplexity.maxTokens]).toEqual([4000, 2200, 2200, 6000]);
  });
});
