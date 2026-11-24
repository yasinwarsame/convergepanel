/**
 * Item 7B — runPanel carries a primary's provider-reported termination reason onto the slot it returns, without
 * changing any retry or substitution decision. Fake connectors only; no provider call is ever made.
 */
const env: Record<string, unknown> = { GROK_MODEL: "grok-test", PERPLEXITY_API_KEY: "", DEEPSEEK_API_KEY: "" };
jest.mock("@/lib/env", () => new Proxy({}, { get: (_t, k: string) => env[k] }));
const connectorMap: Record<string, jest.Mock> = {};
jest.mock("@/lib/connectors", () => ({ CONNECTOR_MAP: connectorMap }));
const mockDeepSeek = jest.fn();
jest.mock("@/lib/connectors/deepseek", () => ({ callDeepSeek: (...a: unknown[]) => mockDeepSeek(...a), DEEPSEEK_MODEL: "deepseek-chat" }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("server-only", () => ({}));

import { runPanel } from "@/lib/panel";
import type { ModelId, ModelResult } from "@/lib/types";

const ANSWER = "A real provider answer that is long enough not to be flagged as suspiciously short by the panel runner.";
const emptyBudget = (modelId: ModelId): ModelResult => ({ modelId, status: "error", rawText: null, latencyMs: 5, terminationReason: "output_budget" });

beforeEach(() => {
  for (const k of Object.keys(connectorMap)) delete connectorMap[k];
  env.DEEPSEEK_API_KEY = "";
  mockDeepSeek.mockReset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("Item 7B — runPanel slot results", () => {
  it("an empty answer that hit its output budget: still failed, never retried, and the placeholder keeps the reason", async () => {
    connectorMap.claude = jest.fn(async () => emptyBudget("claude" as ModelId));
    connectorMap.perplexity = jest.fn(async () => emptyBudget("perplexity" as ModelId)); // fallback not allowed for perplexity
    const rows = await runPanel("q", ["claude", "perplexity"] as ModelId[], { claude: "k", perplexity: "k" } as never, null);
    const by = Object.fromEntries(rows.map((r) => [r.modelId, r]));
    for (const id of ["claude", "perplexity"]) {
      expect(connectorMap[id]).toHaveBeenCalledTimes(1); // not a retryable status: unchanged
      expect(by[id].status).toBe("failed");
      expect(by[id].terminationReason).toBe("output_budget");
    }
  });

  it("R1 NIT: no connector's empty output-budget answer is retryable in runPanel (each primary is called once)", async () => {
    // The exact error shapes each connector returns for an empty answer that hit its budget (see the connector sources).
    const shapes: Record<string, ModelResult> = {
      claude: { modelId: "claude" as ModelId, status: "error", rawText: "Claude did not return any content.", latencyMs: 5, terminationReason: "output_budget" },
      chatgpt: { modelId: "chatgpt" as ModelId, status: "error", rawText: "ChatGPT did not return any content.", latencyMs: 5, terminationReason: "output_budget" },
      gemini: { modelId: "gemini" as ModelId, status: "error", rawText: "Gemini returned an empty response. The panel ran with the other models.", errorMessage: "Gemini returned an empty response.", latencyMs: 5, terminationReason: "output_budget" },
      grok: { modelId: "grok" as ModelId, status: "error", rawText: null, errorMessage: "Grok API returned an empty response.", latencyMs: 5, terminationReason: "output_budget" },
      perplexity: { modelId: "perplexity" as ModelId, status: "error", rawText: null, errorMessage: "Perplexity agent run incomplete/max_output_tokens: no_error_type (no_code)", latencyMs: 5, terminationReason: "output_budget" },
    };
    for (const [id, r] of Object.entries(shapes)) connectorMap[id] = jest.fn(async () => r);
    const rows = await runPanel("q", Object.keys(shapes) as ModelId[], Object.fromEntries(Object.keys(shapes).map((k) => [k, "k"])) as never, null);
    for (const id of Object.keys(shapes)) expect(connectorMap[id]).toHaveBeenCalledTimes(1);
    expect(rows.every((r) => r.status === "failed" && r.terminationReason === "output_budget")).toBe(true);
  });

  it("a timeout keeps no reason, and an ok answer keeps its own", async () => {
    connectorMap.claude = jest.fn(async () => ({ modelId: "claude", status: "timeout", rawText: null, latencyMs: 5, errorMessage: "timed out" }));
    connectorMap.chatgpt = jest.fn(async () => ({ modelId: "chatgpt", status: "ok", rawText: ANSWER, latencyMs: 5, terminationReason: "output_budget" }));
    const rows = await runPanel("q", ["claude", "chatgpt"] as ModelId[], { claude: "k", chatgpt: "k" } as never, null);
    const by = Object.fromEntries(rows.map((r) => [r.modelId, r]));
    expect(by.claude.status).toBe("failed");
    expect(by.claude).not.toHaveProperty("terminationReason");
    expect(by.chatgpt).toMatchObject({ status: "ok", terminationReason: "output_budget" });
  });

  it("DeepSeek substitution is unchanged and the substituted slot never inherits the primary's reason", async () => {
    env.DEEPSEEK_API_KEY = "ds-key";
    mockDeepSeek.mockResolvedValueOnce({ ok: true, text: ANSWER, latencyMs: 5, actualModel: "deepseek-chat" });
    connectorMap.claude = jest.fn(async () => emptyBudget("claude" as ModelId));
    const [row] = await runPanel("q", ["claude"] as ModelId[], { claude: "k" } as never, null);
    expect(mockDeepSeek).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("substituted");
    expect(row).not.toHaveProperty("terminationReason");
  });
});
