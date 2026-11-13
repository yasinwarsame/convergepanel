/**
 * Phase 0 compatibility restoration — P0-H3 (inventory v3.4 A.7.1, row E08; owner O9 "ships with Phase 0"; lands with
 * L04 / L11 per H-9).
 *
 * Phase 0 restores the 35933c8 client consensus engine (lib/consensus.ts counts usable SLOTS), so two slots answered by
 * one substitute model produce a non-null report again whose unified-answer HTML reads "Agreed by 2 models (DeepSeek
 * (substituting ChatGPT), DeepSeek (substituting Claude))". ResultsDisplay presents that HTML only when the usable
 * responses come from at least two INDEPENDENT executing models; otherwise it shows UNIFIED_ANSWER_WITHHELD_TEXT in its
 * place. Presentation only: the report object, which view renders, and every decision are unchanged.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "uid-1" }, authReady: true }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: jest.fn(async () => ({ ok: false, json: async () => ({}) })) }));
jest.mock("@/lib/client/fetchWithTimeout", () => ({ fetchWithTimeout: jest.fn(async () => ({ ok: false, json: async () => ({}) })), FetchError: class FetchError extends Error {} }));
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: { href: string; children?: unknown }) => require("react").createElement("a", { href }, children as never) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import ResultsDisplay, { UNIFIED_ANSWER_WITHHELD_TEXT } from "@/components/ResultsDisplay";
import { synthesizeReport } from "@/lib/consensus";
import type { ModelResult } from "@/lib/types";

const TEXT =
  "Paris is the capital of France. The city has been the seat of the French government for centuries. " +
  "It is located on the Seine river in northern France. Paris is the most populous city in France.";
const ok = (modelId: string, provider: string) => ({ modelId, status: "ok", rawText: TEXT, provider, latencyMs: 1 }) as unknown as ModelResult;
const sub = (modelId: string, provider?: string) =>
  ({ modelId, status: "substituted", rawText: TEXT, ...(provider ? { provider } : {}), substitutedFrom: modelId, latencyMs: 1 }) as unknown as ModelResult;

function texts(node: unknown): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  const n = node as { props?: Record<string, unknown>; children?: unknown };
  const html = n.props && (n.props as any).dangerouslySetInnerHTML?.__html;
  return [...(typeof html === "string" ? [html] : []), ...texts(n.children ?? null)];
}
const mounted: TestRenderer.ReactTestRenderer[] = [];
afterEach(async () => {
  for (const r of mounted.splice(0)) await act(async () => r.unmount());
});
async function mount(results: ModelResult[]) {
  const report = synthesizeReport(results);
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      createElement(ResultsDisplay as never, {
        results,
        synthesizedReport: report,
        onRerun: () => {},
        onAddModel: () => {},
        question: "What is the capital of France?",
        runId: "run-1",
        synthesisStatus: "idle",
        synthesisReport: null,
        adaptive: null,
        allowSynthesisGeneration: false,
      } as never)
    );
  });
  mounted.push(r);
  return { report, text: texts(r.toJSON()).join("") };
}

describe("P0-H3: the slot report's unified-answer HTML is presented only with >= 2 independent executing models", () => {
  it.each([
    ["two DeepSeek substitutions", [sub("chatgpt", "deepseek"), sub("claude", "deepseek")]],
    ["two substitutes, provider not recorded", [sub("chatgpt"), sub("claude")]],
  ])("%s: report non-null (35933c8 slot rule), HTML withheld, reason shown", async (_n, results) => {
    const { report, text } = await mount(results as ModelResult[]);
    expect(report).not.toBeNull();
    expect(report!.unifiedAnswer).toMatch(/Agreed by 2 models/);
    expect(text).toContain(UNIFIED_ANSWER_WITHHELD_TEXT);
    expect(text).not.toMatch(/Agreed by \d+ models/);
  });

  it.each([
    ["two independent models", [ok("chatgpt", "openai"), ok("claude", "anthropic")]],
    ["two DeepSeek substitutions + Grok (2 independent models)", [sub("chatgpt", "deepseek"), sub("claude", "deepseek"), ok("grok", "xai")]],
  ])("%s: the unified-answer HTML is presented", async (_n, results) => {
    const { text } = await mount(results as ModelResult[]);
    expect(text).not.toContain(UNIFIED_ANSWER_WITHHELD_TEXT);
    expect(text).toMatch(/Agreed by \d+ models/);
  });
});
