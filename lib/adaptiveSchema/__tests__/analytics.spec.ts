/**
 * Query-Routing Redesign, Milestone 1.5 — analytics events.
 *
 * Six distinct events, never carrying raw question/claim text — only
 * classification metadata. A PostHog outage must never throw or block.
 */

jest.mock("@/lib/posthog-server", () => ({
  getPostHogClient: jest.fn(),
}));

import { getPostHogClient } from "@/lib/posthog-server";
import {
  trackQueryClassified,
  trackRoutingOutcome,
  trackPanelExecutionStarted,
  trackPanelExecutionCompleted,
  trackPanelExecutionFailed,
} from "@/lib/adaptiveSchema/analytics";
import { QueryClassification } from "@/lib/adaptiveSchema/types";
import { RoutedQuery } from "@/lib/adaptiveSchema/routeClassifiedQuery";

const mockedGetClient = getPostHogClient as jest.MockedFunction<typeof getPostHogClient>;

function classification(overrides: Partial<QueryClassification> = {}): QueryClassification {
  return {
    queryType: "factual_lookup",
    domain: "test",
    answerShape: "direct_answer",
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
    rationale: "This is a private research question that must never reach analytics.",
    ...overrides,
  };
}

describe("query_classified", () => {
  afterEach(() => jest.clearAllMocks());

  it("captures queryType/riskLevel metadata, never the rationale or any question text", () => {
    const capture = jest.fn();
    const flush = jest.fn().mockResolvedValue(undefined);
    mockedGetClient.mockReturnValue({ capture, flush } as any);

    trackQueryClassified("uid-1", classification());

    expect(capture).toHaveBeenCalledTimes(1);
    const call = capture.mock.calls[0][0];
    expect(call.event).toBe("query_classified");
    expect(call.distinctId).toBe("uid-1");
    expect(call.properties.queryType).toBe("factual_lookup");
    expect(call.properties.riskLevel).toBe("professional");
    expect(JSON.stringify(call.properties)).not.toMatch(/private research question/);
  });

  it("never throws when PostHog is unavailable", () => {
    mockedGetClient.mockImplementation(() => {
      throw new Error("NEXT_PUBLIC_POSTHOG_KEY is not set");
    });
    expect(() => trackQueryClassified("uid-1", classification())).not.toThrow();
  });
});

describe("trackRoutingOutcome — one event per non-active kind", () => {
  afterEach(() => jest.clearAllMocks());

  function setupCapture() {
    const capture = jest.fn();
    const flush = jest.fn().mockResolvedValue(undefined);
    mockedGetClient.mockReturnValue({ capture, flush } as any);
    return capture;
  }

  it("handoff -> query_handoff_shown, with handoffTarget", () => {
    const capture = setupCapture();
    const routing: RoutedQuery = {
      kind: "handoff",
      queryType: "claim_verification",
      handoffTarget: "claim_verification",
      response: {} as any,
    };
    trackRoutingOutcome("uid-1", classification({ queryType: "claim_verification" }), routing);
    expect(capture.mock.calls[0][0].event).toBe("query_handoff_shown");
    expect(capture.mock.calls[0][0].properties.handoffTarget).toBe("claim_verification");
  });

  it("disabled -> query_capability_blocked, with capabilityReason", () => {
    const capture = setupCapture();
    const routing: RoutedQuery = {
      kind: "disabled",
      queryType: "document_qa",
      capabilityReason: "no page-reference tracking",
      response: {} as any,
    };
    trackRoutingOutcome("uid-1", classification({ queryType: "document_qa" }), routing);
    expect(capture.mock.calls[0][0].event).toBe("query_capability_blocked");
    expect(capture.mock.calls[0][0].properties.capabilityReason).toBe("no page-reference tracking");
  });

  it("clarification -> query_clarification_requested", () => {
    const capture = setupCapture();
    const routing: RoutedQuery = {
      kind: "clarification",
      queryType: "graceful_limitation",
      question: "Which jurisdiction?",
      response: {} as any,
    };
    trackRoutingOutcome("uid-1", classification({ queryType: "graceful_limitation" }), routing);
    expect(capture.mock.calls[0][0].event).toBe("query_clarification_requested");
  });

  it("unanswerable -> query_capability_blocked", () => {
    const capture = setupCapture();
    const routing: RoutedQuery = { kind: "unanswerable", queryType: "graceful_limitation", response: {} as any };
    trackRoutingOutcome("uid-1", classification({ queryType: "graceful_limitation" }), routing);
    expect(capture.mock.calls[0][0].event).toBe("query_capability_blocked");
  });

  it("never throws when PostHog is unavailable", () => {
    mockedGetClient.mockImplementation(() => {
      throw new Error("down");
    });
    const routing: RoutedQuery = {
      kind: "handoff",
      queryType: "claim_verification",
      handoffTarget: "claim_verification",
      response: {} as any,
    };
    expect(() => trackRoutingOutcome("uid-1", classification(), routing)).not.toThrow();
  });
});

describe("panel_execution_started / panel_execution_completed / panel_execution_failed", () => {
  afterEach(() => jest.clearAllMocks());

  it("started fires with modelCount, completed fires with a full outcome (status/successfulModels/failedModels/totalTokens)", () => {
    const capture = jest.fn();
    const flush = jest.fn().mockResolvedValue(undefined);
    mockedGetClient.mockReturnValue({ capture, flush } as any);

    trackPanelExecutionStarted("uid-1", classification(), 3);
    trackPanelExecutionCompleted("uid-1", classification(), {
      status: "partial",
      successfulModels: 2,
      failedModels: 1,
      totalTokens: 1200,
    });

    expect(capture.mock.calls[0][0].event).toBe("panel_execution_started");
    expect(capture.mock.calls[0][0].properties.modelCount).toBe(3);
    expect(capture.mock.calls[1][0].event).toBe("panel_execution_completed");
    expect(capture.mock.calls[1][0].properties).toMatchObject({
      status: "partial",
      successfulModels: 2,
      failedModels: 1,
      totalTokens: 1200,
    });
  });

  it("every panel_execution_started has a matching terminal event — completed OR failed, never orphaned", () => {
    // Success path: started -> completed.
    const captureA = jest.fn();
    mockedGetClient.mockReturnValue({ capture: captureA, flush: jest.fn().mockResolvedValue(undefined) } as any);
    trackPanelExecutionStarted("uid-1", classification(), 2);
    trackPanelExecutionCompleted("uid-1", classification(), { status: "completed", successfulModels: 2, failedModels: 0, totalTokens: 500 });
    expect(captureA.mock.calls.map((c) => c[0].event)).toEqual(["panel_execution_started", "panel_execution_completed"]);

    // Orchestration-throw path: started -> failed (never silently just "started").
    const captureB = jest.fn();
    mockedGetClient.mockReturnValue({ capture: captureB, flush: jest.fn().mockResolvedValue(undefined) } as any);
    trackPanelExecutionStarted("uid-1", classification(), 2);
    trackPanelExecutionFailed("uid-1", classification(), "orchestration blew up");
    expect(captureB.mock.calls.map((c) => c[0].event)).toEqual(["panel_execution_started", "panel_execution_failed"]);
  });

  it("panel_execution_failed never throws when PostHog is unavailable", () => {
    mockedGetClient.mockImplementation(() => {
      throw new Error("down");
    });
    expect(() => trackPanelExecutionFailed("uid-1", classification(), "boom")).not.toThrow();
  });
});
