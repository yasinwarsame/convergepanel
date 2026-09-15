/**
 * PR #164 review C1 (route level) — a canonical mutation that has ALREADY
 * COMMITTED must still be reported as success when the secondary assignee
 * presentation enrichment fails afterward. Uses the REAL enrichment +
 * presentation modules with injected failures beneath them (a rejecting
 * name resolver and a rejecting membership batch read). Covers: Team
 * Project create (201), the Project-assignee mutation (200, changed:true),
 * archive (200), and the list read (200). The canonical mutation is never
 * repeated to recover presentation data.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedResolveWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({ resolveWorkspaceAccess: (...a: unknown[]) => mockedResolveWorkspaceAccess(...a) }));
const mockedListTeamProjects = jest.fn();
jest.mock("@/lib/projects/listTeamProjects", () => ({ listTeamProjects: (...a: unknown[]) => mockedListTeamProjects(...a) }));
const mockedCreateTeamProject = jest.fn();
const mockedUpdateTeamProjectFields = jest.fn();
jest.mock("@/lib/firestore/teamProjects", () => ({ createTeamProject: (...a: unknown[]) => mockedCreateTeamProject(...a), updateTeamProjectFields: (...a: unknown[]) => mockedUpdateTeamProjectFields(...a) }));
jest.mock("@/lib/firestore/projects", () => ({ countProjectsInWorkspace: jest.fn().mockResolvedValue({ status: "ok", count: 0 }), getProject: jest.fn() }));
jest.mock("@/lib/projects/projectEvents", () => ({ writeProjectEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/security/rateLimit", () => ({ checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// Failure injection BENEATH the real presentation layer.
let getAllShouldThrow = true;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {
      collection: (name: string) => ({ doc: (id: string) => ({ __collection: name, __id: id }) }),
      getAll: () => (getAllShouldThrow ? Promise.reject(new Error("UNAVAILABLE")) : Promise.resolve([])),
    };
  },
}));
const mockNames = jest.fn();
jest.mock("@/lib/workspaces/workspaceReviewerIdentity", () => ({
  REVIEWER_UNAVAILABLE_LABEL: "Unavailable reviewer",
  resolveWorkspaceReviewerDisplayNames: (...a: unknown[]) => mockNames(...a),
}));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET as listGet, POST as createPost } from "@/app/api/workspaces/[workspaceId]/projects/route";
import { POST as assigneesPost } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/assignees/route";
import { POST as archivePost } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/archive/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const TOKEN = { seconds: 1_700_000_000, nanoseconds: 0 };
const project = (assigneeUids: string[] = ["member-1"]) => ({ schemaVersion: 1, id: "p1", workspaceId: WS_ID, name: "P", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), assigneeUids });
const req = (method: string, path: string, body?: unknown) => new NextRequest(`http://localhost${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const degraded = [{ uid: "member-1", displayName: "Unavailable reviewer", state: "stale" }];

beforeEach(() => {
  jest.clearAllMocks();
  getAllShouldThrow = true;
  mockNames.mockRejectedValue(new Error("UNAVAILABLE: simulated resolver failure"));
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "team", workspace: { id: WS_ID, name: "Acme" }, membership: { role: "owner" }, capabilities: ["workspace.read", "projects.read", "projects.create", "projects.manage", "research.read"] });
});

it("an already-committed Team Project CREATE is still 201 when enrichment fails afterward; createTeamProject is called exactly once (never repeated)", async () => {
  mockedCreateTeamProject.mockResolvedValue({ status: "created", project: project([]), documentUpdateTime: Timestamp.now() });
  const res = await createPost(req("POST", `/api/workspaces/${WS_ID}/projects`, { name: "New" }), { params: { workspaceId: WS_ID } });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.project.assignees).toEqual([]);
  expect(mockedCreateTeamProject).toHaveBeenCalledTimes(1);
});

it("an already-committed Project-assignee mutation is still 200 changed:true (degraded presentation, never a retryable failure)", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "updated", project: project(), documentUpdateTime: Timestamp.now() });
  const res = await assigneesPost(req("POST", `/api/workspaces/${WS_ID}/projects/p1/assignees`, { assigneeUids: ["member-1"], expectedUpdateTime: TOKEN }), { params: { workspaceId: WS_ID, projectId: "p1" } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, changed: true });
  expect(body.project.assignees).toEqual(degraded);
  expect(mockedUpdateTeamProjectFields).toHaveBeenCalledTimes(1);
});

it("an already-committed archive is still 200 with degraded assignees", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "updated", project: { ...project(), status: "archived" }, documentUpdateTime: Timestamp.now() });
  const res = await archivePost(req("POST", `/api/workspaces/${WS_ID}/projects/p1/archive`, { expectedUpdateTime: TOKEN }), { params: { workspaceId: WS_ID, projectId: "p1" } });
  expect(res.status).toBe(200);
  expect((await res.json()).project.assignees).toEqual(degraded);
});

it("the Project LIST read does not crash: 200 with every row's assignees degraded to the fallback label + stale", async () => {
  mockedListTeamProjects.mockResolvedValue({ status: "ok", items: [{ project: project(), documentUpdateTime: Timestamp.now() }, { project: { ...project(["member-1", "member-2"]), id: "p2" }, documentUpdateTime: Timestamp.now() }], hasMore: false });
  const res = await listGet(req("GET", `/api/workspaces/${WS_ID}/projects`), { params: { workspaceId: WS_ID } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.items[0].assignees).toEqual(degraded);
  expect(body.items[1].assignees).toHaveLength(2);
  expect(JSON.stringify(body)).not.toContain('"displayName":"member-');
});

it("POSITIVE CONTROL — with the resolver healthy, the same create returns resolved names (the degraded assertions above are not vacuous)", async () => {
  getAllShouldThrow = false;
  mockNames.mockImplementation(async (_ws: string, uids: string[]) => new Map(uids.map((u) => [u, `Name(${u})`])));
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "updated", project: project(), documentUpdateTime: Timestamp.now() });
  const res = await assigneesPost(req("POST", `/api/workspaces/${WS_ID}/projects/p1/assignees`, { assigneeUids: ["member-1"], expectedUpdateTime: TOKEN }), { params: { workspaceId: WS_ID, projectId: "p1" } });
  expect((await res.json()).project.assignees[0].displayName).toBe("Name(member-1)");
});
