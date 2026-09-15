/**
 * Project/Research Assignment — the three list ROUTES' handling of
 * `?assignee=me`: strict parsing (400 on anything else), the caller's OWN
 * uid substituted (never a query value), and the D4 empty view for a run
 * caller who lacks research.create. Everything below the route is mocked.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedRunAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockedRunAccess(...a) }));
const mockedWsAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({ resolveWorkspaceAccess: (...a: unknown[]) => mockedWsAccess(...a) }));
const mockedListWsRuns = jest.fn();
jest.mock("@/lib/workspaces/listTeamWorkspaceRuns", () => ({ listTeamWorkspaceRuns: (...a: unknown[]) => mockedListWsRuns(...a) }));
const mockedListProjectRuns = jest.fn();
jest.mock("@/lib/workspaces/listTeamProjectRuns", () => ({ listTeamProjectRuns: (...a: unknown[]) => mockedListProjectRuns(...a) }));
const mockedListProjects = jest.fn();
jest.mock("@/lib/projects/listTeamProjects", () => ({ listTeamProjects: (...a: unknown[]) => mockedListProjects(...a) }));
const mockedEnrich = jest.fn();
jest.mock("@/lib/workspaces/teamProjectAssigneeEnrichment", () => ({ enrichTeamProjectDtos: (...a: unknown[]) => mockedEnrich(...a) }));
const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...a: unknown[]) => mockedGetProject(...a), countProjectsInWorkspace: jest.fn() }));
jest.mock("@/lib/firestore/teamProjects", () => ({ createTeamProject: jest.fn() }));
jest.mock("@/lib/firestore/teamWorkspaceRuns", () => ({ createTeamWorkspaceRun: jest.fn() }));
jest.mock("@/lib/projects/projectEvents", () => ({ writeProjectEvent: jest.fn() }));
jest.mock("@/lib/security/rateLimit", () => ({ checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }) }));
jest.mock("@/lib/security/requestValidation", () => ({ validateRunPanelRequest: jest.fn(), validateRequestBodySize: jest.fn(), MAX_REQUEST_BODY_SIZE: 1 }));
jest.mock("@/lib/adaptiveSchema/orchestrate", () => ({ planAdaptiveRun: jest.fn() }));
jest.mock("@/lib/adaptiveSchema/analytics", () => ({ trackQueryClassified: jest.fn(), trackRoutingOutcome: jest.fn() }));
jest.mock("@/lib/stripe/subscriptionValidation", () => ({ validateUserSubscription: jest.fn() }));
jest.mock("@/lib/stripe/usageCheck", () => ({ checkAndIncrementUsageForRun: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/env", () => ({ TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined, ADAPTIVE_SCHEMAS_ENABLED: false, ADAPTIVE_SCHEMAS_CANARY_UIDS: undefined }));

import { NextRequest } from "next/server";
import { GET as wsRunsGet } from "@/app/api/workspaces/[workspaceId]/runs/route";
import { GET as projectRunsGet } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/runs/route";
import { GET as projectsGet } from "@/app/api/workspaces/[workspaceId]/projects/route";

const UID = "caller-1";
const WS_ID = "ws-team-1";
const P_ID = "proj-1";
const MEMBER_CAPS = ["workspace.read", "projects.read", "research.read", "research.create", "research.organize"];
const VIEWER_CAPS = ["workspace.read", "projects.read", "research.read"];
const access = (capabilities: string[]) => ({ granted: true, workspaceType: "team", workspace: { id: WS_ID, name: "Acme" }, membership: { role: "member" }, capabilities });
const req = (path: string) => new NextRequest(`http://localhost${path}`, { method: "GET" });

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedRunAccess.mockResolvedValue(access(MEMBER_CAPS));
  mockedWsAccess.mockResolvedValue(access(MEMBER_CAPS));
  mockedListWsRuns.mockResolvedValue({ status: "ok", items: [], hasMore: false });
  mockedListProjectRuns.mockResolvedValue({ status: "ok", items: [], hasMore: false });
  mockedListProjects.mockResolvedValue({ status: "ok", items: [], hasMore: false });
  mockedEnrich.mockResolvedValue([]);
  mockedGetProject.mockResolvedValue({ status: "found", project: { schemaVersion: 1, id: P_ID, workspaceId: WS_ID, name: "P", status: "active", createdByUserId: UID } });
});

describe("GET /workspaces/{W}/runs", () => {
  it("`?assignee=me` ⇒ the CALLER's uid is substituted; a uid value / duplicate ⇒ 400 and no query", async () => {
    await wsRunsGet(req(`/api/workspaces/${WS_ID}/runs?assignee=me`), { params: { workspaceId: WS_ID } });
    expect(mockedListWsRuns).toHaveBeenCalledWith(expect.objectContaining({ assigneeUid: UID }));
    for (const q of ["assignee=other-uid", "assignee=", "assignee=me&assignee=me"]) {
      mockedListWsRuns.mockClear();
      const res = await wsRunsGet(req(`/api/workspaces/${WS_ID}/runs?${q}`), { params: { workspaceId: WS_ID } });
      expect(res.status).toBe(400);
      expect((await res.json()).errorCode).toBe("invalid_assignee_filter");
      expect(mockedListWsRuns).not.toHaveBeenCalled();
    }
  });
  it("no filter ⇒ assigneeUid is undefined (no predicate)", async () => {
    await wsRunsGet(req(`/api/workspaces/${WS_ID}/runs`), { params: { workspaceId: WS_ID } });
    expect(mockedListWsRuns.mock.calls[0][0].assigneeUid).toBeUndefined();
  });
  it("D4 — a Viewer (no research.create) asking `?assignee=me` gets a definitively EMPTY 200 with NO query (positive control: a Member queries)", async () => {
    mockedRunAccess.mockResolvedValue(access(VIEWER_CAPS));
    const res = await wsRunsGet(req(`/api/workspaces/${WS_ID}/runs?assignee=me&scope=unfiled`), { params: { workspaceId: WS_ID } });
    expect(await res.json()).toEqual({ ok: true, items: [], hasMore: false, scope: "unfiled" });
    expect(mockedListWsRuns).not.toHaveBeenCalled();
    // The SAME viewer without the filter still sees the list (assignment never narrows read access).
    await wsRunsGet(req(`/api/workspaces/${WS_ID}/runs`), { params: { workspaceId: WS_ID } });
    expect(mockedListWsRuns).toHaveBeenCalledTimes(1);
  });
});

describe("GET /workspaces/{W}/projects/{P}/runs", () => {
  it("substitutes the caller uid; rejects other values; D4 empty view for a Viewer", async () => {
    await projectRunsGet(req(`/api/workspaces/${WS_ID}/projects/${P_ID}/runs?assignee=me`), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(mockedListProjectRuns).toHaveBeenCalledWith(expect.objectContaining({ assigneeUid: UID }));
    const bad = await projectRunsGet(req(`/api/workspaces/${WS_ID}/projects/${P_ID}/runs?assignee=${UID}`), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(bad.status).toBe(400);
    mockedListProjectRuns.mockClear();
    mockedRunAccess.mockResolvedValue(access(VIEWER_CAPS));
    const res = await projectRunsGet(req(`/api/workspaces/${WS_ID}/projects/${P_ID}/runs?assignee=me`), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(await res.json()).toEqual({ ok: true, items: [], hasMore: false });
    expect(mockedListProjectRuns).not.toHaveBeenCalled();
  });
});

describe("GET /workspaces/{W}/projects", () => {
  it("substitutes the caller uid (any active member is an eligible Project assignee — even a Viewer queries); rejects other values; items are ENRICHED", async () => {
    mockedWsAccess.mockResolvedValue(access(VIEWER_CAPS));
    mockedListProjects.mockResolvedValue({ status: "ok", items: [{ project: { id: "p1" }, documentUpdateTime: null }], hasMore: false });
    mockedEnrich.mockResolvedValue([{ id: "p1", assignees: [{ uid: UID, displayName: "Me", state: "active" }] }]);
    const res = await projectsGet(req(`/api/workspaces/${WS_ID}/projects?assignee=me`), { params: { workspaceId: WS_ID } });
    expect(mockedListProjects).toHaveBeenCalledWith(expect.objectContaining({ assigneeUid: UID, status: "active" }));
    expect((await res.json()).items[0].assignees[0].displayName).toBe("Me");
    expect(mockedEnrich).toHaveBeenCalledWith(WS_ID, [{ project: { id: "p1" }, documentUpdateTime: null }]);
    const bad = await projectsGet(req(`/api/workspaces/${WS_ID}/projects?assignee=nope`), { params: { workspaceId: WS_ID } });
    expect(bad.status).toBe(400);
  });
});
