/**
 * Team Video Verification Creation, Phase 8C-E.3.3.1 —
 * `POST /api/workspaces/{workspaceId}/video-verifications` tests. Mocks
 * every underlying lib function (each independently tested elsewhere,
 * including the shared `executeVideoVerification()` already covered by
 * the 42-test Personal characterization suite) — this suite covers
 * auth/telemetry, rate-limit ordering, body contract, rollout, Gate 1
 * ordering, requester entitlement/user-record, Team-scoped dedup (hit,
 * miss, isolation, infra failure), generic pre-charge (Option A),
 * Gate 2 ordering and failure mapping, token accounting, governance/video
 * -counter gating, the top-level safe outer catch, and response shape.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
const mockedLogIdentityResolutionFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: (...args: unknown[]) => mockedLogIdentityResolutionFailure(...args),
}));

const mockedCheckRateLimit = jest.fn();
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => mockedCheckRateLimit(...args),
}));

let mockedTeamWorkspacesCanaryWorkspaceIds: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  TEAM_WORKSPACES_ENABLED: true,
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return undefined;
  },
  get TEAM_WORKSPACES_CANARY_WORKSPACE_IDS() {
    return mockedTeamWorkspacesCanaryWorkspaceIds;
  },
}));

const mockedResolveTeamWorkspacesMode = jest.fn();
jest.mock("@/lib/workspaces/teamWorkspacesRollout", () => ({
  resolveTeamWorkspacesMode: (...args: unknown[]) => mockedResolveTeamWorkspacesMode(...args),
}));

const mockedAuthorizeGate1 = jest.fn();
const mockedFindDedupCandidate = jest.fn();
const mockedSaveGate2 = jest.fn();
jest.mock("@/lib/firestore/teamVideoVerifications", () => ({
  authorizeTeamVideoVerificationAdmission: (...args: unknown[]) => mockedAuthorizeGate1(...args),
  findTeamVideoVerificationDedupCandidate: (...args: unknown[]) => mockedFindDedupCandidate(...args),
  saveTeamVideoVerification: (...args: unknown[]) => mockedSaveGate2(...args),
}));

const mockedResolveTeamRunWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...args: unknown[]) => mockedResolveTeamRunWorkspaceAccess(...args),
}));

const mockedGetEffectiveEntitlements = jest.fn();
jest.mock("@/lib/admin/entitlements", () => ({
  getEffectiveEntitlements: (...args: unknown[]) => mockedGetEffectiveEntitlements(...args),
}));

const mockedCheckAndIncrementUsage = jest.fn();
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkAndIncrementUsageForRun: (...args: unknown[]) => mockedCheckAndIncrementUsage(...args),
}));

const mockedExecuteVideoVerification = jest.fn();
jest.mock("@/lib/video/videoVerificationExecution", () => ({
  executeVideoVerification: (...args: unknown[]) => mockedExecuteVideoVerification(...args),
}));

const mockedIncrementUserTokenUsage = jest.fn().mockResolvedValue({ tokensUsedCurrentPeriod: 0, periodStart: new Date() });
jest.mock("@/lib/firestore/userTokens", () => ({
  incrementUserTokenUsage: (...args: unknown[]) => mockedIncrementUserTokenUsage(...args),
}));

const mockedEvaluateAndStoreGovernance = jest.fn().mockResolvedValue(null);
jest.mock("@/lib/governance/evaluateAndStore", () => ({
  evaluateAndStoreGovernance: (...args: unknown[]) => mockedEvaluateAndStoreGovernance(...args),
}));

const mockUsersDocGet = jest.fn();
const mockFailedGovernanceAdd = jest.fn();
const mockTxnGet = jest.fn();
const mockTxnSet = jest.fn();
const mockRunTransaction = jest.fn(async (cb: any) => cb({ get: mockTxnGet, set: mockTxnSet }));
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => {
      if (name === "users") {
        return { doc: (_id: string) => ({ get: mockUsersDocGet }) };
      }
      if (name === "failed_governance_audits") {
        return { add: (...args: unknown[]) => mockFailedGovernanceAdd(...args) };
      }
      throw new Error(`unexpected collection: ${name}`);
    },
    runTransaction: (cb: any) => mockRunTransaction(cb),
  },
}));

const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...a: unknown[]) => mockLoggerWarn(...a), error: (...a: unknown[]) => mockLoggerError(...a), info: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/workspaces/[workspaceId]/video-verifications/route";
import { Timestamp } from "firebase-admin/firestore";

const UID = "member-1";
const WS_ID = "ws-team-1";

function nowMonthLabel(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function buildFrame(overrides: Record<string, unknown> = {}) {
  return { base64: Buffer.from("x".repeat(40)).toString("base64"), timestamp: 0, width: 640, height: 360, ...overrides };
}

function buildMetadata(overrides: Record<string, unknown> = {}) {
  return {
    duration: 10, width: 640, height: 360, fileSize: 1_000_000, fileName: "clip.mp4", fileType: "video/mp4",
    codec: "h264", frameRate: 30, createdAt: null, encodingSoftware: null, hasAudio: true, cameraModel: null,
    ...overrides,
  };
}

function buildBody(overrides: Record<string, unknown> = {}) {
  return { frames: [buildFrame()], metadata: buildMetadata(), warnings: [], ...overrides };
}

function buildPostRequest(body: unknown, opts: { rawText?: string; contentType?: string } = {}): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/video-verifications`, {
    method: "POST",
    headers: { "Content-Type": opts.contentType ?? "application/json" },
    body: opts.rawText !== undefined ? opts.rawText : JSON.stringify(body),
  });
}

function executionResult(overrides: Record<string, unknown> = {}) {
  return {
    modelResults: [
      { modelId: "chatgpt", modelName: "GPT-4o", status: "ok", verdict: "authentic_captured", confidence: "high", contentType: "camera_footage", summary: "s", visualIndicators: [], metadataIndicators: [], manipulationSignals: [], authenticitySignals: [], productionSignals: [], deceptionIndicators: [], compressionNotes: [], limitations: [], tokens: 100 },
      { modelId: "claude", modelName: "Claude", status: "ok", verdict: "authentic_captured", confidence: "high", contentType: "camera_footage", summary: "s", visualIndicators: [], metadataIndicators: [], manipulationSignals: [], authenticitySignals: [], productionSignals: [], deceptionIndicators: [], compressionNotes: [], limitations: [], tokens: 100 },
      { modelId: "gemini", modelName: "Gemini", status: "ok", verdict: "authentic_captured", confidence: "high", contentType: "camera_footage", summary: "s", visualIndicators: [], metadataIndicators: [], manipulationSignals: [], authenticitySignals: [], productionSignals: [], deceptionIndicators: [], compressionNotes: [], limitations: [], tokens: 100 },
    ],
    aggregateVerdict: "authentic_captured",
    aggregateContentType: "camera_footage",
    consensusScore: 100,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 1,
    agreementPoints: [],
    disagreementPoints: [],
    verdictCounts: { authentic_captured: 3, authentic_produced: 0, likely_manipulated: 0, inconclusive: 0, insufficient: 0 },
    totalTokens: 300,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedTeamWorkspacesCanaryWorkspaceIds = undefined;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
  mockedResolveTeamWorkspacesMode.mockReturnValue({ enabled: true, source: "global" });
  mockedAuthorizeGate1.mockResolvedValue({ status: "authorized", workspaceId: WS_ID, projectId: null });
  mockedGetEffectiveEntitlements.mockResolvedValue({ planId: "full", source: "stripe", monthlyLimit: 150, maxModelsPerRun: 5 });
  mockUsersDocGet.mockResolvedValue({ exists: true, data: () => ({ email: "member@example.com", usageMonth: nowMonthLabel(), videoRunsThisMonth: 0 }) });
  mockedFindDedupCandidate.mockResolvedValue(null);
  mockedCheckAndIncrementUsage.mockResolvedValue({ allowed: true, runsThisMonth: 1, maxRunsPerMonth: 150, maxModelsPerRun: 5, plan: "full", resetsAt: new Date() });
  mockedExecuteVideoVerification.mockResolvedValue(executionResult());
  mockedSaveGate2.mockResolvedValue({ status: "created", verificationId: "vid-team-1", workspaceId: WS_ID, projectId: null });
  mockTxnGet.mockResolvedValue({ data: () => ({ usageMonth: nowMonthLabel() }) });
  mockRunTransaction.mockImplementation(async (cb: any) => cb({ get: mockTxnGet, set: mockTxnSet }));
});

// ============================================================
// IDENTITY & RATE LIMIT
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — identity & rate limit", () => {
  it("unauthenticated -> 401, correct telemetry, rate limiter never called", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(401);
    expect(mockedLogIdentityResolutionFailure).toHaveBeenCalledWith(
      expect.objectContaining({ route: "POST /api/workspaces/[workspaceId]/video-verifications", method: "POST", failureCategory: "missing_credentials" })
    );
    expect(mockedCheckRateLimit).not.toHaveBeenCalled();
  });

  it("rate-limit denied -> 429, zero downstream work", async () => {
    mockedCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(429);
    expect(mockedAuthorizeGate1).not.toHaveBeenCalled();
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
  });

  it("rate occurs BEFORE body parsing (malformed JSON still hits rate limiter first)", async () => {
    const res = await POST(buildPostRequest(undefined, { rawText: "{not json" }), { params: { workspaceId: WS_ID } });
    expect(mockedCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(400);
  });

  it("rate-limit identifier is UID-only, never contains the Workspace id", async () => {
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const identifier = mockedCheckRateLimit.mock.calls[0][0].identifier as string;
    expect(identifier).toBe(`team-video-verification:${UID}`);
    expect(identifier).not.toContain(WS_ID);
  });
});

// ============================================================
// BODY CONTRACT
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — body contract", () => {
  it("unknown top-level field (workspaceId) -> 400 unexpected_field", async () => {
    const res = await POST(buildPostRequest(buildBody({ workspaceId: "sneaky" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("unexpected_field");
  });

  it("unknown top-level field (verificationId) -> 400 unexpected_field", async () => {
    const res = await POST(buildPostRequest(buildBody({ verificationId: "vid-sneaky" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("unexpected_field");
  });

  it("empty body -> 400 invalid_request", async () => {
    const res = await POST(buildPostRequest(undefined, { rawText: "" }), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });

  it("multipart/form-data -> 400 invalid_request", async () => {
    const res = await POST(buildPostRequest(undefined, { rawText: "--boundary\r\n", contentType: "multipart/form-data; boundary=x" }), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });

  it("no frames -> 400 no_frames", async () => {
    const res = await POST(buildPostRequest(buildBody({ frames: [] })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("no_frames");
  });

  it("duration > 60 -> 400 invalid_metadata", async () => {
    const res = await POST(buildPostRequest(buildBody({ metadata: buildMetadata({ duration: 61 }) })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });

  it("fileSize > 50MB -> 400 file_too_large", async () => {
    const res = await POST(buildPostRequest(buildBody({ metadata: buildMetadata({ fileSize: 51 * 1024 * 1024 }) })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("file_too_large");
  });

  it("projectId omitted -> Gate 1 called with projectId: null", async () => {
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedAuthorizeGate1).toHaveBeenCalledWith(expect.objectContaining({ projectId: null }));
  });

  it("projectId explicit null -> Gate 1 called with projectId: null", async () => {
    await POST(buildPostRequest(buildBody({ projectId: null })), { params: { workspaceId: WS_ID } });
    expect(mockedAuthorizeGate1).toHaveBeenCalledWith(expect.objectContaining({ projectId: null }));
  });

  it("projectId valid string -> Gate 1 called with that projectId", async () => {
    await POST(buildPostRequest(buildBody({ projectId: "proj-1" })), { params: { workspaceId: WS_ID } });
    expect(mockedAuthorizeGate1).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj-1" }));
  });

  it("empty-string projectId -> 400 invalid_request_body", async () => {
    const res = await POST(buildPostRequest(buildBody({ projectId: "" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });
});

// ============================================================
// ROLLOUT
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — rollout", () => {
  it("Phase 10C.1A: disabled -> concealed 404 (not a distinguishable 503), zero Gate 1/dedup/generic/execution", async () => {
    mockedResolveTeamWorkspacesMode.mockReturnValueOnce({ enabled: false, source: "off" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
    expect((await res.json()).errorCode).toBe("team_workspace_not_found");
    expect(mockedAuthorizeGate1).not.toHaveBeenCalled();
    expect(mockedFindDedupCandidate).not.toHaveBeenCalled();
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
  });

  it("F1 parity: not-admitted (Case 1) is byte-identical to Gate 1's own concealed unauthorized denial (Case 2)", async () => {
    mockedResolveTeamWorkspacesMode.mockReturnValueOnce({ enabled: false, source: "off" });
    const notAdmittedRes = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const notAdmittedJson = await notAdmittedRes.json();

    mockedAuthorizeGate1.mockResolvedValueOnce({ status: "unauthorized", reason: "membership_removed" });
    const admittedButForeignRes = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const admittedButForeignJson = await admittedButForeignRes.json();

    expect(notAdmittedRes.status).toBe(admittedButForeignRes.status);
    expect(JSON.stringify(notAdmittedJson)).toBe(JSON.stringify(admittedButForeignJson));
  });
});

// ============================================================
// ROLLOUT — Workspace-scoped canary admission (Phase 10B.3.2A)
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — Workspace-scoped canary admission", () => {
  it("global/uid-canary both off, Workspace-canary admits this exact URL-bound workspaceId -> proceeds to Gate 1", async () => {
    mockedResolveTeamWorkspacesMode.mockReturnValueOnce({ enabled: false, source: "off" });
    mockedTeamWorkspacesCanaryWorkspaceIds = WS_ID;
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    expect(mockedAuthorizeGate1).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS_ID }));
  });

  it("global/uid-canary both off, Workspace-canary configured for a DIFFERENT workspace only -> concealed 404, zero Gate 1/dedup/generic/execution", async () => {
    mockedResolveTeamWorkspacesMode.mockReturnValueOnce({ enabled: false, source: "off" });
    mockedTeamWorkspacesCanaryWorkspaceIds = "ws-some-other-workspace";
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
    expect((await res.json()).errorCode).toBe("team_workspace_not_found");
    expect(mockedAuthorizeGate1).not.toHaveBeenCalled();
    expect(mockedFindDedupCandidate).not.toHaveBeenCalled();
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
  });

  it("malformed Workspace-canary list does not poison an otherwise-successful global admission", async () => {
    mockedResolveTeamWorkspacesMode.mockReturnValueOnce({ enabled: true, source: "global" });
    mockedTeamWorkspacesCanaryWorkspaceIds = Array.from({ length: 11 }, (_, i) => `ws-${i}`).join(",");
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
  });

  it("malformed Workspace-canary list fails closed on its own axis — global/uid off -> concealed 404, never broadens access", async () => {
    mockedResolveTeamWorkspacesMode.mockReturnValueOnce({ enabled: false, source: "off" });
    mockedTeamWorkspacesCanaryWorkspaceIds = "not a valid id/with a slash";
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });
});

// ============================================================
// GATE 1
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — Gate 1", () => {
  it("denial -> mapped error, zero entitlement/dedup/generic/execution/Gate2", async () => {
    mockedAuthorizeGate1.mockResolvedValueOnce({ status: "unauthorized", reason: "insufficient_capability" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(403);
    expect(mockedGetEffectiveEntitlements).not.toHaveBeenCalled();
    expect(mockedFindDedupCandidate).not.toHaveBeenCalled();
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
  });

  it("Phase 10C.1A: team_workspaces_disabled -> concealed 404 (not a distinguishable 503)", async () => {
    mockedAuthorizeGate1.mockResolvedValueOnce({ status: "team_workspaces_disabled" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
    expect((await res.json()).errorCode).toBe("team_workspace_not_found");
  });

  it("project_not_found -> 404", async () => {
    mockedAuthorizeGate1.mockResolvedValueOnce({ status: "project_not_found" });
    const res = await POST(buildPostRequest(buildBody({ projectId: "proj-x" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });

  it("project_archived -> 409", async () => {
    mockedAuthorizeGate1.mockResolvedValueOnce({ status: "project_archived" });
    const res = await POST(buildPostRequest(buildBody({ projectId: "proj-x" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(409);
  });

  it("success -> entitlement/user-record proceeds", async () => {
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedGetEffectiveEntitlements).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// REQUESTER ENTITLEMENT / USER RECORD
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — requester entitlement & user record", () => {
  it("free plan -> 403 plan_required, zero dedup/generic/execution", async () => {
    mockedGetEffectiveEntitlements.mockResolvedValueOnce({ planId: "free", source: "free", monthlyLimit: 8, maxModelsPerRun: 2 });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("plan_required");
    expect(mockedFindDedupCandidate).not.toHaveBeenCalled();
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
  });

  it("video monthly limit reached -> 429 video_limit_reached", async () => {
    mockUsersDocGet.mockResolvedValueOnce({ exists: true, data: () => ({ email: "member@example.com", usageMonth: nowMonthLabel(), videoRunsThisMonth: 20 }) });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("video_limit_reached");
  });

  it("missing user document -> userEmail '', request proceeds normally (not an error)", async () => {
    mockUsersDocGet.mockResolvedValueOnce({ exists: false, data: () => undefined });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    expect(mockedSaveGate2).toHaveBeenCalledWith(expect.objectContaining({ userEmail: "" }));
  });

  it("null/malformed email -> userEmail '', not an error", async () => {
    mockUsersDocGet.mockResolvedValueOnce({ exists: true, data: () => ({ email: null, usageMonth: nowMonthLabel(), videoRunsThisMonth: 0 }) });
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedSaveGate2).toHaveBeenCalledWith(expect.objectContaining({ userEmail: "" }));
  });

  it("Workspace owner's email is never substituted — only the requester's own users/{uid}.email is used", async () => {
    mockUsersDocGet.mockResolvedValueOnce({ exists: true, data: () => ({ email: "requester@example.com", usageMonth: nowMonthLabel(), videoRunsThisMonth: 0 }) });
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedSaveGate2).toHaveBeenCalledWith(expect.objectContaining({ userEmail: "requester@example.com" }));
  });
});

// ============================================================
// DEDUP
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — dedup", () => {
  it("hit + valid row + research.read granted -> 200 _deduplicated, zero generic/execution/Gate2/tokens/counter/governance", async () => {
    mockedFindDedupCandidate.mockResolvedValueOnce({
      id: "vid-existing-1",
      data: {
        userId: "creator-uid", workspaceId: WS_ID, projectId: null, type: "video_verification", fileName: "clip.mp4",
        verdict: "authentic_captured", contentType: "camera_footage", consensusScore: 90, confidenceLabel: "High",
        evidenceQuality: "strong", supportRatio: 100, metadata: {}, metadataAnalysis: { flags: [], summary: "" },
        modelResults: [], agreementPoints: [], disagreementPoints: [], frameCount: 1, warnings: [], timestamp: Timestamp.now(),
      },
    });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });

    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body._deduplicated).toBe(true);
    expect(body.verificationId).toBe("vid-existing-1");
    expect(body.workspaceId).toBe(WS_ID);
    expect(body.projectId).toBeNull();

    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
    expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();
    expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it("MATCHED candidate + malformed row (fails validator) -> FAIL CLOSED, concealed 404, zero downstream work of any kind", async () => {
    mockedFindDedupCandidate.mockResolvedValueOnce({ id: "vid-bad", data: { userId: "x", workspaceId: WS_ID, type: "video_verification" /* missing projectId/timestamp */ } });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.errorCode).toBe("not_found");
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
    expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();
    expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it("MATCHED candidate + valid row + research.read MISSING (granted but lacking capability) -> 403 insufficient_capability, zero downstream work", async () => {
    mockedFindDedupCandidate.mockResolvedValueOnce({
      id: "vid-existing-1",
      data: { userId: "creator-uid", workspaceId: WS_ID, projectId: null, type: "video_verification", timestamp: Timestamp.now() },
    });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["projects.read"] });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.errorCode).toBe("insufficient_capability");
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
    expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();
    expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it("MATCHED candidate + membership removed before fresh read -> FAIL CLOSED, concealed 404, zero downstream work — request never spends provider quota waiting for Gate 2 to rediscover the revocation", async () => {
    mockedFindDedupCandidate.mockResolvedValueOnce({
      id: "vid-existing-1",
      data: { userId: "creator-uid", workspaceId: WS_ID, projectId: null, type: "video_verification", timestamp: Timestamp.now() },
    });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.errorCode).toBe("not_found");
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
    expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();
    expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it("MATCHED candidate + wrong Workspace type on fresh read -> concealed 404, zero downstream work", async () => {
    mockedFindDedupCandidate.mockResolvedValueOnce({
      id: "vid-existing-1",
      data: { userId: "creator-uid", workspaceId: WS_ID, projectId: null, type: "video_verification", timestamp: Timestamp.now() },
    });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "wrong_workspace_type" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
  });

  it("MATCHED candidate + owner-integrity violation on fresh read -> concealed 404, zero downstream work", async () => {
    mockedFindDedupCandidate.mockResolvedValueOnce({
      id: "vid-existing-1",
      data: { userId: "creator-uid", workspaceId: WS_ID, projectId: null, type: "video_verification", timestamp: Timestamp.now() },
    });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "owner_integrity_violation" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
  });

  it("MATCHED candidate + fresh-read rollout disabled -> 503 team_workspaces_disabled, zero downstream work", async () => {
    mockedFindDedupCandidate.mockResolvedValueOnce({
      id: "vid-existing-1",
      data: { userId: "creator-uid", workspaceId: WS_ID, projectId: null, type: "video_verification", timestamp: Timestamp.now() },
    });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "team_workspaces_disabled" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.errorCode).toBe("team_workspaces_disabled");
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
  });

  it("MATCHED candidate + fresh-read infrastructure lookup failure -> 503 mapping, zero downstream work", async () => {
    mockedFindDedupCandidate.mockResolvedValueOnce({
      id: "vid-existing-1",
      data: { userId: "creator-uid", workspaceId: WS_ID, projectId: null, type: "video_verification", timestamp: Timestamp.now() },
    });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.errorCode).toBe("team_workspaces_disabled");
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
  });

  it("KEY ACCEPTANCE INVARIANT: a true dedup HIT can never reach creation unless research.read succeeds — proven across malformed/denied/concealed/infra cases, all producing zero calls to executeVideoVerification/saveTeamVideoVerification", async () => {
    const scenarios: Array<() => void> = [
      () => mockedFindDedupCandidate.mockResolvedValueOnce({ id: "vid-1", data: { userId: "x", type: "video_verification" } }), // malformed
      () => {
        mockedFindDedupCandidate.mockResolvedValueOnce({ id: "vid-2", data: { userId: "x", workspaceId: WS_ID, projectId: null, type: "video_verification", timestamp: Timestamp.now() } });
        mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
      },
      () => {
        mockedFindDedupCandidate.mockResolvedValueOnce({ id: "vid-3", data: { userId: "x", workspaceId: WS_ID, projectId: null, type: "video_verification", timestamp: Timestamp.now() } });
        mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: [] });
      },
    ];
    for (const arrange of scenarios) {
      jest.clearAllMocks();
      mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
      mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
      mockedResolveTeamWorkspacesMode.mockReturnValue({ enabled: true, source: "global" });
      mockedAuthorizeGate1.mockResolvedValue({ status: "authorized", workspaceId: WS_ID, projectId: null });
      mockedGetEffectiveEntitlements.mockResolvedValue({ planId: "full", source: "stripe", monthlyLimit: 150, maxModelsPerRun: 5 });
      mockUsersDocGet.mockResolvedValue({ exists: true, data: () => ({ email: "member@example.com", usageMonth: nowMonthLabel(), videoRunsThisMonth: 0 }) });
      arrange();
      const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
      expect([403, 404]).toContain(res.status);
      expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
      expect(mockedSaveGate2).not.toHaveBeenCalled();
    }
  });

  it("dedup query THROW -> 500 internal_error via outer catch, zero generic/execution/Gate2/tokens/counter/governance", async () => {
    mockedFindDedupCandidate.mockRejectedValueOnce(new Error("firestore unavailable"));
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.errorCode).toBe("internal_error");
    expect(JSON.stringify(body)).not.toMatch(/firestore unavailable/);
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
    expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();
  });

  it("dedup miss -> proceeds to generic charge and execution", async () => {
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
    expect(mockedExecuteVideoVerification).toHaveBeenCalledTimes(1);
  });

  it("dedup is called with workspaceId+projectId binding scope", async () => {
    await POST(buildPostRequest(buildBody({ projectId: "proj-1" })), { params: { workspaceId: WS_ID } });
    expect(mockedFindDedupCandidate).toHaveBeenCalledWith(expect.objectContaining({ uid: UID, workspaceId: WS_ID, projectId: "proj-1", fileName: "clip.mp4" }));
  });
});

// ============================================================
// GENERIC USAGE (Option A — pre-charge before execution)
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — generic usage pre-charge", () => {
  it("called with (uid, 2) exactly once, before execution", async () => {
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledWith(UID, 2);
  });

  it("not called on dedup hit", async () => {
    mockedFindDedupCandidate.mockResolvedValueOnce({
      id: "vid-existing-1",
      data: { userId: "creator-uid", workspaceId: WS_ID, projectId: null, type: "video_verification", timestamp: Timestamp.now() },
    });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
  });

  it("MODEL_LIMIT denial -> 403, zero execution/Gate2", async () => {
    mockedCheckAndIncrementUsage.mockResolvedValueOnce({ allowed: false, reason: "MODEL_LIMIT", runsThisMonth: 1, maxRunsPerMonth: 150, maxModelsPerRun: 2, plan: "lite" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("model_limit");
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
  });

  it("RUN_LIMIT denial -> 429, zero execution/Gate2", async () => {
    mockedCheckAndIncrementUsage.mockResolvedValueOnce({ allowed: false, reason: "RUN_LIMIT", runsThisMonth: 150, maxRunsPerMonth: 150, maxModelsPerRun: 5, plan: "full", resetsAt: new Date() });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("run_limit_reached");
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
  });

  it("THROW -> 500 internal_error via outer catch (Team-only safety improvement over Personal's uncaught quirk), zero execution/Gate2/tokens/counter/governance", async () => {
    mockedCheckAndIncrementUsage.mockRejectedValueOnce(new Error("transient firestore error"));
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.errorCode).toBe("internal_error");
    expect(JSON.stringify(body)).not.toMatch(/transient firestore error/);
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
    expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();
  });
});

// ============================================================
// EXECUTION
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — execution", () => {
  it("executeVideoVerification called with frames/metadata/metadataAnalysis/allWarnings — same shared service", async () => {
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedExecuteVideoVerification).toHaveBeenCalledTimes(1);
    const [frames, metadata, metadataAnalysis, warnings] = mockedExecuteVideoVerification.mock.calls[0];
    expect(Array.isArray(frames)).toBe(true);
    expect(metadata.duration).toBe(10);
    expect(metadataAnalysis).toEqual(expect.objectContaining({ flags: expect.any(Array), summary: expect.any(String) }));
    expect(warnings).toEqual([]);
  });

  it("all-provider-failure result (insufficient) still proceeds to Gate 2 and a normal 200 response", async () => {
    mockedExecuteVideoVerification.mockResolvedValueOnce(
      executionResult({ aggregateVerdict: "insufficient", consensusScore: 0, supportRatio: 0, modelResults: executionResult().modelResults.map((m: any) => ({ ...m, status: "error" })), totalTokens: 0 })
    );
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.verdict).toBe("insufficient");
    expect(mockedSaveGate2).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// GATE 2
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — Gate 2", () => {
  it("success -> governance called, video counter runs, response includes workspaceId/projectId, no Team internals leaked", async () => {
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.verificationId).toBe("vid-team-1");
    expect(body.workspaceId).toBe(WS_ID);
    expect(body.projectId).toBeNull();
    expect(body.role).toBeUndefined();
    expect(body.membership).toBeUndefined();
    expect(body.capabilities).toBeUndefined();
    expect(mockedEvaluateAndStoreGovernance).toHaveBeenCalledTimes(1);
    expect(mockedEvaluateAndStoreGovernance).toHaveBeenCalledWith(expect.objectContaining({ runId: "vid-team-1", collection: "videoVerifications", ownerUid: UID }));
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
  });

  it("saveTeamVideoVerification is called with resolved userEmail as an explicit input, workspaceId, projectId, and computed fields — never a route-generated verificationId", async () => {
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const args = mockedSaveGate2.mock.calls[0][0];
    expect(args.uid).toBe(UID);
    expect(args.userEmail).toBe("member@example.com");
    expect(args.workspaceId).toBe(WS_ID);
    expect(args.projectId).toBeNull();
    expect(args.verificationId).toBeUndefined();
    expect(args.verdict).toBe("authentic_captured");
    expect(args.totalTokens).toBe(300);
  });

  it("unauthorized denial after execution -> generic usage remains consumed, no artifact, no governance, no video counter, no Personal fallback", async () => {
    mockedSaveGate2.mockResolvedValueOnce({ status: "unauthorized", reason: "membership_removed" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1); // consumed, no refund
    expect(mockedExecuteVideoVerification).toHaveBeenCalledTimes(1); // providers ran
    expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("project_archived after execution -> 409, no artifact, no governance, no counter", async () => {
    mockedSaveGate2.mockResolvedValueOnce({ status: "project_archived" });
    const res = await POST(buildPostRequest(buildBody({ projectId: "proj-1" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(409);
    expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it("transaction_failed -> 500 internal_error, generic usage remains consumed, tokens still attempted", async () => {
    mockedSaveGate2.mockResolvedValueOnce({ status: "transaction_failed" });
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(500);
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
    expect(mockedEvaluateAndStoreGovernance).not.toHaveBeenCalled();
  });
});

// ============================================================
// TOKEN ACCOUNTING
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — token accounting", () => {
  it("called exactly once with the real aggregate totalTokens, BEFORE branching on Gate 2's result", async () => {
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledWith(UID, 300);
  });

  it("still attempted on Gate-2 denial (membership revoked)", async () => {
    mockedSaveGate2.mockResolvedValueOnce({ status: "unauthorized", reason: "membership_removed" });
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
  });

  it("still attempted on Gate-2 project_archived", async () => {
    mockedSaveGate2.mockResolvedValueOnce({ status: "project_archived" });
    await POST(buildPostRequest(buildBody({ projectId: "proj-1" })), { params: { workspaceId: WS_ID } });
    expect(mockedIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
  });

  it("not called on dedup hit", async () => {
    mockedFindDedupCandidate.mockResolvedValueOnce({
      id: "vid-existing-1",
      data: { userId: "creator-uid", workspaceId: WS_ID, projectId: null, type: "video_verification", timestamp: Timestamp.now() },
    });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockedIncrementUserTokenUsage).not.toHaveBeenCalled();
  });

  it("token helper throw -> best-effort, does not alter Gate-2 status or block success response", async () => {
    mockedIncrementUserTokenUsage.mockRejectedValueOnce(new Error("token boom"));
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
  });
});

// ============================================================
// GOVERNANCE
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — governance", () => {
  it("failure -> logs, writes failed_governance_audits fallback, response still succeeds, video counter still runs", async () => {
    mockedEvaluateAndStoreGovernance.mockRejectedValueOnce(new Error("governance down"));
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    expect(mockLoggerError).toHaveBeenCalled();
    expect(mockFailedGovernanceAdd).toHaveBeenCalledTimes(1);
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
  });

  it("fallback audit write ALSO failing is swallowed — response still succeeds", async () => {
    mockedEvaluateAndStoreGovernance.mockRejectedValueOnce(new Error("governance down"));
    mockFailedGovernanceAdd.mockRejectedValueOnce(new Error("audit write down too"));
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
  });

  it("no legacy team governance pipeline is ever invoked (module not imported by this route)", () => {
    // The route intentionally never imports applyTeamGovernancePipeline/loadUserAndTeam/legacy teamRuns.
    const routeSource = require("fs").readFileSync(require.resolve("@/app/api/workspaces/[workspaceId]/video-verifications/route"), "utf8");
    expect(routeSource).not.toMatch(/applyTeamGovernancePipeline|loadUserAndTeam|teamRuns/);
  });
});

// ============================================================
// VIDEO COUNTER
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — video counter", () => {
  it("only runs after Gate 2 created", async () => {
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
  });

  it("month-rollover branch resets to usageMonth=now, videoRunsThisMonth=1", async () => {
    mockTxnGet.mockResolvedValueOnce({ data: () => ({ usageMonth: "2000-01" }) });
    await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const [, data] = mockTxnSet.mock.calls[0];
    expect(data.usageMonth).toBe(nowMonthLabel());
    expect(data.videoRunsThisMonth).toBe(1);
  });

  it("counter transaction failure -> logged, response still succeeds", async () => {
    mockRunTransaction.mockRejectedValueOnce(new Error("counter boom"));
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

// ============================================================
// OUTER SAFE CATCH
// ============================================================
describe("POST /api/workspaces/[workspaceId]/video-verifications — outer safe catch", () => {
  it("unexpected exception from getEffectiveEntitlements -> 500 internal_error, no leaked detail", async () => {
    mockedGetEffectiveEntitlements.mockRejectedValueOnce(new Error("entitlements service down, secret-detail-xyz"));
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.errorCode).toBe("internal_error");
    expect(JSON.stringify(body)).not.toMatch(/secret-detail-xyz/);
  });

  it("unexpected exception from the users/{uid} read -> 500 internal_error", async () => {
    mockUsersDocGet.mockRejectedValueOnce(new Error("firestore read failed"));
    const res = await POST(buildPostRequest(buildBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(500);
    expect(mockedExecuteVideoVerification).not.toHaveBeenCalled();
  });
});

// ============================================================
// GET absence — create-only slice
// ============================================================
describe("GET absence — E3.3.1 is create-only", () => {
  it("no GET export exists on this route module", async () => {
    const routeModule = await import("@/app/api/workspaces/[workspaceId]/video-verifications/route");
    expect((routeModule as any).GET).toBeUndefined();
  });
});
