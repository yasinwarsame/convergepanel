/**
 * ADD-TO-TEAM-PROJECT —
 * `POST /api/workspaces/{workspaceId}/projects/{projectId}/research/snapshots`
 * route tests. Mirrors the mocking style of the Team run→Project
 * association route's spec: `createTeamRunSnapshotFromPersonal()` is fully
 * mocked (its own transaction/authorization/idempotency coverage lives in
 * `lib/firestore/__tests__/teamRunSnapshots.spec.ts`), so this file covers
 * route-level concerns only — auth, rate limiting, body allow-list,
 * result→HTTP mapping, secondary-event discipline, and the zero-quota /
 * zero-execution guarantees at the route boundary.
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

const mockedCreateSnapshot = jest.fn();
jest.mock("@/lib/firestore/teamRunSnapshots", () => ({
  createTeamRunSnapshotFromPersonal: (...args: any[]) => mockedCreateSnapshot(...args),
}));

const mockedWriteTeamProjectEventSafely = jest.fn();
jest.mock("@/lib/projects/writeTeamProjectEventSafely", () => ({
  writeTeamProjectEventSafely: (...args: any[]) => mockedWriteTeamProjectEventSafely(...args),
}));

const mockedCheckAndIncrementUsage = jest.fn();
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkAndIncrementUsageForRun: (...args: unknown[]) => mockedCheckAndIncrementUsage(...args),
}));

const mockedExecuteOrdinaryRun = jest.fn();
jest.mock("@/lib/runPanelExecution", () => ({
  executeOrdinaryRun: (...args: unknown[]) => mockedExecuteOrdinaryRun(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { readFileSync } from "fs";
import { join } from "path";
import { NextRequest } from "next/server";
import { POST, SNAPSHOT_RATE_LIMIT } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/research/snapshots/route";

const UID = "member-1";
const WS_ID = "ws-team-1";
const PROJECT_ID = "proj-1";
const SRC = "run-1e70e52a-43ad-40bc-b781-cf161763fe23";
const NEW_RUN = "run-9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f";
const HREF = `/workspace/team/${WS_ID}/projects/${PROJECT_ID}/research/${NEW_RUN}`;

const goodBody = () => ({ source: { sourceType: "personal_research", runId: SRC } });

function buildRequest(body?: unknown, raw?: string, workspaceId = WS_ID, projectId = PROJECT_ID): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/research/snapshots`, {
    method: "POST",
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function callPost(body?: unknown, opts: { raw?: string; workspaceId?: string; projectId?: string } = {}) {
  const workspaceId = opts.workspaceId ?? WS_ID;
  const projectId = opts.projectId ?? PROJECT_ID;
  const res = await POST(buildRequest(body, opts.raw, workspaceId, projectId), { params: { workspaceId, projectId } });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
  mockedCreateSnapshot.mockResolvedValue({ status: "created", runId: NEW_RUN, workspaceId: WS_ID, projectId: PROJECT_ID });
  mockedWriteTeamProjectEventSafely.mockResolvedValue(undefined);
});

describe("auth", () => {
  it("401 unauthorized when unauthenticated — and NOTHING downstream runs (no rate-limit read, no primitive, no event)", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res, json } = await callPost(goodBody());
    expect(res.status).toBe(401);
    expect(json).toEqual({ ok: false, errorCode: "unauthorized", message: "Please sign in." });
    expect(mockedCheckRateLimit).not.toHaveBeenCalled();
    expect(mockedCreateSnapshot).not.toHaveBeenCalled();
    expect(mockedWriteTeamProjectEventSafely).not.toHaveBeenCalled();
    // The anonymous response carries no information about source / Workspace / Project / lock existence.
    expect(JSON.stringify(json)).not.toMatch(new RegExp(`${SRC}|${WS_ID}|${PROJECT_ID}|source|project|workspace|lock`, "i"));
  });

  it("401 auth_error on any other identity failure", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "credential_mismatch" });
    const { res, json } = await callPost(goodBody());
    expect(res.status).toBe(401);
    expect(json.errorCode).toBe("auth_error");
  });
});

describe("rate limit (Z36)", () => {
  it("is UID-scoped at 10/60s, checked AFTER auth and BEFORE body parsing", async () => {
    await callPost(goodBody());
    expect(SNAPSHOT_RATE_LIMIT).toEqual({ maxRequests: 10, windowSeconds: 60 });
    expect(mockedCheckRateLimit).toHaveBeenCalledWith({ maxRequests: 10, windowSeconds: 60, identifier: `team-personal-research-snapshot:${UID}` });
    // A different Workspace/Project in the path uses the SAME identifier — never a per-Workspace bucket.
    await callPost(goodBody(), { workspaceId: "ws-other", projectId: "proj-other" });
    expect(mockedCheckRateLimit.mock.calls[1][0].identifier).toBe(`team-personal-research-snapshot:${UID}`);
  });

  it("429 rate_limited when exhausted, before the body is even parsed, and the primitive is never called", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const { res, json } = await callPost(undefined, { raw: "{not json" });
    expect(res.status).toBe(429);
    expect(json.errorCode).toBe("rate_limited");
    expect(mockedCreateSnapshot).not.toHaveBeenCalled();
  });
});

describe("body allow-list (§B)", () => {
  it("unparseable JSON → 400 invalid_request_body", async () => {
    const { res, json } = await callPost(undefined, { raw: "{not json" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_request_body");
  });

  it("missing source / missing runId / non-string runId / unsupported sourceType → 400 invalid_request_body", async () => {
    for (const body of [{}, { source: {} }, { source: { sourceType: "personal_research" } }, { source: { sourceType: "personal_research", runId: 7 } }, { source: { sourceType: "team_research", runId: SRC } }]) {
      const { res, json } = await callPost(body);
      expect(res.status).toBe(400);
      expect(json.errorCode).toBe("invalid_request_body");
    }
    expect(mockedCreateSnapshot).not.toHaveBeenCalled();
  });

  it("destination identifiers or run CONTENT in the body → 400 unexpected_field, never forwarded", async () => {
    for (const extra of [{ workspaceId: "ws-x" }, { projectId: "p-x" }, { question: "q" }, { results: [] }, { adaptiveOutput: {} }, { governance: {} }, { userId: "u" }, { runDocument: {} }]) {
      const { res, json } = await callPost({ ...goodBody(), ...extra });
      expect(res.status).toBe(400);
      expect(json.errorCode).toBe("unexpected_field");
    }
    const { res } = await callPost({ source: { sourceType: "personal_research", runId: SRC, workspaceId: "ws-x" } });
    expect(res.status).toBe(400);
    expect(mockedCreateSnapshot).not.toHaveBeenCalled();
  });

  it("a blank / malformed runId gets the SAME concealed 404 a foreign source gets — never a distinguishable 400", async () => {
    for (const runId of ["", "a/b", " x"]) {
      const { res, json } = await callPost({ source: { sourceType: "personal_research", runId } });
      expect(res.status).toBe(404);
      expect(json).toEqual({ ok: false, errorCode: "source_not_found", message: "This research could not be found." });
    }
    expect(mockedCreateSnapshot).not.toHaveBeenCalled();
    // Positive control: a foreign-but-well-formed source is the byte-identical response.
    mockedCreateSnapshot.mockResolvedValue({ status: "source_not_found" });
    const { res, json } = await callPost(goodBody());
    expect(res.status).toBe(404);
    expect(json).toEqual({ ok: false, errorCode: "source_not_found", message: "This research could not be found." });
  });
});

describe("primitive call + success mapping (§R)", () => {
  it("passes the PATH destination and the body source to the primitive — the body never chooses the destination", async () => {
    await callPost(goodBody());
    expect(mockedCreateSnapshot).toHaveBeenCalledTimes(1);
    expect(mockedCreateSnapshot).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID, projectId: PROJECT_ID, sourceRunId: SRC });
  });

  it("created → 201 with status, identity fields and the exact Team detail href (Z39); secondary event written AFTER, once", async () => {
    const { res, json } = await callPost(goodBody());
    expect(res.status).toBe(201);
    expect(json).toEqual({ ok: true, status: "created", runId: NEW_RUN, workspaceId: WS_ID, projectId: PROJECT_ID, href: HREF });
    expect(mockedWriteTeamProjectEventSafely).toHaveBeenCalledTimes(1);
    expect(mockedWriteTeamProjectEventSafely).toHaveBeenCalledWith({
      eventType: "project_run_association_changed",
      actorUid: UID,
      workspaceId: WS_ID,
      projectId: PROJECT_ID,
      runId: NEW_RUN,
      fromProjectId: null,
      toProjectId: PROJECT_ID,
    });
    expect(mockedWriteTeamProjectEventSafely.mock.invocationCallOrder[0]).toBeGreaterThan(mockedCreateSnapshot.mock.invocationCallOrder[0]);
  });

  it("a secondary-event failure never makes the committed snapshot look rolled back", async () => {
    mockedWriteTeamProjectEventSafely.mockRejectedValue(new Error("event store down"));
    await expect(callPost(goodBody())).rejects.toThrow("event store down");
  });

  it("already_exists → 200, same identity fields, and NO secondary event (positive control: created DOES emit one)", async () => {
    mockedCreateSnapshot.mockResolvedValue({ status: "already_exists", runId: NEW_RUN, workspaceId: WS_ID, projectId: PROJECT_ID });
    const { res, json } = await callPost(goodBody());
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, status: "already_exists", runId: NEW_RUN, workspaceId: WS_ID, projectId: PROJECT_ID, href: HREF });
    expect(mockedWriteTeamProjectEventSafely).not.toHaveBeenCalled();
  });

  it("the href percent-encodes every path segment", async () => {
    mockedCreateSnapshot.mockResolvedValue({ status: "created", runId: "run a", workspaceId: "ws/1", projectId: "p 1" });
    const { json } = await callPost(goodBody(), { workspaceId: "ws/1", projectId: "p 1" });
    expect(json.href).toBe("/workspace/team/ws%2F1/projects/p%201/research/run%20a");
  });
});

describe("error mapping (§R)", () => {
  it("insufficient_capability → 403", async () => {
    mockedCreateSnapshot.mockResolvedValue({ status: "unauthorized", reason: "insufficient_capability" });
    const { res, json } = await callPost(goodBody());
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("insufficient_capability");
    expect(mockedWriteTeamProjectEventSafely).not.toHaveBeenCalled();
  });

  it("every other authorization reason AND team_workspaces_disabled → the SAME concealed 404 team_workspace_not_found", async () => {
    const reasons = ["workspace_not_found", "workspace_malformed", "membership_not_found", "membership_removed", "membership_malformed", "owner_integrity_violation"];
    const bodies: string[] = [];
    for (const reason of reasons) {
      mockedCreateSnapshot.mockResolvedValue({ status: "unauthorized", reason });
      const { res, json } = await callPost(goodBody());
      expect(res.status).toBe(404);
      bodies.push(JSON.stringify(json));
    }
    mockedCreateSnapshot.mockResolvedValue({ status: "team_workspaces_disabled" });
    const disabled = await callPost(goodBody());
    expect(disabled.res.status).toBe(404);
    bodies.push(JSON.stringify(disabled.json));
    expect(new Set(bodies).size).toBe(1);
    expect(disabled.json.errorCode).toBe("team_workspace_not_found");
  });

  it("project_not_found → 404 project_not_found; project_archived → 409 project_archived", async () => {
    mockedCreateSnapshot.mockResolvedValue({ status: "project_not_found" });
    let r = await callPost(goodBody());
    expect(r.res.status).toBe(404);
    expect(r.json.errorCode).toBe("project_not_found");
    mockedCreateSnapshot.mockResolvedValue({ status: "project_archived" });
    r = await callPost(goodBody());
    expect(r.res.status).toBe(409);
    expect(r.json.errorCode).toBe("project_archived");
  });

  it("source_not_found → 404 source_not_found", async () => {
    mockedCreateSnapshot.mockResolvedValue({ status: "source_not_found" });
    const { res, json } = await callPost(goodBody());
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("source_not_found");
  });

  it("snapshot_too_large → 413 snapshot_too_large", async () => {
    mockedCreateSnapshot.mockResolvedValue({ status: "snapshot_too_large" });
    const { res, json } = await callPost(goodBody());
    expect(res.status).toBe(413);
    expect(json.errorCode).toBe("snapshot_too_large");
  });

  it("integrity_failure / firestore_unavailable / transaction_failed → sanitized 500 internal_error, no Firestore detail", async () => {
    for (const status of ["integrity_failure", "firestore_unavailable", "transaction_failed"]) {
      mockedCreateSnapshot.mockResolvedValue({ status });
      const { res, json } = await callPost(goodBody());
      expect(res.status).toBe(500);
      expect(json.errorCode).toBe("internal_error");
      expect(JSON.stringify(json)).not.toMatch(/firestore|lock|transaction|integrity/i);
    }
    expect(mockedWriteTeamProjectEventSafely).not.toHaveBeenCalled();
  });
});

describe("Z25/Z26 — zero quota, zero execution at the route boundary", () => {
  it("a successful POST never calls the inference quota writer or the execution engine (both mockable, both start at zero, both stay at zero)", async () => {
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(0);
    expect(mockedExecuteOrdinaryRun).toHaveBeenCalledTimes(0);
    const { res } = await callPost(goodBody());
    expect(res.status).toBe(201);
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(0);
    expect(mockedExecuteOrdinaryRun).toHaveBeenCalledTimes(0);
  });

  it("the route source imports neither the quota writer nor any execution/connector module", () => {
    const source = readFileSync(join(__dirname, "..", "route.ts"), "utf8");
    for (const forbidden of ["checkAndIncrementUsageForRun", "usageCheck", "executeOrdinaryRun", "runPanelExecution", "@/lib/connectors", "validateRunPanelRequest", "classifyQuery"]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("createTeamRunSnapshotFromPersonal");
  });

  it("no method other than POST is exported", async () => {
    const route = await import("@/app/api/workspaces/[workspaceId]/projects/[projectId]/research/snapshots/route");
    expect(typeof route.POST).toBe("function");
    for (const method of ["GET", "PATCH", "PUT", "DELETE"]) {
      expect((route as Record<string, unknown>)[method]).toBeUndefined();
    }
    expect(route.runtime).toBe("nodejs");
  });
});
