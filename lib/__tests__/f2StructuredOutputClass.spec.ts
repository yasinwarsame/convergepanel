/**
 * F-2 (Order 34, owner ruling: response text is not a permanent authority signal).
 *
 * 1. PRECONDITION — per-connector fail-closed table. Every panel connector (chatgpt, claude, grok, perplexity, gemini)
 *    and the DeepSeek fallback, called the way BOTH the research panel (runPanel → runSlotWithFallback) and the claim
 *    dispatch (runClaimVerificationPanel) call them, with the provider mocked at the SDK / fetch boundary: a missing
 *    key, a rejected key, an empty response and an SDK exception NEVER yield status "ok" (DeepSeek: never ok:true), and
 *    never carry a placeholder as an answer. Only a provider-returned, non-empty answer is "ok".
 * 2. The structured fact: `outputClass: "model_response"` is stamped only on ok + no errorCode (runPanel live rows and
 *    runtimeModelProvenance at completion); the gate skips the "mock response" text oracle only for such rows; history
 *    (rows without the fact) is unchanged; the exact INVALID_MOCK literal is still excluded.
 * 3. Claims: a genuine answer discussing a "mock response" records its provider and is independent.
 */
const mockOpenAICreate = jest.fn();
jest.mock("openai", () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: (...a: unknown[]) => mockOpenAICreate(...a) } } })) }));
const mockAnthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({ messages: { create: (...a: unknown[]) => mockAnthropicCreate(...a) } })) }));
const mockGeminiGenerate = jest.fn();
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({ getGenerativeModel: () => ({ generateContent: (...a: unknown[]) => mockGeminiGenerate(...a) }) })),
  HarmCategory: {},
  HarmBlockThreshold: {},
}));
const env: Record<string, unknown> = { GROK_MODEL: "grok-test", PERPLEXITY_API_KEY: "", DEEPSEEK_API_KEY: "" };
jest.mock("@/lib/env", () => new Proxy({}, { get: (_t, k: string) => env[k] }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("server-only", () => ({}));

import { callChatGPT } from "@/lib/connectors/chatgpt";
import { callClaude } from "@/lib/connectors/claude";
import { callGrok } from "@/lib/connectors/grok";
import { callPerplexity } from "@/lib/connectors/perplexity";
import { callGemini } from "@/lib/connectors/gemini";
import { callDeepSeek } from "@/lib/connectors/deepseek";
import { runClaimVerificationPanel } from "@/lib/verification/runClaimVerificationPanel";
import { runtimeModelProvenance } from "@/lib/firestore/runs";
import { runPanel } from "@/lib/panel";
import { buildClaimModelEvidence } from "@/lib/verification/buildClaimModelEvidence";
import { executionIdentityVerified, placeholderClass, runExecutionIdentity, STORED_PLACEHOLDER_LITERALS } from "@/lib/panel/executionIdentity";
import { storedRunConsensusIndependence } from "@/lib/panel/independentVoices";
import { storedVerificationConsensusIndependence } from "@/lib/panel/storedVerificationIndependence";
import { runDocumentToPublicResults } from "@/lib/user/runDocumentToPublicResults";
import type { ModelResult } from "@/lib/types";

const ANSWER = "A real provider answer.";
type Path = "missing key" | "rejected key" | "empty response" | "SDK exception" | "answer";
const PATHS: Path[] = ["missing key", "rejected key", "empty response", "SDK exception", "answer"];
const KEY = "k-test";

function arrange(path: Path) {
  const reject401 = () => Promise.reject(Object.assign(new Error("401 Incorrect API key provided"), { status: 401 }));
  const boom = () => Promise.reject(new Error("socket hang up"));
  mockOpenAICreate.mockImplementation(() =>
    path === "rejected key" ? reject401() : path === "SDK exception" ? boom() : Promise.resolve({ choices: [{ message: { content: path === "empty response" ? "" : ANSWER }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  );
  mockAnthropicCreate.mockImplementation(() =>
    path === "rejected key" ? reject401() : path === "SDK exception" ? boom() : Promise.resolve({ content: path === "empty response" ? [] : [{ type: "text", text: ANSWER }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })
  );
  mockGeminiGenerate.mockImplementation(() =>
    path === "rejected key"
      ? Promise.reject(Object.assign(new Error("[400] API key not valid. Please pass a valid API key."), { status: 400 }))
      : path === "SDK exception"
        ? boom()
        : Promise.resolve({ response: { text: async () => (path === "empty response" ? "" : ANSWER), candidates: [{ finishReason: "STOP" }], usageMetadata: { totalTokenCount: 2, promptTokenCount: 1, candidatesTokenCount: 1 } } })
  );
  const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  jest.spyOn(global, "fetch").mockImplementation(((url: string) => {
    if (path === "rejected key") return json(401, { error: { message: "invalid api key" } });
    if (path === "SDK exception") return Promise.reject(new Error("socket hang up"));
    if (String(url).includes("x.ai")) return json(200, { choices: [{ message: { content: path === "empty response" ? "" : ANSWER }, finish_reason: "stop" }], usage: { total_tokens: 2 } });
    // Perplexity Agent API.
    return json(200, path === "empty response" ? { object: "response", status: "completed", output: [] } : { object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: ANSWER }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  }) as never);
  env.PERPLEXITY_API_KEY = path === "missing key" ? "" : KEY;
  process.env.GEMINI_API_KEY = path === "missing key" ? "" : KEY;
}

const CONNECTORS: Array<[string, (k?: string) => Promise<ModelResult>]> = [
  ["chatgpt", (k) => callChatGPT("q", null, k)],
  ["claude", (k) => callClaude("q", null, k)],
  ["grok", (k) => callGrok("q", null, k)],
  ["perplexity", (k) => callPerplexity("q", null, k)],
  ["gemini", (k) => callGemini("q", null, k)],
];

const table: string[] = [];

beforeEach(() => {
  for (const m of ["log", "warn", "error", "info", "debug"] as const) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  if (process.env.F2_TABLE) require("fs").writeFileSync(process.env.F2_TABLE, table.join("\n") + "\n");
});

describe("PRECONDITION: every connector fails closed on every non-answer path (research and claim paths share these calls)", () => {
  describe.each(CONNECTORS)("%s", (id, call) => {
    it.each(PATHS)("%s", async (path) => {
      arrange(path);
      const r = await call(path === "missing key" ? "" : KEY);
      table.push(`${id} | ${path} | status=${r.status} | errorCode=${r.errorCode ?? "-"} | text=${JSON.stringify((r.rawText ?? "").slice(0, 60))}`);
      if (path === "answer") {
        expect([r.status, r.rawText]).toEqual(["ok", ANSWER]);
      } else {
        expect([id, path, r.status === "ok"]).toEqual([id, path, false]);
        // A non-answer never carries a placeholder as an answer: whatever text it has, it is not "ok".
        expect(placeholderClass({ modelId: id, status: r.status, rawText: r.rawText ?? "" })).not.toBe("INVALID_MOCK");
      }
      // The claim dispatch stamps a provider only on ok (and never on a non-answer).
      const [claimRow] = await runClaimVerificationPanel("c", [id as never], { [id]: path === "missing key" ? "" : KEY });
      expect([claimRow.status === "ok", typeof claimRow.provider === "string"]).toEqual([path === "answer", path === "answer"]);
      // The completion stamp: only ok + no errorCode.
      expect(runtimeModelProvenance({ ...r, provider: "openai" }).outputClass).toBe(path === "answer" ? "model_response" : undefined);
    });
  });

  it.each(["missing key", "rejected key", "empty response", "SDK exception", "answer"] as const)("DeepSeek fallback: %s", async (path) => {
    arrange(path);
    const r = await callDeepSeek("q", "chatgpt", path === "missing key" ? "" : KEY);
    table.push(`deepseek | ${path} | ok=${r.ok} | code=${"code" in r ? r.code : "-"}`);
    expect(r.ok).toBe(path === "answer");
    if (r.ok) expect(r.text).toBe(ANSWER);
  });

  it("research panel path (runPanel, DeepSeek fallback off): only a real answer is ok and carries outputClass", async () => {
    for (const path of PATHS) {
      arrange(path);
      const rows = await runPanel("q", ["chatgpt", "claude", "grok", "perplexity", "gemini"] as never, Object.fromEntries(["chatgpt", "claude", "grok", "perplexity", "gemini"].map((m) => [m, path === "missing key" ? "" : KEY])) as never, null);
      for (const r of rows) {
        table.push(`runPanel ${r.modelId} | ${path} | status=${r.status} | outputClass=${r.outputClass ?? "-"}`);
        expect([r.modelId, path, r.status === "ok", r.outputClass]).toEqual([r.modelId, path, path === "answer", path === "answer" ? "model_response" : undefined]);
      }
    }
  });
});

describe("the structured fact replaces the text oracle on NEW rows only", () => {
  const MENTION = "Some APIs return a mock response during testing; production data differs.";
  const run = (rows: Array<Record<string, unknown>>) => ({ runDocument: { perModel: rows } });
  const row = (m: string, p: string, t: string, extra: Record<string, unknown> = {}) => ({ modelId: m, status: "ok", provider: p, rawTextTruncated: t, ...extra });

  it("a new row that discusses a mock response is a model response → independent", () => {
    expect(storedRunConsensusIndependence(run([row("chatgpt", "openai", MENTION, { outputClass: "model_response" }), row("claude", "anthropic", "Paris.", { outputClass: "model_response" })]))).toBe("independent");
  });

  it("historical rows (no fact) keep the text oracle exactly as before", () => {
    expect(storedRunConsensusIndependence(run([row("chatgpt", "openai", MENTION), row("claude", "anthropic", "Paris.")]))).toBe("unverified");
    expect(placeholderClass({ modelId: "chatgpt", status: "ok", rawText: MENTION })).toBe("VALIDITY_UNKNOWN");
    expect(placeholderClass({ modelId: "chatgpt", status: "ok", rawText: MENTION, outputClass: "something-else" })).toBe("VALIDITY_UNKNOWN");
  });

  it("the exact INVALID_MOCK literal is still excluded, with or without the fact", () => {
    for (const extra of [{}, { outputClass: "model_response" }]) {
      expect(placeholderClass({ modelId: "chatgpt", status: "ok", rawText: STORED_PLACEHOLDER_LITERALS.chatgpt, ...extra })).toBe("INVALID_MOCK");
      const id = runExecutionIdentity([{ modelId: "chatgpt", status: "ok", rawText: STORED_PLACEHOLDER_LITERALS.chatgpt, ...extra }, { modelId: "grok", status: "ok", provider: "xai", rawText: "x" }]);
      expect([id.placeholderSlots, id.independentModels]).toEqual([["chatgpt"], 1]);
    }
  });

  it("the gate reads the fact on live rows too", () => {
    expect(executionIdentityVerified([{ modelId: "chatgpt", status: "ok", provider: "openai", rawText: MENTION, outputClass: "model_response" }])).toBe(true);
    expect(executionIdentityVerified([{ modelId: "chatgpt", status: "ok", provider: "openai", rawText: MENTION }])).toBe(false);
  });

  it("saved results carry the fact only when the persisted row does", () => {
    const pub = runDocumentToPublicResults({ perModel: [row("chatgpt", "openai", MENTION, { outputClass: "model_response", latencyMs: 1, wasTruncated: false }), row("claude", "anthropic", "x", { latencyMs: 1, wasTruncated: false })] } as never);
    expect(pub.map((p) => (p as { outputClass?: string }).outputClass)).toEqual(["model_response", undefined]);
  });

  it("completion stamp: ok without errorCode only (substituted / failed / ok with an errorCode never)", () => {
    expect(runtimeModelProvenance({ status: "ok" } as never).outputClass).toBe("model_response");
    expect(runtimeModelProvenance({ status: "ok", errorCode: "provider_not_configured" } as never).outputClass).toBeUndefined();
    for (const status of ["substituted", "failed", "error", "timeout", "refused"]) expect(runtimeModelProvenance({ status } as never).outputClass).toBeUndefined();
  });
});

describe("claims (current write): a genuine answer discussing a mock response records its provider", () => {
  it("independent; the control and the exact literal behave as before", () => {
    const genuine = JSON.stringify({ verdict: "accurate", confidence: "high", summary: "The vendor's demo returned a mock response instead of live data, as the claim says.", correctParts: [], incorrectParts: [], unverifiableParts: [] });
    const plain = JSON.stringify({ verdict: "accurate", confidence: "high", summary: "Confirmed.", correctParts: [], incorrectParts: [], unverifiableParts: [] });
    const rows = (t: string) => [{ modelId: "chatgpt", status: "ok", rawText: t, provider: "openai", latencyMs: 1 }, { modelId: "claude", status: "ok", rawText: plain, provider: "anthropic", latencyMs: 1 }] as unknown as ModelResult[];
    const ev = buildClaimModelEvidence(rows(genuine));
    expect(ev.map((e) => (e as { provider?: string }).provider)).toEqual(["openai", "anthropic"]);
    expect(storedVerificationConsensusIndependence({ modelResults: ev, selectedModels: ["chatgpt", "claude"] })).toBe("independent");
    const lit = buildClaimModelEvidence([{ modelId: "chatgpt", status: "ok", rawText: STORED_PLACEHOLDER_LITERALS.chatgpt, provider: "openai", latencyMs: 1 } as unknown as ModelResult]);
    expect(["status" in lit[0] && lit[0].status, "provider" in lit[0]]).toEqual(["parse_error", false]);
  });
});
