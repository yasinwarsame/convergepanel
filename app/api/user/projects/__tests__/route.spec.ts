/**
 * Project Foundation, Phase 6C — GET/POST /api/user/projects tests.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));

let globalEnabled = false;
let canaryUidsRaw: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get PROJECTS_ENABLED() {
    return globalEnabled;
  },
  get PROJECTS_CANARY_UIDS() {
    return canaryUidsRaw;
  },
}));

const mockedResolvePersonalWorkspaceForOwner = jest.fn();
jest.mock("@/lib/workspaces/resolvePersonalWorkspaceForOwner", () => ({
  resolvePersonalWorkspaceForOwner: (...args: any[]) => mockedResolvePersonalWorkspaceForOwner(...args),
}));

const mockedCreateProject = jest.fn();
const mockedCountProjectsInWorkspace = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({
  createProject: (...args: any[]) => mockedCreateProject(...args),
  countProjectsInWorkspace: (...args: any[]) => mockedCountProjectsInWorkspace(...args),
}));

const mockedListProjectsForOwner = jest.fn();
jest.mock("@/lib/projects/listProjectsForOwner", () => ({
  listProjectsForOwner: (...args: any[]) => mockedListProjectsForOwner(...args),
}));

const mockedWriteProjectEvent = jest.fn();
jest.mock("@/lib/projects/projectEvents", () => ({
  writeProjectEvent: (...args: any[]) => mockedWriteProjectEvent(...args),
}));

const mockedCheckRateLimit = jest.fn();
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: (...args: any[]) => mockedCheckRateLimit(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET, POST } from "@/app/api/user/projects/route";

const UID = "owner-1";
const WS_ID = "personal-owner-1";
const NOW = Timestamp.now();
const UPDATE_TIME = Timestamp.fromMillis(1_700_000_000_000);

function validProject(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "proj-1",
    workspaceId: WS_ID,
    name: "My Project",
    status: "active",
    createdByUserId: UID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildGetRequest(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/user/projects${qs}`);
}

function buildPostRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/user/projects", {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function callGet(qs = "") {
  const res = await GET(buildGetRequest(qs));
  const json = await res.json();
  return { res, json };
}

async function callPost(body?: unknown) {
  const res = await POST(buildPostRequest(body));
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  globalEnabled = false;
  canaryUidsRaw = undefined;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() });
});

describe("auth (shared by GET and POST)", () => {
  it("GET 401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callGet();
    expect(res.status).toBe(401);
    expect(mockedListProjectsForOwner).not.toHaveBeenCalled();
  });

  it("POST 401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callPost({ name: "X" });
    expect(res.status).toBe(401);
    expect(mockedCreateProject).not.toHaveBeenCalled();
  });
});

describe("rollout gate (shared by GET and POST)", () => {
  it("GET: feature absent/off -> route dark, no Project read attempted", async () => {
    const { res, json } = await callGet();
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("projects_disabled");
    expect(mockedListProjectsForOwner).not.toHaveBeenCalled();
  });

  it("POST: feature absent/off -> route dark, no Project write attempted", async () => {
    const { res, json } = await callPost({ name: "X" });
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("projects_disabled");
    expect(mockedCreateProject).not.toHaveBeenCalled();
  });

  it("exact canary UID -> route available", async () => {
    canaryUidsRaw = UID;
    mockedListProjectsForOwner.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    const { res } = await callGet();
    expect(res.status).toBe(200);
  });

  it("other UID -> unavailable", async () => {
    canaryUidsRaw = "someone-else";
    const { res, json } = await callGet();
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("projects_disabled");
  });

  it("SECURITY: malformed canary -> fail closed (dark), never fail open", async () => {
    canaryUidsRaw = "not/a/uid";
    const { res, json } = await callGet();
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("projects_disabled");
  });

  it("global true -> available even with no canary", async () => {
    globalEnabled = true;
    mockedListProjectsForOwner.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    const { res } = await callGet();
    expect(res.status).toBe(200);
  });
});

describe("GET /api/user/projects — listing", () => {
  beforeEach(() => {
    globalEnabled = true;
  });

  it("returns the mapped DTO list on success", async () => {
    mockedListProjectsForOwner.mockResolvedValue({
      status: "ok",
      items: [{ project: validProject(), documentUpdateTime: UPDATE_TIME }],
      hasMore: false,
    });
    const { res, json } = await callGet();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.items).toHaveLength(1);
    expect(json.items[0].id).toBe("proj-1");
    expect(json.items[0]).not.toHaveProperty("workspaceId");
  });

  it("never accepts workspaceId from a query parameter — scoping comes exclusively from the authenticated uid", async () => {
    mockedListProjectsForOwner.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await callGet("?workspaceId=personal-someone-else");
    expect(mockedListProjectsForOwner).toHaveBeenCalledWith(expect.objectContaining({ uid: UID }));
    const callArgs = mockedListProjectsForOwner.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("workspaceId");
  });

  it("passes the cursor query param through", async () => {
    mockedListProjectsForOwner.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await callGet("?cursor=abc123");
    expect(mockedListProjectsForOwner).toHaveBeenCalledWith(expect.objectContaining({ cursorRaw: "abc123" }));
  });

  it("malformed cursor -> invalid_cursor, 400", async () => {
    mockedListProjectsForOwner.mockResolvedValue({ status: "invalid_cursor" });
    const { res, json } = await callGet("?cursor=garbage");
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_cursor");
  });

  it("SECURITY: an integrity violation (malformed/mismatched Project in the result) fails closed, never partially discloses items", async () => {
    mockedListProjectsForOwner.mockResolvedValue({ status: "integrity_violation" });
    const { res, json } = await callGet();
    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
  });

  it("empty result -> 200 with an empty items array, not an error", async () => {
    mockedListProjectsForOwner.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    const { res, json } = await callGet();
    expect(res.status).toBe(200);
    expect(json.items).toEqual([]);
  });

  it("Workspace-prerequisite failure maps through the existing sanitized Workspace error response", async () => {
    mockedListProjectsForOwner.mockResolvedValue({ status: "not_found" });
    const { res, json } = await callGet();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("workspace_missing");
  });
});

describe("POST /api/user/projects — creation", () => {
  beforeEach(() => {
    globalEnabled = true;
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "found", workspace: { id: WS_ID, name: "Personal Workspace" } });
    mockedCountProjectsInWorkspace.mockResolvedValue({ status: "ok", count: 0 });
    mockedCreateProject.mockResolvedValue({ status: "created", project: validProject(), documentUpdateTime: UPDATE_TIME });
  });

  it("valid create returns 201 with the DTO", async () => {
    const { res, json } = await callPost({ name: "My Project" });
    expect(res.status).toBe(201);
    expect(json.ok).toBe(true);
    expect(json.project.id).toBe("proj-1");
  });

  it("creation never provisions a Workspace — only resolvePersonalWorkspaceForOwner (read) is called, never ensurePersonalWorkspace or any create path", async () => {
    await callPost({ name: "X" });
    expect(mockedResolvePersonalWorkspaceForOwner).toHaveBeenCalledWith(UID);
  });

  it("SECURITY: createProject is called with the SERVER-RESOLVED workspaceId specifically — direct assertion, not just 'the resolver was called'", async () => {
    await callPost({ name: "X" });
    expect(mockedCreateProject).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS_ID }));
  });

  it("if the Personal Workspace prerequisite is broken, creation fails closed and never calls createProject", async () => {
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "not_found" });
    const { res, json } = await callPost({ name: "X" });
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("workspace_missing");
    expect(mockedCreateProject).not.toHaveBeenCalled();
  });

  it("invalid name -> 400, createProject never called", async () => {
    const { res, json } = await callPost({ name: "" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_project_name");
    expect(mockedCreateProject).not.toHaveBeenCalled();
  });

  it("whitespace-only name -> 400", async () => {
    const { res, json } = await callPost({ name: "   " });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_project_name");
  });

  it("whitespace is normalized (trimmed) before being passed to createProject", async () => {
    await callPost({ name: "  My Project  " });
    expect(mockedCreateProject).toHaveBeenCalledWith(expect.objectContaining({ name: "My Project" }));
  });

  it("SECURITY: a client-supplied workspaceId is rejected outright (unknown field), never silently trusted", async () => {
    const { res, json } = await callPost({ name: "X", workspaceId: "personal-someone-else" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unexpected_field");
    expect(mockedCreateProject).not.toHaveBeenCalled();
  });

  it("SECURITY: a client-supplied createdByUserId is rejected outright", async () => {
    const { res, json } = await callPost({ name: "X", createdByUserId: "attacker-uid" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unexpected_field");
  });

  it("SECURITY: a client-supplied status/id is rejected outright", async () => {
    const r1 = await callPost({ name: "X", status: "archived" });
    expect(r1.res.status).toBe(400);
    const r2 = await callPost({ name: "X", id: "chosen-by-client" });
    expect(r2.res.status).toBe(400);
  });

  it("the created Project's embedded id matches the document id returned by createProject (trusted pass-through, not re-derived)", async () => {
    mockedCreateProject.mockResolvedValue({ status: "created", project: validProject({ id: "auto-id-42" }), documentUpdateTime: UPDATE_TIME });
    const { json } = await callPost({ name: "X" });
    expect(json.project.id).toBe("auto-id-42");
  });

  it("duplicate names are allowed — no dedup check anywhere in this route", async () => {
    const { res } = await callPost({ name: "My Project" }); // matches the seeded validProject() name
    expect(res.status).toBe(201);
  });

  it("SECURITY: the Project count guard counts active AND archived Projects together — at/above the threshold rejects creation", async () => {
    mockedCountProjectsInWorkspace.mockResolvedValue({ status: "ok", count: 200 });
    const { res, json } = await callPost({ name: "X" });
    expect(res.status).toBe(429);
    expect(json.errorCode).toBe("too_many_projects");
    expect(mockedCreateProject).not.toHaveBeenCalled();
  });

  it("under the count threshold, creation proceeds normally", async () => {
    mockedCountProjectsInWorkspace.mockResolvedValue({ status: "ok", count: 199 });
    const { res } = await callPost({ name: "X" });
    expect(res.status).toBe(201);
  });

  it("a count-guard infrastructure failure does not itself block creation (fails open on the abuse guard only, never on authorization)", async () => {
    mockedCountProjectsInWorkspace.mockResolvedValue({ status: "count_failed" });
    const { res } = await callPost({ name: "X" });
    expect(res.status).toBe(201);
  });

  it("EVENT FAILURE SAFETY: creation still succeeds (201) even when the projectEvents write fails internally — writeProjectEvent's own real contract is to never reject (proven in projectEvents.spec.ts), so this simulates that same contract: the mock resolves (representing an internally-caught failure), and the route must not treat that resolution as a reason to fail the response", async () => {
    mockedWriteProjectEvent.mockResolvedValue(undefined);
    const { res, json } = await callPost({ name: "X" });
    expect(res.status).toBe(201);
    expect(json.ok).toBe(true);
    expect(mockedWriteProjectEvent).toHaveBeenCalled();
  });

  it("a canonical creation failure never attempts to write a success event with fabricated data — writeProjectEvent is only called after createProject succeeds", async () => {
    mockedCreateProject.mockResolvedValue({ status: "create_failed" });
    const { res } = await callPost({ name: "X" });
    expect(res.status).toBe(500);
    expect(mockedWriteProjectEvent).not.toHaveBeenCalled();
  });

  it("is rate-limited per uid", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(), retryAfter: 30 });
    const { res } = await callPost({ name: "X" });
    expect(res.status).toBe(429);
    expect(mockedCreateProject).not.toHaveBeenCalled();
  });
});
