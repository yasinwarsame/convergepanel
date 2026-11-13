/**
 * F-2 (Order 34, integration review m1): the SAME new run reads identically live and after reload.
 *
 * Live: the real `executeOrdinaryRun` builds the public rows the client renders (primary path, and the fallback path
 * taken when the first public-row pass throws). Saved: the rows handed to `completeRun` are persisted with the real
 * Step 6.2a `runtimeModelProvenance` and read back with the real `runDocumentToPublicResults` (Personal and Team read
 * APIs). Both are rendered through the real ResultsDisplay: the run line and the per-response card must match, and a
 * genuine answer that merely discusses a "mock response" never shows the unknown-validity notice. A historical row (no
 * structured fact) keeps the text oracle on both views.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "uid-1" }, authReady: true }) }));
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
  prepareAuthedHeaders: async (_user: unknown, headers: Headers) => headers,
}));
jest.mock("@/lib/client/fetchWithTimeout", () => ({
  fetchWithTimeout: jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" })),
  FetchError: class FetchError extends Error {},
}));
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: { href: string; children?: unknown }) => require("react").createElement("a", { href }, children as never) }));
jest.mock("@/lib/env", () => ({ OPENAI_API_KEY: "test", ANTHROPIC_API_KEY: "test", XAI_API_KEY: "test", PERPLEXITY_API_KEY: "test", GEMINI_API_KEY: "test" }));

// No Firebase: the admin module is replaced (the real runs module is loaded only for runtimeModelProvenance).
jest.mock("@/lib/firebase/admin", () => ({ adminDb: undefined, adminAuth: undefined, getAdminDb: () => { throw new Error("no firebase in tests"); } }));
const mockCompleteRun = jest.fn();
jest.mock("@/lib/firestore/runs", () => {
  const actual = jest.requireActual("@/lib/firestore/runs");
  return {
    runtimeModelProvenance: actual.runtimeModelProvenance,
    completeRun: (...a: unknown[]) => mockCompleteRun(...a),
    markRunError: jest.fn().mockResolvedValue(undefined),
    persistAdaptiveOutput: jest.fn(),
    persistLegacyAdaptiveOutput: jest.fn(),
    readGovernanceRecordForInitialization: jest.fn(),
    persistAutomatedGovernanceUpdate: jest.fn(),
    writeAdaptiveGovernanceEvent: jest.fn(),
  };
});
jest.mock("@/lib/firestore/userTokens", () => ({ incrementUserTokenUsage: jest.fn().mockResolvedValue({ tokensUsedCurrentPeriod: 0, periodStart: new Date() }) }));
jest.mock("@/lib/firestore/teamRuns", () => ({ createAdaptiveTeamRunProjection: jest.fn() }));
const mockRunPanel = jest.fn();
jest.mock("@/lib/panel", () => ({ runPanel: (...a: unknown[]) => mockRunPanel(...a) }));
const mockDebug = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: (...a: unknown[]) => mockDebug(...a) } }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import ResultsDisplay from "@/components/ResultsDisplay";
import { synthesizeReport } from "@/lib/consensus";
import { executeOrdinaryRun } from "@/lib/runPanelExecution";
import { runtimeModelProvenance } from "@/lib/firestore/runs";
import { runDocumentToPublicResults } from "@/lib/user/runDocumentToPublicResults";
import { executionIdentityVerified, placeholderClass, runExecutionIdentity, VALIDITY_UNKNOWN_NOTICE } from "@/lib/panel/executionIdentity";
import type { ModelResult } from "@/lib/types";
import type { RunDocument } from "@/lib/panel/schemas";

const MOCK_TALK =
  "The vendor's demo returned a mock response instead of live data, so the dashboard figures were placeholders. Paris is the capital of France and has been for centuries, according to every source consulted.";
const PARIS = "Paris is the capital of France. It has been the seat of government for centuries and is its largest city by population.";
const usage = { totalTokens: 10, promptTokens: 5, completionTokens: 5 };

/** What lib/panel.ts runSlotWithFallback returns for two own-connector answers (F-2 stamp on both, or on neither). */
function panelRows(stamped: boolean): ModelResult[] {
  const fact = stamped ? { outputClass: "model_response" as const } : {};
  return [
    { modelId: "chatgpt", status: "ok", rawText: MOCK_TALK, latencyMs: 5, tokenUsage: usage, provider: "openai", requestedModel: "gpt-test", actualModel: "gpt-test", ...fact },
    { modelId: "claude", status: "ok", rawText: PARIS, latencyMs: 6, tokenUsage: usage, provider: "anthropic", requestedModel: "claude-test", actualModel: "claude-test", ...fact },
  ];
}

/** The persisted perModel row as completeRun writes it (text + the Step 6.2a provenance), read back via the real adapter. */
function reload(passedToCompleteRun: ModelResult[], opts: { persistedBeforeF2?: boolean } = {}) {
  const runDocument = {
    perModel: passedToCompleteRun.map((r) => ({
      modelId: r.modelId,
      status: r.status,
      rawTextTruncated: r.rawText ?? "",
      latencyMs: r.latencyMs,
      tokenUsage: usage,
      wasTruncated: false,
      ...(opts.persistedBeforeF2
        ? (({ outputClass: _drop, ...rest }) => rest)(runtimeModelProvenance(r))
        : runtimeModelProvenance(r)),
    })),
  } as unknown as RunDocument;
  return runDocumentToPublicResults(runDocument) as unknown as ModelResult[];
}

async function live(stamped: boolean, opts: { fallbackPath?: boolean } = {}) {
  mockRunPanel.mockResolvedValueOnce(panelRows(stamped));
  if (opts.fallbackPath) {
    // The first public-row pass logs "Text processing"; throwing there sends executeOrdinaryRun to its fallback builder.
    mockDebug.mockImplementation((msg: unknown) => {
      if (typeof msg === "string" && msg.startsWith("[run-panel] Text processing")) throw new Error("forced first-pass failure");
    });
  }
  const out = await executeOrdinaryRun({ uid: "uid-1", runId: "run-1", trimmedQuestion: "What is the capital of France?", context: null, selectedModels: ["chatgpt", "claude"] as never, adaptivePlan: null, debugRawResponseRequested: false } as never);
  expect(out.status).toBe(200);
  const liveRows = (out.body as { results: ModelResult[] }).results;
  const persisted = opts.fallbackPath ? panelRows(stamped) : (mockCompleteRun.mock.calls.at(-1)![0] as { results: ModelResult[] }).results;
  return { liveRows, savedRows: reload(persisted) };
}

const nodeText = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(nodeText).join(""));
const mounted: TestRenderer.ReactTestRenderer[] = [];
async function render(results: ModelResult[]) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      createElement(ResultsDisplay as never, { results, synthesizedReport: synthesizeReport(results), onRerun: () => {}, onAddModel: () => {}, question: "What is the capital of France?", runId: "run-1", synthesisStatus: "idle", synthesisReport: null, adaptive: null, allowSynthesisGeneration: false } as never)
    );
  });
  mounted.push(r);
  for (const b of r.root.findAll((n) => n.type === "button" && /Show answer/.test(nodeText(n)))) {
    await act(async () => {
      b.props.onClick?.();
    });
  }
  const text = nodeText(r.root);
  const runLine = text.match(/This panel compared [^.]*?(\)|models)/)?.[0] ?? null;
  return { text, runLine };
}

beforeEach(() => {
  mockCompleteRun.mockReset().mockResolvedValue({ totalTokens: 20, tokensByProvider: { openai: 10, anthropic: 10 } });
  mockRunPanel.mockReset();
  mockDebug.mockReset();
  for (const m of ["log", "warn", "error", "debug"] as const) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  jest.restoreAllMocks();
});

describe("F-2: a new run reads the same live and after reload", () => {
  it.each([
    ["primary public-row path", false],
    ["fallback public-row path", true],
  ])("stamped genuine answer discussing a mock response (%s): independent on both, same run line, no unknown-validity card", async (_label, fallbackPath) => {
    const { liveRows, savedRows } = await live(true, { fallbackPath });
    expect(liveRows.map((r) => r.outputClass)).toEqual(["model_response", "model_response"]);
    expect(savedRows.map((r) => r.outputClass)).toEqual(["model_response", "model_response"]);
    for (const rows of [liveRows, savedRows]) {
      expect(executionIdentityVerified(rows)).toBe(true);
      expect(runExecutionIdentity(rows).kind).toBe("IND");
      expect(runExecutionIdentity(rows).qualified).toBe(false);
      expect(placeholderClass(rows[0])).toBeNull();
    }
    const l = await render(liveRows);
    const s = await render(savedRows);
    expect(l.runLine).toBe("This panel compared 2 models");
    expect(s.runLine).toBe(l.runLine);
    expect(l.text).toContain(MOCK_TALK);
    expect(s.text).toContain(MOCK_TALK);
    expect(l.text).not.toContain(VALIDITY_UNKNOWN_NOTICE);
    expect(s.text).not.toContain(VALIDITY_UNKNOWN_NOTICE);
    expect(l.text).not.toContain("model independence unverified");
    expect(s.text).not.toContain("model independence unverified");
  });

  it("history (a row persisted before F-2, no structured fact): the text oracle still applies on the saved view", async () => {
    const { liveRows } = await live(true);
    const persisted = (mockCompleteRun.mock.calls.at(-1)![0] as { results: ModelResult[] }).results;
    const historical = reload(persisted, { persistedBeforeF2: true });
    expect(historical.some((r) => "outputClass" in r)).toBe(false);
    expect(executionIdentityVerified(historical)).toBe(false);
    expect(placeholderClass(historical[0])).toBe("VALIDITY_UNKNOWN");
    const s = await render(historical);
    expect(s.text).toContain(VALIDITY_UNKNOWN_NOTICE);
    // The same text on a new (stamped) live row is a model response.
    expect(executionIdentityVerified(liveRows)).toBe(true);
  });
});
