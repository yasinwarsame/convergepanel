/**
 * Saved-run provenance honesty (S1) — the REAL PanelSynthesisView wiring.
 *
 * The pure rules live in lib/panel/substitutionDisplay.ts (unit-tested there,
 * with a pre-S1 oracle for live parity). This proves the component actually
 * uses them for the "Model health" chip and the copied synthesis markdown when
 * it renders a SAVED run's rows (a cached report, no generation).
 */
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: Record<string, unknown>) => require("react").createElement("a", { href }, children as never) }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u" }, authReady: true }) }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import PanelSynthesisView from "@/components/PanelSynthesisView";
import { getModelDisplayNameSafe } from "@/lib/panelModels";

const REPORT = {
  executiveSummary: "Both answers agree on the core steps.",
  keyFindings: [{ claim: "Create a repository first.", confidence: "High", evidenceRefs: [], modelsSupporting: ["chatgpt", "claude"] }],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  methodology: "Cross-model comparison.",
};
const ok = { modelId: "chatgpt", status: "ok", rawText: "A long enough answer from ChatGPT about repositories.", rawTextFull: "A long enough answer from ChatGPT about repositories.", latencyMs: 1 };
const savedSub = (over: Record<string, unknown> = {}) => ({ modelId: "claude", status: "substituted", rawText: "A long enough fallback answer about repositories.", rawTextFull: "A long enough fallback answer about repositories.", latencyMs: 1, ...over });

let copied: string[] = [];
/** Every renderer this file creates, unmounted after each test: VerificationActions
 *  schedules a 2s "Copied!" reset timer that only its unmount cleanup clears.
 *  Leaving it pending let it fire after this file finished — "Cannot log after
 *  tests are done", which makes `jest --runInBand` exit 1 with every test green. */
const mounted: TestRenderer.ReactTestRenderer[] = [];
beforeEach(() => {
  copied = [];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (t: string) => void copied.push(t) } }, configurable: true });
});
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  jest.restoreAllMocks();
});

async function mount(results: unknown[]) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(PanelSynthesisView, { results: results as never, question: "How do I start?", runId: "run-1", preGeneratedStatus: "complete", preGeneratedReport: REPORT as never }));
  });
  mounted.push(r);
  return r;
}
const textOf = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const chip = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => n.type === "span" && typeof n.props.title === "string" && textOf(n).startsWith("Substituted:"))[0];
async function copy(r: TestRenderer.ReactTestRenderer) {
  const button = r.root.findAll((n) => n.type === "button" && textOf(n).toLowerCase().includes("copy"))[0];
  // The handler is fire-and-forget (`void (async () => …)()`); flush its
  // microtasks inside act so the copy and the "Copied!" state update both land
  // before asserting, rather than relying on timing.
  await act(async () => {
    button.props.onClick();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  expect(copied.length).toBeGreaterThan(0);
  return copied.join("\n");
}

describe("a saved pre-6.2a substituted row", () => {
  it("Model health chip: count label and fact-only tooltip — never the slot as the substitute", async () => {
    const r = await mount([ok, savedSub()]);
    const c = chip(r);
    expect(textOf(c)).toBe("Substituted: 1");
    expect(textOf(c)).not.toContain(getModelDisplayNameSafe("claude"));
    expect(c.props.title).toBe(`${getModelDisplayNameSafe("claude")}: substituted`);
  });

  it("copied markdown names no substitute provider", async () => {
    const text = await copy(await mount([ok, savedSub()]));
    expect(text).toContain("Panel note: 1 model substituted.");
    expect(text).not.toMatch(/DeepSeek|Anthropic|Unknown|deepseek-chat/);
  });
});

describe("a saved post-6.2a substituted row", () => {
  it("copied markdown names the recorded provider", async () => {
    const text = await copy(await mount([ok, savedSub({ provider: "deepseek", requestedModel: "claude-RUN-1" })]));
    expect(text).toContain("Panel note: 1 model substituted (DeepSeek).");
  });
  it("tooltip states the recorded requested model only", async () => {
    const c = chip(await mount([ok, savedSub({ provider: "deepseek", requestedModel: "claude-RUN-1" })]));
    expect(c.props.title).toBe(`${getModelDisplayNameSafe("claude")}: substituted (requested claude-RUN-1)`);
  });
});
