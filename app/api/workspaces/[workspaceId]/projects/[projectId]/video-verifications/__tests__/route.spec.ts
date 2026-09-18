/**
 * TEAM-VERIFICATION-PARITY-R5-I1 §AE —
 * `GET /api/workspaces/{W}/projects/{P}/video-verifications`.
 *
 * Proves: Workspace authorization then `research.read` only (never
 * `research.organize`), exactly ONE Project lookup at the route and none
 * inside the list helper, concealment of missing/malformed/cross-Workspace
 * Projects, a distinguishable 503 for a Project READ failure, archived
 * Projects still readable, exact Project-scoped query, pagination, and zero
 * writes.
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
const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...a: unknown[]) => mockedGetProject(...a) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/video-verifications/route";
import { capabilitiesForRole } from "@/lib/workspaces/capabilities";
import { createFakeState, TEAM_W, teamVideoDoc, personalVideoDoc } from "@/lib/workspaces/__tests__/teamVideoFakeFirestore";

const T = 1_700_000_000_000;
const P = "p1";
const grant = (role: "owner" | "admin" | "member" | "reviewer" | "viewer" = "member") => ({ granted: true, workspace: { id: TEAM_W, type: "team" }, membership: { role }, capabilities: [...capabilitiesForRole(role)] });
const foundProject = (overrides: Record<string, unknown> = {}) => ({ status: "found", project: { id: P, workspaceId: TEAM_W, name: "Project p1", status: "active", ...overrides } });

async function get(query = "", uid = "reader-b", projectId = P) {
  mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "authenticated", uid, source: "session_cookie" });
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/projects/${projectId}/video-verifications${query}`), { params: { workspaceId: TEAM_W, projectId } });
  return { status: res.status, body: await res.json() };
}
const ids = (body: any) => body.items.map((i: any) => i.verificationId);

beforeEach(() => {
  jest.clearAllMocks();
  mockState = createFakeState();
  mockedAccess.mockResolvedValue(grant());
  mockedGetProject.mockResolvedValue(foundProject());
});

describe("identity and Workspace authorization", () => {
  it("missing credentials -> 401 unauthorized, no access or Project lookup", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/projects/${P}/video-verifications`), { params: { workspaceId: TEAM_W, projectId: P } });
    expect(res.status).toBe(401);
    expect((await res.json()).errorCode).toBe("unauthorized");
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("an auth resolver failure -> 401 auth_error", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "revoked_session" });
    const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/projects/${P}/video-verifications`), { params: { workspaceId: TEAM_W, projectId: P } });
    expect((await res.json()).errorCode).toBe("auth_error");
  });

  it.each(["team_workspaces_disabled", "workspace_not_found", "wrong_workspace_type", "membership_not_found", "membership_removed", "owner_integrity_violation"])("denial %s -> concealed 404 before any Project lookup", async (reason) => {
    mockedAccess.mockResolvedValueOnce({ granted: false, reason });
    const r = await get();
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe("team_workspace_not_found");
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("lookup_failed -> 503", async () => {
    mockedAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    expect((await get()).status).toBe(503);
  });

  it("granted without research.read -> 403, no Project lookup, no query", async () => {
    mockedAccess.mockResolvedValueOnce({ ...grant(), capabilities: ["workspace.read"] });
    const r = await get();
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe("insufficient_capability");
    expect(mockedGetProject).not.toHaveBeenCalled();
    expect(mockState.queries).toEqual([]);
  });
});

describe("research.organize is NEVER required to read", () => {
  it.each(["owner", "admin", "member", "reviewer", "viewer"] as const)("role %s reads the Project's Videos", async (role) => {
    mockState.collections.videoVerifications = [teamVideoDoc("vid-1", { projectId: P })];
    mockedAccess.mockResolvedValueOnce(grant(role));
    const r = await get();
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual(["vid-1"]);
  });

  it("a caller holding research.read but NOT research.organize still reads", async () => {
    mockState.collections.videoVerifications = [teamVideoDoc("vid-1", { projectId: P })];
    mockedAccess.mockResolvedValueOnce({ ...grant(), capabilities: ["research.read"] });
    expect((await get()).status).toBe(200);
  });

  it("reviewer and viewer genuinely lack research.organize (the gate above is not vacuous)", () => {
    for (const role of ["reviewer", "viewer"] as const) {
      expect([...capabilitiesForRole(role)]).not.toContain("research.organize");
      expect([...capabilitiesForRole(role)]).toContain("research.read");
    }
  });
});

describe("Project resolution", () => {
  it("the addressed Project is looked up exactly once, and never again inside the list helper", async () => {
    mockState.collections.videoVerifications = [teamVideoDoc("vid-1", { projectId: P }), teamVideoDoc("vid-2", { projectId: P })];
    await get();
    expect(mockedGetProject).toHaveBeenCalledTimes(1);
    expect(mockedGetProject).toHaveBeenCalledWith(P);
    expect(mockState.getAllCalls).toEqual([]);
    expect(mockState.docGets.filter((p) => p.startsWith("projects/"))).toEqual([]);
  });

  it.each(["not_found", "malformed"])("a %s Project -> concealed 404, no query", async (status) => {
    mockedGetProject.mockResolvedValueOnce({ status });
    const r = await get();
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe("project_not_found");
    expect(mockState.queries).toEqual([]);
  });

  it("a cross-Workspace Project -> concealed 404, identical to not_found", async () => {
    mockedGetProject.mockResolvedValueOnce(foundProject({ workspaceId: "ws-other" }));
    const r = await get();
    expect(r).toEqual({ status: 404, body: { ok: false, errorCode: "project_not_found", message: "This Project could not be found." } });
    expect(mockState.queries).toEqual([]);
  });

  it.each(["firestore_unavailable", "read_failed"])("a Project READ infrastructure failure (%s) -> 503, distinct from not_found", async (status) => {
    mockedGetProject.mockResolvedValueOnce({ status });
    const r = await get();
    expect(r.status).toBe(503);
    expect(r.body.errorCode).toBe("team_workspace_unavailable");
  });

  it("an ACTIVE Project is readable and its label is returned", async () => {
    mockState.collections.videoVerifications = [teamVideoDoc("vid-1", { projectId: P })];
    const r = await get();
    expect(r.body.items[0].project).toEqual({ id: P, name: "Project p1", status: "active" });
  });

  it("an ARCHIVED Project stays readable and reports its real status", async () => {
    mockedGetProject.mockResolvedValueOnce(foundProject({ status: "archived" }));
    mockState.collections.videoVerifications = [teamVideoDoc("vid-1", { projectId: P })];
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.items[0].project).toEqual({ id: P, name: "Project p1", status: "archived" });
  });
});

describe("query and containment", () => {
  it("queries the exact Workspace AND Project with timestamp/document-id ordering and no creator predicate", async () => {
    mockState.collections.videoVerifications = [teamVideoDoc("vid-1", { projectId: P })];
    await get();
    expect(mockState.queries).toEqual([
      {
        collection: "videoVerifications",
        filters: [{ field: "workspaceId", op: "==", value: TEAM_W }, { field: "projectId", op: "==", value: P }],
        orders: [{ field: "timestamp", dir: "desc" }, { field: "__name__", dir: "desc" }],
        limit: 21,
      },
    ]);
    expect(JSON.stringify(mockState.queries)).not.toContain("userId");
  });

  it("Videos filed elsewhere, unfiled Videos, foreign-Workspace and Personal rows never appear", async () => {
    mockState.collections.videoVerifications = [
      teamVideoDoc("mine", { projectId: P }, T + 5),
      teamVideoDoc("other-project", { projectId: "p2" }, T + 4),
      teamVideoDoc("unfiled", {}, T + 3),
      teamVideoDoc("foreign", { workspaceId: "ws-other", projectId: P }, T + 2),
      personalVideoDoc("personal", {}, T + 1),
    ];
    expect(ids((await get()).body)).toEqual(["mine"]);
  });

  it("a row whose own projectId contradicts the address fails the WHOLE page", async () => {
    mockState.ignoreQueryFilters = true;
    mockState.collections.videoVerifications = [teamVideoDoc("mismatch", { projectId: "p2" })];
    const r = await get();
    expect(r).toEqual({ status: 500, body: { ok: false, errorCode: "internal_error", message: "Something went wrong. Please try again." } });
  });

  it("a malformed row fails the whole page, never a partial one", async () => {
    mockState.collections.videoVerifications = [teamVideoDoc("good", { projectId: P }, T + 1), teamVideoDoc("bad", { projectId: P, verdict: "nope" }, T)];
    expect((await get()).status).toBe(500);
  });
});

describe("pagination", () => {
  it("limit defaults to 20 and clamps to [1, 50]", async () => {
    await get();
    await get("?limit=0");
    await get("?limit=500");
    expect(mockState.queries.map((q) => q.limit)).toEqual([21, 21, 51]);
  });

  it("pages with an opaque cursor; hasMore true always carries one; a malformed cursor is 400 before any query", async () => {
    mockState.collections.videoVerifications = Array.from({ length: 3 }, (_, i) => teamVideoDoc(`v${i}`, { projectId: P }, T + i * 1000));
    const p1 = await get("?limit=2");
    expect(ids(p1.body)).toEqual(["v2", "v1"]);
    expect(p1.body.hasMore).toBe(true);
    expect(typeof p1.body.nextCursor).toBe("string");
    const p2 = await get(`?limit=2&cursor=${p1.body.nextCursor}`);
    expect(ids(p2.body)).toEqual(["v0"]);
    expect(p2.body.hasMore).toBe(false);

    mockState.queries.length = 0;
    expect(await get("?cursor=%%%bad")).toEqual({ status: 400, body: { ok: false, errorCode: "invalid_cursor", message: "This page link is no longer valid." } });
    expect(mockState.queries).toEqual([]);
  });

  it("the Project list response carries no redundant scope field", async () => {
    expect("scope" in (await get()).body).toBe(false);
  });
});

describe("zero side effects", () => {
  it("no write is attempted on any path", async () => {
    mockState.collections.videoVerifications = [teamVideoDoc("vid-1", { projectId: P })];
    await get();
    mockedGetProject.mockResolvedValueOnce({ status: "not_found" });
    await get();
    await get("?cursor=%%%bad");
    expect(mockState.writeAttempts).toEqual([]);
  });

  it("never exposes the uploader uid, email or token accounting", async () => {
    mockState.collections.videoVerifications = [teamVideoDoc("vid-1", { projectId: P, userId: "uploader-secret-uid" })];
    const json = JSON.stringify((await get()).body);
    for (const leaked of ["uploader-secret-uid", "userId", "userEmail", "totalTokens", "modelResults"]) {
      expect(json).not.toContain(leaked);
    }
  });
});
