/**
 * Project/Research Assignment — GET|PATCH .../runs/{runId}/assignee.
 * `setTeamRunAssignee()`, the run access resolver, the presentation and
 * the D8 overlap reader are mocked; this suite covers identity, run-id
 * syntax concealment, UID-scoped rate limiting, strict body parsing, the
 * exact primitive call, the frozen §6.2 mapping, and GET's read-only shape.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedSet = jest.fn();
jest.mock("@/lib/projects/setTeamRunAssignee", () => ({ setTeamRunAssignee: (...a: unknown[]) => mockedSet(...a) }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
const mockedPresent = jest.fn();
jest.mock("@/lib/workspaces/assigneePresentation", () => ({ resolveAssigneePresentations: (...a: unknown[]) => mockedPresent(...a) }));
const mockedOverlap = jest.fn();
jest.mock("@/lib/workspaces/runAssignmentReviewOverlap", () => ({ readRunReviewerUidsForAssignmentWarning: (...a: unknown[]) => mockedOverlap(...a) }));
const mockedCheckRateLimit = jest.fn();
jest.mock("@/lib/security/rateLimit", () => ({ checkRateLimit: (...a: unknown[]) => mockedCheckRateLimit(...a) }));
const runDocs = new Map<string, Record<string, unknown>>();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return { collection: () => ({ doc: (id: string) => ({ get: async () => ({ exists: runDocs.has(id), data: () => runDocs.get(id) }) }) }) };
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET, PATCH } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/assignee/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const RUN_ID = "run-1";
const VALID_BODY = { assigneeUid: "member-1", expectedAssigneeUid: null };

function patch(body?: unknown, runId = RUN_ID, rawText?: string) {
  const init = rawText !== undefined ? { method: "PATCH", body: rawText } : { method: "PATCH", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  return PATCH(new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${encodeURIComponent(runId)}/assignee`, init), { params: { workspaceId: WS_ID, runId } });
}
function get(runId = RUN_ID) {
  return GET(new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${encodeURIComponent(runId)}/assignee`, { method: "GET" }), { params: { workspaceId: WS_ID, runId } });
}
async function json(res: Response) {
  return { status: res.status, body: await res.json() };
}
const ACCESS = { granted: true, workspace: { id: WS_ID, name: "Acme" }, membership: { role: "member" }, capabilities: ["workspace.read", "research.read", "research.create", "research.organize"] };

beforeEach(() => {
  jest.clearAllMocks();
  runDocs.clear();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true });
  mockedAccess.mockResolvedValue(ACCESS);
  mockedPresent.mockResolvedValue(new Map([["member-1", { uid: "member-1", displayName: "Bao", state: "active" }]]));
  mockedOverlap.mockResolvedValue(["member-1"]);
});

describe("PATCH — gates", () => {
  it("401 unauthenticated; nothing called", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    expect((await patch(VALID_BODY)).status).toBe(401);
    expect(mockedSet).not.toHaveBeenCalled();
  });
  it("a syntactically invalid run id answers the SAME concealed 404 as a foreign run (never a distinguishable 400), before rate limiting", async () => {
    mockedSet.mockResolvedValue({ status: "run_not_found" });
    const foreign = await json(await patch(VALID_BODY));
    const bad = await json(await patch(VALID_BODY, "../evil"));
    expect(foreign.status).toBe(404);
    expect(bad).toEqual(foreign);
    expect(mockedCheckRateLimit).toHaveBeenCalledTimes(1);
  });
  it("rate limit is UID-scoped (never Workspace-scoped) and answers 429", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false });
    expect((await patch(VALID_BODY)).status).toBe(429);
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(expect.objectContaining({ identifier: `team-run-assignee:${UID}` }));
    expect(mockedSet).not.toHaveBeenCalled();
  });
  it("strict body: malformed JSON / unknown field / missing expectedAssigneeUid ⇒ 400", async () => {
    expect(await json(await patch(undefined, RUN_ID, "{"))).toMatchObject({ status: 400, body: { errorCode: "invalid_request_body" } });
    expect(await json(await patch({ ...VALID_BODY, projectId: "p" }))).toMatchObject({ status: 400, body: { errorCode: "unexpected_field" } });
    expect(await json(await patch({ assigneeUid: "member-1" }))).toMatchObject({ status: 400, body: { errorCode: "invalid_request_body" } });
    expect(mockedSet).not.toHaveBeenCalled();
  });
});

describe("PATCH — primitive call and mapping", () => {
  it("passes exactly {uid, workspaceId, runId, assigneeUid, expectedAssigneeUid}", async () => {
    mockedSet.mockResolvedValue({ status: "assigned", runId: RUN_ID, workspaceId: WS_ID, previousAssigneeUid: null, assigneeUid: "member-1" });
    await patch(VALID_BODY);
    expect(mockedSet).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID, runId: RUN_ID, assigneeUid: "member-1", expectedAssigneeUid: null });
  });
  it("assigned ⇒ 200 changed:true; unchanged ⇒ 200 changed:false; neither leaks previousAssigneeUid", async () => {
    mockedSet.mockResolvedValueOnce({ status: "assigned", runId: RUN_ID, workspaceId: WS_ID, previousAssigneeUid: "x", assigneeUid: "member-1" });
    const a = await json(await patch(VALID_BODY));
    expect(a).toEqual({ status: 200, body: { ok: true, changed: true, runId: RUN_ID, workspaceId: WS_ID, assigneeUid: "member-1" } });
    mockedSet.mockResolvedValueOnce({ status: "unchanged", runId: RUN_ID, workspaceId: WS_ID, assigneeUid: "member-1" });
    expect(await json(await patch(VALID_BODY))).toEqual({ status: 200, body: { ok: true, changed: false, runId: RUN_ID, workspaceId: WS_ID, assigneeUid: "member-1" } });
  });
  it.each([
    [{ status: "unauthorized", reason: "insufficient_capability" }, 403, "insufficient_capability"],
    [{ status: "unauthorized", reason: "not_a_member" }, 404, "team_workspace_not_found"],
    [{ status: "run_not_found" }, 404, "run_not_found"],
    [{ status: "conflict" }, 409, "assignee_conflict"],
    [{ status: "assignee_not_eligible" }, 400, "assignee_not_eligible"],
    [{ status: "firestore_unavailable" }, 500, "internal_error"],
    [{ status: "transaction_failed" }, 500, "internal_error"],
  ])("%p ⇒ %i %s", async (result, status, code) => {
    mockedSet.mockResolvedValue(result);
    expect(await json(await patch(VALID_BODY))).toMatchObject({ status, body: { ok: false, errorCode: code } });
  });
  it("CONCEALMENT — both rollout non-admissions answer the SAME body as a non-member", async () => {
    mockedSet.mockResolvedValueOnce({ status: "unauthorized", reason: "not_a_member" });
    const baseline = await json(await patch(VALID_BODY));
    for (const status of ["team_workspaces_disabled", "project_assignment_disabled"]) {
      mockedSet.mockResolvedValueOnce({ status });
      expect(await json(await patch(VALID_BODY))).toEqual(baseline);
    }
  });
});

describe("GET — read-only presentation for the picker (D8 input)", () => {
  it("requires research.read; denial mapping comes from the shared run-access responses", async () => {
    mockedAccess.mockResolvedValue({ ...ACCESS, capabilities: ["workspace.read"] });
    expect((await get()).status).toBe(403);
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    expect((await get()).status).toBe(404);
  });
  it("returns the normalized assignee presentation (RUN rule) + reviewerUids; never writes (setTeamRunAssignee untouched)", async () => {
    runDocs.set(RUN_ID, { userId: "x", workspaceId: WS_ID, projectId: "proj-1", createdAt: Timestamp.now(), assigneeUid: "member-1" });
    const r = await json(await get());
    expect(r).toEqual({ status: 200, body: { ok: true, runId: RUN_ID, workspaceId: WS_ID, projectId: "proj-1", assignee: { uid: "member-1", displayName: "Bao", state: "active" }, reviewerUids: ["member-1"] } });
    expect(mockedPresent).toHaveBeenCalledWith(WS_ID, "run", ["member-1"]);
    expect(mockedOverlap).toHaveBeenCalledWith(RUN_ID);
    expect(mockedSet).not.toHaveBeenCalled();
  });
  it("unassigned ⇒ assignee: null (no presentation read); MALFORMED stored value (42) ⇒ null, never the raw value", async () => {
    runDocs.set(RUN_ID, { userId: "x", workspaceId: WS_ID, projectId: null, createdAt: Timestamp.now() });
    expect((await json(await get())).body.assignee).toBeNull();
    expect(mockedPresent).not.toHaveBeenCalled();
    runDocs.set(RUN_ID, { userId: "x", workspaceId: WS_ID, projectId: null, createdAt: Timestamp.now(), assigneeUid: 42 });
    const r = await json(await get());
    expect(r.body.assignee).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain("42");
  });
  it("missing / foreign / legacy run and a malformed run id all answer the SAME concealed 404", async () => {
    const missing = await json(await get());
    runDocs.set(RUN_ID, { userId: "x", workspaceId: "ws-other", projectId: null, createdAt: Timestamp.now() });
    expect(await json(await get())).toEqual(missing);
    runDocs.set(RUN_ID, { userId: "x", createdAt: Timestamp.now() });
    expect(await json(await get())).toEqual(missing);
    expect(await json(await get("../evil"))).toEqual(missing);
    expect(missing.status).toBe(404);
  });
});
