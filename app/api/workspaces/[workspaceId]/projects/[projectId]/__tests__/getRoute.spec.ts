/**
 * ZCA L-5 — `GET /api/workspaces/[workspaceId]/projects/[projectId]` (D-4 E-b). Ports the Project gate of
 * the seven former Team Project Server Components: access → view capability → getProject → containment,
 * in that order, every denial the same 404, every transient failure the same generic 503.
 */
const mockResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockResolveWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({ resolveWorkspaceAccess: (...a: unknown[]) => mockResolveWorkspaceAccess(...a) }));
const mockGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...a: unknown[]) => mockGetProject(...a) }));
// PR #164 review C1 — the assignee presentation must degrade, never crash.
const mockDisplayNames = jest.fn();
jest.mock("@/lib/workspaces/workspaceReviewerIdentity", () => ({
  REVIEWER_UNAVAILABLE_LABEL: "Unavailable reviewer",
  resolveWorkspaceReviewerDisplayNames: (...a: unknown[]) => mockDisplayNames(...a),
}));
jest.mock("@/lib/firebase/admin", () => ({ adminDb: {}, adminAuth: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/route";

const WS = "ws-1";
const PROJECT = "proj-7";
const call = (opts: { ws?: string; p?: string; include?: string } = {}) => {
  const ws = opts.ws ?? WS;
  const p = opts.p ?? PROJECT;
  const q = opts.include ? `?include=${opts.include}` : "";
  return GET(new NextRequest(`http://localhost/api/workspaces/${ws}/projects/${p}${q}`), { params: { workspaceId: ws, projectId: p } });
};
const authed = (uid = "u1") => mockResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid, source: "bearer_token" });
const team = (capabilities: string[] = ["workspace.read", "projects.read", "research.read"]) => ({ granted: true, workspaceType: "team", workspace: { id: WS, name: "Acme" }, membership: { role: "viewer" }, capabilities });
const found = (over: Record<string, unknown> = {}) => ({ status: "found", project: { id: PROJECT, workspaceId: WS, name: "ABC Acquisition", status: "active", assigneeUids: [], ...over } });

beforeEach(() => jest.clearAllMocks());

describe("identity", () => {
  it.each(["missing_credentials", "invalid_bearer_token", "revoked_session", "expired_session"])("%s → 401, nothing looked up", async (reason) => {
    mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason });
    expect((await call()).status).toBe(401);
    expect(mockResolveWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockGetProject).not.toHaveBeenCalled();
  });
  it("a verifier outage → 503, nothing looked up", async () => {
    mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "auth_unavailable" });
    expect((await call()).status).toBe(503);
    expect(mockGetProject).not.toHaveBeenCalled();
  });
});

describe("gate order: the Project is never looked up for a caller the pages refused", () => {
  it("access denied → 404 and getProject is never called", async () => {
    authed();
    mockResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    expect((await call()).status).toBe(404);
    expect(mockGetProject).not.toHaveBeenCalled();
  });
  it("a Personal workspace → 404 and getProject is never called", async () => {
    authed();
    mockResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "personal", workspace: { id: WS } });
    expect((await call()).status).toBe(404);
    expect(mockGetProject).not.toHaveBeenCalled();
  });
  it("a member holding NONE of the Project-page view capabilities → 404 and getProject is never called", async () => {
    authed();
    mockResolveWorkspaceAccess.mockResolvedValue(team(["workspace.read", "members.read"]));
    expect((await call()).status).toBe(404);
    expect(mockGetProject).not.toHaveBeenCalled();
  });
  it.each([["projects.read"], ["research.read"], ["research.create"]])("%s alone is enough to look the Project up", async (cap) => {
    authed();
    mockResolveWorkspaceAccess.mockResolvedValue(team([cap]));
    mockGetProject.mockResolvedValue(found());
    expect((await call()).status).toBe(200);
  });
  it("access is resolved for the BEARER's uid; getProject is called with exactly the route's projectId", async () => {
    authed("u-bearer");
    mockResolveWorkspaceAccess.mockResolvedValue(team());
    mockGetProject.mockResolvedValue(found());
    await call();
    expect(mockResolveWorkspaceAccess).toHaveBeenCalledWith({ uid: "u-bearer", workspaceId: WS });
    expect(mockGetProject).toHaveBeenCalledWith(PROJECT);
  });
});

describe("concealment and transient failures", () => {
  it("not found, malformed and ANOTHER Workspace's Project answer byte-identical 404s", async () => {
    authed();
    mockResolveWorkspaceAccess.mockResolvedValue(team());
    const bodies: string[] = [];
    for (const r of [{ status: "not_found" }, { status: "malformed" }, found({ workspaceId: "other-ws" })]) {
      mockGetProject.mockResolvedValueOnce(r);
      const res = await call();
      expect(res.status).toBe(404);
      bodies.push(await res.text());
    }
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_not_found" });
    const denied = await call();
    bodies.push(await denied.text());
    expect(new Set(bodies).size).toBe(1);
  });
  it("lookup_failed, firestore_unavailable and read_failed answer the same generic 503, naming no id or store", async () => {
    authed();
    const bodies: string[] = [];
    mockResolveWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    bodies.push(await (await call()).text());
    for (const s of ["firestore_unavailable", "read_failed"]) {
      mockResolveWorkspaceAccess.mockResolvedValueOnce(team());
      mockGetProject.mockResolvedValueOnce({ status: s });
      const res = await call();
      expect(res.status).toBe(503);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(new RegExp(`${PROJECT}|${WS}`));
    expect(bodies[0].toLowerCase()).not.toMatch(/firestore|project/);
  });
  it("an ARCHIVED Project is returned with its status (the creation pages' active rule is applied by the client)", async () => {
    authed();
    mockResolveWorkspaceAccess.mockResolvedValue(team());
    mockGetProject.mockResolvedValue(found({ status: "archived" }));
    await expect((await call()).json()).resolves.toEqual({ ok: true, project: { id: PROJECT, name: "ABC Acquisition", status: "archived" } });
  });
});

describe("assignees (the Project detail page's read-only chips)", () => {
  it("are omitted unless requested", async () => {
    authed();
    mockResolveWorkspaceAccess.mockResolvedValue(team());
    mockGetProject.mockResolvedValue(found({ assigneeUids: ["member-1"] }));
    const body = await (await call()).json();
    expect(body.project).not.toHaveProperty("assignees");
    expect(mockDisplayNames).not.toHaveBeenCalled();
  });
  it("are omitted for a caller without projects.read, even when requested", async () => {
    authed();
    mockResolveWorkspaceAccess.mockResolvedValue(team(["research.read"]));
    mockGetProject.mockResolvedValue(found({ assigneeUids: ["member-1"] }));
    const body = await (await call({ include: "assignees" })).json();
    expect(body.project).not.toHaveProperty("assignees");
  });
  it("a rejecting name resolver degrades to the fallback label + stale, never a crash (positive control: a healthy resolver names them)", async () => {
    authed();
    mockResolveWorkspaceAccess.mockResolvedValue(team());
    mockGetProject.mockResolvedValue(found({ assigneeUids: ["member-1"] }));
    mockDisplayNames.mockRejectedValueOnce(new Error("UNAVAILABLE"));
    const degraded = await (await call({ include: "assignees" })).json();
    expect(degraded.project.assignees).toEqual([{ uid: "member-1", displayName: "Unavailable reviewer", state: "stale" }]);
    mockDisplayNames.mockResolvedValueOnce(new Map([["member-1", "Bao"]]));
    const healthy = await (await call({ include: "assignees" })).json();
    expect(healthy.project.assignees[0].displayName).toBe("Bao");
  });
  it("every answer is private, no-store", async () => {
    authed();
    mockResolveWorkspaceAccess.mockResolvedValue(team());
    mockGetProject.mockResolvedValue(found());
    expect((await call()).headers.get("Cache-Control")).toBe("private, no-store");
  });
});
