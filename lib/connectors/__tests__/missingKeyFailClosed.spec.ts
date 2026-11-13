/**
 * Fail-closed provider configuration (ChatGPT + Claude connectors).
 *
 * Before: a falsy apiKey made both connectors return a FABRICATED success —
 * `status: "ok"`, rawText "Mock response from <model> (no API key configured)" —
 * which counted as a responding model in every aggregation.
 *
 * Now: a missing / empty / whitespace-only key is an explicit, typed
 * provider-configuration failure (status "error", errorCode
 * "provider_not_configured", rawText null), identical in every environment, and
 * the provider SDK is never constructed. A configured key still reaches the SDK.
 *
 * The connectors are exercised for real; only the provider SDKs and the logger
 * are doubles. No real provider call is ever made.
 */
const mockOpenAICreate = jest.fn();
const mockOpenAICtor = jest.fn().mockImplementation(() => ({ chat: { completions: { create: (...a: unknown[]) => mockOpenAICreate(...a) } } }));
// A plain function (not an arrow) so `new OpenAI(...)` works; it returns the double.
jest.mock("openai", () => ({ __esModule: true, default: function OpenAI(...a: unknown[]) { return mockOpenAICtor(...a); } }));

const mockAnthropicCreate = jest.fn();
const mockAnthropicCtor = jest.fn().mockImplementation(() => ({ messages: { create: (...a: unknown[]) => mockAnthropicCreate(...a) } }));
jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: function Anthropic(...a: unknown[]) { return mockAnthropicCtor(...a); } }));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => mockLoggerWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { callChatGPT } from "@/lib/connectors/chatgpt";
import { callClaude } from "@/lib/connectors/claude";
import { isApiKeyConfigured } from "@/lib/connectors/providerNotConfigured";
import type { ModelResult } from "@/lib/types";

const FAKE_KEY = "sk-FAKE-test-key-never-real-0000";

const CONNECTORS = [
  { name: "chatgpt", call: callChatGPT, ctor: mockOpenAICtor, create: mockOpenAICreate, envVar: "OPENAI_API_KEY" },
  { name: "claude", call: callClaude, ctor: mockAnthropicCtor, create: mockAnthropicCreate, envVar: "ANTHROPIC_API_KEY" },
] as const;

const MISSING_KEYS: Array<[string, string | undefined]> = [
  ["undefined", undefined],
  ["empty string", ""],
  ["spaces only", "   "],
  ["tabs/newlines only", "\t\n \r\n"],
];

const ENVIRONMENTS = ["production", "development", "test"] as const;

const env = process.env as Record<string, string | undefined>;
const ORIGINAL_NODE_ENV = env.NODE_ENV;

let consoleSpies: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  delete env.FORCE_OPENAI_FAIL;
  delete env.FORCE_ANTHROPIC_FAIL;
  consoleSpies = [
    jest.spyOn(console, "log").mockImplementation(() => {}),
    jest.spyOn(console, "warn").mockImplementation(() => {}),
    jest.spyOn(console, "error").mockImplementation(() => {}),
  ];
});
afterEach(() => {
  env.NODE_ENV = ORIGINAL_NODE_ENV;
  consoleSpies.forEach((s) => s.mockRestore());
  jest.useRealTimers();
});

function assertProviderNotConfigured(result: ModelResult, modelId: string, envVar: string) {
  expect(result.modelId).toBe(modelId);
  expect(result.status).toBe("error");
  expect(result.errorCode).toBe("provider_not_configured");
  expect(result.rawText).toBeNull();
  expect(result.errorMessage).toBe(
    `${modelId === "chatgpt" ? "ChatGPT (OpenAI)" : "Claude (Anthropic)"} is not available: ${envVar} is not configured.`
  );
  expect(result.latencyMs).toBe(0);
  expect(result.tokenUsage).toEqual({ totalTokens: 0, promptTokens: null, completionTokens: null });
  expect(JSON.stringify(result).toLowerCase()).not.toContain("mock");
}

describe.each(CONNECTORS)("$name connector — missing API key fails closed", ({ name, call, ctor, create, envVar }) => {
  describe.each(ENVIRONMENTS)("NODE_ENV=%s", (nodeEnv) => {
    it.each(MISSING_KEYS)("key %s → typed provider_not_configured error, SDK never constructed", async (_label, key) => {
      env.NODE_ENV = nodeEnv;
      const result = await call("What is the capital of France?", null, key);
      assertProviderNotConfigured(result, name, envVar);
      expect(ctor).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn.mock.calls[0][1]).toEqual({ modelId: name, errorCode: "provider_not_configured" });
    });
  });

  it("the dev-only FORCE_*_FAIL path is untouched (checked before the key)", async () => {
    env.NODE_ENV = "development";
    env[name === "chatgpt" ? "FORCE_OPENAI_FAIL" : "FORCE_ANTHROPIC_FAIL"] = "1";
    try {
      const result = await call("q", null, undefined);
      expect(result).toEqual({ modelId: name, status: "error", rawText: null, errorMessage: "Forced failure (dev)", latencyMs: 0 });
      expect(ctor).not.toHaveBeenCalled();
    } finally {
      delete env.FORCE_OPENAI_FAIL;
      delete env.FORCE_ANTHROPIC_FAIL;
    }
  });
});

describe("configured key — unchanged: the SDK is constructed with the key and called", () => {
  it("chatgpt", async () => {
    jest.useFakeTimers();
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: "Paris is the capital of France." } }],
      usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
    });
    const result = await callChatGPT("What is the capital of France?", null, FAKE_KEY);
    expect(mockOpenAICtor).toHaveBeenCalledTimes(1);
    expect(mockOpenAICtor).toHaveBeenCalledWith({ apiKey: FAKE_KEY });
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
    expect(result.rawText).toBe("Paris is the capital of France.");
    expect(result.errorCode).toBeUndefined();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    jest.clearAllTimers();
  });

  it("claude", async () => {
    jest.useFakeTimers();
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Paris is the capital of France." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 7 },
    });
    const result = await callClaude("What is the capital of France?", null, FAKE_KEY);
    expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCtor).toHaveBeenCalledWith({ apiKey: FAKE_KEY });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
    expect(result.rawText).toBe("Paris is the capital of France.");
    expect(result.errorCode).toBeUndefined();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    jest.clearAllTimers();
  });

  it.each(CONNECTORS)("$name: a provider 401 (rejected key) is an error, never ok, never a mock", async ({ name, call, create }) => {
    jest.useFakeTimers();
    create.mockRejectedValue(Object.assign(new Error("401 Incorrect API key provided"), { status: 401 }));
    const result = await call("q", null, FAKE_KEY);
    expect(create).toHaveBeenCalledTimes(1); // the SDK really was reached; the 401 came from it
    expect(result.status).toBe("error");
    expect(result.errorCode).toBeUndefined(); // a rejected key is a provider failure, not "not configured"
    expect(String(result.rawText)).not.toMatch(/mock/i);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    expect(result.modelId).toBe(name);
    jest.clearAllTimers();
  });
});

describe("isApiKeyConfigured", () => {
  it.each([
    [undefined, false],
    [null, false],
    ["", false],
    ["   ", false],
    ["\n\t", false],
    ["k", true],
    [` ${FAKE_KEY} `, true],
  ])("%p → %p", (key, expected) => {
    expect(isApiKeyConfigured(key as string | null | undefined)).toBe(expected);
  });
});
