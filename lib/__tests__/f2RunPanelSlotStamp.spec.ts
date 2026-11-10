/**
 * F-2 (Order 34): the live research-row stamp in runPanel → runSlotWithFallback, exercised with fake connectors (no
 * provider calls). Pins the two branches the per-connector table cannot reach, because no real connector returns them:
 *   - a connector that returns ok WITH an errorCode is never stamped `outputClass: "model_response"`;
 *   - an ok on a RETRY attempt (after a retryable timeout) is stamped exactly like a first-attempt ok.
 * Also records why the claim-side INVALID_MOCK guard is defensive only: the exact placeholder literal never parses as a
 * verdict, so it reaches the parse_error branch first (mutation F13 is equivalent; see MOCK-RESPONSE.md).
 */
const env: Record<string, unknown> = { GROK_MODEL: "grok-test", PERPLEXITY_API_KEY: "", DEEPSEEK_API_KEY: "" };
jest.mock("@/lib/env", () => new Proxy({}, { get: (_t, k: string) => env[k] }));
const connectorMap: Record<string, jest.Mock> = {};
jest.mock("@/lib/connectors", () => ({ CONNECTOR_MAP: connectorMap }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("server-only", () => ({}));

import { runPanel } from "@/lib/panel";
import { buildClaimModelEvidence } from "@/lib/verification/buildClaimModelEvidence";
import { placeholderClass, STORED_PLACEHOLDER_LITERALS } from "@/lib/panel/executionIdentity";
import type { ModelId, ModelResult } from "@/lib/types";

const ANSWER = "A real provider answer that is long enough not to be flagged as suspiciously short by the panel runner.";

function ok(modelId: ModelId, extra: Partial<ModelResult> = {}): ModelResult {
  return { modelId, status: "ok", rawText: ANSWER, latencyMs: 5, ...extra };
}

beforeEach(() => {
  for (const k of Object.keys(connectorMap)) delete connectorMap[k];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("F-2 live stamp (runPanel slot result)", () => {
  it("first-attempt ok without errorCode is stamped; ok WITH an errorCode is not", async () => {
    connectorMap.chatgpt = jest.fn(async () => ok("chatgpt"));
    connectorMap.claude = jest.fn(async () => ok("claude", { errorCode: "some_connector_warning" }));
    const rows = await runPanel("q", ["chatgpt", "claude"] as ModelId[], { chatgpt: "k", claude: "k" } as never, null);
    const by = Object.fromEntries(rows.map((r) => [r.modelId, r]));
    expect(by.chatgpt.status).toBe("ok");
    expect(by.chatgpt.outputClass).toBe("model_response");
    expect(by.claude.status).toBe("ok");
    expect(by.claude.errorCode).toBe("some_connector_warning");
    expect(by.claude).not.toHaveProperty("outputClass");
  });

  it("an ok on a retry attempt (after a retryable timeout) is stamped; a retry ok with an errorCode is not", async () => {
    let gpt = 0;
    connectorMap.chatgpt = jest.fn(async () => (++gpt === 1 ? { modelId: "chatgpt", status: "timeout", rawText: null, latencyMs: 5, errorMessage: "timed out" } : ok("chatgpt")));
    let cl = 0;
    connectorMap.claude = jest.fn(async () => (++cl === 1 ? { modelId: "claude", status: "timeout", rawText: null, latencyMs: 5, errorMessage: "timed out" } : ok("claude", { errorCode: "some_connector_warning" })));
    const rows = await runPanel("q", ["chatgpt", "claude"] as ModelId[], { chatgpt: "k", claude: "k" } as never, null);
    const by = Object.fromEntries(rows.map((r) => [r.modelId, r]));
    expect(connectorMap.chatgpt).toHaveBeenCalledTimes(2);
    expect(by.chatgpt.status).toBe("ok");
    expect(by.chatgpt.outputClass).toBe("model_response");
    expect(connectorMap.claude).toHaveBeenCalledTimes(2);
    expect(by.claude.status).toBe("ok");
    expect(by.claude).not.toHaveProperty("outputClass");
  });

  it("a slot that never answers is not stamped", async () => {
    connectorMap.chatgpt = jest.fn(async () => ({ modelId: "chatgpt", status: "timeout", rawText: null, latencyMs: 5, errorMessage: "timed out" }));
    const rows = await runPanel("q", ["chatgpt"] as ModelId[], { chatgpt: "k" } as never, null);
    expect(rows[0].status).not.toBe("ok");
    expect(rows[0]).not.toHaveProperty("outputClass");
  });
});

describe("F-2 claims: the INVALID_MOCK guard is defensive (the literal cannot parse as a verdict)", () => {
  it.each([
    ["chatgpt", ""],
    ["chatgpt", "  \n"],
    ["claude", ""],
    ["claude", "\t "],
  ] as const)("%s literal (padding %j) is INVALID_MOCK and lands on parse_error with no provider", (slot, pad) => {
    const text = pad + STORED_PLACEHOLDER_LITERALS[slot] + pad;
    expect(placeholderClass({ modelId: slot, status: "ok", rawText: text })).toBe("INVALID_MOCK");
    const [row] = buildClaimModelEvidence([{ modelId: slot, status: "ok", rawText: text, latencyMs: 1, provider: slot === "chatgpt" ? "openai" : "anthropic" }]);
    expect(row.status).toBe("parse_error");
    expect(row).not.toHaveProperty("provider");
  });
});
