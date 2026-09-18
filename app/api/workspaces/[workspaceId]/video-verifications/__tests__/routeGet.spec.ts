/**
 * TEAM-VERIFICATION-PARITY-R5-I1 §AD — `GET /api/workspaces/{W}/video-verifications`
 * (Workspace and `?scope=unfiled` Team Video lists). The REAL list helper, row
 * validator and strict summary run against the in-memory Firestore fake;
 * identity and Team Workspace access are controlled boundaries.
 *
 * This GET shares a route FILE with the Production-stable Team Video POST, so
 * every POST-only dependency (rate limit, Gate 1, dedup, entitlements, video
 * limit, quota, provider execution, tokens, governance, Gate 2) is a THROWING
 * spy: a read that reached any of them fails loudly here rather than silently
 * acquiring a side effect.
 */

jest.mock("firebase-admin/firestore", () => require("@/lib/workspaces/__tests__/teamVideoFakeFirestore").fakeFirestoreModule);
let mockState: import("@/lib/workspaces/__tests__/teamVideoFakeFirestore").FakeState;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    const { makeFakeDb } = require("@/lib/workspaces/__tests__/teamVideoFakeFirestore");
    return mockState.unavailable ? null : makeFakeDb(mockState);
  },
}));
const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
const mockedLogIdentityResolutionFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: (...a: unknown[]) => mockedLogIdentityResolutionFailure(...a) }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/env", () => ({ OPENAI_API_KEY: "t", ANTHROPIC_API_KEY: "t", GEMINI_API_KEY: "t", TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined }));

const mockPostOnly = (name: string) => jest.fn(() => { throw new Error(`POST-only dependency reached from a GET: ${name}`); });
const mockedRateLimit = mockPostOnly("checkRateLimit");
const mockedGate1 = mockPostOnly("authorizeTeamVideoVerificationAdmission");
const mockedDedup = mockPostOnly("findTeamVideoVerificationDedupCandidate");
const mockedGate2 = mockPostOnly("saveTeamVideoVerification");
const mockedEntitlements = mockPostOnly("getEffectiveEntitlements");
const mockedVideoLimit = mockPostOnly("getVideoLimit");
const mockedUsage = mockPostOnly("checkAndIncrementUsageForRun");
const mockedAnalyze = mockPostOnly("analyzeMetadata");
const mockedExecute = mockPostOnly("executeVideoVerification");
const mockedTokens = mockPostOnly("incrementUserTokenUsage");
const mockedGovernance = mockPostOnly("evaluateAndStoreGovernance");
jest.mock("@/lib/security/rateLimit", () => ({ checkRateLimit: (...a: unknown[]) => (mockedRateLimit as any)(...a) }));
jest.mock("@/lib/firestore/teamVideoVerifications", () => ({
  authorizeTeamVideoVerificationAdmission: (...a: unknown[]) => (mockedGate1 as any)(...a),
  findTeamVideoVerificationDedupCandidate: (...a: unknown[]) => (mockedDedup as any)(...a),
  saveTeamVideoVerification: (...a: unknown[]) => (mockedGate2 as any)(...a),
}));
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: (...a: unknown[]) => (mockedEntitlements as any)(...a) }));
jest.mock("@/lib/billing/planConfig", () => ({ getVideoLimit: (...a: unknown[]) => (mockedVideoLimit as any)(...a) }));
jest.mock("@/lib/stripe/usageCheck", () => ({ checkAndIncrementUsageForRun: (...a: unknown[]) => (mockedUsage as any)(...a) }));
jest.mock("@/lib/video/videoPure", () => ({ analyzeMetadata: (...a: unknown[]) => (mockedAnalyze as any)(...a) }));
jest.mock("@/lib/video/videoVerificationExecution", () => ({ executeVideoVerification: (...a: unknown[]) => (mockedExecute as any)(...a) }));
jest.mock("@/lib/firestore/userTokens", () => ({ incrementUserTokenUsage: (...a: unknown[]) => (mockedTokens as any)(...a) }));
jest.mock("@/lib/governance/evaluateAndStore", () => ({ evaluateAndStoreGovernance: (...a: unknown[]) => (mockedGovernance as any)(...a) }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/video-verifications/route";
import { capabilitiesForRole } from "@/lib/workspaces/capabilities";
import { createFakeState, projectDoc, TEAM_W, teamVideoDoc, personalVideoDoc } from "@/lib/workspaces/__tests__/teamVideoFakeFirestore";

const T = 1_700_000_000_000;
const grant = (role: "owner" | "admin" | "member" | "reviewer" | "viewer" = "member") => ({ granted: true, workspace: { id: TEAM_W, type: "team" }, membership: { role }, capabilities: [...capabilitiesForRole(role)] });

async function get(query = "", uid = "reader-b") {
  mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "authenticated", uid, source: "session_cookie" });
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/video-verifications${query}`), { params: { workspaceId: TEAM_W } });
  return { status: res.status, body: await res.json() };
}
const ids = (body: any) => body.items.map((i: any) => i.verificationId);

function expectNoPostSideEffects() {
  for (const spy of [mockedRateLimit, mockedGate1, mockedDedup, mockedGate2, mockedEntitlements, mockedVideoLimit, mockedUsage, mockedAnalyze, mockedExecute, mockedTokens, mockedGovernance]) {
    expect(spy).not.toHaveBeenCalled();
  }
  expect(mockState.writeAttempts).toEqual([]);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState = createFakeState();
  mockedAccess.mockResolvedValue(grant());
});

describe("identity", () => {
  it("missing credentials -> 401 unauthorized, telemetry attributed to GET, no access lookup", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/video-verifications`), { params: { workspaceId: TEAM_W } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, errorCode: "unauthorized", message: "Please sign in." });
    expect(mockedLogIdentityResolutionFailure).toHaveBeenCalledWith({ route: "GET /api/workspaces/[workspaceId]/video-verifications", method: "GET", failureCategory: "missing_credentials" });
    expect(mockedAccess).not.toHaveBeenCalled();
  });

  it.each(["invalid_bearer_token", "revoked_session", "credential_mismatch", "expired_session"])("%s -> 401 auth_error, no access lookup, no query", async (reason) => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason });
    const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/video-verifications`), { params: { workspaceId: TEAM_W } });
    expect(res.status).toBe(401);
    expect((await res.json()).errorCode).toBe("auth_error");
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockState.queries).toEqual([]);
  });
});

describe("Team Workspace authorization", () => {
  it("access is resolved for the ADDRESSED Workspace and the caller", async () => {
    await get();
    expect(mockedAccess).toHaveBeenCalledWith({ uid: "reader-b", workspaceId: TEAM_W });
  });

  it.each(["team_workspaces_disabled", "workspace_not_found", "workspace_malformed", "wrong_workspace_type", "membership_not_found", "membership_removed", "membership_malformed", "owner_integrity_violation"])("denial %s -> identical concealed 404, no query", async (reason) => {
    mockedAccess.mockResolvedValueOnce({ granted: false, reason });
    const r = await get();
    expect(r).toEqual({ status: 404, body: { ok: false, errorCode: "team_workspace_not_found", message: "This Team Workspace could not be found." } });
    expect(mockState.queries).toEqual([]);
  });

  it("lookup_failed -> 503 team_workspace_unavailable", async () => {
    mockedAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    expect((await get()).status).toBe(503);
  });

  it("granted without research.read -> 403 insufficient_capability, no query", async () => {
    mockedAccess.mockResolvedValueOnce({ ...grant(), capabilities: ["workspace.read"] });
    const r = await get();
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe("insufficient_capability");
    expect(mockState.queries).toEqual([]);
  });

  it.each(["owner", "admin", "member", "reviewer", "viewer"] as const)("role %s (carries research.read) reads the same Videos", async (role) => {
    mockState.collections.videoVerifications = [teamVideoDoc("vid-1", { userId: "uploader-a" })];
    mockedAccess.mockResolvedValueOnce(grant(role));
    const r = await get();
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual(["vid-1"]);
  });

  it("reviewer and viewer read without holding research.create", async () => {
    for (const role of ["reviewer", "viewer"] as const) {
      expect([...capabilitiesForRole(role)]).not.toContain("research.create");
    }
  });

  it("a member other than the uploader reads the uploader's Video; the uploader who lost membership is concealed", async () => {
    mockState.collections.videoVerifications = [teamVideoDoc("vid-1", { userId: "uploader-a" })];
    expect(ids((await get("", "reader-b")).body)).toEqual(["vid-1"]);
    mockedAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    expect((await get("", "uploader-a")).status).toBe(404);
  });
});

describe("list contract", () => {
  it("all scope: 200 with items, hasMore, scope, newest first; Personal and foreign rows never appear", async () => {
    mockState.collections.videoVerifications = [
      teamVideoDoc("old", {}, T),
      teamVideoDoc("new", { projectId: "p1" }, T + 5),
      personalVideoDoc("personal", {}, T + 9),
      teamVideoDoc("foreign", { workspaceId: "ws-other" }, T + 7),
    ];
    mockState.collections.projects = [projectDoc("p1", { status: "archived" })];
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.scope).toBe("all");
    expect(r.body.hasMore).toBe(false);
    expect(ids(r.body)).toEqual(["new", "old"]);
    expect(r.body.items[0].project).toEqual({ id: "p1", name: "Project p1", status: "archived" });
    expectNoPostSideEffects();
  });

  it("?scope=unfiled -> only projectId == null, zero Project reads, scope echoed", async () => {
    mockState.collections.videoVerifications = [teamVideoDoc("unfiled"), teamVideoDoc("filed", { projectId: "p1" })];
    const r = await get("?scope=unfiled");
    expect(ids(r.body)).toEqual(["unfiled"]);
    expect(r.body.scope).toBe("unfiled");
    expect(mockState.getAllCalls).toEqual([]);
  });

  it("unsupported scope -> 400 invalid_scope before any query", async () => {
    const r = await get("?scope=project");
    expect(r).toEqual({ status: 400, body: { ok: false, errorCode: "invalid_scope", message: "Unsupported scope value." } });
    expect(mockState.queries).toEqual([]);
  });

  it("limit defaults to 20 and clamps to [1, 50]", async () => {
    await get();
    await get("?limit=0");
    await get("?limit=500");
    await get("?limit=nope");
    expect(mockState.queries.map((q) => q.limit)).toEqual([21, 21, 51, 21]);
  });

  it("the query is workspaceId-only with timestamp/document-id ordering and no creator predicate", async () => {
    mockState.collections.videoVerifications = [teamVideoDoc("vid-1")];
    await get();
    expect(mockState.queries).toEqual([
      { collection: "videoVerifications", filters: [{ field: "workspaceId", op: "==", value: TEAM_W }], orders: [{ field: "timestamp", dir: "desc" }, { field: "__name__", dir: "desc" }], limit: 21 },
    ]);
  });

  it("empty Workspace -> 200 with an empty page and no cursor", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(r.body.hasMore).toBe(false);
    expect("nextCursor" in r.body).toBe(false);
  });

  it("pagination: nextCursor resumes; hasMore true always carries a cursor; a malformed cursor is 400", async () => {
    mockState.collections.videoVerifications = Array.from({ length: 3 }, (_, i) => teamVideoDoc(`v${i}`, {}, T + i * 1000));
    const p1 = await get("?limit=2");
    expect(ids(p1.body)).toEqual(["v2", "v1"]);
    expect(p1.body.hasMore).toBe(true);
    expect(typeof p1.body.nextCursor).toBe("string");
    expect(p1.body.nextCursor.length).toBeGreaterThan(0);
    const p2 = await get(`?limit=2&cursor=${p1.body.nextCursor}`);
    expect(ids(p2.body)).toEqual(["v0"]);
    expect(p2.body.hasMore).toBe(false);
    expect("nextCursor" in p2.body).toBe(false);
    expect(await get("?cursor=%%%bad")).toEqual({ status: 400, body: { ok: false, errorCode: "invalid_cursor", message: "This page link is no longer valid." } });
  });

  it("an invalid cursor is rejected before any Firestore query", async () => {
    await get("?cursor=%%%bad");
    expect(mockState.queries).toEqual([]);
  });

  it.each([
    ["a malformed row in the page", () => { mockState.collections.videoVerifications = [teamVideoDoc("good", {}, T + 1), teamVideoDoc("bad", { type: "claim_verification" }, T)]; }],
    ["a malformed PEEK row", () => { mockState.collections.videoVerifications = [teamVideoDoc("v2", {}, T + 2), teamVideoDoc("v1", {}, T + 1), teamVideoDoc("peek", { frameCount: -1 }, T)]; }],
    ["a cross-Workspace referenced Project", () => { mockState.collections.videoVerifications = [teamVideoDoc("x", { projectId: "p-foreign" })]; mockState.collections.projects = [projectDoc("p-foreign", { workspaceId: "ws-other" })]; }],
    ["a missing referenced Project", () => { mockState.collections.videoVerifications = [teamVideoDoc("x", { projectId: "p-gone" })]; }],
    ["a summary-field failure", () => { mockState.collections.videoVerifications = [teamVideoDoc("x", { evidenceQuality: "excellent" })]; }],
    ["a query infrastructure failure", () => { mockState.throwOnQuery = true; }],
  ])("%s -> 500 internal_error, never a partial page", async (_l, seed) => {
    seed();
    const r = await get(_l === "a malformed PEEK row" ? "?limit=2" : "");
    expect(r).toEqual({ status: 500, body: { ok: false, errorCode: "internal_error", message: "Something went wrong. Please try again." } });
  });

  it("response JSON never exposes the uploader uid, email, raw timestamps, tokens or capability data", async () => {
    mockState.collections.videoVerifications = [teamVideoDoc("v", { userId: "uploader-secret-uid" })];
    const json = JSON.stringify((await get()).body);
    for (const leaked of ["uploader-secret-uid", "userId", "userEmail", "capabilities", "membership", "seconds", "nanoseconds", "modelResults", "totalTokens", "supportRatio"]) {
      expect(json).not.toContain(leaked);
    }
  });
});

describe("zero side effects", () => {
  it("no POST dependency is invoked and no write is attempted, on success or on failure", async () => {
    mockState.collections.videoVerifications = [teamVideoDoc("v1", { projectId: "p1" }), teamVideoDoc("v2")];
    mockState.collections.projects = [projectDoc("p1")];
    await get();
    await get("?scope=unfiled");
    await get("?scope=bogus");
    await get("?cursor=%%%bad");
    mockedAccess.mockResolvedValueOnce({ granted: false, reason: "membership_not_found" });
    await get();
    expectNoPostSideEffects();
  });
});
