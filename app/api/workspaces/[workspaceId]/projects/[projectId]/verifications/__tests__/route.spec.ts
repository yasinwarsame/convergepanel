/**
 * TEAM-VERIFICATION-PARITY-R3 —
 * `GET /api/workspaces/{W}/projects/{P}/verifications`. Real `getProject()`,
 * list helper and row validator against the in-memory Firestore fake;
 * identity and Team Workspace access are controlled boundaries.
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

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/verifications/route";
import { capabilitiesForRole } from "@/lib/workspaces/capabilities";
import { createFakeState, projectDoc, TEAM_W, teamClaimDoc } from "@/lib/workspaces/__tests__/teamClaimFakeFirestore";

const T = 1_700_000_000_000;
const P = "p1";
const grant = (role: "owner" | "admin" | "member" | "reviewer" | "viewer" = "member") => ({ granted: true, workspace: { id: TEAM_W, type: "team" }, membership: { role }, capabilities: [...capabilitiesForRole(role)] });
const PROJECT_NOT_FOUND = { status: 404, body: { ok: false, errorCode: "project_not_found", message: "This Project could not be found." } };

async function get(query = "", projectId = P, uid = "reader-b") {
  mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "authenticated", uid, source: "session_cookie" });
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/projects/${projectId}/verifications${query}`), { params: { workspaceId: TEAM_W, projectId } });
  return { status: res.status, body: await res.json() };
}
const ids = (body: any) => body.items.map((i: any) => i.verificationId);

beforeEach(() => {
  jest.clearAllMocks();
  mockState = createFakeState();
  mockState.collections.projects = [projectDoc(P)];
  mockedAccess.mockResolvedValue(grant());
});

describe("identity and Workspace authorization", () => {
  it("missing credentials -> 401 unauthorized (GET telemetry); invalid bearer -> 401 auth_error; neither reads anything", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    let res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/projects/${P}/verifications`), { params: { workspaceId: TEAM_W, projectId: P } });
    expect(res.status).toBe(401);
    expect((await res.json()).errorCode).toBe("unauthorized");
    expect(mockedLogIdentityResolutionFailure).toHaveBeenCalledWith({ route: "GET /api/workspaces/[workspaceId]/projects/[projectId]/verifications", method: "GET", failureCategory: "missing_credentials" });
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "invalid_bearer_token" });
    res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/projects/${P}/verifications`), { params: { workspaceId: TEAM_W, projectId: P } });
    expect((await res.json()).errorCode).toBe("auth_error");
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockState.docGets).toEqual([]);
  });

  it.each(["workspace_not_found", "membership_not_found", "membership_removed", "membership_malformed", "team_workspaces_disabled", "owner_integrity_violation"])("denial %s -> concealed 404 before any Project read", async (reason) => {
    mockedAccess.mockResolvedValueOnce({ granted: false, reason });
    const r = await get();
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe("team_workspace_not_found");
    expect(mockState.docGets).toEqual([]);
  });

  it("lookup_failed -> 503; missing research.read -> 403 before any Project read", async () => {
    mockedAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    expect((await get()).status).toBe(503);
    mockedAccess.mockResolvedValueOnce({ ...grant(), capabilities: ["workspace.read", "projects.read"] });
    expect((await get()).status).toBe(403);
    expect(mockState.docGets).toEqual([]);
  });

  it("research.read alone suffices: a viewer and a reviewer (no research.organize) read the Project list", async () => {
    mockState.collections.verifications = [teamClaimDoc("v", { projectId: P })];
    for (const role of ["viewer", "reviewer"] as const) {
      expect(capabilitiesForRole(role)).not.toContain("research.organize");
      mockedAccess.mockResolvedValueOnce(grant(role));
      expect(ids((await get()).body)).toEqual(["v"]);
    }
  });
});

describe("Project validation — exactly once, before the Claim query", () => {
  it("valid Project -> one Project document read, then the Project-scoped query", async () => {
    mockState.collections.verifications = [teamClaimDoc("v", { projectId: P })];
    const r = await get();
    expect(r.status).toBe(200);
    expect(mockState.docGets).toEqual([`projects/${P}`]);
    expect(mockState.getAllCalls).toEqual([]);
    expect(mockState.queries[0].filters).toEqual([{ field: "workspaceId", op: "==", value: TEAM_W }, { field: "projectId", op: "==", value: P }]);
  });

  it.each([
    ["not found", () => (mockState.collections.projects = [])],
    ["malformed", () => (mockState.collections.projects = [projectDoc(P, { status: "deleted" })])],
    ["embedded id mismatch", () => (mockState.collections.projects = [{ id: P, data: projectDoc("other").data }])],
    ["another Workspace's Project", () => (mockState.collections.projects = [projectDoc(P, { workspaceId: "ws-other" })])],
  ])("%s -> identical concealed project_not_found, no Claim query", async (_l, setup) => {
    setup();
    expect(await get()).toEqual(PROJECT_NOT_FOUND);
    expect(mockState.queries).toEqual([]);
  });

  it("Project read infrastructure failure -> 503, no Claim query", async () => {
    mockState.throwOnDocGetCollections.add("projects");
    const r = await get();
    expect(r.status).toBe(503);
    expect(r.body.errorCode).toBe("team_workspace_unavailable");
    expect(mockState.queries).toEqual([]);
  });

  it("an ARCHIVED Project stays readable, with its label on every item", async () => {
    mockState.collections.projects = [projectDoc(P, { status: "archived", name: "Old work" })];
    mockState.collections.verifications = [teamClaimDoc("v1", { projectId: P }, T + 1), teamClaimDoc("v2", { projectId: P }, T)];
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: any) => i.project)).toEqual([{ id: P, name: "Old work", status: "archived" }, { id: P, name: "Old work", status: "archived" }]);
  });
});

describe("Project list contract", () => {
  it("exact Project containment: Unfiled, other-Project, Personal and foreign rows are excluded; no creator filter", async () => {
    const personal = teamClaimDoc("personal", { projectId: P }, T + 9);
    delete personal.data.workspaceId;
    mockState.collections.verifications = [
      teamClaimDoc("mine-a", { projectId: P, userId: "creator-a" }, T + 5),
      teamClaimDoc("mine-b", { projectId: P, userId: "creator-c" }, T + 4),
      teamClaimDoc("unfiled", {}, T + 8),
      teamClaimDoc("other-project", { projectId: "p2" }, T + 7),
      teamClaimDoc("foreign", { workspaceId: "ws-other", projectId: P }, T + 6),
      personal,
    ];
    const r = await get();
    expect(ids(r.body)).toEqual(["mine-a", "mine-b"]);
    expect(JSON.stringify(mockState.queries)).not.toContain("userId");
    expect(r.body).not.toHaveProperty("scope");
  });

  it("empty Project -> ok, no items", async () => {
    expect((await get()).body).toEqual({ ok: true, items: [], hasMore: false });
  });

  it("pagination and malformed cursor", async () => {
    mockState.collections.verifications = Array.from({ length: 3 }, (_, i) => teamClaimDoc(`v${i}`, { projectId: P }, T + i * 1000));
    const p1 = await get("?limit=2");
    expect(ids(p1.body)).toEqual(["v2", "v1"]);
    const p2 = await get(`?limit=2&cursor=${p1.body.nextCursor}`);
    expect(ids(p2.body)).toEqual(["v0"]);
    expect((await get("?cursor=garbage!!")).body.errorCode).toBe("invalid_cursor");
  });

  it("malformed emitted row or malformed PEEK row -> 500, never a partial page", async () => {
    mockState.collections.verifications = [teamClaimDoc("good", { projectId: P }, T + 1), teamClaimDoc("bad", { projectId: P, userId: "" }, T)];
    expect((await get()).status).toBe(500);
    mockState.collections.verifications = [teamClaimDoc("a", { projectId: P }, T + 2), teamClaimDoc("peek", { projectId: P, timestamp: "not-a-timestamp" }, T + 1)];
    expect((await get("?limit=1")).status).toBe(500);
  });

  it("zero writes", async () => {
    mockState.collections.verifications = [teamClaimDoc("v", { projectId: P })];
    await get();
    expect(mockState.writeAttempts).toEqual([]);
  });
});
