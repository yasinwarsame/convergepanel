/**
 * Order 5 Phase 0 — executeOrdinaryRun() wiring of the Provider Search
 * Evidence counters: flag-gated, one aggregate event per Perplexity slot,
 * content-free, zero writes, response unchanged.
 */

let countersFlag = false;
jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
  get PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED() {
    return countersFlag;
  },
}));

const firestoreCalls: string[] = [];
const track = (name: string, impl: (...a: any[]) => any) => (...args: any[]) => {
  firestoreCalls.push(name);
  return impl(...args);
};
jest.mock("@/lib/firestore/runs", () => ({
  completeRun: track("completeRun", async () => ({ totalTokens: 80, tokensByProvider: { anthropic: 50, perplexity: 30 } })),
  markRunError: track("markRunError", async () => undefined),
  persistAdaptiveOutput: track("persistAdaptiveOutput", async () => ({ saved: true })),
  persistLegacyAdaptiveOutput: track("persistLegacyAdaptiveOutput", async () => ({ saved: true })),
  readGovernanceRecordForInitialization: track("readGovernanceRecordForInitialization", async () => null),
  persistAutomatedGovernanceUpdate: track("persistAutomatedGovernanceUpdate", async () => undefined),
  writeAdaptiveGovernanceEvent: track("writeAdaptiveGovernanceEvent", async () => undefined),
}));
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: track("incrementUserTokenUsage", async () => ({ tokensUsedCurrentPeriod: 80, periodStart: new Date() })),
}));
jest.mock("@/lib/firestore/adaptiveRetryAccounting", () => ({
  applyAdaptiveRetryAccounting: track("applyAdaptiveRetryAccounting", async () => ({ status: "no_retry_calls" })),
}));
jest.mock("@/lib/firestore/teamRuns", () => ({ createAdaptiveTeamRunProjection: track("createAdaptiveTeamRunProjection", async () => undefined) }));
jest.mock("@/lib/firebase/admin", () => ({ adminDb: null, adminAuth: null, FIREBASE_PROJECT_ID: "test" }));

const mockedFinalize = jest.fn();
jest.mock("@/lib/adaptiveSchema/orchestrate", () => ({ finalizeAdaptiveRun: (...a: any[]) => mockedFinalize(...a) }));
jest.mock("@/lib/adaptiveSchema/analytics", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/analytics");
  const stubs: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) stubs[key] = typeof actual[key] === "function" ? jest.fn() : actual[key];
  return stubs;
});
const mockedRunPanel = jest.fn();
jest.mock("@/lib/panel", () => ({ runPanel: (...a: any[]) => mockedRunPanel(...a) }));
const logInfo = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: (...a: any[]) => logInfo(...a), error: jest.fn(), debug: jest.fn() } }));

import { executeOrdinaryRun } from "@/lib/runPanelExecution";
import * as observationModule from "@/lib/providers/perplexitySearchEvidenceObservation";
import { PROVIDER_SEARCH_EVIDENCE_PHASE0_EVENT } from "@/lib/providers/perplexitySearchEvidenceObservation";

const QUESTION = "CONFIDENTIAL-QUESTION what changed in the tariff policy?";
const CONTEXT = "CONFIDENTIAL-CONTEXT memo text";
const UID = "uid-SECRET-1";
const RUN_ID = "run-SECRET-1";

function perplexityAgentRaw() {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "perplexity/sonar",
    output: [
      {
        type: "search_results",
        results: [
          { id: 1, url: "https://news.example-private-domain.com/a?id=1", title: "PRIVATE-TITLE", snippet: "PRIVATE-SNIPPET", date: "2026-01-02", last_updated: "2026-02-01" },
          { id: 2, url: "https://example.org/b?access_token=leak", title: "t", snippet: "s", date: "2026-02-30" },
        ],
      },
      { type: "search_results", results: [{ id: 3, url: "https://example.net/c", date: null }] },
      { type: "message", content: [{ type: "output_text", text: "MODEL-ANSWER-TEXT" }] },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

function panelResults() {
  return [
    { modelId: "claude", status: "ok", rawText: "Claude answer", latencyMs: 5, provider: "anthropic", tokenUsage: { totalTokens: 50, promptTokens: 30, completionTokens: 20 } },
    {
      modelId: "perplexity",
      status: "ok",
      rawText: "MODEL-ANSWER-TEXT",
      latencyMs: 5,
      provider: "perplexity",
      tokenUsage: { totalTokens: 30, promptTokens: 20, completionTokens: 10 },
      rawResponse: perplexityAgentRaw(),
    },
  ];
}

function args(adaptive: boolean) {
  return {
    uid: UID,
    runId: RUN_ID,
    trimmedQuestion: QUESTION,
    context: CONTEXT,
    selectedModels: ["claude", "perplexity"] as any,
    adaptivePlan: adaptive
      ? {
          classification: { queryType: "comparison_matrix" } as any,
          schema: { id: "comparison_matrix", fields: [] } as any,
          promptOverrides: { claude: "P", perplexity: "P" },
          routing: { kind: "active" } as any,
        }
      : null,
    debugRawResponseRequested: false,
    requestBudget: { startedAtMonoMs: performance.now(), budgetMs: 300_000 },
  };
}

const phase0Events = () => logInfo.mock.calls.filter(([event]) => event === PROVIDER_SEARCH_EVIDENCE_PHASE0_EVENT);

beforeEach(() => {
  jest.clearAllMocks();
  firestoreCalls.length = 0;
  countersFlag = false;
  mockedRunPanel.mockImplementation(async () => panelResults());
  // Adaptive slot data carries the fields sourceBacked/source coverage derive from, so any mutation of it is visible in the response.
  mockedFinalize.mockResolvedValue({
    schemaId: "comparison_matrix",
    adaptiveResults: [
      { modelId: "claude", schemaId: "comparison_matrix", ok: true, data: { directConclusion: "c", sources: ["https://src.test/claude"] } },
      { modelId: "perplexity", schemaId: "comparison_matrix", ok: true, data: { directConclusion: "p", sources: ["https://src.test/pplx"] } },
    ],
  });
});

describe("flag off (default)", () => {
  it("emits no Phase-0 event and never invokes the observer", async () => {
    const spy = jest.spyOn(observationModule, "observeProviderSearchEvidence");
    await executeOrdinaryRun(args(false));
    await executeOrdinaryRun(args(true));
    expect(phase0Events()).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("flag on", () => {
  it("non-adaptive run: exactly one aggregate event with exact counts", async () => {
    countersFlag = true;
    await executeOrdinaryRun(args(false));
    const events = phase0Events();
    expect(events).toHaveLength(1);
    expect(events[0][1]).toEqual({
      schemaVersion: 1,
      provider: "perplexity",
      resultStatus: "ok",
      responseShape: "agent",
      agentStatus: "completed",
      searchResultItems: 2,
      resultEntries: 3,
      malformedEntries: 0,
      urlUsable: 2,
      urlInvalid: 0,
      urlOverLimit: 0,
      privacyDroppedEntries: 1,
      dateAbsent: 1,
      dateValid: 1,
      dateMalformed: 1,
      dateFuture: 0,
      lastUpdatedPresent: 1,
      lastUpdatedAbsent: 2,
      retryEligibility: "not_applicable",
      safeEntries: 2,
      eligible: true,
      ineligibilityReason: null,
    });
  });

  it("the event carries no content-bearing value (uid, run id, question, context, answer, URL, domain, title, snippet, raw date)", async () => {
    countersFlag = true;
    await executeOrdinaryRun(args(false));
    const serialized = JSON.stringify(phase0Events());
    for (const needle of [UID, RUN_ID, "CONFIDENTIAL", "MODEL-ANSWER", "PRIVATE", "example", "http", "access_token", "leak", "2026-01-02", "2026-02-30", "resp_1", "perplexity/sonar"]) {
      expect(serialized).not.toContain(needle);
    }
  });

  it("adaptive run: retry state from the finalized slot (adopted_full → retry_ineligible)", async () => {
    countersFlag = true;
    mockedFinalize.mockResolvedValue({
      schemaId: "comparison_matrix",
      adaptiveResults: [
        { modelId: "claude", schemaId: "comparison_matrix", ok: true, data: {} },
        { modelId: "perplexity", schemaId: "comparison_matrix", ok: true, data: {}, retried: true, retryOutcome: "adopted_full" },
      ],
    });
    await executeOrdinaryRun(args(true));
    expect(phase0Events()[0][1]).toMatchObject({ retryEligibility: "ineligible", eligible: false, ineligibilityReason: "retry_ineligible" });
  });

  it("adaptive run with no retry metadata is eligible (adaptive does not gate evidence)", async () => {
    countersFlag = true;
    await executeOrdinaryRun(args(true));
    expect(phase0Events()[0][1]).toMatchObject({ retryEligibility: "eligible", eligible: true });
  });

  it("adaptive finalization failure fails closed (adaptive_state_unknown); the response still succeeds", async () => {
    countersFlag = true;
    mockedFinalize.mockRejectedValue(new Error("finalize exploded"));
    const result = await executeOrdinaryRun(args(true));
    expect(result.status).toBe(200);
    expect(phase0Events()[0][1]).toMatchObject({ retryEligibility: "unknown", eligible: false, ineligibilityReason: "adaptive_state_unknown" });
  });

  it("DeepSeek-substituted Perplexity slot is observed as ineligible", async () => {
    countersFlag = true;
    mockedRunPanel.mockImplementation(async () => {
      const r = panelResults();
      r[1] = { ...r[1], status: "substituted", provider: "deepseek", substitutedFrom: "perplexity:perplexity/sonar", rawResponse: undefined } as any;
      return r;
    });
    await executeOrdinaryRun(args(false));
    expect(phase0Events()[0][1]).toMatchObject({ provider: "deepseek", eligible: false, ineligibilityReason: "substituted" });
  });

  it("no Perplexity slot → no event", async () => {
    countersFlag = true;
    mockedRunPanel.mockImplementation(async () => [panelResults()[0], { ...panelResults()[0], modelId: "chatgpt", provider: "openai" }]);
    await executeOrdinaryRun({ ...args(false), selectedModels: ["claude", "chatgpt"] as any });
    expect(phase0Events()).toHaveLength(0);
  });

  it("an observer failure is contained: no throw, response unchanged", async () => {
    countersFlag = true;
    const spy = jest.spyOn(observationModule, "observeProviderSearchEvidence").mockImplementation(() => {
      throw new Error("boom https://leak.example");
    });
    const result = await executeOrdinaryRun(args(false));
    expect(result.status).toBe(200);
    expect(phase0Events()).toHaveLength(0);
    spy.mockRestore();
  });
});

describe("no side effects", () => {
  async function run(flag: boolean, adaptive: boolean) {
    jest.clearAllMocks();
    firestoreCalls.length = 0;
    countersFlag = flag;
    const result = await executeOrdinaryRun(args(adaptive));
    return { body: JSON.stringify(result), writes: [...firestoreCalls] };
  }

  it.each([[false], [true]])("adaptive=%p: identical response body and identical Firestore call sequence with the flag on vs off; rawResponse stays stripped", async (adaptive) => {
    const off = await run(false, adaptive);
    const on = await run(true, adaptive);
    expect(on.body).toBe(off.body);
    expect(on.writes).toEqual(off.writes);
    expect(on.body).not.toContain("rawResponse");
    expect(on.body).not.toContain("search_results");
  });

  it("the observer never mutates the panel results it reads (deep-frozen inputs, event still emitted)", async () => {
    countersFlag = true;
    const deepFreeze = (o: any): any => {
      if (o && typeof o === "object" && !Object.isFrozen(o)) {
        Object.freeze(o);
        Object.values(o).forEach(deepFreeze);
      }
      return o;
    };
    mockedRunPanel.mockImplementation(async () => {
      const r = panelResults();
      deepFreeze(r[1].rawResponse);
      return r;
    });
    const result = await executeOrdinaryRun(args(false));
    expect(result.status).toBe(200);
    expect(phase0Events()).toHaveLength(1);
    expect(phase0Events()[0][1]).toMatchObject({ resultEntries: 3, eligible: true });
});
});
