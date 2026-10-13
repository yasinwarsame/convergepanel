/**
 * Perplexity Agent API migration — panel-level invariants:
 *  - logical `modelId: "perplexity"` / provider "perplexity" unchanged; physical model is "perplexity/sonar";
 *  - retry classification still works from the preserved error strings;
 *  - a DeepSeek substitution stays provider "deepseek" with no Perplexity rawResponse;
 *  - Claim Verification still sends a grounded Agent request and parses the answer;
 *  - provider search results never reach panel `sources` (validated output identical with/without them).
 * No network: `fetch` is replaced per test.
 */
import { ModelResult } from "@/lib/types";

function agentBody(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: "resp_x",
    object: "response",
    model: "perplexity/sonar",
    status: "completed",
    error: null,
    output: [
      { type: "search_results", results: [{ id: 1, url: "https://provider-only.example.com/doc", date: "2026-01-02", last_updated: "2026-01-03", title: "t", snippet: "s", source: "web" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ...extra,
  };
}

function routeFetch(handler: (url: string, body: any) => { status: number; json: unknown }) {
  const calls: { url: string; body: any }[] = [];
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const { status, json } = handler(url, body);
    return { ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => json } as any;
  });
  return calls;
}

describe("panel identity (runPanel)", () => {
  it("keeps logical modelId/provider and reports the physical perplexity/sonar model", async () => {
    const calls = routeFetch(() => ({ status: 200, json: agentBody("answer text that is long enough to not be suspiciously short at all, really") }));
    const { runPanel } = await import("@/lib/panel");
    const [r] = await runPanel("Q", ["perplexity"], { perplexity: "test-key" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.perplexity.ai/v1/agent");
    expect(r.modelId).toBe("perplexity");
    expect(r.status).toBe("ok");
    expect(r.provider).toBe("perplexity");
    expect(r.requestedModel).toBe("perplexity/sonar");
    expect(r.actualModel).toBe("perplexity/sonar");
  });

  it("HTTP 503 is still retried (3 attempts) and HTTP 401 is not (string classification preserved)", async () => {
    const { runPanel } = await import("@/lib/panel");
    let calls = routeFetch(() => ({ status: 503, json: { error: { message: "unavailable" } } }));
    const [r503] = await runPanel("Q", ["perplexity"], { perplexity: "test-key" });
    expect(calls.filter((c) => c.url.includes("perplexity"))).toHaveLength(3);
    expect(r503.status).toBe("failed");
    expect(r503.modelId).toBe("perplexity");

    calls = routeFetch(() => ({ status: 401, json: { error: { message: "bad key" } } }));
    const [r401] = await runPanel("Q", ["perplexity"], { perplexity: "test-key" });
    expect(calls).toHaveLength(1);
    expect(r401.status).toBe("failed");
  });

  it("an HTTP-200 server-class Agent failure is retried; a cancelled run is not", async () => {
    const { runPanel } = await import("@/lib/panel");
    let calls = routeFetch(() => ({ status: 200, json: agentBody("", { status: "failed", error: { type: "internal_error", code: 500, message: "x" }, output: [] }) }));
    await runPanel("Q", ["perplexity"], { perplexity: "test-key" });
    expect(calls).toHaveLength(3);
    calls = routeFetch(() => ({ status: 200, json: agentBody("", { status: "cancelled", error: null, output: [] }) }));
    await runPanel("Q", ["perplexity"], { perplexity: "test-key" });
    expect(calls).toHaveLength(1);
  });
});

describe("DeepSeek substitution identity (fallback enabled only for this test)", () => {
  it("a substituted perplexity slot is provider deepseek with no Perplexity rawResponse", async () => {
    const saved = { fb: process.env.PANEL_DEEPSEEK_FALLBACK_FOR, key: process.env.DEEPSEEK_API_KEY };
    process.env.PANEL_DEEPSEEK_FALLBACK_FOR = "perplexity";
    process.env.DEEPSEEK_API_KEY = "ds-test";
    try {
      let result: ModelResult | undefined;
      await jest.isolateModulesAsync(async () => {
        jest.doMock("@/lib/connectors/deepseek", () => ({
          DEEPSEEK_MODEL: "deepseek-chat",
          callDeepSeek: jest.fn(async () => ({ ok: true, text: "deepseek answer", latencyMs: 3, actualModel: "deepseek-chat" })),
        }));
        routeFetch(() => ({ status: 503, json: { error: { message: "down" } } }));
        const { runPanel } = await import("@/lib/panel");
        [result] = await runPanel("Q", ["perplexity"], { perplexity: "test-key" });
      });
      expect(result!.modelId).toBe("perplexity");
      expect(result!.status).toBe("substituted");
      expect(result!.provider).toBe("deepseek");
      expect(result!.rawResponse).toBeUndefined();
      expect(result!.requestedModel).toBe("perplexity/sonar");
    } finally {
      if (saved.fb === undefined) delete process.env.PANEL_DEEPSEEK_FALLBACK_FOR; else process.env.PANEL_DEEPSEEK_FALLBACK_FOR = saved.fb;
      if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved.key;
    }
  });
});

describe("Claim Verification compatibility", () => {
  it("sends a grounded Agent request and the answer reaches the existing verification parser", async () => {
    const verdictJson = JSON.stringify({ verdict: "accurate", confidence: "high", summary: "ok", correctParts: ["a"], incorrectParts: [], unverifiableParts: [], reasoning: "r" });
    const calls = routeFetch(() => ({ status: 200, json: agentBody(verdictJson) }));
    const { runClaimVerificationPanel } = await import("@/lib/verification/runClaimVerificationPanel");
    const { tryParseVerificationJson } = await import("@/lib/verification/parseVerificationJson");
    const [r] = await runClaimVerificationPanel("The sky is blue.", ["perplexity"], { perplexity: "test-key" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.tools).toEqual([{ type: "web_search", search_type: "web", max_results: 10 }]);
    expect(calls[0].body.instructions).toContain("The sky is blue.");
    expect(r.modelId).toBe("perplexity");
    expect(r.status).toBe("ok");
    const parsed = tryParseVerificationJson(r.rawText);
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/"sources"/);
  });
});

describe("provider search results never reach panel sources", () => {
  it("validated adaptive output is identical with and without provider search results", async () => {
    const { callPerplexity } = await import("@/lib/connectors/perplexity");
    const { validateAdaptiveResponse } = await import("@/lib/adaptiveSchema/validator");
    const { getResultSchema } = await import("@/lib/adaptiveSchema/schemaRegistry");
    const schema = getResultSchema("ranked_enumeration" as any);
    const modelJson = JSON.stringify({ items: [{ id: "alpha", label: "Alpha", rank: 1, sources: ["NIST glossary"] }] });

    routeFetch(() => ({ status: 200, json: agentBody(modelJson) }));
    const withSearch = await callPerplexity("Q", null, "test-key");
    const noSearchBody = agentBody(modelJson);
    noSearchBody.output = noSearchBody.output.filter((i: any) => i.type !== "search_results");
    routeFetch(() => ({ status: 200, json: noSearchBody }));
    const withoutSearch = await callPerplexity("Q", null, "test-key");

    const a = validateAdaptiveResponse("perplexity", schema, withSearch.rawText);
    const b = validateAdaptiveResponse("perplexity", schema, withoutSearch.rawText);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toContain("provider-only.example.com");
    expect(a.data?.items?.[0]?.sources).toEqual(["NIST glossary"]);
  });
});
