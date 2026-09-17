/**
 * TEAM-VERIFICATION-PARITY-R3 — `GET /api/workspaces/{W}/verifications`
 * (Workspace and `?scope=unfiled` Team Claim lists). The REAL list helper and
 * row validator run against the in-memory Firestore fake; identity and Team
 * Workspace access are controlled boundaries. Every POST-only dependency
 * (execution, quota, tokens, governance, Gate 1/2, rate limit) is a throwing
 * spy, so any read that reached one fails here.
 */

jest.mock("firebase-admin/firestore", () => require("@/lib/workspaces/__tests__/teamClaimFakeFirestore").fakeFirestoreModule);
let mockState: import("@/lib/workspaces/__tests__/teamClaimFakeFirestore").FakeState;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    const { makeFakeDb } = require("@/lib/workspaces/__tests__/teamClaimFakeFirestore");
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
jest.mock("@/lib/env", () => ({ OPENAI_API_KEY: "t", ANTHROPIC_API_KEY: "t", XAI_API_KEY: "t", PERPLEXITY_API_KEY: "t", GEMINI_API_KEY: "t", TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined }));

const mockPostOnly = (name: string) => jest.fn(() => { throw new Error(`POST-only dependency reached from a GET: ${name}`); });
const mockedRateLimit = mockPostOnly("rateLimit");
const mockedGate1 = mockPostOnly("gate1");
const mockedGate2 = mockPostOnly("gate2");
const mockedSubscription = mockPostOnly("subscription");
const mockedUsage = mockPostOnly("usage");
const mockedPanel = mockPostOnly("runClaimVerificationPanel");
const mockedTokens = mockPostOnly("tokens");
const mockedGovernance = mockPostOnly("evaluateAndStoreGovernance");
const mockedTeamPipeline = mockPostOnly("applyTeamGovernancePipeline");
const mockedOrigin = mockPostOnly("resolveClaimVerificationOrigin");
jest.mock("@/lib/security/rateLimit", () => ({ checkRateLimit: (...a: unknown[]) => (mockedRateLimit as any)(...a) }));
jest.mock("@/lib/firestore/teamClaimVerifications", () => ({ authorizeTeamClaimVerificationAdmission: (...a: unknown[]) => (mockedGate1 as any)(...a), saveTeamClaimVerification: (...a: unknown[]) => (mockedGate2 as any)(...a) }));
jest.mock("@/lib/stripe/subscriptionValidation", () => ({ validateUserSubscription: (...a: unknown[]) => (mockedSubscription as any)(...a) }));
jest.mock("@/lib/stripe/usageCheck", () => ({ checkAndIncrementUsageForRun: (...a: unknown[]) => (mockedUsage as any)(...a) }));
jest.mock("@/lib/verification/runClaimVerificationPanel", () => ({ runClaimVerificationPanel: (...a: unknown[]) => (mockedPanel as any)(...a) }));
jest.mock("@/lib/firestore/userTokens", () => ({ incrementUserTokenUsage: (...a: unknown[]) => (mockedTokens as any)(...a) }));
jest.mock("@/lib/governance/evaluateAndStore", () => ({ evaluateAndStoreGovernance: (...a: unknown[]) => (mockedGovernance as any)(...a) }));
jest.mock("@/lib/governance/teamGovernancePipeline", () => ({ applyTeamGovernancePipeline: (...a: unknown[]) => (mockedTeamPipeline as any)(...a), mergeGovernanceIntoBody: (b: unknown) => b }));
jest.mock("@/lib/verification/claimVerificationOrigin", () => ({ resolveClaimVerificationOrigin: (...a: unknown[]) => (mockedOrigin as any)(...a) }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/verifications/route";
import { capabilitiesForRole } from "@/lib/workspaces/capabilities";
import { createFakeState, projectDoc, TEAM_W, teamClaimDoc } from "@/lib/workspaces/__tests__/teamClaimFakeFirestore";

const T = 1_700_000_000_000;
const grant = (role: "owner" | "admin" | "member" | "reviewer" | "viewer" = "member") => ({ granted: true, workspace: { id: TEAM_W, type: "team" }, membership: { role }, capabilities: [...capabilitiesForRole(role)] });

async function get(query = "", uid = "reader-b") {
  mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "authenticated", uid, source: "session_cookie" });
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/verifications${query}`), { params: { workspaceId: TEAM_W } });
  return { status: res.status, body: await res.json() };
}
const ids = (body: any) => body.items.map((i: any) => i.verificationId);

function expectNoPostSideEffects() {
  for (const spy of [mockedRateLimit, mockedGate1, mockedGate2, mockedSubscription, mockedUsage, mockedPanel, mockedTokens, mockedGovernance, mockedTeamPipeline, mockedOrigin]) {
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
    const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/verifications`), { params: { workspaceId: TEAM_W } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, errorCode: "unauthorized", message: "Please sign in." });
    expect(mockedLogIdentityResolutionFailure).toHaveBeenCalledWith({ route: "GET /api/workspaces/[workspaceId]/verifications", method: "GET", failureCategory: "missing_credentials" });
    expect(mockedAccess).not.toHaveBeenCalled();
  });

  it.each(["invalid_bearer_token", "revoked_session", "credential_mismatch", "expired_session"])("%s -> 401 auth_error, no access lookup", async (reason) => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason });
    const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/verifications`), { params: { workspaceId: TEAM_W } });
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

  it.each(["owner", "admin", "member", "reviewer", "viewer"] as const)("role %s (carries research.read) reads the same Claims", async (role) => {
    mockState.collections.verifications = [teamClaimDoc("v1", { userId: "creator-a" })];
    mockedAccess.mockResolvedValueOnce(grant(role));
    const r = await get();
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual(["v1"]);
  });

  it("a member other than the creator reads the creator's Claim; the creator who lost membership is concealed", async () => {
    mockState.collections.verifications = [teamClaimDoc("v1", { userId: "creator-a" })];
    expect(ids((await get("", "reader-b")).body)).toEqual(["v1"]);
    mockedAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    expect((await get("", "creator-a")).status).toBe(404);
  });
});

describe("list contract", () => {
  it("all scope: 200 with items, hasMore, scope, newest first; Personal and foreign rows never appear", async () => {
    const personal = teamClaimDoc("personal", {}, T + 9);
    delete personal.data.workspaceId;
    delete personal.data.projectId;
    mockState.collections.verifications = [teamClaimDoc("old", {}, T), teamClaimDoc("new", { projectId: "p1" }, T + 5), personal, teamClaimDoc("foreign", { workspaceId: "ws-other" }, T + 7)];
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
    mockState.collections.verifications = [teamClaimDoc("unfiled"), teamClaimDoc("filed", { projectId: "p1" })];
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

  it("limit defaults to 20, clamps to [1, 50]", async () => {
    await get();
    await get("?limit=0");
    await get("?limit=500");
    await get("?limit=nope");
    expect(mockState.queries.map((q) => q.limit)).toEqual([21, 21, 51, 21]);
  });

  it("pagination: nextCursor resumes; a malformed cursor is 400 invalid_cursor", async () => {
    mockState.collections.verifications = Array.from({ length: 3 }, (_, i) => teamClaimDoc(`v${i}`, {}, T + i * 1000));
    const p1 = await get("?limit=2");
    expect(ids(p1.body)).toEqual(["v2", "v1"]);
    expect(p1.body.hasMore).toBe(true);
    const p2 = await get(`?limit=2&cursor=${p1.body.nextCursor}`);
    expect(ids(p2.body)).toEqual(["v0"]);
    expect(p2.body.hasMore).toBe(false);
    expect("nextCursor" in p2.body).toBe(false);
    expect(await get("?cursor=%%%bad")).toEqual({ status: 400, body: { ok: false, errorCode: "invalid_cursor", message: "This page link is no longer valid." } });
  });

  it("integrity violation or infrastructure failure -> 500 internal_error, never a partial page", async () => {
    mockState.collections.verifications = [teamClaimDoc("good", {}, T + 1), teamClaimDoc("bad", { type: "video_verification" }, T)];
    expect(await get()).toEqual({ status: 500, body: { ok: false, errorCode: "internal_error", message: "Something went wrong. Please try again." } });
    mockState.collections.verifications = [teamClaimDoc("x", { projectId: "p-foreign" })];
    mockState.collections.projects = [projectDoc("p-foreign", { workspaceId: "ws-other" })];
    expect((await get()).status).toBe(500);
    mockState.throwOnQuery = true;
    expect((await get()).status).toBe(500);
  });

  it("response JSON never exposes creator uid, raw timestamps or capability/membership data", async () => {
    mockState.collections.verifications = [teamClaimDoc("v", { userId: "creator-secret-uid" })];
    const json = JSON.stringify((await get()).body);
    for (const leaked of ["creator-secret-uid", "userId", "capabilities", "membership", "seconds", "nanoseconds", "modelResults", "auditBundle"]) {
      expect(json).not.toContain(leaked);
    }
  });
});
