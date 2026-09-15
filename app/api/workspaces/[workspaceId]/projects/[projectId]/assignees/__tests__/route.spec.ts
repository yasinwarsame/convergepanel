/**
 * Project/Research Assignment — POST .../projects/{projectId}/assignees.
 * `updateTeamProjectFields()` and the enrichment are mocked; this suite
 * covers identity, UID-scoped rate limiting, strict body parsing, the exact
 * primitive call, and the frozen §6.2 status mapping — including the
 * concealment of rollout non-admission as an ordinary authorization denial.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedUpdate = jest.fn();
jest.mock("@/lib/firestore/teamProjects", () => ({ updateTeamProjectFields: (...a: unknown[]) => mockedUpdate(...a) }));
const mockedEnrich = jest.fn();
jest.mock("@/lib/workspaces/teamProjectAssigneeEnrichment", () => ({ enrichTeamProjectDtos: (...a: unknown[]) => mockedEnrich(...a) }));
const mockedCheckRateLimit = jest.fn();
jest.mock("@/lib/security/rateLimit", () => ({ checkRateLimit: (...a: unknown[]) => mockedCheckRateLimit(...a) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { POST } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/assignees/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const PROJECT_ID = "proj-1";
const TOKEN = { seconds: 1_700_000_000, nanoseconds: 0 };
const VALID_BODY = { assigneeUids: ["member-1"], expectedUpdateTime: TOKEN };
const project = { id: PROJECT_ID, workspaceId: WS_ID, name: "P", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), assigneeUids: ["member-1"] };

function call(body?: unknown, rawText?: string) {
  const init = rawText !== undefined ? { method: "POST", body: rawText } : { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  return POST(new NextRequest(`http://localhost/api/workspaces/${WS_ID}/projects/${PROJECT_ID}/assignees`, init), { params: { workspaceId: WS_ID, projectId: PROJECT_ID } });
}
async function json(res: Response) {
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true });
  mockedEnrich.mockImplementation(async (_ws: string, items: { project: { id: string } }[]) => items.map((i) => ({ id: i.project.id, assignees: [{ uid: "member-1", displayName: "Bao", state: "active" }] })));
});

describe("gates before the primitive", () => {
  it("401 when unauthenticated; nothing called", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    expect((await call(VALID_BODY)).status).toBe(401);
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCheckRateLimit).not.toHaveBeenCalled();
  });
  it("rate limit is UID-scoped (never Workspace-scoped) and answers 429", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false });
    expect((await call(VALID_BODY)).status).toBe(429);
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(expect.objectContaining({ identifier: `team-project-assignees:${UID}`, maxRequests: 20, windowSeconds: 60 }));
    expect(JSON.stringify(mockedCheckRateLimit.mock.calls[0][0])).not.toContain(WS_ID);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });
  it("malformed JSON / unknown field / missing key / invalid token ⇒ 400 with the exact codes; nothing called", async () => {
    expect(await json(await call(undefined, "{not json"))).toMatchObject({ status: 400, body: { errorCode: "invalid_request_body" } });
    expect(await json(await call({ ...VALID_BODY, workspaceId: "x" }))).toMatchObject({ status: 400, body: { errorCode: "unexpected_field" } });
    expect(await json(await call({ assigneeUids: [] }))).toMatchObject({ status: 400, body: { errorCode: "invalid_request_body" } });
    expect(await json(await call({ assigneeUids: [], expectedUpdateTime: { seconds: "1" } }))).toMatchObject({ status: 400, body: { errorCode: "invalid_update_time" } });
    expect(mockedUpdate).not.toHaveBeenCalled();
  });
  it("an oversized raw array (> 200) ⇒ 400 too_many_assignees before the primitive", async () => {
    const r = await json(await call({ assigneeUids: Array.from({ length: 201 }, () => "a"), expectedUpdateTime: TOKEN }));
    expect(r).toMatchObject({ status: 400, body: { errorCode: "too_many_assignees" } });
    expect(mockedUpdate).not.toHaveBeenCalled();
  });
});

describe("the primitive call and success mapping", () => {
  it("passes {uid, workspaceId, projectId, mutation:{kind:'set_assignees', assigneeUids RAW}, expectedUpdateTime} — path ids only, never body ids", async () => {
    mockedUpdate.mockResolvedValue({ status: "updated", project, documentUpdateTime: Timestamp.now() });
    await call(VALID_BODY);
    expect(mockedUpdate).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID, projectId: PROJECT_ID, mutation: { kind: "set_assignees", assigneeUids: ["member-1"] }, expectedUpdateTime: expect.objectContaining({ seconds: TOKEN.seconds, nanoseconds: TOKEN.nanoseconds }) });
  });
  it("updated ⇒ 200 {ok, changed:true, project: ENRICHED dto}; unchanged ⇒ changed:false; projection-unavailable ⇒ flagged, still 200", async () => {
    mockedUpdate.mockResolvedValueOnce({ status: "updated", project, documentUpdateTime: Timestamp.now() });
    expect(await json(await call(VALID_BODY))).toMatchObject({ status: 200, body: { ok: true, changed: true, project: { id: PROJECT_ID, assignees: [{ displayName: "Bao" }] } } });
    mockedUpdate.mockResolvedValueOnce({ status: "unchanged", project, documentUpdateTime: Timestamp.now() });
    expect(await json(await call(VALID_BODY))).toMatchObject({ status: 200, body: { ok: true, changed: false } });
    mockedUpdate.mockResolvedValueOnce({ status: "updated_projection_unavailable", project });
    expect(await json(await call(VALID_BODY))).toMatchObject({ status: 200, body: { ok: true, changed: true, projectionUnavailable: true } });
    expect(mockedEnrich).toHaveBeenLastCalledWith(WS_ID, [{ project, documentUpdateTime: null }]);
  });
});

describe("frozen §6.2 mapping", () => {
  it.each([
    [{ status: "unauthorized", reason: "insufficient_capability" }, 403, "insufficient_capability"],
    [{ status: "unauthorized", reason: "not_a_member" }, 404, "team_workspace_not_found"],
    [{ status: "project_not_found" }, 404, "project_not_found"],
    [{ status: "project_archived" }, 409, "project_archived"],
    [{ status: "precondition_failed" }, 409, "conflict"],
    [{ status: "invalid_assignees" }, 400, "invalid_request_body"],
    [{ status: "too_many_assignees" }, 400, "too_many_assignees"],
    [{ status: "assignee_not_eligible" }, 400, "assignee_not_eligible"],
    [{ status: "firestore_unavailable" }, 500, "internal_error"],
    [{ status: "update_failed" }, 500, "internal_error"],
  ])("%p ⇒ %i %s", async (result, status, code) => {
    mockedUpdate.mockResolvedValue(result);
    expect(await json(await call(VALID_BODY))).toMatchObject({ status, body: { ok: false, errorCode: code } });
  });

  it("CONCEALMENT — team_workspaces_disabled and project_assignment_disabled answer the SAME body as a non-member (never a rollout oracle)", async () => {
    mockedUpdate.mockResolvedValueOnce({ status: "unauthorized", reason: "not_a_member" });
    const baseline = await json(await call(VALID_BODY));
    mockedUpdate.mockResolvedValueOnce({ status: "team_workspaces_disabled" });
    expect(await json(await call(VALID_BODY))).toEqual(baseline);
    mockedUpdate.mockResolvedValueOnce({ status: "project_assignment_disabled" });
    expect(await json(await call(VALID_BODY))).toEqual(baseline);
    expect(baseline.status).toBe(404);
  });
});
