/**
 * Project Read Foundation, Phase 7A — GET /api/user/project-runs tests.
 * Mirrors app/api/user/projects/__tests__/route.spec.ts's mocking style.
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

const mockedListProjectRunsForOwner = jest.fn();
jest.mock("@/lib/projects/listProjectRunsForOwner", () => ({
  listProjectRunsForOwner: (...args: any[]) => mockedListProjectRunsForOwner(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET } from "@/app/api/user/project-runs/route";

const UID = "owner-1";
const P1 = "proj-1";
const NOW = Timestamp.now();
const UPDATE_TIME = Timestamp.fromMillis(1_700_000_000_000);

function buildRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/user/project-runs${query}`);
}

async function callGet(query: string) {
  const res = await GET(buildRequest(query));
  const json = await res.json();
  return { res, json };
}

function validProject(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id: P1, workspaceId: "personal-owner-1", name: "My Project", status: "active", createdByUserId: UID, createdAt: NOW, updatedAt: NOW, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  globalEnabled = true;
  canaryUidsRaw = undefined;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedListProjectRunsForOwner.mockResolvedValue({ status: "ok", items: [], hasMore: false });
});

describe("auth", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callGet(`?scope=unfiled`);
    expect(res.status).toBe(401);
    expect(mockedListProjectRunsForOwner).not.toHaveBeenCalled();
  });
});

describe("rollout gate", () => {
  it("Projects backend disabled -> dark, no read reached", async () => {
    globalEnabled = false;
    const { res, json } = await callGet(`?scope=unfiled`);
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("projects_disabled");
    expect(mockedListProjectRunsForOwner).not.toHaveBeenCalled();
  });

  it("Projects backend canary hit -> reaches read", async () => {
    globalEnabled = false;
    canaryUidsRaw = UID;
    const { res } = await callGet(`?scope=unfiled`);
    expect(res.status).toBe(200);
    expect(mockedListProjectRunsForOwner).toHaveBeenCalled();
  });

  it("gate checked BEFORE any query parsing/run read — a malformed query with the gate off still just 503s", async () => {
    globalEnabled = false;
    const { res } = await callGet(``); // missing scope entirely
    expect(res.status).toBe(503);
    expect(mockedListProjectRunsForOwner).not.toHaveBeenCalled();
  });
});

describe("strict query parsing", () => {
  it("neither projectId nor scope -> 400 missing_scope", async () => {
    const { res, json } = await callGet(``);
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("missing_scope");
    expect(mockedListProjectRunsForOwner).not.toHaveBeenCalled();
  });

  it("both projectId and scope -> 400 ambiguous_scope", async () => {
    const { res, json } = await callGet(`?projectId=${P1}&scope=unfiled`);
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("ambiguous_scope");
  });

  it("unknown scope value -> 400 unknown_scope", async () => {
    const { res, json } = await callGet(`?scope=archived`);
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unknown_scope");
  });

  it("client-supplied workspaceId/userId are never read as authority", async () => {
    await callGet(`?scope=unfiled&workspaceId=forged&userId=forged`);
    expect(mockedListProjectRunsForOwner).toHaveBeenCalledWith(expect.objectContaining({ uid: UID, scope: { type: "unfiled" } }));
  });

  it("SECURITY: the call into listProjectRunsForOwner carries EXACTLY {uid, scope, limit, cursorRaw} — no forged/extra field of any name can ride along, even when present in the query string", async () => {
    await callGet(`?scope=unfiled&workspaceId=forged&userId=forged&projectIdOverride=forged`);
    const callArgs = mockedListProjectRunsForOwner.mock.calls[0][0];
    expect(Object.keys(callArgs).sort()).toEqual(["cursorRaw", "limit", "scope", "uid"].sort());
    expect(callArgs).toEqual({ uid: UID, scope: { type: "unfiled" }, limit: 20, cursorRaw: null });
  });
});

describe("Project scope", () => {
  it("foreign/inaccessible Project -> concealed 404", async () => {
    mockedListProjectRunsForOwner.mockResolvedValue({ status: "project_failure", projectStatus: "workspace_mismatch" });
    const { res, json } = await callGet(`?projectId=${P1}`);
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("project_not_found");
  });

  it("malformed Project id -> concealed 404 (same as foreign, no distinguishing side channel)", async () => {
    mockedListProjectRunsForOwner.mockResolvedValue({ status: "project_failure", projectStatus: "invalid_project_id" });
    const { res, json } = await callGet(`?projectId=..%2Fetc`);
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("project_not_found");
  });

  it("malformed Project embedded ID -> concealed 404", async () => {
    mockedListProjectRunsForOwner.mockResolvedValue({ status: "project_failure", projectStatus: "malformed" });
    const { res, json } = await callGet(`?projectId=${P1}`);
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("project_not_found");
  });

  it("archived own Project -> 200, readable, project metadata included with status:archived", async () => {
    mockedListProjectRunsForOwner.mockResolvedValue({
      status: "ok",
      items: [],
      hasMore: false,
      projectMeta: { project: validProject({ status: "archived" }), documentUpdateTime: UPDATE_TIME },
    });
    const { res, json } = await callGet(`?projectId=${P1}`);
    expect(res.status).toBe(200);
    expect(json.scope).toEqual({ type: "project", project: expect.objectContaining({ status: "archived" }) });
  });

  it("active own Project -> 200, project metadata included", async () => {
    mockedListProjectRunsForOwner.mockResolvedValue({
      status: "ok",
      items: [],
      hasMore: false,
      projectMeta: { project: validProject({ status: "active" }), documentUpdateTime: UPDATE_TIME },
    });
    const { res, json } = await callGet(`?projectId=${P1}`);
    expect(res.status).toBe(200);
    expect(json.scope.project.status).toBe("active");
  });

  it("project scope response DTO never exposes workspaceId/createdByUserId/schemaVersion", async () => {
    mockedListProjectRunsForOwner.mockResolvedValue({
      status: "ok",
      items: [],
      hasMore: false,
      projectMeta: { project: validProject(), documentUpdateTime: UPDATE_TIME },
    });
    const { json } = await callGet(`?projectId=${P1}`);
    expect(json.scope.project.workspaceId).toBeUndefined();
    expect(json.scope.project.createdByUserId).toBeUndefined();
    expect(json.scope.project.schemaVersion).toBeUndefined();
  });
});

describe("Unfiled scope", () => {
  it("200, scope.type = unfiled, no fabricated project object", async () => {
    const { res, json } = await callGet(`?scope=unfiled`);
    expect(res.status).toBe(200);
    expect(json.scope).toEqual({ type: "unfiled" });
  });
});

describe("empty states are data, not errors", () => {
  it("zero results is a successful 200, not a 404", async () => {
    const { res, json } = await callGet(`?scope=unfiled`);
    expect(res.status).toBe(200);
    expect(json.items).toEqual([]);
    expect(json.hasMore).toBe(false);
  });
});

describe("cursor errors", () => {
  it("invalid cursor -> 400", async () => {
    mockedListProjectRunsForOwner.mockResolvedValue({ status: "invalid_cursor" });
    const { res, json } = await callGet(`?scope=unfiled&cursor=garbage`);
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_cursor");
  });
});

describe("integrity/query failures map to internal error, never leak detail", () => {
  it("integrity_violation -> 500 internal_error", async () => {
    mockedListProjectRunsForOwner.mockResolvedValue({ status: "integrity_violation" });
    const { res, json } = await callGet(`?scope=unfiled`);
    expect(res.status).toBe(500);
    expect(json.errorCode).toBe("internal_error");
  });

  it("query_failed -> 500 internal_error", async () => {
    mockedListProjectRunsForOwner.mockResolvedValue({ status: "query_failed" });
    const { res, json } = await callGet(`?scope=unfiled`);
    expect(res.status).toBe(500);
    expect(json.errorCode).toBe("internal_error");
  });
});

describe("Workspace prerequisite failures", () => {
  it("workspace_failure maps through the shared sanitized error response", async () => {
    mockedListProjectRunsForOwner.mockResolvedValue({ status: "workspace_failure", workspaceStatus: "not_found" });
    const { res, json } = await callGet(`?scope=unfiled`);
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("workspace_missing");
  });
});

describe("response shape", () => {
  it("success envelope has exactly the expected top-level keys", async () => {
    mockedListProjectRunsForOwner.mockResolvedValue({ status: "ok", items: [{ id: "run-1", at: "x", question: "q", selectedModels: [], projectId: null }], hasMore: false });
    const { json } = await callGet(`?scope=unfiled`);
    expect(Object.keys(json).sort()).toEqual(["hasMore", "items", "ok", "scope"].sort());
  });

  it("nextCursor present only when supplied by the orchestration layer", async () => {
    mockedListProjectRunsForOwner.mockResolvedValue({ status: "ok", items: [], hasMore: true, nextCursor: "abc" });
    const { json } = await callGet(`?scope=unfiled`);
    expect(json.nextCursor).toBe("abc");
  });
});
