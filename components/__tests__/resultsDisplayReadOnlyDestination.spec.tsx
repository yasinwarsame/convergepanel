/**
 * TEAM-RESEARCH-PARITY-R2-C1 §J — `ResultsDisplay`'s read-only execution
 * destination contract, proven against the REAL renderer (same ESM-dependency
 * mocking as `resultsDisplaySynthesisPolicy.spec.tsx`). The single-successful-
 * model branch is the only place `readOnlyActions` changes markup.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
const AUTH = { user: { uid: "uid-1" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import ResultsDisplay from "@/components/ResultsDisplay";

const SINGLE = [{ modelId: "chatgpt", status: "ok", rawTextFull: "Only answer", rawText: "Only answer", tokenUsage: { totalTokens: 3 }, latencyMs: 12 }];
const TWO = [...SINGLE, { modelId: "claude", status: "ok", rawTextFull: "Second", rawText: "Second", tokenUsage: { totalTokens: 3 }, latencyMs: 12 }];

function base(extra: Record<string, unknown> = {}) {
  return { results: SINGLE, synthesizedReport: null, onRerun: jest.fn(), onAddModel: jest.fn(), question: "Q?", runId: "run-1", synthesisStatus: "idle", synthesisReport: null, adaptive: null, ...extra };
}
async function mount(props: Record<string, unknown>) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(ResultsDisplay as never, props as never));
  });
  await act(async () => {
    await new Promise((res) => setTimeout(res, 0));
  });
  return r;
}
const anchors = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "a").map((n) => ({ href: n.props.href as string, text: JSON.stringify(n.children) }));
const buttons = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "button").map((n) => JSON.stringify(n.children));
const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("ResultsDisplay — read-only execution destination (single successful model)", () => {
  it("readOnlyActions=false (live composer): the existing rerun / add-model buttons render, no pointer, no anchor", async () => {
    const r = await mount(base());
    expect(buttons(r).some((b) => b.includes("Re-run Same Panel"))).toBe(true);
    expect(buttons(r).some((b) => b.includes("Add Another Model + Re-run"))).toBe(true);
    expect(text(r)).not.toContain("To run this question again");
    expect(anchors(r)).toEqual([]);
  });

  it("readOnlyActions=true + explicit destination: renders exactly that destination and label, and no execution buttons", async () => {
    const r = await mount(base({ readOnlyActions: true, readOnlyExecutionTarget: { href: "/somewhere/else", label: "Elsewhere" } }));
    expect(anchors(r)).toEqual([{ href: "/somewhere/else", text: JSON.stringify(["Elsewhere"]) }]);
    expect(text(r)).toContain("To run this question again");
    expect(buttons(r).some((b) => b.includes("Re-run"))).toBe(false);
  });

  it("readOnlyActions=true + null / absent destination: neutral read-only copy, NO anchor, NO execution buttons, content still renders", async () => {
    for (const props of [base({ readOnlyActions: true, readOnlyExecutionTarget: null }), base({ readOnlyActions: true })]) {
      const r = await mount(props);
      expect(anchors(r)).toEqual([]);
      expect(text(r)).toContain("This saved report is read-only.");
      expect(text(r)).not.toContain("To run this question again");
      expect(text(r)).not.toContain('"href":"/"');
      expect(buttons(r).some((b) => b.includes("Re-run"))).toBe(false);
      expect(text(r)).toContain("Only One Model Responded");
    }
  });

  it("no hard-coded '/' appears merely because readOnlyActions=true", async () => {
    const r = await mount(base({ readOnlyActions: true }));
    expect(text(r)).not.toContain('"href":"/"');
  });

  it("the Personal caller's destination reproduces the pre-C1 markup exactly: href '/' with the 'Research' label", async () => {
    const r = await mount(base({ readOnlyActions: true, readOnlyExecutionTarget: { href: "/", label: "Research" } }));
    expect(anchors(r)).toEqual([{ href: "/", text: JSON.stringify(["Research"]) }]);
  });

  it("the destination prop is decoupled from the synthesis policy: two rows + default policy still auto-POST regardless of destination; policy false never POSTs", async () => {
    await mount(base({ results: TWO, readOnlyActions: true, readOnlyExecutionTarget: { href: "/x" } }));
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    mockedAuthedFetch.mockClear();
    await mount(base({ results: TWO, readOnlyActions: true, readOnlyExecutionTarget: { href: "/x" }, allowSynthesisGeneration: false }));
    await mount(base({ results: TWO, readOnlyActions: true, readOnlyExecutionTarget: null, allowSynthesisGeneration: false }));
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
  });
});
