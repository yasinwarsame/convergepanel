/**
 * P0 restoration (2026-11-01). The "generic" answer type now saves the analysis it generated.
 *
 * Production condition: Gemini failed on every call. The classifier fell back to "generic", the only executed answer
 * type with no saved envelope, and every run reloaded with no analysis at all.
 *
 * Chain, every layer real; only model calls are mocked:
 *   finalizeAdaptiveRun(generic)  [the run's real builder; Gemini healthy, or Gemini failing on every call]
 *     -> persistedLegacyOutput    [what runPanelExecution writes to runs/{id}.legacyAdaptiveOutput]
 *     -> JSON round trip          [Firestore]
 *     -> buildRunReadPayload -> interpretPersistedRunReadPayload -> PersistedResearchResultView -> ResultsDisplay
 *
 * Proves: the envelope holds only what the builder generated; the saved view renders the adaptive result, never the
 * no-analysis fallback; nothing is fetched or re-run on read.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
const AUTH = { user: { uid: "owner-1" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));
jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "k" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
jest.mock("@/lib/connectors", () => ({ CONNECTOR_MAP: {} }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { callGemini } from "@/lib/connectors/gemini";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { parsePersistedLegacyAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { buildRunReadPayload } from "@/lib/runs/runReadPayload";
import { interpretPersistedRunReadPayload } from "@/lib/research/persistedRunPresentation";
import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import { CLASSIFICATION_BASE, DEFAULT_MODE, SCENARIOS, geminiMockImpl } from "./o5p/o5pScenarios";

const gem = callGemini as unknown as jest.Mock;
const RUN_ID = "run-p0-generic-1";
const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const genericMixed = SCENARIOS.find((s) => s.name === "generic-mixed")!;
const GENERIC_CLASSIFICATION = { ...CLASSIFICATION_BASE, queryType: "generic", answerShape: getResultSchema("generic" as never).renderHint, fallbackReason: "connector_error" };

async function finalizeGeneric(geminiUp: boolean) {
  gem.mockReset();
  gem.mockImplementation(geminiUp ? geminiMockImpl(DEFAULT_MODE) : async () => ({ modelId: "gemini", status: "error", rawText: "Gemini request failed. Please try again.", latencyMs: 250 }));
  const input = genericMixed.results();
  const res: any = await finalizeAdaptiveRun(getResultSchema("generic" as never), input as never, "Will AI eliminate more jobs than it creates in the next 10 years?", undefined, GENERIC_CLASSIFICATION as never);
  return { res, input };
}

function savedDoc(input: any[], legacyAdaptiveOutput: unknown) {
  const perModel = input.map((r) => ({ modelId: r.modelId, status: r.status, rawTextTruncated: r.rawText ?? "", tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 5, wasTruncated: false }));
  return roundTrip({ userId: "owner-1", question: "Will AI eliminate more jobs than it creates in the next 10 years?", status: "complete", runDocument: { perModel }, legacyAdaptiveOutput });
}

async function renderSaved(doc: Record<string, unknown>) {
  const payload = roundTrip(await buildRunReadPayload({ mayReadDecisionContent: true, runId: RUN_ID, data: doc, viewerRole: "owner", resolveReviewRouting: jest.fn().mockResolvedValue("not_configured") }));
  const interp = interpretPersistedRunReadPayload(payload, RUN_ID);
  if (interp.kind !== "ready") throw new Error(`not ready: ${interp.kind}`);
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(PersistedResearchResultView, { presentation: interp.presentation }));
  });
  return { r, interp };
}

/**
 * The invariant is "no model call and no write": no POST, and nothing to the run or synthesis endpoints. A read-only
 * GET (the existing usage/plan lookup some surfaces mount) is pre-existing behaviour and is allowed.
 */
function expectNoExecutionOrSynthesisCall() {
  for (const [url, init] of mockedAuthedFetch.mock.calls as [string, { method?: string } | undefined][]) {
    expect([url, init?.method ?? "GET"]).not.toEqual(expect.arrayContaining(["POST"]));
    expect(String(url)).not.toMatch(/\/api\/(synthesize-panel|run-panel|workspaces\/[^/]+\/runs$)/);
  }
}

beforeEach(() => {
  mockedAuthedFetch.mockReset();
  mockedAuthedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe.each([
  ["Gemini healthy", true],
  ["Gemini failing on every call (the Production condition)", false],
])("generic run, %s", (_label, geminiUp) => {
  it("the builder attaches a version-1 generic envelope that is only a copy of what it generated", async () => {
    const { res } = await finalizeGeneric(geminiUp);
    const env = res.persistedLegacyOutput;
    expect(env).toBeDefined();
    expect(env.version).toBe(1);
    expect(env.schemaId).toBe("generic");
    expect(env.classification).toEqual(GENERIC_CLASSIFICATION);
    expect(env.results).toEqual(res.adaptiveResults);
    expect(env.alignedClaims).toEqual(res.alignedClaims);
    expect(env.gate).toEqual(res.gate);
    expect(env.synthesisReport).toEqual(res.synthesisReport);
    expect(env.trustSummary).toEqual(res.trustSummary);
    // It survives Firestore's JSON round trip and the real reader accepts it.
    const parsed = parsePersistedLegacyAdaptiveOutput(roundTrip(env));
    expect(parsed.ok).toBe(true);
  });

  it("a saved generic run reloads into the adaptive result, never the no-analysis fallback, with zero fetches", async () => {
    const { res, input } = await finalizeGeneric(geminiUp);
    const { r, interp } = await renderSaved(savedDoc(input, res.persistedLegacyOutput));
    if (interp.kind !== "ready") throw new Error("not ready");
    expect(interp.presentation.adaptive?.schemaId).toBe("generic");
    expect(interp.presentation.adaptive?.persistenceStatus).toBe("saved");
    expect(r.root.findAll((n) => typeof n.type === "string" && n.props["data-testid"] === "responses-without-analysis")).toHaveLength(0);
    expect(JSON.stringify(r.toJSON())).not.toMatch(/No unified answer yet/);
    expectNoExecutionOrSynthesisCall();
  });
});

it("the same generic run saved WITHOUT an envelope (every run before this fix) still shows its model responses", async () => {
  const { input } = await finalizeGeneric(false);
  const { r } = await renderSaved(savedDoc(input, undefined));
  const shown = r.root.findAll((n) => typeof n.type === "string" && n.props["data-testid"] === "saved-model-response").map((n) => n.props["data-model-id"]);
  expect(shown.length).toBeGreaterThan(1);
  expect(shown).toEqual(input.filter((x: any) => x.status === "ok" && x.rawText).map((x: any) => x.modelId));
  expectNoExecutionOrSynthesisCall();
});
