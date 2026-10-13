/**
 * Perplexity Agent API migration — contract tests for the pure parser, the
 * request builder, the connector, token extraction, the logical/physical model
 * identity, Claim Verification compatibility and the DeepSeek identity
 * invariant. No network: `fetch` is replaced per test.
 */
import {
  PERPLEXITY_AGENT_ENDPOINT,
  PERPLEXITY_AGENT_MODEL,
  agentOutcome,
  buildPerplexityAgentRequestBody,
  classifyAgentResponseShape,
  parsePerplexityAgentResponse,
} from "@/lib/providers/perplexityAgentResponse";
import { callPerplexity } from "@/lib/connectors/perplexity";
import { CONNECTOR_MAP } from "@/lib/connectors";
import { getTotalTokensFromProviderResponse } from "@/lib/tokenExtraction";
import { getModelTimeout, MODEL_LIMITS } from "@/lib/modelConfig";
import { logger } from "@/lib/logger";

// ── fixtures ────────────────────────────────────────────────────────────────

function agentResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_test_1",
    object: "response",
    created_at: 1,
    completed_at: 2,
    model: "perplexity/sonar",
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      {
        type: "search_results",
        queries: ["q"],
        results: [
          { id: 1, url: "https://example.com/a", title: "A", snippet: "s", date: "2026-01-02", last_updated: "2026-02-03", source: "web" },
          { id: 2, url: "https://example.org/b", title: "B", snippet: "s", date: null, last_updated: "2026-02-03", source: "web" },
        ],
      },
      { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"answer":"final [1]"}', annotations: [] }] },
    ],
    usage: {
      input_tokens: 1200,
      output_tokens: 340,
      total_tokens: 1540,
      cost: { input_cost: 0.0003, output_cost: 0.00085, tool_calls_cost: 0.0025, total_cost: 0.00365, currency: "USD" },
      tool_calls_details: { search_web: { invocation: 1 } },
    },
    ...overrides,
  };
}

const LEGACY_CHAT = {
  id: "x",
  object: "chat.completion",
  model: "sonar",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "legacy answer" } }],
  citations: ["https://legacy.example/c"],
  search_results: [{ url: "https://legacy.example/c", date: "2025-01-01" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

type FetchCall = { url: string; init: any };
let calls: FetchCall[] = [];
function mockFetchJson(status: number, body: unknown) {
  calls = [];
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body } as any;
  });
}
const sentBody = () => JSON.parse(calls[0].init.body);

afterEach(() => {
  jest.useRealTimers();
});

// ── request contract ────────────────────────────────────────────────────────

describe("Agent request contract", () => {
  it("builds the exact pinned key set with perplexity/sonar, requested web_search and store:false", () => {
    const body = buildPerplexityAgentRequestBody({ instructions: "SYS", input: "Q", maxOutputTokens: 6000, temperature: 0.2 });
    expect(Object.keys(body).sort()).toEqual(["input", "instructions", "max_output_tokens", "max_steps", "model", "store", "temperature", "tool_choice", "tools"]);
    expect(body).toEqual({
      model: "perplexity/sonar",
      instructions: "SYS",
      input: "Q",
      max_output_tokens: 6000,
      temperature: 0.2,
      tools: [{ type: "web_search", search_type: "web", max_results: 10 }],
      tool_choice: { type: "web_search" },
      max_steps: 1,
      store: false,
    });
    expect(body).not.toHaveProperty("preset");
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body).not.toHaveProperty("background");
  });

  it("the connector posts that body to /v1/agent with centralized limits and the system prompt as instructions", async () => {
    mockFetchJson(200, agentResponse());
    await callPerplexity("What is X?", null, "test-key", { systemPromptOverride: "SYSTEM PROMPT" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.perplexity.ai/v1/agent");
    expect(PERPLEXITY_AGENT_ENDPOINT).toBe("https://api.perplexity.ai/v1/agent");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer test-key");
    const body = sentBody();
    expect(body.model).toBe(PERPLEXITY_AGENT_MODEL);
    expect(body.instructions).toBe("SYSTEM PROMPT");
    expect(body.input).toBe("What is X?");
    expect(body.max_output_tokens).toBe(MODEL_LIMITS.perplexity.maxTokens);
    expect(body.temperature).toBe(0.2);
    expect(body.store).toBe(false);
    expect(body.tools).toEqual([{ type: "web_search", search_type: "web", max_results: 10 }]);
    expect(body.tool_choice).toEqual({ type: "web_search" });
    expect(body).not.toHaveProperty("preset");
  });

  it("without an override the default panel prompt becomes the instructions", async () => {
    mockFetchJson(200, agentResponse());
    await callPerplexity("Plain question", "ctx", "test-key");
    const body = sentBody();
    expect(typeof body.instructions).toBe("string");
    expect(body.instructions.length).toBeGreaterThan(0);
    expect(body.input).toBe("Plain question");
  });
});

// ── parser ──────────────────────────────────────────────────────────────────

describe("Agent response parser", () => {
  it("classifies shapes: agent, legacy chat, malformed", () => {
    expect(classifyAgentResponseShape(agentResponse())).toBe("agent");
    expect(classifyAgentResponseShape(LEGACY_CHAT)).toBe("legacy_chat");
    for (const bad of [null, 1, "x", [], {}, { object: "response" }, { object: "response", status: "completed" }, { object: "response", status: 3, output: [] }, { object: "chat.completion" }]) {
      expect(classifyAgentResponseShape(bad)).toBe("malformed");
    }
  });

  it("tolerates unknown extra fields and unknown output item types", () => {
    const r = agentResponse({ some_new_field: { x: 1 } });
    (r.output as any[]).unshift({ type: "brand_new_item", data: 1 }, { type: "fetch_url_results", contents: [] });
    const parsed = parsePerplexityAgentResponse(r);
    expect(parsed.shape).toBe("agent");
    expect(parsed.text).toBe('{"answer":"final [1]"}');
  });

  it("extracts text from the FINAL message item only (and joins its output_text parts)", () => {
    const r = agentResponse({
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "preamble, searching..." }] },
        { type: "search_results", results: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"a":' }, { type: "refusal", text: "IGNORED" }, { type: "output_text", text: "1}" }] },
      ],
    });
    const parsed = parsePerplexityAgentResponse(r);
    expect(parsed.text).toBe('{"a":1}');
    expect(parsed.diagnostics.messageItems).toBe(2);
  });

  it("recognises search_results items (diagnostics only) including zero results", () => {
    expect(parsePerplexityAgentResponse(agentResponse()).diagnostics).toMatchObject({ searchResultItems: 1, searchResultEntries: 2, searchInvocations: 1 });
    const none = agentResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "t" }] }] });
    expect(parsePerplexityAgentResponse(none).diagnostics).toMatchObject({ searchResultItems: 0, searchResultEntries: 0 });
    const empty = agentResponse({ output: [{ type: "search_results", results: [] }, { type: "message", content: [{ type: "output_text", text: "t" }] }] });
    expect(parsePerplexityAgentResponse(empty).diagnostics).toMatchObject({ searchResultItems: 1, searchResultEntries: 0 });
  });

  it("never reads legacy top-level choices/citations/search_results as an answer", () => {
    const parsed = parsePerplexityAgentResponse(LEGACY_CHAT);
    expect(parsed.text).toBeNull();
    expect(parsed.diagnostics.searchResultItems).toBe(0);
    expect(agentOutcome(parsed).kind).toBe("error");
    // an agent body that ALSO carries legacy keys still reads only output[]
    const hybrid = { ...agentResponse({ output: [] }), choices: LEGACY_CHAT.choices, search_results: LEGACY_CHAT.search_results };
    const p2 = parsePerplexityAgentResponse(hybrid);
    expect(p2.text).toBeNull();
    expect(p2.diagnostics.searchResultItems).toBe(0);
  });

  it("cost/search diagnostics are null when absent — never a fabricated 0", () => {
    const parsed = parsePerplexityAgentResponse(agentResponse({ usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }));
    expect(parsed.diagnostics.costTotal).toBeNull();
    expect(parsed.diagnostics.toolCallsCost).toBeNull();
    expect(parsed.diagnostics.searchInvocations).toBeNull();
    const full = parsePerplexityAgentResponse(agentResponse());
    expect(full.diagnostics).toMatchObject({ costTotal: 0.00365, costCurrency: "USD", toolCallsCost: 0.0025, searchInvocations: 1 });
  });

  it("does not mutate its input", () => {
    const r = agentResponse();
    const snapshot = JSON.stringify(r);
    parsePerplexityAgentResponse(r);
    expect(JSON.stringify(r)).toBe(snapshot);
  });
});

describe("Agent outcome (HTTP 200 is not success)", () => {
  const outcomeOf = (o: Record<string, unknown>) => agentOutcome(parsePerplexityAgentResponse(agentResponse(o)));

  it("completed + text → ok/stop", () => {
    expect(outcomeOf({})).toEqual({ kind: "ok", text: '{"answer":"final [1]"}', finishReason: "stop" });
  });
  it("completed without text → error with the legacy no-content message", () => {
    expect(outcomeOf({ output: [{ type: "search_results", results: [] }] })).toEqual({ kind: "error", errorMessage: "Perplexity did not return any content." });
  });
  it("incomplete/max_output_tokens + text → truncated/length", () => {
    expect(outcomeOf({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).toMatchObject({ kind: "truncated", finishReason: "length" });
  });
  it("incomplete for another reason, or without text → error", () => {
    expect(outcomeOf({ status: "incomplete", incomplete_details: { reason: "content_filter" } }).kind).toBe("error");
    expect(outcomeOf({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }).kind).toBe("error");
  });
  it("failed / cancelled / unknown status → error with stable message", () => {
    const failed = outcomeOf({ status: "failed", error: { type: "internal_error", code: 500, message: "boom" } });
    expect(failed).toEqual({ kind: "error", errorMessage: "Perplexity agent run failed/none: internal_error (500) 5xx (HTTP-equivalent 500) - boom" });
    const cancelled = outcomeOf({ status: "cancelled", error: null });
    expect(cancelled).toEqual({ kind: "error", errorMessage: "Perplexity agent run cancelled/none: no_error_type (no_code)" });
    expect(outcomeOf({ status: "in_progress" }).kind).toBe("error");
    expect(outcomeOf({ status: "queued" }).kind).toBe("error");
  });
});

// ── connector results, errors and timeouts ──────────────────────────────────

describe("callPerplexity results", () => {
  it("success: logical modelId perplexity, untouched rawResponse, finishReason stop, Agent token mapping", async () => {
    const body = agentResponse();
    mockFetchJson(200, body);
    const r = await callPerplexity("Q", null, "test-key");
    expect(r.modelId).toBe("perplexity");
    expect(r.status).toBe("ok");
    expect(r.rawText).toBe('{"answer":"final [1]"}');
    expect(r.rawResponse).toEqual(body); // the provider JSON itself, not a normalized copy
    expect((r as any).finishReason).toBe("stop");
    expect((r as any).wasTruncated).toBeUndefined();
    expect(r.tokenUsage).toEqual({ totalTokens: 1540, promptTokens: 1200, completionTokens: 340 });
    expect((r as any).sources).toBeUndefined();
  });

  it("truncated: ok with wasTruncated, length and the existing truncation message", async () => {
    mockFetchJson(200, agentResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
    const r = await callPerplexity("Q", null, "test-key");
    expect(r.status).toBe("ok");
    expect((r as any).finishReason).toBe("length");
    expect((r as any).wasTruncated).toBe(true);
    expect(r.errorMessage).toBe("Response was truncated due to token limit. Consider increasing max_tokens for longer responses.");
  });

  it("HTTP 200 failed run is an error, never ok", async () => {
    mockFetchJson(200, agentResponse({ status: "failed", error: { type: "bad_gateway", code: 502, message: "upstream" } }));
    const r = await callPerplexity("Q", null, "test-key");
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("Perplexity agent run failed");
    expect(r.errorMessage).toMatch(/\b5\d{2}\b/);
  });

  it("legacy Chat Completions body is rejected (no choices dependency)", async () => {
    mockFetchJson(200, LEGACY_CHAT);
    const r = await callPerplexity("Q", null, "test-key");
    expect(r.status).toBe("error");
    expect(r.rawText).toBeNull();
  });

  it("malformed body is an error", async () => {
    mockFetchJson(200, { hello: "world" });
    const r = await callPerplexity("Q", null, "test-key");
    expect(r.status).toBe("error");
    expect(r.errorMessage).toBe("Perplexity API returned an unrecognized response shape.");
  });

  it.each([400, 401, 403, 408, 429, 500, 502, 503])("HTTP %i keeps the 'HTTP <status>' error form", async (status) => {
    mockFetchJson(status, { error: { message: "provider says no", type: "x", code: status } });
    const r = await callPerplexity("Q", null, "test-key");
    expect(r.status).toBe("error");
    expect(r.errorMessage).toBe(`Perplexity API error: HTTP ${status} - provider says no`);
    expect(r.rawResponse).toBeUndefined();
  });

  it("client timeout uses the centralized hard timeout and is reported as timeout", async () => {
    jest.useFakeTimers();
    (global as any).fetch = jest.fn((_url: string, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => { const e = new Error("aborted"); (e as any).name = "AbortError"; reject(e); });
    }));
    const p = callPerplexity("Q", null, "test-key");
    await jest.advanceTimersByTimeAsync(getModelTimeout("perplexity").hardTimeoutMs);
    const r = await p;
    expect(r.status).toBe("timeout");
    expect(r.errorMessage).toBe(`Perplexity request timed out after ${getModelTimeout("perplexity").hardTimeoutMs / 1000} seconds.`);
  });

  it("CONNECTOR_MAP.perplexity is the Agent connector", () => {
    expect(CONNECTOR_MAP.perplexity).toBe(callPerplexity);
  });
});

describe("cost/search diagnostics logging", () => {
  afterEach(() => jest.restoreAllMocks());

  it("logs provider cost and search usage on every Agent run", async () => {
    const info = jest.spyOn(logger, "info").mockImplementation(() => undefined);
    mockFetchJson(200, agentResponse());
    await callPerplexity("Q", null, "test-key");
    const call = info.mock.calls.find((c: any[]) => c[0] === "[Perplexity connector] Agent run");
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      shape: "agent", status: "completed", model: "perplexity/sonar", outcome: "ok",
      inputTokens: 1200, outputTokens: 340, totalTokens: 1540,
      costTotal: 0.00365, costCurrency: "USD", toolCallsCost: 0.0025,
      searchInvocations: 1, searchResultItems: 1, searchResultEntries: 2, messageItems: 1,
    });
  });

  it("logs null (never 0) when the provider omits cost and search usage", async () => {
    const info = jest.spyOn(logger, "info").mockImplementation(() => undefined);
    mockFetchJson(200, agentResponse({ usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }));
    await callPerplexity("Q", null, "test-key");
    const call = info.mock.calls.find((c: any[]) => c[0] === "[Perplexity connector] Agent run");
    expect(call![1]).toMatchObject({ costTotal: null, costCurrency: null, toolCallsCost: null, searchInvocations: null });
  });

  it("warns (without failing the call) when a completed run shows no observed web search", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    mockFetchJson(200, agentResponse({
      output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    }));
    const r = await callPerplexity("Q", null, "test-key");
    expect(r.status).toBe("ok");
    expect(warn.mock.calls.some((c: any[]) => c[0] === "[Perplexity connector] Agent run completed without an observed web search")).toBe(true);
  });

  it("does not warn when the search was observed", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    mockFetchJson(200, agentResponse());
    await callPerplexity("Q", null, "test-key");
    expect(warn.mock.calls.some((c: any[]) => String(c[0]).includes("without an observed web search"))).toBe(false);
  });
});

describe("token extraction", () => {
  it("perplexity maps input/output tokens; total from provider", () => {
    expect(getTotalTokensFromProviderResponse("perplexity", { usage: { input_tokens: 7, output_tokens: 3, total_tokens: 11 } })).toEqual({ totalTokens: 11, promptTokens: 7, completionTokens: 3 });
  });
  it("perplexity computes the total when the provider omits it", () => {
    expect(getTotalTokensFromProviderResponse("perplexity", { usage: { input_tokens: 7, output_tokens: 3 } })).toEqual({ totalTokens: 10, promptTokens: 7, completionTokens: 3 });
  });
  it("other OpenAI-compatible providers are unchanged", () => {
    const legacy = { usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } };
    expect(getTotalTokensFromProviderResponse("openai", legacy)).toEqual({ totalTokens: 10, promptTokens: 4, completionTokens: 6 });
    expect(getTotalTokensFromProviderResponse("xai", legacy)).toEqual({ totalTokens: 10, promptTokens: 4, completionTokens: 6 });
  });
});
