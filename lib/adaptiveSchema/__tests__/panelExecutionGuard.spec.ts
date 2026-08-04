/**
 * Query-Routing Redesign, Milestone 1.5 — server-side execution guard.
 *
 * Proves the thing Milestone 1 didn't: that a handoff, disabled, or
 * clarification-required classification never reaches the model panel at
 * all. planAdaptiveRun() is the function app/api/run-panel/route.ts calls
 * before runPanel() — its `promptOverrides` being empty for a non-active
 * routing decision IS the proof that zero models would be invoked, since
 * route.ts's guard (`if (adaptivePlan.routing.kind !== "active") return
 * buildNonExecutionPayload(...)`) returns before runPanel() ever sees
 * those overrides.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { planAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { routeClassifiedQuery } from "@/lib/adaptiveSchema/routeClassifiedQuery";
import { buildNonExecutionPayload } from "@/lib/adaptiveSchema/orchestrate";
import { QueryType } from "@/lib/adaptiveSchema/types";

function mockClassification(overrides: Record<string, any>) {
  return JSON.stringify({
    domain: "test",
    answerShape: "generic_sections",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "get_answer",
    confidence: 0.9,
    riskLevel: "professional",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "cross_model_consistency",
    requestedCount: null,
    requiresClarification: false,
    clarificationQuestion: null,
    rationale: "test fixture",
    ...overrides,
  });
}

function mockGeminiOnce(queryType: QueryType, overrides: Record<string, any> = {}) {
  mockedCallGemini.mockResolvedValueOnce({
    modelId: "gemini",
    status: "ok",
    rawText: mockClassification({ queryType, ...overrides }),
    latencyMs: 5,
  });
}

const MODELS = ["chatgpt", "claude", "grok"] as any[];

describe("planAdaptiveRun — non-active routing invokes zero models", () => {
  afterEach(() => jest.clearAllMocks());

  it("Claim Verification handoff: promptOverrides is empty for every selected model", async () => {
    mockGeminiOnce("claim_verification");
    const plan = await planAdaptiveRun("The unemployment rate is 4.2%. Is this true?", MODELS, null);
    expect(plan.routing.kind).toBe("handoff");
    expect(Object.keys(plan.promptOverrides)).toHaveLength(0);
  });

  it("Video Verification handoff: promptOverrides is empty for every selected model", async () => {
    mockGeminiOnce("media_authenticity_review");
    const plan = await planAdaptiveRun("Is this viral clip manipulated?", MODELS, null);
    expect(plan.routing.kind).toBe("handoff");
    expect(Object.keys(plan.promptOverrides)).toHaveLength(0);
  });

  it("disabled document_qa: promptOverrides is empty for every selected model", async () => {
    mockGeminiOnce("document_qa");
    const plan = await planAdaptiveRun("What does this contract say about termination?", MODELS, null);
    expect(plan.routing.kind).toBe("disabled");
    expect(Object.keys(plan.promptOverrides)).toHaveLength(0);
  });

  it("disabled current_live_information: promptOverrides is empty for every selected model", async () => {
    mockGeminiOnce("current_live_information");
    const plan = await planAdaptiveRun("What happened in AI today?", MODELS, null);
    expect(plan.routing.kind).toBe("disabled");
    expect(Object.keys(plan.promptOverrides)).toHaveLength(0);
  });

  it("clarification-required graceful_limitation: promptOverrides is empty for every selected model", async () => {
    mockGeminiOnce("graceful_limitation", { requiresClarification: true, clarificationQuestion: "Which jurisdiction?" });
    const plan = await planAdaptiveRun("What laws apply to me?", MODELS, null);
    expect(plan.routing.kind).toBe("clarification");
    expect(Object.keys(plan.promptOverrides)).toHaveLength(0);
  });

  it("unanswerable graceful_limitation (no clarification): promptOverrides is empty for every selected model", async () => {
    mockGeminiOnce("graceful_limitation", { requiresClarification: false });
    const plan = await planAdaptiveRun("List every AI company in the world.", MODELS, null);
    expect(plan.routing.kind).toBe("unanswerable");
    expect(Object.keys(plan.promptOverrides)).toHaveLength(0);
  });
});

describe("planAdaptiveRun — active schemas still invoke the normal panel path", () => {
  afterEach(() => jest.clearAllMocks());

  it("active factual_lookup: promptOverrides has one entry per selected model", async () => {
    mockGeminiOnce("factual_lookup");
    const plan = await planAdaptiveRun("What is the capital of Kenya?", MODELS, null);
    expect(plan.routing.kind).toBe("active");
    expect(Object.keys(plan.promptOverrides).sort()).toEqual([...MODELS].sort());
    for (const modelId of MODELS) {
      expect(plan.promptOverrides[modelId]).toBeTruthy();
    }
  });

  it("active procedural (a pre-existing schema): behaves exactly as before — full promptOverrides, unchanged schema", async () => {
    mockGeminiOnce("procedural");
    const plan = await planAdaptiveRun("How do I open a brokerage account?", MODELS, null);
    expect(plan.routing.kind).toBe("active");
    expect(plan.schema.id).toBe("procedural");
    expect(Object.keys(plan.promptOverrides)).toHaveLength(MODELS.length);
  });
});

describe("Client and server derive the same routing decision (no divergence possible)", () => {
  afterEach(() => jest.clearAllMocks());

  it.each<[string, QueryType, Record<string, any>]>([
    ["claim_verification", "claim_verification", {}],
    ["media_authenticity_review", "media_authenticity_review", {}],
    ["document_qa", "document_qa", {}],
    ["factual_lookup", "factual_lookup", {}],
    ["graceful_limitation (clarification)", "graceful_limitation", { requiresClarification: true, clarificationQuestion: "?" }],
  ])("%s: planAdaptiveRun's stored routing matches calling routeClassifiedQuery directly on the same classification", async (label, queryType, overrides) => {
    mockGeminiOnce(queryType, overrides);
    // Question text must be unique per case — classifyQuery's LRU cache is
    // keyed by normalized query text and persists across tests in this
    // file; a repeated literal here would silently reuse an earlier case's
    // cached classification instead of consuming this case's own mock.
    const plan = await planAdaptiveRun(`some question about ${label}`, MODELS, null);
    const independentlyRouted = routeClassifiedQuery(plan.classification);
    expect(plan.routing.kind).toBe(independentlyRouted.kind);
  });
});

describe("buildNonExecutionPayload — persistence shape", () => {
  afterEach(() => jest.clearAllMocks());

  it("reports zero models invoked and zero tokens used for a handoff", async () => {
    mockGeminiOnce("claim_verification");
    const plan = await planAdaptiveRun("Is this true?", MODELS, null);
    if (plan.routing.kind === "active") throw new Error("unreachable");
    const payload = buildNonExecutionPayload(plan.classification, plan.routing);
    expect(payload.adaptive.modelsInvoked).toBe(0);
    expect(payload.adaptive.tokensUsed).toBe(0);
    expect(payload.adaptive.executionStatus).toBe("not_started");
    expect(payload.results).toEqual([]);
    expect(payload.runId).toBeNull();
  });

  it("never carries consensus/certainty/gate/verdict fields — no model was called", async () => {
    mockGeminiOnce("document_qa");
    const plan = await planAdaptiveRun("What does the contract say?", MODELS, null);
    if (plan.routing.kind === "active") throw new Error("unreachable");
    const payload = buildNonExecutionPayload(plan.classification, plan.routing);
    expect(payload.adaptive).not.toHaveProperty("gate");
    expect(payload.adaptive).not.toHaveProperty("synthesisReport");
    expect(payload.adaptive).not.toHaveProperty("trustSummary");
    expect(payload.adaptive).not.toHaveProperty("alignedClaims");
  });

  it.each<["handoff" | "disabled" | "clarification" | "unanswerable" | "invalid", string]>([
    ["handoff", "handoff"],
    ["disabled", "capability_gap"],
    ["clarification", "clarification_required"],
    ["unanswerable", "unanswerable"],
  ])("maps RoutedQuery kind '%s' to routingOutcome '%s' via the single centralized mapping", async (kind, expectedOutcome) => {
    const queryTypeByKind: Record<string, QueryType> = {
      handoff: "claim_verification",
      disabled: "document_qa",
      clarification: "graceful_limitation",
      unanswerable: "graceful_limitation",
    };
    const overridesByKind: Record<string, Record<string, any>> = {
      clarification: { requiresClarification: true, clarificationQuestion: "?" },
    };
    mockGeminiOnce(queryTypeByKind[kind], overridesByKind[kind] ?? {});
    // Unique text per case — see the caching note in the describe block above.
    const plan = await planAdaptiveRun(`question for routing outcome ${kind}`, MODELS, null);
    expect(plan.routing.kind).toBe(kind);
    if (plan.routing.kind === "active") throw new Error("unreachable");
    const payload = buildNonExecutionPayload(plan.classification, plan.routing);
    expect(payload.adaptive.routingOutcome).toBe(expectedOutcome);
  });

  it("throws (fails safe) rather than build a nonsensical payload if ever called with an active routing decision", async () => {
    mockGeminiOnce("factual_lookup");
    const plan = await planAdaptiveRun("What is the capital of Kenya?", MODELS, null);
    expect(() => buildNonExecutionPayload(plan.classification, plan.routing)).toThrow();
  });
});
