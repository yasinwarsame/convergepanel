/**
 * Order 33 — the canonical provider registry (ruling B) and the claim provider stamp (ruling A), at unit level.
 */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockCall = { chatgpt: jest.fn(), claude: jest.fn(), grok: jest.fn() };
jest.mock("@/lib/connectors/chatgpt", () => ({ callChatGPT: (...a: unknown[]) => mockCall.chatgpt(...a) }));
jest.mock("@/lib/connectors/claude", () => ({ callClaude: (...a: unknown[]) => mockCall.claude(...a) }));
jest.mock("@/lib/connectors/grok", () => ({ callGrok: (...a: unknown[]) => mockCall.grok(...a) }));

import { CANONICAL_PROVIDERS, canonicalProvider } from "@/lib/panel/providerRegistry";
import { executionIdentityVerified, runExecutionIdentity } from "@/lib/panel/executionIdentity";
import { executingModelKey, independentVoices, UNRECORDED_SUBSTITUTE_KEY } from "@/lib/panel/independentVoices";
import { CONNECTOR_MAP, connectorProvider } from "@/lib/connectors";
import { runClaimVerificationPanel } from "@/lib/verification/runClaimVerificationPanel";
import { buildClaimModelEvidence } from "@/lib/verification/buildClaimModelEvidence";
import { storedVerificationConsensusIndependence, storedVerificationIndependentAnswerCount } from "@/lib/panel/storedVerificationIndependence";
import { STORED_PLACEHOLDER_LITERALS } from "@/lib/panel/executionIdentity";
import { PANEL_MODELS } from "@/lib/panelModels";
import type { ModelResult } from "@/lib/types";

const BODY = JSON.stringify({ verdict: "accurate", confidence: "high", summary: "ok", correctParts: [], incorrectParts: [], unverifiableParts: [] });
const res = (modelId: string, status: string, extra: Partial<ModelResult> = {}): ModelResult => ({ modelId, status, rawText: BODY, latencyMs: 1, ...extra }) as ModelResult;

describe("ruling B: the canonical provider registry", () => {
  it("holds exactly the providers the code has ever written (panel config union + the DeepSeek substitute)", () => {
    expect([...CANONICAL_PROVIDERS].sort()).toEqual(["anthropic", "deepseek", "google", "openai", "perplexity", "xai"]);
    for (const m of PANEL_MODELS) expect(canonicalProvider(m.provider)).toBe(m.provider);
  });

  it("normalizes by trim + lowercase only", () => {
    expect(canonicalProvider(" OpenAI ")).toBe("openai");
    expect(canonicalProvider("DEEPSEEK")).toBe("deepseek");
    expect(canonicalProvider("\tgoogle\n")).toBe("google");
    expect(canonicalProvider("open ai")).toBeNull();
    expect(canonicalProvider("openai.")).toBeNull();
  });

  it.each(["", "   ", "none", "None", "n/a", "N/A", "na", "unknown", "Unknown", "missing", "unresolved", "null", "undefined", "acme", "forged", "mistral", "gemini", "grok", "chatgpt"])(
    "rejects %p",
    (token) => expect(canonicalProvider(token)).toBeNull()
  );

  it.each([null, undefined, 0, 1, true, {}, ["openai"]])("rejects the non-string %p", (v) => expect(canonicalProvider(v)).toBeNull());

  it("the gate verifies a usable row only with a registered provider", () => {
    expect(executionIdentityVerified([{ modelId: "chatgpt", status: "ok", provider: "openai" }])).toBe(true);
    expect(executionIdentityVerified([{ modelId: "chatgpt", status: "ok", provider: " OpenAI " }])).toBe(true);
    for (const p of ["None", "n/a", "acme", "unknown", "", "missing"]) {
      expect([p, executionIdentityVerified([{ modelId: "chatgpt", status: "ok", provider: p }])]).toEqual([p, false]);
      expect([p, executionIdentityVerified([{ modelId: "claude", status: "substituted", provider: p }])]).toEqual([p, false]);
    }
  });

  it("the independent-voice key keys only registered substitutes; an unregistered token is an unrecorded substitute", () => {
    expect(executingModelKey({ modelId: "claude", status: "substituted", provider: " DeepSeek " })).toBe("substitute:deepseek");
    expect(executingModelKey({ modelId: "claude", status: "substituted", provider: "acme" })).toBe(UNRECORDED_SUBSTITUTE_KEY);
    expect(independentVoices([{ modelId: "chatgpt", status: "substituted", provider: "deepseek" }, { modelId: "claude", status: "substituted", provider: "acme" }])).toHaveLength(1);
  });

  it("two slots answered by one executing provider count once", () => {
    const id = runExecutionIdentity([{ modelId: "chatgpt", status: "substituted", provider: "deepseek" }, { modelId: "claude", status: "substituted", provider: "DeepSeek" }]);
    expect([id.verified, id.independentModels, id.answeredSlots]).toEqual([true, 1, 2]);
  });
});

describe("ruling A: the claim dispatch stamps the provider of the connector function it invoked", () => {
  beforeEach(() => {
    mockCall.chatgpt.mockReset();
    mockCall.claude.mockReset();
    mockCall.grok.mockReset();
  });

  it("each owned connector function maps to its canonical provider", () => {
    expect(connectorProvider(CONNECTOR_MAP.chatgpt)).toBe("openai");
    expect(connectorProvider(CONNECTOR_MAP.claude)).toBe("anthropic");
    expect(connectorProvider(CONNECTOR_MAP.grok)).toBe("xai");
    expect(connectorProvider(CONNECTOR_MAP.perplexity)).toBe("perplexity");
    expect(connectorProvider(CONNECTOR_MAP.gemini)).toBe("google");
    expect(connectorProvider(async () => res("x", "ok"))).toBeNull();
    expect(connectorProvider(undefined)).toBeNull();
  });

  it("ok answers are stamped; non-ok outcomes are not; a connector-reported provider on an ok answer is not trusted", async () => {
    mockCall.chatgpt.mockResolvedValue(res("chatgpt", "ok", { provider: "acme" }));
    mockCall.claude.mockResolvedValue(res("claude", "timeout", { rawText: null }));
    mockCall.grok.mockResolvedValue(res("grok", "error", { rawText: null, provider: "xai" }));
    const out = await runClaimVerificationPanel("c", ["chatgpt", "claude", "grok"], {});
    expect(out.map((r) => [r.modelId, r.status, r.provider])).toEqual([
      ["chatgpt", "ok", "openai"],
      ["claude", "timeout", undefined],
      ["grok", "error", undefined],
    ]);
    // …and the stored evidence writes no provider for the failed rows, whatever they carried.
    const ev = buildClaimModelEvidence(out);
    expect(ev.map((e) => [e.status, (e as { provider?: string }).provider])).toEqual([["ok", "openai"], ["failed", undefined], ["failed", undefined]]);
  });

  it("a substitute's own reported provider is kept by the dispatch, as before", async () => {
    mockCall.chatgpt.mockResolvedValue(res("chatgpt", "substituted", { provider: "deepseek" }));
    const [row] = await runClaimVerificationPanel("c", ["chatgpt"], {});
    expect([row.status, row.provider]).toEqual(["substituted", "deepseek"]);
  });

  it("a slot dispatched to a function this module does not own records no provider (never the slot name)", async () => {
    const original = CONNECTOR_MAP.grok;
    try {
      (CONNECTOR_MAP as Record<string, unknown>).grok = async () => res("grok", "ok", { provider: "xai" });
      const [row] = await runClaimVerificationPanel("c", ["grok"], {});
      expect([row.status, "provider" in row]).toEqual(["ok", false]);
      expect("provider" in buildClaimModelEvidence([row])[0]).toBe(false);
    } finally {
      (CONNECTOR_MAP as Record<string, unknown>).grok = original;
    }
  });

  it("a slot whose connector returns another slot's id is still stamped by the function invoked for this slot", async () => {
    mockCall.claude.mockResolvedValue(res("chatgpt", "ok"));
    const [row] = await runClaimVerificationPanel("c", ["claude"], {});
    expect([row.modelId, row.provider]).toEqual(["claude", "anthropic"]);
  });
});

describe("ruling A: buildClaimModelEvidence writes a provider only for a successful, non-placeholder, canonical own answer", () => {
  it.each([
    ["registered", "openai", "openai"],
    ["normalized", " OpenAI ", "openai"],
    ["None", "None", undefined],
    ["n/a", "n/a", undefined],
    ["acme", "acme", undefined],
    ["unknown", "unknown", undefined],
    ["absent", undefined, undefined],
  ])("ok answer with stamped provider %s", (_l, provider, stored) => {
    const [e] = buildClaimModelEvidence([res("chatgpt", "ok", provider === undefined ? {} : { provider })]);
    expect([e.status, (e as { provider?: string }).provider]).toEqual(["ok", stored]);
  });

  it.each(["timeout", "error", "refused", "rate_limited", "failed"])("a %s result records no provider", (status) => {
    const [e] = buildClaimModelEvidence([res("chatgpt", status, { provider: "openai", rawText: null })]);
    expect([e.status, "provider" in e]).toEqual(["failed", false]);
  });

  it("an unparseable answer (parse_error) records no provider", () => {
    const [e] = buildClaimModelEvidence([res("chatgpt", "ok", { provider: "openai", rawText: "not json" })]);
    expect([e.status, "provider" in e]).toEqual(["parse_error", false]);
  });

  it("placeholder texts (D-5) record no provider: the listed literal, and text whose validity cannot be established", () => {
    const [lit] = buildClaimModelEvidence([res("chatgpt", "ok", { provider: "openai", rawText: STORED_PLACEHOLDER_LITERALS.chatgpt })]);
    expect("provider" in lit).toBe(false);
    const unknownValidity = JSON.stringify({ verdict: "accurate", confidence: "high", summary: "Mock response for the demo", correctParts: [], incorrectParts: [], unverifiableParts: [] });
    const [vu] = buildClaimModelEvidence([res("claude", "ok", { provider: "anthropic", rawText: unknownValidity })]);
    expect([vu.status, "provider" in vu]).toEqual(["ok", false]);
  });

  it("a substitution stores the substitute's provider exactly as today (trimmed, not re-normalized)", () => {
    const [e] = buildClaimModelEvidence([res("chatgpt", "substituted", { provider: " DeepSeek " })]);
    expect([(e as { substituted?: boolean }).substituted, (e as { provider?: string }).provider]).toEqual([true, "DeepSeek"]);
  });

  it("a substitution keeps the substitute's provider as today, and two substituted slots count once", () => {
    const ev = buildClaimModelEvidence([res("chatgpt", "substituted", { provider: "deepseek" }), res("claude", "substituted", { provider: "deepseek" })]);
    expect(ev.map((e) => [(e as { substituted?: boolean }).substituted, (e as { provider?: string }).provider])).toEqual([[true, "deepseek"], [true, "deepseek"]]);
    expect(storedVerificationIndependentAnswerCount({ modelResults: ev })).toBe(1);
    expect(storedVerificationConsensusIndependence({ modelResults: ev })).toBe("insufficient");
  });

  it("two genuine stamped own answers are independent; the same record before Order 33 (no provider) stays unverified", () => {
    const ev = buildClaimModelEvidence([res("chatgpt", "ok", { provider: "openai" }), res("claude", "ok", { provider: "anthropic" })]);
    expect(storedVerificationConsensusIndependence({ modelResults: ev, selectedModels: ["chatgpt", "claude"] })).toBe("independent");
    const old = ev.map(({ provider: _p, ...rest }) => rest);
    expect(storedVerificationConsensusIndependence({ modelResults: old, selectedModels: ["chatgpt", "claude"] })).toBe("unverified");
  });
});
