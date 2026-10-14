/**
 * Model-identity PR A — the REAL PanelSynthesisView "Export memo" action lists
 * each usable model by the run's recorded requested model (or "model not
 * recorded"), never by a product label or a bare family.
 */
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: Record<string, unknown>) => require("react").createElement("a", { href }, children as never) }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u" }, authReady: true }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) }));
const memoInputs: Array<{ modelsUsed?: string[] }> = [];
jest.mock("@/lib/verification/generateMemo", () => ({
  generateVerificationMemo: (input: { modelsUsed?: string[] }) => {
    memoInputs.push(input);
    return "memo";
  },
  downloadTextFile: jest.fn(),
}));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import PanelSynthesisView from "@/components/PanelSynthesisView";

const REPORT = {
  executiveSummary: "Both answers agree on the core steps.",
  keyFindings: [{ claim: "Create a repository first.", confidence: "High", evidenceRefs: [], modelsSupporting: ["chatgpt", "claude"] }],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  methodology: "Cross-model comparison.",
};
const row = (modelId: string, extra: Record<string, unknown> = {}) => ({
  modelId,
  status: "ok",
  rawText: `A long enough answer from ${modelId} about repositories.`,
  rawTextFull: `A long enough answer from ${modelId} about repositories.`,
  latencyMs: 1,
  ...extra,
});

const mounted: TestRenderer.ReactTestRenderer[] = [];
beforeEach(() => {
  memoInputs.length = 0;
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  jest.restoreAllMocks();
});

async function exportMemo(results: unknown[]): Promise<string[]> {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(PanelSynthesisView, { results: results as never, question: "How do I start?", runId: "run-1", preGeneratedStatus: "complete", preGeneratedReport: REPORT as never }));
  });
  mounted.push(r);
  const actions = r.root.findAll((n) => typeof n.props.onExportMemo === "function");
  expect(actions.length).toBeGreaterThan(0);
  await act(async () => {
    actions[0].props.onExportMemo();
  });
  expect(memoInputs).toHaveLength(1);
  return memoInputs[0].modelsUsed ?? [];
}

describe("PanelSynthesisView memo export", () => {
  it("live rows: each model by its recorded requested model", async () => {
    expect(await exportMemo([row("chatgpt", { provider: "openai", requestedModel: "gpt-4o-mini" }), row("claude", { provider: "anthropic", requestedModel: "claude-haiku-4-5-20251001" })])).toEqual([
      "ChatGPT · requested: gpt-4o-mini",
      "Claude · requested: claude-haiku-4-5-20251001",
    ]);
  });

  it("saved pre-6.2a rows: 'model not recorded', never a product label", async () => {
    const models = await exportMemo([row("chatgpt"), row("claude")]);
    expect(models).toEqual(["ChatGPT · model not recorded", "Claude · model not recorded"]);
    expect(models.join("\n")).not.toMatch(/GPT 5\.2|Claude Opus/);
  });
});
