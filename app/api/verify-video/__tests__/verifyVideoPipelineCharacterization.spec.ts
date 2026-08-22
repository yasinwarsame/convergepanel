/**
 * Phase 8C-E.3.1A — full-pipeline characterization test for
 * `POST /api/verify-video`. Zero permanent behavioral coverage existed for
 * this route before this suite — the pre-existing
 * `verifyVideoAuthRegression.spec.ts` deliberately stops at the rate-limit
 * gate and never reaches dedup, entitlement/quota, vision-model dispatch,
 * persistence, governance, or either usage counter (confirmed by the 8C-E.3.0
 * audit). This suite exercises the real, unmodified route end to end,
 * mocking only true external boundaries (auth, rate limiter, entitlement
 * lookup, Firestore/adminDb, the three vision-provider callers, usage
 * helpers, token accounting, governance, logger) so every assertion below
 * reflects genuine current production behavior, including quirks this phase
 * is explicitly forbidden from correcting.
 *
 * TESTS ONLY — see docs/... (8C-E.3.0 report) for why this precedes any
 * mechanical extraction.
 */

// ============================================================
// Auth (mirrors verifyVideoAuthRegression.spec.ts's own proven pattern —
// the Personal route calls resolveRequestIdentity(), which itself calls
// verifySessionCookie()/verifyIdToken() under the hood).
// ============================================================
const mockVerifySessionCookie = jest.fn();
const mockVerifyIdToken = jest.fn();
jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookie: (...args: unknown[]) => mockVerifySessionCookie(...args),
}));
jest.mock("@/lib/firebase/auth", () => ({
  verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));

// ============================================================
// Rate limiter (dynamically imported by the route; jest.mock still
// intercepts the dynamic import, same proven technique as the Claim spec).
// ============================================================
const mockCheckRateLimit = jest.fn();
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

// ============================================================
// Entitlement lookup.
// ============================================================
const mockGetEffectiveEntitlements = jest.fn();
jest.mock("@/lib/admin/entitlements", () => ({
  getEffectiveEntitlements: (...args: unknown[]) => mockGetEffectiveEntitlements(...args),
}));

// ============================================================
// Vision-provider callers — the lowest external boundary, per instruction
// preference (mock providers, not the orchestration/aggregation around them).
// ============================================================
const mockCallOpenAIVision = jest.fn();
const mockCallClaudeVision = jest.fn();
const mockCallGeminiVision = jest.fn();
jest.mock("@/lib/video/visionCalls", () => ({
  callOpenAIVision: (...args: unknown[]) => mockCallOpenAIVision(...args),
  callClaudeVision: (...args: unknown[]) => mockCallClaudeVision(...args),
  callGeminiVision: (...args: unknown[]) => mockCallGeminiVision(...args),
}));

// ============================================================
// Usage helpers (dynamically imported by the route).
// ============================================================
const mockCheckUsageAllowanceForRun = jest.fn();
const mockCheckAndIncrementUsageForRun = jest.fn();
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkUsageAllowanceForRun: (...args: unknown[]) => mockCheckUsageAllowanceForRun(...args),
  checkAndIncrementUsageForRun: (...args: unknown[]) => mockCheckAndIncrementUsageForRun(...args),
}));

// ============================================================
// Token accounting.
// ============================================================
const mockIncrementUserTokenUsage = jest.fn();
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: (...args: unknown[]) => mockIncrementUserTokenUsage(...args),
}));

// ============================================================
// Governance.
// ============================================================
const mockEvaluateAndStoreGovernance = jest.fn();
jest.mock("@/lib/governance/evaluateAndStore", () => ({
  evaluateAndStoreGovernance: (...args: unknown[]) => mockEvaluateAndStoreGovernance(...args),
}));

// ============================================================
// Logger.
// ============================================================
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: {
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// ============================================================
// Firestore/adminDb — hand-rolled fake covering exactly the surface the
// route touches: users/{uid}.get(), videoVerifications dedup where().get(),
// videoVerifications/{id}.set(), failed_governance_audits.add(), and the
// video-counter runTransaction(get/set). No real Firestore engine — call
// arguments are asserted directly, mirroring how the existing Claim spec
// asserts on saveClaimVerification.mock.calls rather than building a fake
// transactional DB.
// ============================================================
const mockUsersDocGet = jest.fn();
const mockVideoDocSet = jest.fn();
const mockDedupWhereGet = jest.fn();
const mockFailedGovernanceAdd = jest.fn();
const mockTxnGet = jest.fn();
const mockTxnSet = jest.fn();
const mockRunTransaction = jest.fn(async (cb: (txn: { get: typeof mockTxnGet; set: typeof mockTxnSet }) => unknown) =>
  cb({ get: mockTxnGet, set: mockTxnSet })
);

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => {
      if (name === "users") {
        return { doc: (_id: string) => ({ get: mockUsersDocGet }) };
      }
      if (name === "videoVerifications") {
        return {
          doc: (id: string) => ({ set: (data: unknown) => mockVideoDocSet(id, data) }),
          where: () => ({ where: () => ({ get: mockDedupWhereGet }) }),
        };
      }
      if (name === "failed_governance_audits") {
        return { add: (...args: unknown[]) => mockFailedGovernanceAdd(...args) };
      }
      throw new Error(`verifyVideoPipelineCharacterization: unexpected collection "${name}"`);
    },
    runTransaction: (cb: (txn: { get: typeof mockTxnGet; set: typeof mockTxnSet }) => unknown) => mockRunTransaction(cb),
  },
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/verify-video/route";
import { getVideoLimit } from "@/lib/billing/planConfig";
// Deliberately the REAL, unmocked implementations — used only to prove the
// repairable-JSON fixture below genuinely requires the repair fallback,
// mirroring Phase 8C-E.1.2's methodology for Claim.
import { cleanJsonResponse, repairTruncatedJson } from "@/lib/verification/cleanJsonResponse";

const UID = "uid-1";

function nowMonthLabel(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fakeTimestamp(ms: number) {
  return { toMillis: () => ms, toDate: () => new Date(ms) };
}

function b64(n = 40): string {
  return Buffer.from("x".repeat(n)).toString("base64");
}

function buildFrame(overrides: Record<string, unknown> = {}) {
  return { base64: b64(), timestamp: 0, width: 640, height: 360, ...overrides };
}

function buildMetadata(overrides: Record<string, unknown> = {}) {
  return {
    duration: 10,
    width: 640,
    height: 360,
    fileSize: 1_000_000,
    fileName: "clip.mp4",
    fileType: "video/mp4",
    codec: "h264",
    frameRate: 30,
    createdAt: "2026-08-01T00:00:00.000Z",
    encodingSoftware: "iPhone",
    hasAudio: true,
    cameraModel: "iPhone 16 Pro",
    ...overrides,
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    frames: [buildFrame()],
    metadata: buildMetadata(),
    warnings: [],
    ...overrides,
  };
}

function buildRequest(body: unknown, opts: { rawText?: string; contentType?: string } = {}): NextRequest {
  return new NextRequest("http://localhost/api/verify-video", {
    method: "POST",
    headers: { "Content-Type": opts.contentType ?? "application/json", Cookie: "__session=valid" },
    body: opts.rawText !== undefined ? opts.rawText : JSON.stringify(body),
  });
}

function providerJsonRow(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "authentic_captured",
    confidence: "high",
    contentType: "camera_footage",
    summary: "test summary",
    deceptionIndicators: [],
    visualIndicators: ["v1"],
    metadataIndicators: ["m1"],
    manipulationSignals: [],
    authenticitySignals: ["a1"],
    productionSignals: [],
    compressionNotes: [],
    limitations: [],
    reasoning: "test reasoning",
    ...overrides,
  };
}

function providerOk(overrides: Record<string, unknown> = {}, tokens = 100) {
  return { text: JSON.stringify(providerJsonRow(overrides)), tokens };
}

function setAllProvidersOk() {
  mockCallOpenAIVision.mockResolvedValue(providerOk({}, 100));
  mockCallClaudeVision.mockResolvedValue(providerOk({}, 100));
  mockCallGeminiVision.mockResolvedValue(providerOk({}, 100));
}

function resetToDefaults() {
  jest.clearAllMocks();

  mockVerifySessionCookie.mockResolvedValue({ uid: UID, isAdmin: false });
  mockVerifyIdToken.mockResolvedValue(null);

  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });

  mockGetEffectiveEntitlements.mockResolvedValue({
    planId: "full",
    source: "stripe",
    monthlyLimit: 150,
    maxModelsPerRun: 5,
  });

  mockUsersDocGet.mockResolvedValue({
    exists: true,
    data: () => ({ email: "user@example.com", usageMonth: nowMonthLabel(), videoRunsThisMonth: 0 }),
  });

  mockDedupWhereGet.mockResolvedValue({ docs: [] });
  mockVideoDocSet.mockResolvedValue(undefined);
  mockFailedGovernanceAdd.mockResolvedValue(undefined);

  mockTxnGet.mockResolvedValue({ data: () => ({ usageMonth: nowMonthLabel() }) });
  mockTxnSet.mockResolvedValue(undefined);
  mockRunTransaction.mockImplementation(async (cb: (txn: { get: typeof mockTxnGet; set: typeof mockTxnSet }) => unknown) =>
    cb({ get: mockTxnGet, set: mockTxnSet })
  );

  mockCheckUsageAllowanceForRun.mockResolvedValue({
    allowed: true,
    runsThisMonth: 1,
    maxRunsPerMonth: 150,
    maxModelsPerRun: 5,
    plan: "full",
    resetsAt: new Date(),
  });
  mockCheckAndIncrementUsageForRun.mockResolvedValue({
    allowed: true,
    runsThisMonth: 2,
    maxRunsPerMonth: 150,
    maxModelsPerRun: 5,
    plan: "full",
    resetsAt: new Date(),
  });

  mockIncrementUserTokenUsage.mockResolvedValue({ tokensUsedCurrentPeriod: 0, periodStart: new Date() });
  mockEvaluateAndStoreGovernance.mockResolvedValue({ governanceStatus: "approved" });

  setAllProvidersOk();
}

beforeEach(() => {
  resetToDefaults();
});

// ============================================================
// 1. NORMAL 3-MODEL SUCCESS
// ============================================================
describe("normal 3-model success", () => {
  it("200, all 3 providers dispatched, response shape complete, no Team fields", async () => {
    const res = await POST(buildRequest(validBody()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.verificationId).toBe("string");
    expect(body.verificationId.startsWith("vid-")).toBe(true);
    expect(body.verdict).toBe("authentic_captured");
    expect(body.contentType).toBe("camera_footage");
    expect(body.consensusScore).toBe(100);
    expect(body.confidenceLabel).toBe("High");
    expect(body.evidenceQuality).toBe("strong");
    expect(body.supportRatio).toBe(100);
    expect(body.metadata).toEqual(expect.objectContaining({ duration: 10, width: 640, height: 360 }));
    expect(body.metadataAnalysis).toEqual(expect.objectContaining({ flags: expect.any(Array), summary: expect.any(String) }));
    expect(body.modelEvidence).toHaveLength(3);
    expect(body.modelEvidence.map((m: any) => m.modelId)).toEqual(["chatgpt", "claude", "gemini"]);
    for (const row of body.modelEvidence) {
      expect(row.status).toBe("ok");
      expect(row.verdict).toBe("authentic_captured");
      expect(row.summary).toBe("test summary");
    }
    expect(body.agreementPoints).toEqual(expect.any(Array));
    expect(body.disagreementPoints).toEqual(expect.any(Array));
    expect(body.aggregateSummary).toEqual(
      expect.objectContaining({ totalModels: 3, modelsAuthenticCaptured: 3, modelsManipulated: 0 })
    );
    expect(body.frameCount).toBe(1);
    expect(body.warnings).toEqual([]);
    expect(typeof body.disclaimer).toBe("string");

    expect(body.workspaceId).toBeUndefined();
    expect(body.projectId).toBeUndefined();

    expect(mockCallOpenAIVision).toHaveBeenCalledTimes(1);
    expect(mockCallClaudeVision).toHaveBeenCalledTimes(1);
    expect(mockCallGeminiVision).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// 2. PERSISTED SUCCESS DOCUMENT
// ============================================================
describe("persisted success document", () => {
  it("videoVerifications/{vid-*} write contains exact expected fields, no Team fields", async () => {
    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(200);

    expect(mockVideoDocSet).toHaveBeenCalledTimes(1);
    const [docId, doc] = mockVideoDocSet.mock.calls[0];
    expect(docId).toMatch(/^vid-/);
    expect(doc).toEqual(
      expect.objectContaining({
        userId: UID,
        userEmail: "user@example.com",
        type: "video_verification",
        fileName: "clip.mp4",
        verdict: "authentic_captured",
        contentType: "camera_footage",
        consensusScore: 100,
        confidenceLabel: "High",
        evidenceQuality: "strong",
        supportRatio: 100,
        metadata: expect.objectContaining({ duration: 10, fileSize: 1_000_000 }),
        metadataAnalysis: expect.objectContaining({ flags: expect.any(Array), summary: expect.any(String) }),
        modelResults: expect.any(Array),
        agreementPoints: expect.any(Array),
        disagreementPoints: expect.any(Array),
        frameCount: 1,
        warnings: [],
        totalTokens: 300,
      })
    );
    expect(doc.modelResults).toHaveLength(3);
    expect(doc.timestamp).toBeTruthy(); // FieldValue.serverTimestamp() sentinel — not overfit to internals.
    expect(doc.workspaceId).toBeUndefined();
    expect(doc.projectId).toBeUndefined();
  });
});

// ============================================================
// 3. PROVIDER ORDER
// ============================================================
describe("provider dispatch order", () => {
  it("output order is fixed declaration order (chatgpt, claude, gemini) regardless of completion timing", async () => {
    mockCallGeminiVision.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(providerOk({ summary: "gemini" })), 5))
    );
    mockCallClaudeVision.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(providerOk({ summary: "claude" })), 15))
    );
    mockCallOpenAIVision.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(providerOk({ summary: "chatgpt" })), 25))
    );

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.modelEvidence.map((m: any) => m.modelId)).toEqual(["chatgpt", "claude", "gemini"]);
    expect(body.modelEvidence.map((m: any) => m.summary)).toEqual(["chatgpt", "claude", "gemini"]);
  });
});

// ============================================================
// 4. PARTIAL PROVIDER FAILURE
// ============================================================
describe("partial provider failure", () => {
  it("2/3 succeed, 1 fails -> request still succeeds, failed row normalized, artifact persisted", async () => {
    mockCallGeminiVision.mockRejectedValueOnce(new Error("gemini boom"));

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.verdict).toBe("authentic_captured"); // 2/2 usable -> 100% majority
    const geminiRow = body.modelEvidence.find((m: any) => m.modelId === "gemini");
    expect(geminiRow.status).toBe("error");
    expect(geminiRow.verdict).toBe("insufficient");
    expect(geminiRow.summary).toBe("Model failed: gemini boom");
    const chatgptRow = body.modelEvidence.find((m: any) => m.modelId === "chatgpt");
    expect(chatgptRow.status).toBe("ok");
    expect(mockVideoDocSet).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// 5. ALL PROVIDERS FAIL
// ============================================================
describe("all providers fail (0/3 usable)", () => {
  it("aggregateVerdict == insufficient, artifact still persists, ordinary success path", async () => {
    mockCallOpenAIVision.mockRejectedValueOnce(new Error("a"));
    mockCallClaudeVision.mockRejectedValueOnce(new Error("b"));
    mockCallGeminiVision.mockRejectedValueOnce(new Error("c"));

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.verdict).toBe("insufficient");
    expect(body.consensusScore).toBe(0);
    expect(body.supportRatio).toBe(0);
    expect(body.modelEvidence.every((m: any) => m.status === "error")).toBe(true);

    expect(mockVideoDocSet).toHaveBeenCalledTimes(1);
    expect(mockCheckAndIncrementUsageForRun).toHaveBeenCalledTimes(1);
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledWith(UID, 0);
  });
});

// ============================================================
// 6/7. REPAIRABLE / UNREPAIRABLE JSON
// ============================================================
describe("repairable truncated provider JSON", () => {
  it("fails first parse, repairTruncatedJson() fixes it, row becomes status ok (Phase 8C-E.1.2-style proof)", async () => {
    const truncated =
      '{"verdict": "authentic_captured", "confidence": "high", "contentType": "camera_footage", "summary": "This appears to be genuine footage with consistent lighting and natural motion includ';

    const cleaned = cleanJsonResponse(truncated);
    expect(() => JSON.parse(cleaned)).toThrow();
    const repaired = repairTruncatedJson(cleaned);
    const repairedParsed = JSON.parse(repaired);
    expect(repairedParsed).toEqual({
      verdict: "authentic_captured",
      confidence: "high",
      contentType: "camera_footage",
      summary: "This appears to be genuine footage with consistent lighting and natural motion includ",
    });

    mockCallClaudeVision.mockResolvedValueOnce({ text: truncated, tokens: 50 });

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    const claudeRow = body.modelEvidence.find((m: any) => m.modelId === "claude");
    expect(claudeRow.status).toBe("ok");
    expect(claudeRow.verdict).toBe("authentic_captured");
    expect(claudeRow.summary).toBe("This appears to be genuine footage with consistent lighting and natural motion includ");
    // Siblings unaffected / correctly ordered.
    expect(body.modelEvidence.map((m: any) => m.modelId)).toEqual(["chatgpt", "claude", "gemini"]);
  });
});

describe("unrepairable provider JSON", () => {
  it("fails first parse and repair -> status parse_error, request still succeeds", async () => {
    mockCallGeminiVision.mockResolvedValueOnce({ text: "not valid json {{{", tokens: 20 });

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    const geminiRow = body.modelEvidence.find((m: any) => m.modelId === "gemini");
    expect(geminiRow.status).toBe("parse_error");
    expect(geminiRow.verdict).toBe("insufficient");
    expect(geminiRow.summary).toBe("Model returned invalid JSON; could not parse verification result.");
  });
});

// ============================================================
// 8-11. DEDUP
// ============================================================
describe("dedup hit", () => {
  it("returns cached artifact, zero provider calls, zero accounting, zero new persistence", async () => {
    const existingId = "vid-existing-1";
    mockDedupWhereGet.mockResolvedValueOnce({
      docs: [
        {
          id: existingId,
          data: () => ({
            userId: UID,
            fileName: "clip.mp4",
            timestamp: fakeTimestamp(Date.now() - 5_000),
            metadata: buildMetadata(),
            verdict: "authentic_captured",
            contentType: "camera_footage",
            consensusScore: 90,
            confidenceLabel: "High",
            evidenceQuality: "strong",
            supportRatio: 100,
            metadataAnalysis: { flags: [], summary: "No notable metadata flags." },
            modelResults: [],
            agreementPoints: [],
            disagreementPoints: [],
            frameCount: 1,
            warnings: [],
          }),
        },
      ],
    });

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body._deduplicated).toBe(true);
    expect(body.verificationId).toBe(existingId);

    expect(mockCallOpenAIVision).not.toHaveBeenCalled();
    expect(mockCallClaudeVision).not.toHaveBeenCalled();
    expect(mockCallGeminiVision).not.toHaveBeenCalled();
    expect(mockCheckUsageAllowanceForRun).not.toHaveBeenCalled();
    expect(mockCheckAndIncrementUsageForRun).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
    expect(mockEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    expect(mockVideoDocSet).not.toHaveBeenCalled();
  });
});

describe("dedup newest-match selection", () => {
  it("with two matching docs, the newest (by timestamp) is the one returned", async () => {
    mockDedupWhereGet.mockResolvedValueOnce({
      docs: [
        {
          id: "vid-older",
          data: () => ({
            userId: UID,
            fileName: "clip.mp4",
            timestamp: fakeTimestamp(Date.now() - 20_000),
            metadata: buildMetadata(),
            verdict: "authentic_captured",
          }),
        },
        {
          id: "vid-newer",
          data: () => ({
            userId: UID,
            fileName: "clip.mp4",
            timestamp: fakeTimestamp(Date.now() - 3_000),
            metadata: buildMetadata(),
            verdict: "likely_manipulated",
          }),
        },
      ],
    });

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body._deduplicated).toBe(true);
    expect(body.verificationId).toBe("vid-newer");
  });

  it("MATERIAL FINDING: only the single newest doc's own criteria are ever checked — an older matching doc is never consulted if the newest doc fails the window/size/duration check", async () => {
    mockDedupWhereGet.mockResolvedValueOnce({
      docs: [
        {
          // Older doc WOULD match (recent, same size/duration) if it were checked.
          id: "vid-older-would-match",
          data: () => ({
            userId: UID,
            fileName: "clip.mp4",
            timestamp: fakeTimestamp(Date.now() - 10_000),
            metadata: buildMetadata(),
            verdict: "authentic_captured",
          }),
        },
        {
          // Newest doc, but fileSize mismatch -> the ONLY doc actually checked, and it fails.
          id: "vid-newest-mismatch",
          data: () => ({
            userId: UID,
            fileName: "clip.mp4",
            timestamp: fakeTimestamp(Date.now() - 1_000),
            metadata: buildMetadata({ fileSize: 999 }),
            verdict: "likely_manipulated",
          }),
        },
      ],
    });

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body._deduplicated).toBeUndefined(); // MISS, despite an older matching doc existing.
    expect(mockCallOpenAIVision).toHaveBeenCalledTimes(1);
  });
});

describe("dedup miss", () => {
  it("outside the 30s window -> miss, providers execute, new artifact persisted", async () => {
    mockDedupWhereGet.mockResolvedValueOnce({
      docs: [
        {
          id: "vid-old",
          data: () => ({
            userId: UID,
            fileName: "clip.mp4",
            timestamp: fakeTimestamp(Date.now() - 35_000),
            metadata: buildMetadata(),
          }),
        },
      ],
    });
    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body._deduplicated).toBeUndefined();
    expect(mockCallOpenAIVision).toHaveBeenCalledTimes(1);
    expect(mockVideoDocSet).toHaveBeenCalledTimes(1);
  });

  it("fileSize mismatch -> miss", async () => {
    mockDedupWhereGet.mockResolvedValueOnce({
      docs: [
        {
          id: "vid-diff-size",
          data: () => ({
            userId: UID,
            fileName: "clip.mp4",
            timestamp: fakeTimestamp(Date.now() - 5_000),
            metadata: buildMetadata({ fileSize: 42 }),
          }),
        },
      ],
    });
    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body._deduplicated).toBeUndefined();
    expect(mockCallOpenAIVision).toHaveBeenCalledTimes(1);
  });

  it("duration difference beyond 0.5s tolerance -> miss", async () => {
    mockDedupWhereGet.mockResolvedValueOnce({
      docs: [
        {
          id: "vid-diff-duration",
          data: () => ({
            userId: UID,
            fileName: "clip.mp4",
            timestamp: fakeTimestamp(Date.now() - 5_000),
            metadata: buildMetadata({ duration: 12 }),
          }),
        },
      ],
    });
    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body._deduplicated).toBeUndefined();
    expect(mockCallOpenAIVision).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// 15. FREE PLAN BLOCK
// ============================================================
describe("free plan block", () => {
  it("403 plan_required, no dedup, no models, no persistence, no usage increment", async () => {
    mockGetEffectiveEntitlements.mockResolvedValueOnce({ planId: "free", source: "free", monthlyLimit: 8, maxModelsPerRun: 2 });

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("plan_required");

    expect(mockDedupWhereGet).not.toHaveBeenCalled();
    expect(mockCallOpenAIVision).not.toHaveBeenCalled();
    expect(mockVideoDocSet).not.toHaveBeenCalled();
    expect(mockCheckUsageAllowanceForRun).not.toHaveBeenCalled();
  });
});

// ============================================================
// 16. VIDEO MONTHLY LIMIT
// ============================================================
describe("video monthly limit reached", () => {
  it("429 video_limit_reached, exact limit in message, no downstream work", async () => {
    const limit = getVideoLimit("full");
    mockUsersDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ email: "user@example.com", usageMonth: nowMonthLabel(), videoRunsThisMonth: limit }),
    });

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(429);
    expect(body.error.code).toBe("video_limit_reached");
    expect(body.error.message).toContain(String(limit));

    expect(mockDedupWhereGet).not.toHaveBeenCalled();
    expect(mockCallOpenAIVision).not.toHaveBeenCalled();
    expect(mockVideoDocSet).not.toHaveBeenCalled();
  });
});

// ============================================================
// 17. GENERIC USAGE PRECHECK DENIAL
// ============================================================
describe("generic usage precheck denial", () => {
  it("RUN_LIMIT precheck denial -> 429, no models, no persistence, no downstream accounting", async () => {
    mockCheckUsageAllowanceForRun.mockResolvedValueOnce({
      allowed: false,
      reason: "RUN_LIMIT",
      runsThisMonth: 150,
      maxRunsPerMonth: 150,
      maxModelsPerRun: 5,
      plan: "full",
      resetsAt: new Date(),
    });

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(429);
    expect(body.error.code).toBe("run_limit_reached");

    expect(mockCallOpenAIVision).not.toHaveBeenCalled();
    expect(mockVideoDocSet).not.toHaveBeenCalled();
    expect(mockCheckAndIncrementUsageForRun).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
  });
});

// ============================================================
// 18. STORAGE FAILURE
// ============================================================
describe("storage failure", () => {
  it("500 storage_failed; providers DID execute; no downstream accounting/governance runs", async () => {
    mockVideoDocSet.mockRejectedValueOnce(new Error("firestore down"));

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("storage_failed");
    expect(body.error.message).toMatch(/not charged/i);

    expect(mockCallOpenAIVision).toHaveBeenCalledTimes(1);
    expect(mockCallClaudeVision).toHaveBeenCalledTimes(1);
    expect(mockCallGeminiVision).toHaveBeenCalledTimes(1);

    expect(mockCheckAndIncrementUsageForRun).not.toHaveBeenCalled();
    expect(mockEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
  });
});

// ============================================================
// 19/20. POST-WRITE GENERIC USAGE DENIAL / THROW
// ============================================================
describe("post-write generic usage denial (return value)", () => {
  it("artifact remains, response still succeeds, governance/video-counter/tokens still run", async () => {
    mockCheckAndIncrementUsageForRun.mockResolvedValueOnce({
      allowed: false,
      reason: "RUN_LIMIT",
      runsThisMonth: 150,
      maxRunsPerMonth: 150,
      maxModelsPerRun: 5,
      plan: "full",
      resetsAt: new Date(),
    });

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    expect(mockVideoDocSet).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(mockEvaluateAndStoreGovernance).toHaveBeenCalledTimes(1);
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
  });
});

describe("post-write generic usage THROW (distinct from denial — no top-level try/catch wraps this call)", () => {
  it("MATERIAL FINDING: a thrown exception here propagates uncaught out of POST(); artifact is already persisted by that point", async () => {
    mockCheckAndIncrementUsageForRun.mockRejectedValueOnce(new Error("transient firestore error"));

    await expect(POST(buildRequest(validBody()))).rejects.toThrow("transient firestore error");

    // The write already happened before the throw — this is real, current behavior.
    expect(mockVideoDocSet).toHaveBeenCalledTimes(1);
    // Nothing after the throw point ran.
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
  });
});

// ============================================================
// 21/22. GOVERNANCE
// ============================================================
describe("governance success", () => {
  it("evaluateAndStoreGovernance invoked with collection/runId/expected input shape", async () => {
    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(200);
    expect(mockEvaluateAndStoreGovernance).toHaveBeenCalledTimes(1);
    const [arg] = mockEvaluateAndStoreGovernance.mock.calls[0];
    expect(arg.collection).toBe("videoVerifications");
    expect(arg.runId).toMatch(/^vid-/);
    expect(arg.ownerUid).toBe(UID);
    expect(arg.input).toEqual(
      expect.objectContaining({
        consensusScore: 100,
        evidenceQuality: "strong",
        sourceBacked: false,
        missingSourcesCount: 0,
        modelHealth: { ok: 3, substituted: 0, failed: 0 },
        runType: "verification",
        verificationVerdict: "confirmed",
      })
    );
  });
});

describe("governance failure", () => {
  it("logs, writes failed_governance_audits fallback, request still succeeds, downstream accounting still runs", async () => {
    mockEvaluateAndStoreGovernance.mockRejectedValueOnce(new Error("governance down"));

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    expect(mockLoggerError).toHaveBeenCalled();
    expect(mockFailedGovernanceAdd).toHaveBeenCalledTimes(1);
    const [auditArg] = mockFailedGovernanceAdd.mock.calls[0];
    expect(auditArg).toEqual(
      expect.objectContaining({ collection: "videoVerifications", ownerUid: UID, error: "governance down" })
    );

    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
  });

  it("fallback audit write ALSO failing is swallowed — never escapes, response still succeeds", async () => {
    mockEvaluateAndStoreGovernance.mockRejectedValueOnce(new Error("governance down"));
    mockFailedGovernanceAdd.mockRejectedValueOnce(new Error("audit write down too"));

    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(200);
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// 23/24. VIDEO USAGE COUNTER
// ============================================================
describe("video usage counter success", () => {
  it("runTransaction invoked after persistence, using real usageMonth field", async () => {
    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(200);
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    expect(mockTxnGet).toHaveBeenCalledTimes(1);
    expect(mockTxnSet).toHaveBeenCalledTimes(1);
    const [ref, data, opts] = mockTxnSet.mock.calls[0];
    expect(ref).toBeDefined();
    expect(opts).toEqual({ merge: true });
    // Same calendar month as the seeded users doc -> increment branch, not the rollover-reset branch.
    expect(data).toEqual(
      expect.objectContaining({ updatedAt: expect.anything() })
    );
    expect("videoRunsThisMonth" in data).toBe(true);
  });

  it("month-rollover branch resets to usageMonth=now, videoRunsThisMonth=1", async () => {
    mockTxnGet.mockResolvedValueOnce({ data: () => ({ usageMonth: "2000-01" }) });
    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(200);
    const [, data] = mockTxnSet.mock.calls[0];
    expect(data.usageMonth).toBe(nowMonthLabel());
    expect(data.videoRunsThisMonth).toBe(1);
  });
});

describe("video usage counter failure", () => {
  it("best-effort/log-only — artifact remains, tokens still account, response still succeeds", async () => {
    mockRunTransaction.mockRejectedValueOnce(new Error("counter txn boom"));

    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockLoggerError).toHaveBeenCalled();
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// 25/26. TOKEN ACCOUNTING
// ============================================================
describe("token accounting success", () => {
  it("incrementUserTokenUsage called once with real aggregate totalTokens, no double count", async () => {
    mockCallOpenAIVision.mockResolvedValue(providerOk({}, 111));
    mockCallClaudeVision.mockResolvedValue(providerOk({}, 222));
    mockCallGeminiVision.mockResolvedValue(providerOk({}, 333));

    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(200);
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledWith(UID, 666);
  });
});

describe("token accounting failure", () => {
  it("best-effort/log-only — response still succeeds", async () => {
    mockIncrementUserTokenUsage.mockRejectedValueOnce(new Error("token boom"));
    const res = await POST(buildRequest(validBody()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalled();
  });
});

// ============================================================
// 27. VALIDATION
// ============================================================
describe("body / validation", () => {
  it("empty body -> 400 invalid_request", async () => {
    const res = await POST(buildRequest(undefined, { rawText: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  it("multipart/form-data -> 400 invalid_request", async () => {
    const res = await POST(buildRequest(undefined, { rawText: "--boundary\r\n", contentType: "multipart/form-data; boundary=x" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  it("invalid JSON -> 400 invalid_request", async () => {
    const res = await POST(buildRequest(undefined, { rawText: "{not json" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  it("body not an object (JSON primitive) -> 400 invalid_request", async () => {
    const res = await POST(buildRequest(undefined, { rawText: "42" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  it("missing frames -> 400 no_frames", async () => {
    const res = await POST(buildRequest({ metadata: buildMetadata() }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("no_frames");
  });

  it("0 frames -> 400 no_frames", async () => {
    const res = await POST(buildRequest(validBody({ frames: [] })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("no_frames");
  });

  it("> 15 frames -> 400 too_many_frames", async () => {
    const res = await POST(buildRequest(validBody({ frames: Array.from({ length: 16 }, () => buildFrame()) })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("too_many_frames");
  });

  it("missing metadata -> 400 invalid_metadata", async () => {
    const res = await POST(buildRequest({ frames: [buildFrame()] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_metadata");
  });

  it("duration <= 0 -> 400 invalid_metadata", async () => {
    const res = await POST(buildRequest(validBody({ metadata: buildMetadata({ duration: 0 }) })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_metadata");
  });

  it("duration > 60 -> 400 invalid_metadata", async () => {
    const res = await POST(buildRequest(validBody({ metadata: buildMetadata({ duration: 61 }) })));
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.error.code).toBe("invalid_metadata");
    expect(b.error.message).toMatch(/60 seconds/);
  });

  it("fileSize > 50MB -> 400 file_too_large", async () => {
    const res = await POST(buildRequest(validBody({ metadata: buildMetadata({ fileSize: 51 * 1024 * 1024 }) })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("file_too_large");
  });

  it("per-frame oversized base64 -> 400 frame_too_large", async () => {
    const res = await POST(buildRequest(validBody({ frames: [buildFrame({ base64: "a".repeat(900_001) })] })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("frame_too_large");
  });

  it("aggregate base64 payload > 12MB -> 413 payload_too_large", async () => {
    const frames = Array.from({ length: 14 }, () => buildFrame({ base64: "a".repeat(900_000) }));
    const res = await POST(buildRequest(validBody({ frames })));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
  }, 15_000);
});

// ============================================================
// 28. DATA-URL FRAME NORMALIZATION
// ============================================================
describe("data-url frame normalization", () => {
  it("data: URL prefix is stripped before provider dispatch", async () => {
    const raw = b64();
    const res = await POST(buildRequest(validBody({ frames: [buildFrame({ base64: `data:image/jpeg;base64,${raw}` })] })));
    expect(res.status).toBe(200);
    const [, framesArg] = mockCallOpenAIVision.mock.calls[0];
    expect(framesArg[0].base64).toBe(raw);
  });
});

// ============================================================
// 29. UNKNOWN FIELDS
// ============================================================
describe("unknown top-level fields (Personal-only behavior — do not harden)", () => {
  it("unknown fields are silently ignored, request still succeeds", async () => {
    const res = await POST(buildRequest(validBody({ someUnexpectedField: "ignored" })));
    expect(res.status).toBe(200);
  });
});
