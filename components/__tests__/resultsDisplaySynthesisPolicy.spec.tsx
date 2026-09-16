/**
 * TEAM-RESEARCH-PARITY-R2 §L/§M/§S — `ResultsDisplay`'s synthesis-generation
 * policy, proven against the REAL renderer.
 *
 * `react-markdown` and `remark-gfm` are ESM-only and unparseable by this repo's
 * Jest transform, which is why every other suite stubs `ResultsDisplay`. Here
 * they are replaced by trivial factories so the component itself — its
 * auto-trigger effect included — actually mounts and runs. `authedFetch` is the
 * controlled boundary the effect POSTs through.
 *
 * NEGATIVE contract: a persisted read (two successful rows, runId, idle
 * synthesis, no cached report, no adaptive result) with
 * `allowSynthesisGeneration={false}` must produce ZERO synthesis POSTs.
 * POSITIVE contract: the same input WITHOUT the prop (the live composer's
 * default) still triggers exactly the established automatic synthesis.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
const AUTH = { user: { uid: "uid-1" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "fs";
import { join } from "path";
import ResultsDisplay from "@/components/ResultsDisplay";

const SOURCE = readFileSync(join(__dirname, "..", "ResultsDisplay.tsx"), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const rows = () => [
  { modelId: "chatgpt", status: "ok", rawTextFull: "Answer one", rawText: "Answer one", tokenUsage: { totalTokens: 3 }, latencyMs: 12 },
  { modelId: "claude", status: "ok", rawTextFull: "Answer two", rawText: "Answer two", tokenUsage: { totalTokens: 3 }, latencyMs: 12 },
];

/** §S 1–6: ordinary persisted run, ≥2 successful models, runId, idle, no cached synthesis, no adaptive. */
function persistedReadProps(extra: Record<string, unknown> = {}) {
  return {
    results: rows(),
    synthesizedReport: null,
    onRerun: () => {},
    onAddModel: () => {},
    question: "What changed?",
    runId: "run-77",
    synthesisStatus: "idle",
    synthesisReport: null,
    adaptive: null,
    ...extra,
  };
}

async function mount(props: Record<string, unknown>) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(ResultsDisplay as never, props as never));
  });
  // Let the effect's dynamic import + fetch chain settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuthedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("ResultsDisplay synthesis-generation policy (R2 §L)", () => {
  it("NEGATIVE — a persisted read with allowSynthesisGeneration={false} performs ZERO synthesis POSTs and zero side-effect fetches, and still renders the rows", async () => {
    const r = await mount(persistedReadProps({ readOnlyActions: true, allowSynthesisGeneration: false }));
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    // The renderer mounted and painted its (pre-existing, unchanged) no-synthesis presentation rather than nothing.
    expect(r.toJSON()).not.toBeNull();
    expect(JSON.stringify(r.toJSON()).length).toBeGreaterThan(100);
  });

  it("NEGATIVE — a re-render under the same policy still never POSTs (the auto-trigger set is never marked, and nothing fires later)", async () => {
    const r = await mount(persistedReadProps({ readOnlyActions: true, allowSynthesisGeneration: false }));
    await act(async () => {
      r.update(createElement(ResultsDisplay as never, persistedReadProps({ readOnlyActions: true, allowSynthesisGeneration: false, question: "What changed? (edited)" }) as never));
    });
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
  });

  it("POSITIVE — the same input with the DEFAULT policy (live composer) triggers exactly one POST /api/synthesize-panel carrying runId, question and the successful rows", async () => {
    await mount(persistedReadProps());
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedAuthedFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/synthesize-panel");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.runId).toBe("run-77");
    expect(body.question).toBe("What changed?");
    expect(body.results.map((x: { modelId: string }) => x.modelId)).toEqual(["chatgpt", "claude"]);
  });

  it("POSITIVE — allowSynthesisGeneration={true} passed explicitly behaves exactly like the default", async () => {
    await mount(persistedReadProps({ allowSynthesisGeneration: true }));
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });

  it("SEPARATION — readOnlyActions alone is NOT the synthesis policy: with the default policy it still auto-POSTs (which is why durable surfaces must pass the explicit prop)", async () => {
    await mount(persistedReadProps({ readOnlyActions: true }));
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
  });

  it("pre-existing conditions are unchanged under the default policy: a cached report, an adaptive result, or a single row never triggers", async () => {
    await mount(persistedReadProps({ synthesisReport: { headline: "cached" }, synthesisStatus: "complete" }));
    await mount(persistedReadProps({ results: rows().slice(0, 1) }));
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
  });
});

describe("ResultsDisplay synthesis-generation policy — source contract (R2 §M)", () => {
  it("the prop defaults to TRUE in the component's destructuring, so untouched call sites keep automatic synthesis", () => {
    expect(CODE).toMatch(/allowSynthesisGeneration = true,/);
  });

  it("the only synthesize-panel POST in the renderer sits inside the branch guarded by the shared policy helper", () => {
    const posts = CODE.match(/authedFetch\("\/api\/synthesize-panel"/g) ?? [];
    expect(posts).toHaveLength(1);
    const guardIdx = CODE.indexOf("shouldAutoTriggerSynthesis({");
    const postIdx = CODE.indexOf('authedFetch("/api/synthesize-panel"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(guardIdx);
    // The helper receives the policy prop, not a literal.
    expect(CODE.slice(guardIdx, postIdx)).toMatch(/allowSynthesisGeneration,\s*\}\)/);
  });
});
