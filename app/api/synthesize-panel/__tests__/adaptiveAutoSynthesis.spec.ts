/**
 * Query-Routing Redesign, Phase 2A, Step 6 — blocker FIX enforcement.
 *
 * Originally documented a confirmed bug: /api/synthesize-panel had no
 * adaptive-awareness and would process a Milestone-2 adaptive run's
 * structured JSON output as ordinary prose, running legacy claims-matrix
 * synthesis and System A governance against it (see
 * docs/governance-decision-receipts-design.md §14.4/§16). This file now
 * enforces the fix: a defensive, server-side, durable-data-based guard
 * (checking `runs/{runId}.adaptiveOutput` directly, never a client-supplied
 * flag) rejects the request BEFORE any LLM call, claims extraction,
 * consensus scoring, run-document write, or governance call.
 *
 * Covers all four `parsePersistedAdaptiveOutput` outcomes:
 *   - valid      → reject (409 ADAPTIVE_RUN_NOT_SUPPORTED)
 *   - malformed  → reject (409 ADAPTIVE_RUN_INVALID) — NOT treated as legacy
 *   - unsupported_version → reject (409 ADAPTIVE_RUN_UNSUPPORTED_VERSION) — NOT treated as legacy
 *   - absent     → continue, legacy synthesis unchanged
 *
 * Only genuine externals are mocked: auth, rate limiting, Firestore, and
 * the OpenAI SDK. The adaptive-detection logic itself (parsePersistedAdaptiveOutput)
 * runs for real — this is exactly the condition being enforced, so it is
 * never mocked away.
 */

jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test-key",
  ANTHROPIC_API_KEY: "test-key",
}));

jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: jest.fn().mockResolvedValue({ uid: "test-uid" }),
}));
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: jest.fn(),
}));
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() }),
}));

// Minimal, real-shaped fake Firestore: `runs/{runId}` starts absent (cache
// miss) unless pre-seeded via runDocs.set(...) before a test; `.update()`/
// `.set()` resolve and mutate the same in-memory store, so writes are
// directly inspectable afterward; `users/{uid}` returns a fake profile.
// `readFailureRunIds` lets a single test force the run-document `.get()`
// to reject for one specific runId, without a module reset.
const runDocs = new Map<string, Record<string, unknown>>();
const readFailureRunIds = new Set<string>();
// Tracks how many times `.get()` was called for `runs/{runId}` — lets a
// test assert the route makes exactly one lookup attempt per request
// (no internal retry loop) rather than inferring it indirectly.
const runsGetCallCounts = new Map<string, number>();
const mockAdminDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: jest.fn().mockImplementation(async () => {
        if (name === "runs") {
          runsGetCallCounts.set(id, (runsGetCallCounts.get(id) || 0) + 1);
        }
        if (name === "runs" && readFailureRunIds.has(id)) {
          throw new Error("Firestore unavailable");
        }
        if (name === "users") {
          return { exists: true, data: () => ({ email: "user@example.com" }) };
        }
        const data = runDocs.get(id);
        return { exists: !!data, data: () => data };
      }),
      update: jest.fn().mockImplementation(async (fields: Record<string, unknown>) => {
        runDocs.set(id, { ...(runDocs.get(id) || {}), ...fields });
      }),
      set: jest.fn().mockImplementation(async (fields: Record<string, unknown>, opts?: { merge?: boolean }) => {
        const existing = opts?.merge ? runDocs.get(id) || {} : {};
        runDocs.set(id, { ...existing, ...fields });
      }),
      collection: () => ({
        add: jest.fn().mockResolvedValue({ id: "event-id" }),
      }),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: mockAdminDb,
}));

const mockedEvaluateAndStoreGovernance = jest.fn().mockResolvedValue({ governanceStatus: "approved" });
jest.mock("@/lib/governance/evaluateAndStore", () => ({
  evaluateAndStoreGovernance: (...args: unknown[]) => mockedEvaluateAndStoreGovernance(...args),
}));

const MINIMAL_VALID_SYNTHESIS = {
  executiveSummary: "Synthesis of the panel's decision-support responses.",
  keyFindings: [
    {
      claim: "The panel favors HubSpot on cost.",
      confidence: "Medium",
      evidenceRefs: [],
      modelsSupporting: ["chatgpt", "claude"],
    },
  ],
  disagreements: [],
  biasAndBlindSpots: [],
  openQuestions: [],
  methodology: "Cross-model comparison of structured decision_support outputs.",
};

const mockCreate = jest.fn().mockResolvedValue({
  choices: [{ message: { content: JSON.stringify(MINIMAL_VALID_SYNTHESIS) } }],
});
jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: (...args: unknown[]) => mockCreate(...args) } },
  }));
});
jest.mock("@anthropic-ai/sdk", () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn() },
  }));
});

import { NextRequest } from "next/server";
import { POST } from "@/app/api/synthesize-panel/route";

const ADAPTIVE_DECISION_SUPPORT_JSON = JSON.stringify({
  decisionQuestion: "Which CRM should we choose?",
  options: ["HubSpot", "Salesforce"],
  criteria: ["Total cost", "Ease of integration"],
  userProvidedCriteria: [],
  assessments: [],
  recommendationAction: "choose_option",
  recommendedOption: "HubSpot",
  recommendationRationale: "Lower cost fits the stated budget.",
  recommendationCaveats: [],
  assumptions: [],
});

const LEGACY_PROSE_TEXT = [
  "chatgpt: Based on the available data, HubSpot appears to be the stronger choice for a small team.",
  "It offers a lower total cost of ownership and simpler onboarding than Salesforce for teams under twenty seats.",
].join(" ");

function buildSynthesizeRequest(runId: string, resultsText: string) {
  return new NextRequest("http://localhost/api/synthesize-panel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId,
      question: "Which CRM should we choose?",
      results: [
        { modelId: "chatgpt", text: resultsText },
        { modelId: "claude", text: resultsText },
      ],
    }),
  });
}

// A real, structurally valid PersistedAdaptiveOutputV1 for decision_support
// — satisfies parsePersistedAdaptiveOutput's own structural checks exactly.
const VALID_ADAPTIVE_OUTPUT = {
  version: 1,
  schemaId: "decision_support",
  answerShape: "decision_support_view",
  classification: { queryType: "decision_support" },
  meta: {},
  result: {
    decisionQuestion: "Which CRM should we choose?",
    options: [{ id: "hubspot", label: "HubSpot" }],
    recommendation: { action: "choose_option", recommendedOptionId: "hubspot" },
    totalModels: 2,
  },
  generatedAt: "2026-07-29T00:00:00.000Z",
};

const EXISTING_GOVERNANCE_RECORD = {
  version: 1,
  schemaId: "decision_support",
  answerShape: "decision_support_view",
  adaptiveOutputVersion: 1,
  humanReview: { status: "unreviewed" },
  decisionReceipt: {
    conclusion: "Existing conclusion",
    basis: [],
    assumptions: [],
    uncertainties: [],
    limitations: [],
    sources: [],
    sourceBacked: false,
    humanReviewNeeded: false,
  },
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

describe("POST /api/synthesize-panel — adaptive run rejection (Step 6 fix)", () => {
  beforeEach(() => {
    runDocs.clear();
    mockedEvaluateAndStoreGovernance.mockClear();
    mockCreate.mockClear();
    runsGetCallCounts.clear();
  });

  describe("valid persisted adaptiveOutput — rejected", () => {
    const runId = "run-valid-adaptive";

    beforeEach(() => {
      runDocs.set(runId, { adaptiveOutput: VALID_ADAPTIVE_OUTPUT, governanceRecord: EXISTING_GOVERNANCE_RECORD });
    });

    it("returns a 409 rejection with the documented error code, not schema output or receipt content", async () => {
      const response = await POST(buildSynthesizeRequest(runId, ADAPTIVE_DECISION_SUPPORT_JSON));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.errorCode).toBe("ADAPTIVE_RUN_NOT_SUPPORTED");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("HubSpot");
      expect(serialized).not.toContain("Existing conclusion");
    });

    it("never calls OpenAI (no LLM call, no claims extraction)", async () => {
      await POST(buildSynthesizeRequest(runId, ADAPTIVE_DECISION_SUPPORT_JSON));
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("never calls evaluateAndStoreGovernance", async () => {
      await POST(buildSynthesizeRequest(runId, ADAPTIVE_DECISION_SUPPORT_JSON));
      expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    });

    it("never writes synthesizedStructuredReport or synthesisConsensusSummary", async () => {
      await POST(buildSynthesizeRequest(runId, ADAPTIVE_DECISION_SUPPORT_JSON));
      const stored = runDocs.get(runId);
      expect(stored?.synthesizedStructuredReport).toBeUndefined();
      expect(stored?.synthesisConsensusSummary).toBeUndefined();
      expect(stored?.schemaVersion).toBeUndefined();
    });

    it("never writes legacy governance fields (governanceStatus/Reasons/Meta)", async () => {
      await POST(buildSynthesizeRequest(runId, ADAPTIVE_DECISION_SUPPORT_JSON));
      const stored = runDocs.get(runId);
      expect(stored?.governanceStatus).toBeUndefined();
      expect(stored?.governanceReasons).toBeUndefined();
      expect(stored?.governanceMeta).toBeUndefined();
    });

    it("leaves adaptiveOutput completely unchanged", async () => {
      await POST(buildSynthesizeRequest(runId, ADAPTIVE_DECISION_SUPPORT_JSON));
      const stored = runDocs.get(runId);
      expect(stored?.adaptiveOutput).toEqual(VALID_ADAPTIVE_OUTPUT);
    });

    it("leaves governanceRecord completely unchanged", async () => {
      await POST(buildSynthesizeRequest(runId, ADAPTIVE_DECISION_SUPPORT_JSON));
      const stored = runDocs.get(runId);
      expect(stored?.governanceRecord).toEqual(EXISTING_GOVERNANCE_RECORD);
    });
  });

  describe("malformed adaptiveOutput marker — fails safe, NOT treated as legacy", () => {
    const runId = "run-malformed-adaptive";

    beforeEach(() => {
      runDocs.set(runId, { adaptiveOutput: { version: 1, schemaId: "not_a_real_schema" } });
    });

    it("returns a 409 rejection with ADAPTIVE_RUN_INVALID, not a legacy success", async () => {
      const response = await POST(buildSynthesizeRequest(runId, ADAPTIVE_DECISION_SUPPORT_JSON));
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.errorCode).toBe("ADAPTIVE_RUN_INVALID");
    });

    it("never calls OpenAI or governance for a malformed marker", async () => {
      await POST(buildSynthesizeRequest(runId, ADAPTIVE_DECISION_SUPPORT_JSON));
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    });
  });

  describe("unsupported adaptiveOutput version — fails safe, NOT treated as legacy", () => {
    const runId = "run-unsupported-version-adaptive";

    beforeEach(() => {
      runDocs.set(runId, { adaptiveOutput: { ...VALID_ADAPTIVE_OUTPUT, version: 2 } });
    });

    it("returns a 409 rejection with ADAPTIVE_RUN_UNSUPPORTED_VERSION, not a legacy success", async () => {
      const response = await POST(buildSynthesizeRequest(runId, ADAPTIVE_DECISION_SUPPORT_JSON));
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.errorCode).toBe("ADAPTIVE_RUN_UNSUPPORTED_VERSION");
    });

    it("never calls OpenAI or governance for an unsupported version", async () => {
      await POST(buildSynthesizeRequest(runId, ADAPTIVE_DECISION_SUPPORT_JSON));
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    });
  });

  describe("absent adaptiveOutput — legacy synthesis continues, unchanged", () => {
    it("a MISSING run (the document doesn't exist at all — a successful lookup that found nothing, not a lookup failure) still synthesizes successfully (200, ok:true)", async () => {
      const response = await POST(buildSynthesizeRequest("run-legacy-no-doc", LEGACY_PROSE_TEXT));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("a pre-existing run document with no adaptiveOutput field still synthesizes successfully", async () => {
      const runId = "run-legacy-existing-doc";
      runDocs.set(runId, { userId: "test-uid", question: "Which CRM should we choose?" });

      const response = await POST(buildSynthesizeRequest(runId, LEGACY_PROSE_TEXT));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it("still reaches evaluateAndStoreGovernance with runType 'research' for a genuinely legacy run — System A behavior for legacy runs is unchanged", async () => {
      await POST(buildSynthesizeRequest("run-legacy-governance", LEGACY_PROSE_TEXT));
      expect(mockedEvaluateAndStoreGovernance).toHaveBeenCalledTimes(1);
      const [callArgs] = mockedEvaluateAndStoreGovernance.mock.calls[0];
      expect(callArgs.collection).toBe("runs");
      expect(callArgs.input.runType).toBe("research");
    });

    it("still writes synthesizedStructuredReport and synthesisConsensusSummary for a genuinely legacy run", async () => {
      const runId = "run-legacy-writes";
      await POST(buildSynthesizeRequest(runId, LEGACY_PROSE_TEXT));
      const stored = runDocs.get(runId);
      expect(stored?.synthesizedStructuredReport).toBeDefined();
      expect(stored?.schemaVersion).toBe(1);
      expect(stored).toHaveProperty("synthesisConsensusSummary");
    });
  });

  describe("Firestore read failure for the run document — FAILS CLOSED (post-review correction)", () => {
    const runId = "run-read-error";

    afterEach(() => readFailureRunIds.delete(runId));

    it("returns a non-success response (503, RUN_LOOKUP_UNAVAILABLE) rather than continuing to legacy synthesis", async () => {
      readFailureRunIds.add(runId);

      const response = await POST(buildSynthesizeRequest(runId, LEGACY_PROSE_TEXT));
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.errorCode).toBe("RUN_LOOKUP_UNAVAILABLE");
    });

    it("never constructs or calls OpenAI", async () => {
      readFailureRunIds.add(runId);
      await POST(buildSynthesizeRequest(runId, LEGACY_PROSE_TEXT));
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("never calls evaluateAndStoreGovernance", async () => {
      readFailureRunIds.add(runId);
      await POST(buildSynthesizeRequest(runId, LEGACY_PROSE_TEXT));
      expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    });

    it("writes no synthesis fields and no legacy governance fields", async () => {
      readFailureRunIds.add(runId);
      await POST(buildSynthesizeRequest(runId, LEGACY_PROSE_TEXT));
      const stored = runDocs.get(runId);
      expect(stored?.synthesizedStructuredReport).toBeUndefined();
      expect(stored?.synthesisConsensusSummary).toBeUndefined();
      expect(stored?.schemaVersion).toBeUndefined();
      expect(stored?.governanceStatus).toBeUndefined();
      expect(stored?.governanceReasons).toBeUndefined();
      expect(stored?.governanceMeta).toBeUndefined();
    });

    it("leaves any pre-existing adaptiveOutput/governanceRecord on the run untouched", async () => {
      readFailureRunIds.add(runId);
      // Pre-seed the run with real adaptive + governance data. The read
      // itself will still throw (readFailureRunIds forces this
      // unconditionally), proving the fail-closed path never depends on
      // what the document actually contains — only on whether it could be
      // read at all.
      runDocs.set(runId, { adaptiveOutput: VALID_ADAPTIVE_OUTPUT, governanceRecord: EXISTING_GOVERNANCE_RECORD });

      await POST(buildSynthesizeRequest(runId, LEGACY_PROSE_TEXT));

      const stored = runDocs.get(runId);
      expect(stored?.adaptiveOutput).toEqual(VALID_ADAPTIVE_OUTPUT);
      expect(stored?.governanceRecord).toEqual(EXISTING_GOVERNANCE_RECORD);
    });

    it("does not expose Firestore error details in the response body", async () => {
      readFailureRunIds.add(runId);
      const response = await POST(buildSynthesizeRequest(runId, LEGACY_PROSE_TEXT));
      const body = await response.json();
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("Firestore unavailable");
      expect(serialized.toLowerCase()).not.toContain("firestore");
    });

    it("does not retry the lookup — .get() is called exactly once for this runId per request", async () => {
      readFailureRunIds.add(runId);
      await POST(buildSynthesizeRequest(runId, LEGACY_PROSE_TEXT));
      expect(runsGetCallCounts.get(runId)).toBe(1);
    });
  });
});
