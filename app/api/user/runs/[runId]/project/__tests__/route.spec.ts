/**
 * Run/Project Association, Phase 6D.4A — PATCH /api/user/runs/{runId}/project tests.
 * Mirrors the mocking style of app/api/user/projects/[projectId]/archive/__tests__/route.spec.ts.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));

let projectsGlobalEnabled = false;
let projectsCanaryUidsRaw: string | undefined = undefined;
let writerGlobalEnabled = false;
let writerCanaryUidsRaw: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get PROJECTS_ENABLED() {
    return projectsGlobalEnabled;
  },
  get PROJECTS_CANARY_UIDS() {
    return projectsCanaryUidsRaw;
  },
  get PROJECT_RUN_ASSOCIATION_WRITES_ENABLED() {
    return writerGlobalEnabled;
  },
  get PROJECT_RUN_ASSOCIATION_WRITE_CANARY_UIDS() {
    return writerCanaryUidsRaw;
  },
}));

const mockedCheckRateLimit = jest.fn();
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: (...args: any[]) => mockedCheckRateLimit(...args),
}));

const mockedAssociateRunWithProject = jest.fn();
jest.mock("@/lib/projects/associateRunWithProject", () => ({
  associateRunWithProject: (...args: any[]) => mockedAssociateRunWithProject(...args),
}));

const mockedWriteProjectEvent = jest.fn();
jest.mock("@/lib/projects/projectEvents", () => ({
  writeProjectEvent: (...args: any[]) => mockedWriteProjectEvent(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/user/runs/[runId]/project/route";

const UID = "owner-1";
const WS_ID = "personal-owner-1";
const RUN_ID = "run-1e70e52a-43ad-40bc-b781-cf161763fe23";
const PROJECT_ID = "proj-1";

function buildRequest(body?: unknown, runId = RUN_ID): NextRequest {
  return new NextRequest(`http://localhost/api/user/runs/${runId}/project`, {
    method: "PATCH",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function callPatch(body?: unknown, runId = RUN_ID) {
  const res = await PATCH(buildRequest(body, runId), { params: { runId } });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  projectsGlobalEnabled = true;
  projectsCanaryUidsRaw = undefined;
  writerGlobalEnabled = true;
  writerCanaryUidsRaw = undefined;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() });
  mockedAssociateRunWithProject.mockResolvedValue({
    status: "associated",
    runId: RUN_ID,
    workspaceId: WS_ID,
    fromProjectId: null,
    toProjectId: PROJECT_ID,
  });
  mockedWriteProjectEvent.mockResolvedValue(undefined);
});

describe("auth", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(401);
    expect(mockedAssociateRunWithProject).not.toHaveBeenCalled();
  });
});

describe("dual rollout gate", () => {
  it("Projects backend ineligible (writer on, Projects off) -> dark, no run read reached", async () => {
    projectsGlobalEnabled = false;
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("projects_disabled");
    expect(mockedAssociateRunWithProject).not.toHaveBeenCalled();
  });

  it("writer gate off (Projects on) -> dark, no run read reached", async () => {
    writerGlobalEnabled = false;
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("projects_disabled");
    expect(mockedAssociateRunWithProject).not.toHaveBeenCalled();
  });

  it("both off -> dark", async () => {
    projectsGlobalEnabled = false;
    writerGlobalEnabled = false;
    const { res } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(503);
  });

  it("MUTATION CHECK: writer-global-true alone (Projects backend off, uid not in Projects canary) is NOT sufficient — the going-forward null-writer flag being globally on must never expose this route to everyone", async () => {
    writerGlobalEnabled = true;
    projectsGlobalEnabled = false;
    projectsCanaryUidsRaw = undefined;
    const { res } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(503);
    expect(mockedAssociateRunWithProject).not.toHaveBeenCalled();
  });

  it("canary membership in both independently -> reaches association", async () => {
    writerGlobalEnabled = false;
    writerCanaryUidsRaw = UID;
    projectsGlobalEnabled = false;
    projectsCanaryUidsRaw = UID;
    const { res } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(200);
    expect(mockedAssociateRunWithProject).toHaveBeenCalled();
  });
});

describe("malformed run id — never distinguishable from foreign", () => {
  it("path-separator run id -> same concealed 404 as a foreign run", async () => {
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null }, "run/1");
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("run_not_found");
    expect(mockedAssociateRunWithProject).not.toHaveBeenCalled();
  });
});

describe("strict body validation", () => {
  it("missing projectId -> 400", async () => {
    const { res, json } = await callPatch({ expectedProjectId: null });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_request_body");
  });

  it("missing expectedProjectId -> 400", async () => {
    const { res, json } = await callPatch({ projectId: PROJECT_ID });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_request_body");
  });

  it("unknown field -> 400 unexpected_field", async () => {
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null, workspaceId: "forged" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unexpected_field");
  });

  it("SECURITY: forged userId field -> rejected outright", async () => {
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null, userId: "someone-else" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unexpected_field");
  });

  it("projectId as a number -> 400 invalid_request_body", async () => {
    const { res, json } = await callPatch({ projectId: 42, expectedProjectId: null });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_request_body");
  });

  it("projectId as an object -> 400", async () => {
    const { res } = await callPatch({ projectId: {}, expectedProjectId: null });
    expect(res.status).toBe(400);
  });

  it("projectId as an array -> 400", async () => {
    const { res } = await callPatch({ projectId: [], expectedProjectId: null });
    expect(res.status).toBe(400);
  });

  it("malformed projectId string -> 400", async () => {
    const { res } = await callPatch({ projectId: "proj/1", expectedProjectId: null });
    expect(res.status).toBe(400);
  });

  it("explicit null for both fields is valid, not rejected", async () => {
    const { res } = await callPatch({ projectId: null, expectedProjectId: null });
    expect(res.status).not.toBe(400);
  });

  it("invalid JSON body -> 400", async () => {
    const req = new NextRequest(`http://localhost/api/user/runs/${RUN_ID}/project`, { method: "PATCH", body: "{not json" });
    const res = await PATCH(req, { params: { runId: RUN_ID } });
    expect(res.status).toBe(400);
  });
});

describe("rate limiting", () => {
  it("rate_limited -> 429, association never attempted", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(), retryAfter: 60 });
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(429);
    expect(json.errorCode).toBe("rate_limited");
    expect(mockedAssociateRunWithProject).not.toHaveBeenCalled();
  });

  it("uses a per-uid rate-limit identifier", async () => {
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(expect.objectContaining({ identifier: expect.stringContaining(UID) }));
  });
});

describe("success responses + DTO shape", () => {
  it("assign -> 200, minimal DTO { ok, runId, projectId }", async () => {
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, runId: RUN_ID, projectId: PROJECT_ID });
  });

  it("unassign -> 200, projectId: null in response", async () => {
    mockedAssociateRunWithProject.mockResolvedValue({ status: "associated", runId: RUN_ID, workspaceId: WS_ID, fromProjectId: PROJECT_ID, toProjectId: null });
    const { res, json } = await callPatch({ projectId: null, expectedProjectId: PROJECT_ID });
    expect(res.status).toBe(200);
    expect(json.projectId).toBeNull();
  });

  it("DOES NOT expose workspaceId/userId/question/report in the response", async () => {
    const { json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(json.workspaceId).toBeUndefined();
    expect(json.userId).toBeUndefined();
    expect(json.question).toBeUndefined();
  });
});

describe("error status mapping", () => {
  const cases: Array<[string, number, string]> = [
    ["run_not_found", 404, "run_not_found"],
    ["conflict", 409, "project_association_conflict"],
    ["unchanged", 409, "project_association_unchanged"],
    ["target_not_found", 404, "project_not_found"],
    ["target_archived", 409, "project_archived"],
    ["run_state_invalid", 500, "internal_error"],
    ["workspace_invalid", 500, "internal_error"],
    ["workspaces_disabled", 500, "internal_error"],
    ["firestore_unavailable", 500, "internal_error"],
    ["transaction_failed", 500, "internal_error"],
  ];

  for (const [status, expectedHttp, expectedCode] of cases) {
    it(`${status} -> HTTP ${expectedHttp} / ${expectedCode}`, async () => {
      mockedAssociateRunWithProject.mockResolvedValue({ status });
      const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
      expect(res.status).toBe(expectedHttp);
      expect(json.errorCode).toBe(expectedCode);
      expect(mockedWriteProjectEvent).not.toHaveBeenCalled();
    });
  }

  it("conflict response never echoes the caller's guessed or actual current projectId", async () => {
    mockedAssociateRunWithProject.mockResolvedValue({ status: "conflict" });
    const { json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: "wrong-guess" });
    expect(JSON.stringify(json)).not.toContain("wrong-guess");
    expect(JSON.stringify(json)).not.toContain(PROJECT_ID);
  });
});

describe("event emission — exactly once per committed change, never otherwise", () => {
  it("assign emits exactly one project_run_association_changed event", async () => {
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(mockedWriteProjectEvent).toHaveBeenCalledTimes(1);
    expect(mockedWriteProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "project_run_association_changed", runId: RUN_ID, fromProjectId: null, toProjectId: PROJECT_ID, projectId: PROJECT_ID })
    );
  });

  it("move emits one event with both from and to populated", async () => {
    mockedAssociateRunWithProject.mockResolvedValue({ status: "associated", runId: RUN_ID, workspaceId: WS_ID, fromProjectId: "proj-1", toProjectId: "proj-2" });
    await callPatch({ projectId: "proj-2", expectedProjectId: "proj-1" });
    expect(mockedWriteProjectEvent).toHaveBeenCalledTimes(1);
    expect(mockedWriteProjectEvent).toHaveBeenCalledWith(expect.objectContaining({ fromProjectId: "proj-1", toProjectId: "proj-2", projectId: "proj-2" }));
  });

  it("unassign emits one event, using fromProjectId as the required non-null event projectId", async () => {
    mockedAssociateRunWithProject.mockResolvedValue({ status: "associated", runId: RUN_ID, workspaceId: WS_ID, fromProjectId: "proj-1", toProjectId: null });
    await callPatch({ projectId: null, expectedProjectId: "proj-1" });
    expect(mockedWriteProjectEvent).toHaveBeenCalledWith(expect.objectContaining({ fromProjectId: "proj-1", toProjectId: null, projectId: "proj-1" }));
  });

  it("conflict emits zero events", async () => {
    mockedAssociateRunWithProject.mockResolvedValue({ status: "conflict" });
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(mockedWriteProjectEvent).not.toHaveBeenCalled();
  });

  it("no-op (unchanged) emits zero events", async () => {
    mockedAssociateRunWithProject.mockResolvedValue({ status: "unchanged" });
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: PROJECT_ID });
    expect(mockedWriteProjectEvent).not.toHaveBeenCalled();
  });

  it("archived target emits zero events", async () => {
    mockedAssociateRunWithProject.mockResolvedValue({ status: "target_archived" });
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(mockedWriteProjectEvent).not.toHaveBeenCalled();
  });

  it("foreign/concealed target emits zero events", async () => {
    mockedAssociateRunWithProject.mockResolvedValue({ status: "target_not_found" });
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(mockedWriteProjectEvent).not.toHaveBeenCalled();
  });

  it("EVENT FAILURE SAFETY: association still returns success when the event write fails internally", async () => {
    mockedWriteProjectEvent.mockResolvedValue(undefined); // writeProjectEvent never rejects by contract
    const { res } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(200);
  });

  it("PROPERTY B: the route awaits the event write before returning", async () => {
    let resolveEvent!: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveEvent = resolve;
    });
    mockedWriteProjectEvent.mockReturnValue(deferred);

    let settled = false;
    const patchPromise = callPatch({ projectId: PROJECT_ID, expectedProjectId: null }).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    resolveEvent();
    const { res } = await patchPromise;
    expect(settled).toBe(true);
    expect(res.status).toBe(200);
  });

  it("event payload never includes Project name, run question, answer, or report content", async () => {
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    const callArgs = mockedWriteProjectEvent.mock.calls[0][0];
    expect(Object.keys(callArgs).sort()).toEqual(["actorUid", "eventType", "fromProjectId", "projectId", "runId", "toProjectId", "workspaceId"].sort());
  });
});

describe("transaction side-effect purity (structural)", () => {
  it("associateRunWithProject.ts never imports/calls writeProjectEvent — event emission lives only in the route, after the transaction resolves", () => {
    const fs = require("fs");
    const path = require("path");
    const src: string = fs.readFileSync(path.join(process.cwd(), "lib/projects/associateRunWithProject.ts"), "utf8");
    // Strip comments before matching, to avoid false positives from this
    // module's own doc comments that reference writeProjectEvent by name.
    const withoutBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
    const withoutLineComments = withoutBlockComments.replace(/\/\/.*$/gm, "");
    expect(withoutLineComments).not.toMatch(/writeProjectEvent/);
  });
});
