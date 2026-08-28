/**
 * Team Run→Project Association, Phase 8C-C —
 * `PATCH /api/workspaces/{workspaceId}/runs/{runId}/project` tests.
 * Mirrors the mocking style of the Personal association route's own test
 * file (`app/api/user/runs/[runId]/project/__tests__/route.spec.ts`):
 * `associateTeamRunWithProject()` is fully mocked (its own extensive
 * transaction/authorization/race coverage lives in
 * `lib/projects/__tests__/associateTeamRunWithProject.spec.ts`), so this
 * file focuses purely on route-level concerns — request parsing, rate
 * limiting, result→HTTP mapping, and event-emission discipline.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));

const mockedCheckRateLimit = jest.fn();
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: (...args: any[]) => mockedCheckRateLimit(...args),
}));

const mockedAssociateTeamRunWithProject = jest.fn();
jest.mock("@/lib/projects/associateTeamRunWithProject", () => ({
  associateTeamRunWithProject: (...args: any[]) => mockedAssociateTeamRunWithProject(...args),
}));

const mockedWriteTeamProjectEventSafely = jest.fn();
jest.mock("@/lib/projects/writeTeamProjectEventSafely", () => ({
  writeTeamProjectEventSafely: (...args: any[]) => mockedWriteTeamProjectEventSafely(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/project/route";

const UID = "member-1";
const WS_ID = "ws-team-1";
const RUN_ID = "run-1e70e52a-43ad-40bc-b781-cf161763fe23";
const PROJECT_ID = "proj-1";

function buildRequest(body?: unknown, workspaceId = WS_ID, runId = RUN_ID): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${workspaceId}/runs/${runId}/project`, {
    method: "PATCH",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function callPatch(body?: unknown, workspaceId = WS_ID, runId = RUN_ID) {
  const res = await PATCH(buildRequest(body, workspaceId, runId), { params: { workspaceId, runId } });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() });
  mockedAssociateTeamRunWithProject.mockResolvedValue({
    status: "associated",
    runId: RUN_ID,
    workspaceId: WS_ID,
    fromProjectId: null,
    toProjectId: PROJECT_ID,
  });
  mockedWriteTeamProjectEventSafely.mockResolvedValue(undefined);
});

describe("auth", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(401);
    expect(mockedAssociateTeamRunWithProject).not.toHaveBeenCalled();
  });
});

describe("no non-transaction Workspace precheck at the route layer", () => {
  it("the route performs zero Workspace/membership authorization of its own — associateTeamRunWithProject is called with exactly {uid, workspaceId, runId, targetProjectId, expectedProjectId}, nothing more", async () => {
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(mockedAssociateTeamRunWithProject).toHaveBeenCalledWith({
      uid: UID,
      workspaceId: WS_ID,
      runId: RUN_ID,
      targetProjectId: PROJECT_ID,
      expectedProjectId: null,
    });
  });
});

describe("malformed run id — never distinguishable from foreign", () => {
  it("path-separator run id -> same concealed 404 as a foreign run", async () => {
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null }, WS_ID, "run/1");
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("run_not_found");
    expect(mockedAssociateTeamRunWithProject).not.toHaveBeenCalled();
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
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null, userId: "forged" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unexpected_field");
  });

  it("projectId as a number -> 400 invalid_request_body", async () => {
    const { res, json } = await callPatch({ projectId: 42, expectedProjectId: null });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_request_body");
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
    const req = new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/project`, { method: "PATCH", body: "{not json" });
    const res = await PATCH(req, { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });
});

describe("rate limiting", () => {
  it("rate_limited -> 429, association never attempted", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(), retryAfter: 60 });
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(429);
    expect(json.errorCode).toBe("rate_limited");
    expect(mockedAssociateTeamRunWithProject).not.toHaveBeenCalled();
  });

  it("uses a UID-scoped (not Workspace-scoped) rate-limit identifier — moving across Workspace ids cannot bypass the per-user limit", async () => {
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(expect.objectContaining({ identifier: expect.stringContaining(UID) }));
    const identifier = mockedCheckRateLimit.mock.calls[0][0].identifier as string;
    expect(identifier).not.toContain(WS_ID);
  });
});

describe("success responses + DTO shape", () => {
  it("assign -> 200, { ok, runId, workspaceId, projectId }", async () => {
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, runId: RUN_ID, workspaceId: WS_ID, projectId: PROJECT_ID });
  });

  it("unassign -> 200, projectId: null in response", async () => {
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "associated", runId: RUN_ID, workspaceId: WS_ID, fromProjectId: PROJECT_ID, toProjectId: null });
    const { res, json } = await callPatch({ projectId: null, expectedProjectId: PROJECT_ID });
    expect(res.status).toBe(200);
    expect(json.projectId).toBeNull();
  });

  it("DOES NOT expose membership/capability/role/authorization-reason/Project/Workspace document internals", async () => {
    const { json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(Object.keys(json).sort()).toEqual(["ok", "projectId", "runId", "workspaceId"].sort());
  });
});

describe("error status mapping", () => {
  it("Phase 10C.1A: team_workspaces_disabled -> concealed 404 (not a distinguishable 503)", async () => {
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "team_workspaces_disabled" });
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("team_workspace_not_found");
    expect(mockedWriteTeamProjectEventSafely).not.toHaveBeenCalled();
  });

  it("F1 parity: team_workspaces_disabled (Case 1) is byte-identical to an unauthorized/workspace_not_found denial (Case 2)", async () => {
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "team_workspaces_disabled" });
    const notAdmitted = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "unauthorized", reason: "workspace_not_found" });
    const admittedButForeign = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(notAdmitted.res.status).toBe(admittedButForeign.res.status);
    expect(JSON.stringify(notAdmitted.json)).toBe(JSON.stringify(admittedButForeign.json));
  });

  const authReasons: Array<[string, number, string]> = [
    ["workspace_not_found", 404, "team_workspace_not_found"],
    ["workspace_malformed", 404, "team_workspace_not_found"],
    ["membership_not_found", 404, "team_workspace_not_found"],
    ["membership_removed", 404, "team_workspace_not_found"],
    ["membership_malformed", 404, "team_workspace_not_found"],
    ["owner_integrity_violation", 404, "team_workspace_not_found"],
    ["insufficient_capability", 403, "insufficient_capability"],
  ];
  for (const [reason, expectedHttp, expectedCode] of authReasons) {
    it(`unauthorized/${reason} -> HTTP ${expectedHttp} / ${expectedCode}`, async () => {
      mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "unauthorized", reason });
      const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
      expect(res.status).toBe(expectedHttp);
      expect(json.errorCode).toBe(expectedCode);
      expect(mockedWriteTeamProjectEventSafely).not.toHaveBeenCalled();
    });
  }

  const resultCases: Array<[string, number, string]> = [
    ["run_not_found", 404, "run_not_found"],
    ["conflict", 409, "project_association_conflict"],
    ["unchanged", 409, "project_association_unchanged"],
    ["target_not_found", 404, "project_not_found"],
    ["target_archived", 409, "project_archived"],
    ["firestore_unavailable", 500, "internal_error"],
    ["transaction_failed", 500, "internal_error"],
  ];
  for (const [status, expectedHttp, expectedCode] of resultCases) {
    it(`${status} -> HTTP ${expectedHttp} / ${expectedCode}`, async () => {
      mockedAssociateTeamRunWithProject.mockResolvedValue({ status });
      const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
      expect(res.status).toBe(expectedHttp);
      expect(json.errorCode).toBe(expectedCode);
      expect(mockedWriteTeamProjectEventSafely).not.toHaveBeenCalled();
    });
  }

  it("conflict response never echoes the caller's guessed or actual current projectId", async () => {
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "conflict" });
    const { json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: "wrong-guess" });
    expect(JSON.stringify(json)).not.toContain("wrong-guess");
    expect(JSON.stringify(json)).not.toContain(PROJECT_ID);
  });

  it("run_not_found conceals whether the run exists, is malformed, or is Team-shape-invalid — one indistinguishable response", async () => {
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "run_not_found" });
    const { res, json } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("run_not_found");
  });
});

describe("event emission — exactly once per committed change, never otherwise, never inside the transaction", () => {
  it("assign emits exactly one project_run_association_changed event via the Team-safe wrapper", async () => {
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(mockedWriteTeamProjectEventSafely).toHaveBeenCalledTimes(1);
    expect(mockedWriteTeamProjectEventSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "project_run_association_changed",
        actorUid: UID,
        workspaceId: WS_ID,
        runId: RUN_ID,
        fromProjectId: null,
        toProjectId: PROJECT_ID,
        projectId: PROJECT_ID,
      })
    );
  });

  it("move emits one event with both from and to populated", async () => {
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "associated", runId: RUN_ID, workspaceId: WS_ID, fromProjectId: "proj-1", toProjectId: "proj-2" });
    await callPatch({ projectId: "proj-2", expectedProjectId: "proj-1" });
    expect(mockedWriteTeamProjectEventSafely).toHaveBeenCalledTimes(1);
    expect(mockedWriteTeamProjectEventSafely).toHaveBeenCalledWith(expect.objectContaining({ fromProjectId: "proj-1", toProjectId: "proj-2", projectId: "proj-2" }));
  });

  it("unassign emits one event, using fromProjectId as the required non-null event projectId", async () => {
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "associated", runId: RUN_ID, workspaceId: WS_ID, fromProjectId: "proj-1", toProjectId: null });
    await callPatch({ projectId: null, expectedProjectId: "proj-1" });
    expect(mockedWriteTeamProjectEventSafely).toHaveBeenCalledWith(expect.objectContaining({ fromProjectId: "proj-1", toProjectId: null, projectId: "proj-1" }));
  });

  it("conflict emits zero events", async () => {
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "conflict" });
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(mockedWriteTeamProjectEventSafely).not.toHaveBeenCalled();
  });

  it("no-op (unchanged) emits zero events", async () => {
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "unchanged" });
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: PROJECT_ID });
    expect(mockedWriteTeamProjectEventSafely).not.toHaveBeenCalled();
  });

  it("auth failure emits zero events", async () => {
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "unauthorized", reason: "insufficient_capability" });
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(mockedWriteTeamProjectEventSafely).not.toHaveBeenCalled();
  });

  it("target failure emits zero events", async () => {
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "target_not_found" });
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(mockedWriteTeamProjectEventSafely).not.toHaveBeenCalled();
  });

  it("transaction failure emits zero events", async () => {
    mockedAssociateTeamRunWithProject.mockResolvedValue({ status: "transaction_failed" });
    await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(mockedWriteTeamProjectEventSafely).not.toHaveBeenCalled();
  });

  it("EVENT FAILURE SAFETY: association still returns success even though the event write is best-effort (wrapper never rejects by contract)", async () => {
    mockedWriteTeamProjectEventSafely.mockResolvedValue(undefined);
    const { res } = await callPatch({ projectId: PROJECT_ID, expectedProjectId: null });
    expect(res.status).toBe(200);
  });

  it("the route awaits the event write before returning", async () => {
    let resolveEvent!: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveEvent = resolve;
    });
    mockedWriteTeamProjectEventSafely.mockReturnValue(deferred);

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
    const callArgs = mockedWriteTeamProjectEventSafely.mock.calls[0][0];
    expect(Object.keys(callArgs).sort()).toEqual(["actorUid", "eventType", "fromProjectId", "projectId", "runId", "toProjectId", "workspaceId"].sort());
  });
});

describe("transaction side-effect purity (structural)", () => {
  it("associateTeamRunWithProject.ts never imports/calls writeProjectEvent or writeTeamProjectEventSafely — event emission lives only in the route, after the transaction resolves", () => {
    const fs = require("fs");
    const path = require("path");
    const src: string = fs.readFileSync(path.join(process.cwd(), "lib/projects/associateTeamRunWithProject.ts"), "utf8");
    const withoutBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
    const withoutLineComments = withoutBlockComments.replace(/\/\/.*$/gm, "");
    expect(withoutLineComments).not.toMatch(/writeProjectEvent/);
    expect(withoutLineComments).not.toMatch(/writeTeamProjectEventSafely/);
  });

  it("associateTeamRunWithProject.ts never imports logger.warn/error calls inside its transaction callback body (only outside, in the catch block)", () => {
    const fs = require("fs");
    const path = require("path");
    const src: string = fs.readFileSync(path.join(process.cwd(), "lib/projects/associateTeamRunWithProject.ts"), "utf8");
    const callbackStart = src.indexOf("await adminDb.runTransaction");
    const callbackEnd = src.indexOf("});", callbackStart);
    const callbackBody = src.slice(callbackStart, callbackEnd);
    expect(callbackBody).not.toMatch(/logger\./);
  });
});
