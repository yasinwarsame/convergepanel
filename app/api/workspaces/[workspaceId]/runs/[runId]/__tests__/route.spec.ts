/**
 * Team Research Parity, Phase R1 — `GET /api/workspaces/{workspaceId}/runs/{runId}`.
 *
 * Identity, the Team run access resolver, Firestore, the Project reader,
 * assignee enrichment, the assignment reader and the review-routing
 * resolver are mocked at their module boundaries; the row validator, the
 * response family, the viewer-role helper, the payload builder and every
 * envelope parser are REAL. Covers: gate ordering, the Team concealment
 * family (never the user route's local 403/404 mapping), Workspace and
 * Project containment, assignment-never-authorizes, reviewer redaction,
 * Project label degradation vs infrastructure failure, and the Team
 * presentation fields (no source run id, no reviewer identity).
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...a: unknown[]) => mockedGetProject(...a) }));
const mockedAssignees = jest.fn();
jest.mock("@/lib/workspaces/teamRunAssigneeEnrichment", () => ({ resolveRunAssigneesForPage: (...a: unknown[]) => mockedAssignees(...a) }));
const mockedGetAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({ getAdaptiveHumanReviewAssignment: (...a: unknown[]) => mockedGetAssignment(...a) }));
const mockedReviewRouting = jest.fn();
jest.mock("@/lib/runs/resolveRunReviewRouting", () => ({ resolveRunReviewRouting: (...a: unknown[]) => mockedReviewRouting(...a) }));
const runDocs = new Map<string, Record<string, unknown>>();
let adminAvailable = true;
let runGetThrows = false;
/** Section L — every Firestore write surface records an attempt; the read must make none. */
const writeAttempts: string[] = [];
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    if (!adminAvailable) return null;
    const record = (op: string) => async () => {
      writeAttempts.push(op);
      throw new Error(`write attempted: ${op}`);
    };
    return {
      collection: (name: string) => ({
        doc: (id: string) => ({
          get: async () => {
            if (name !== "runs") throw new Error(`unexpected collection ${name}`);
            if (runGetThrows) throw new Error("firestore down");
            return { exists: runDocs.has(id), data: () => runDocs.get(id) };
          },
          set: record(`${name}.set`),
          update: record(`${name}.update`),
          delete: record(`${name}.delete`),
          create: record(`${name}.create`),
        }),
        add: record(`${name}.add`),
      }),
      batch: () => ({ set: record("batch.set"), update: record("batch.update"), delete: record("batch.delete"), commit: record("batch.commit") }),
      runTransaction: record("runTransaction"),
    };
  },
}));
jest.mock("@/lib/connectors", () => new Proxy({}, { get: (_t, key) => { throw new Error(`model connector touched: ${String(key)}`); } }));
const mockedLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: mockedLogger }));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/route";
import { FIXTURE_OWNER_UID, FIXTURE_PROJECT_ID, FIXTURE_RUN_ID, FIXTURE_WORKSPACE_ID, fullTeamRunData, governanceRecord } from "@/lib/runs/__tests__/runReadFixtures";

const UID = "member-b";
const WS_ID = FIXTURE_WORKSPACE_ID;
const RUN_ID = FIXTURE_RUN_ID;
const CREATED = Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z"));
const COMPLETED = Timestamp.fromDate(new Date("2026-09-02T10:05:00.000Z"));
const SOURCE_CREATED = Timestamp.fromDate(new Date("2026-08-01T00:00:00.000Z"));
const NUL = String.fromCharCode(0);

function teamRun(overrides: Record<string, unknown> = {}) {
  return fullTeamRunData({
    createdAt: CREATED,
    completedAt: COMPLETED,
    assigneeUid: "member-c",
    origin: { type: "personal_research", runId: "SECRET-personal-source-run", sourceCreatedAt: SOURCE_CREATED, sourceCompletedAt: null },
    ...overrides,
  });
}
function grant(capabilities: string[] = ["workspace.read", "research.read"]) {
  return { granted: true, workspace: { id: WS_ID, type: "team" }, membership: { role: "member" }, capabilities };
}
function get(runId = RUN_ID, query = "", headers: Record<string, string> = {}) {
  return GET(new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${encodeURIComponent(runId)}${query}`, { method: "GET", headers }), { params: { workspaceId: WS_ID, runId } });
}
async function json(res: Response) {
  return { status: res.status, body: await res.json() };
}
const CONCEALED = { status: 404, body: { ok: false, errorCode: "run_not_found", message: "This run could not be found." } };

beforeEach(() => {
  jest.clearAllMocks();
  runDocs.clear();
  writeAttempts.length = 0;
  adminAvailable = true;
  runGetThrows = false;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedAccess.mockResolvedValue(grant());
  mockedGetProject.mockResolvedValue({ status: "found", project: { id: FIXTURE_PROJECT_ID, workspaceId: WS_ID, name: "Launch", status: "active", createdByUserId: "x" }, documentUpdateTime: CREATED });
  mockedAssignees.mockResolvedValue([{ uid: "member-c", displayName: "Cy", state: "active" }]);
  mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
  mockedReviewRouting.mockResolvedValue("in_queue");
  runDocs.set(RUN_ID, teamRun());
});

describe("gates, in order", () => {
  it("401 unauthenticated — nothing else consulted", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const r = await json(await get());
    expect(r.status).toBe(401);
    expect(r.body.errorCode).toBe("unauthorized");
    expect(mockedAccess).not.toHaveBeenCalled();
  });

  // TEAM-RESEARCH-PARITY-R4-T1 — a PRESENT but invalid bearer is an authentication
  // failure (auth_error), never "please sign in" (unauthorized), and it stops the
  // request at the identity boundary: no Workspace access, no run read, no builder.
  it("401 invalid bearer token → auth_error (not unauthorized); nothing past identity resolution is consulted", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "invalid_bearer_token" });
    const runReads = jest.spyOn(runDocs, "has");
    const res = await get(RUN_ID, `?projectId=${FIXTURE_PROJECT_ID}`, { authorization: "Bearer not-a-valid-firebase-id-token" });
    const r = await json(res);

    expect(r).toEqual({ status: 401, body: { ok: false, errorCode: "auth_error", message: "Authentication failed." } });
    // The route handed the real request (with its bearer) to the shared resolver exactly once.
    expect(mockedResolveRequestIdentity).toHaveBeenCalledTimes(1);
    expect((mockedResolveRequestIdentity.mock.calls[0][0] as Request).headers.get("authorization")).toBe("Bearer not-a-valid-firebase-id-token");
    const { logIdentityResolutionFailure } = jest.requireMock("@/lib/auth/identityResolutionTelemetry") as { logIdentityResolutionFailure: jest.Mock };
    expect(logIdentityResolutionFailure).toHaveBeenCalledWith(
      expect.objectContaining({ route: "GET /api/workspaces/[workspaceId]/runs/[runId]", method: "GET", failureCategory: "invalid_bearer_token" })
    );
    // Short-circuit: no Team authorization, no Firestore lookup, no enrichment, no write.
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(runReads).not.toHaveBeenCalled();
    expect(mockedGetProject).not.toHaveBeenCalled();
    expect(mockedAssignees).not.toHaveBeenCalled();
    expect(mockedGetAssignment).not.toHaveBeenCalled();
    expect(mockedReviewRouting).not.toHaveBeenCalled();
    expect(writeAttempts).toEqual([]);
    runReads.mockRestore();
  });

  it.each(["invalid_session_cookie", "credential_mismatch", "revoked_session", "expired_session"])(
    "401 %s → auth_error (never unauthorized), no Workspace access",
    async (reason) => {
      mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason });
      const r = await json(await get());
      expect(r).toEqual({ status: 401, body: { ok: false, errorCode: "auth_error", message: "Authentication failed." } });
      expect(mockedAccess).not.toHaveBeenCalled();
    }
  );

  it.each(["", " run", "a/b", "..", `run${NUL}`])("malformed run id %j → concealed run_not_found before any Workspace lookup", async (bad) => {
    const r = await json(await get(bad));
    expect(r).toEqual(CONCEALED);
    expect(mockedAccess).not.toHaveBeenCalled();
  });

  it.each(["", " p", "a/b"])("malformed ?projectId=%j → concealed run_not_found before any Workspace lookup (never a 400)", async (bad) => {
    const r = await json(await get(RUN_ID, `?projectId=${encodeURIComponent(bad)}`));
    expect(r).toEqual(CONCEALED);
    expect(mockedAccess).not.toHaveBeenCalled();
  });

  it("access is resolved for the ADDRESSED Workspace and the requester", async () => {
    await get();
    expect(mockedAccess).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID });
  });

  it.each(["membership_not_found", "membership_removed", "membership_malformed", "workspace_not_found", "workspace_malformed", "wrong_workspace_type", "owner_integrity_violation", "team_workspaces_disabled"])(
    "denial %s → the Team family's concealed 404 team_workspace_not_found (NOT the user route's 403 forbidden)",
    async (reason) => {
      mockedAccess.mockResolvedValue({ granted: false, reason });
      const r = await json(await get());
      expect(r.status).toBe(404);
      expect(r.body.errorCode).toBe("team_workspace_not_found");
      expect(mockedGetAssignment).not.toHaveBeenCalled();
    }
  );

  it("denial lookup_failed → 503 team_workspace_unavailable", async () => {
    mockedAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    const r = await json(await get());
    expect(r.status).toBe(503);
    expect(r.body.errorCode).toBe("team_workspace_unavailable");
  });

  it("granted without research.read → 403 insufficient_capability; run never read", async () => {
    mockedAccess.mockResolvedValue(grant(["workspace.read"]));
    const r = await json(await get());
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe("insufficient_capability");
    expect(mockedGetAssignment).not.toHaveBeenCalled();
  });

  it("Firebase Admin unavailable → 503 (availability, never absence)", async () => {
    adminAvailable = false;
    const r = await json(await get());
    expect(r.status).toBe(503);
    expect(r.body.errorCode).toBe("team_workspace_unavailable");
  });

  it("run read throws → 503, error never forwarded", async () => {
    runGetThrows = true;
    const r = await json(await get());
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("firestore down");
  });

  it("run absent → concealed run_not_found", async () => {
    runDocs.clear();
    expect(await json(await get())).toEqual(CONCEALED);
  });
});

describe("containment", () => {
  it("a Personal run (no workspaceId) is concealed even for a granted member", async () => {
    runDocs.set(RUN_ID, teamRun({ workspaceId: undefined }));
    expect(await json(await get())).toEqual(CONCEALED);
    expect(mockedGetAssignment).not.toHaveBeenCalled();
  });

  it("a run bound to ANOTHER Team Workspace is concealed — the addressed Workspace grant does not reach across", async () => {
    runDocs.set(RUN_ID, teamRun({ workspaceId: "otherTeamWorkspaceId00001" }));
    expect(await json(await get())).toEqual(CONCEALED);
  });

  it("a row with an absent/malformed projectId or a non-Timestamp createdAt fails shape validation and is concealed", async () => {
    runDocs.set(RUN_ID, teamRun({ projectId: undefined }));
    expect(await json(await get())).toEqual(CONCEALED);
    runDocs.set(RUN_ID, teamRun({ projectId: 42 }));
    expect(await json(await get())).toEqual(CONCEALED);
    runDocs.set(RUN_ID, teamRun({ createdAt: "2026-09-02T10:00:00.000Z" }));
    expect(await json(await get())).toEqual(CONCEALED);
  });

  it("?projectId matching the run's Project → 200; a different Project → concealed", async () => {
    expect((await get(RUN_ID, `?projectId=${FIXTURE_PROJECT_ID}`)).status).toBe(200);
    expect(await json(await get(RUN_ID, "?projectId=someOtherProject"))).toEqual(CONCEALED);
  });

  it("an Unfiled run is readable without ?projectId but concealed when addressed through any Project", async () => {
    runDocs.set(RUN_ID, teamRun({ projectId: null }));
    const r = await json(await get());
    expect(r.status).toBe(200);
    expect(r.body.team.projectId).toBeNull();
    expect(r.body.team.project).toBeNull();
    expect(mockedGetProject).not.toHaveBeenCalled();
    expect(await json(await get(RUN_ID, `?projectId=${FIXTURE_PROJECT_ID}`))).toEqual(CONCEALED);
  });

  it("a filed run whose Project belongs to ANOTHER Workspace is concealed (integrity anomaly, never leaked)", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: FIXTURE_PROJECT_ID, workspaceId: "otherWs", name: "Foreign", status: "active" }, documentUpdateTime: CREATED });
    expect(await json(await get())).toEqual(CONCEALED);
  });
});

describe("assignment never authorizes", () => {
  it("a non-member named by the run's reviewer assignment is still concealed; the builder is never reached", async () => {
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { assignedReviewerUserId: UID } });
    const r = await json(await get());
    expect(r.status).toBe(404);
    expect(mockedGetAssignment).not.toHaveBeenCalled();
    expect(mockedReviewRouting).not.toHaveBeenCalled();
  });

  it("a non-member who is the run's PRIMARY ASSIGNEE (assigneeUid) is still concealed — assignment is responsibility, never access", async () => {
    runDocs.set(RUN_ID, teamRun({ assigneeUid: UID }));
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const r = await json(await get());
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe("team_workspace_not_found");
    expect(mockedAssignees).not.toHaveBeenCalled();
  });

  it("an assigned reviewer whose membership lacks research.read still gets 403 insufficient_capability — assignment never substitutes for the capability", async () => {
    mockedAccess.mockResolvedValue(grant(["workspace.read", "reviews.submit"]));
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { assignedReviewerUserId: UID } });
    const r = await json(await get());
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe("insufficient_capability");
  });

  it("the run's own creator gets no bypass — creator identity is attribution only", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: FIXTURE_OWNER_UID, source: "session_cookie" });
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_removed" });
    const r = await json(await get());
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe("team_workspace_not_found");
  });

  it("assigned + reviews.submit but a decided review → team_member, full rows", async () => {
    mockedAccess.mockResolvedValue(grant(["workspace.read", "research.read", "reviews.submit"]));
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { assignedReviewerUserId: UID } });
    runDocs.set(RUN_ID, teamRun({ governanceRecord: governanceRecord("approved") }));
    const r = await json(await get());
    expect(r.status).toBe(200);
    expect(r.body.viewerRole).toBe("team_member");
    expect(r.body.results[0]).toHaveProperty("tokenUsage");
  });

  it("assignment lookup failure → team_member (lesser role), never a denial", async () => {
    mockedAccess.mockResolvedValue(grant(["workspace.read", "research.read", "reviews.submit"]));
    mockedGetAssignment.mockResolvedValue({ status: "read_failed" });
    const r = await json(await get());
    expect(r.status).toBe(200);
    expect(r.body.viewerRole).toBe("team_member");
  });
});

describe("viewer role and redaction", () => {
  it("a granted viewer-role member (research.read only) gets the full research payload with tokenUsage/latencyMs", async () => {
    const r = await json(await get());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.viewerRole).toBe("team_member");
    expect(r.body.adaptive.status).toBe("valid");
    expect(r.body.adaptive.output.schemaId).toBe("deep_research");
    expect(r.body.legacyAdaptive.status).toBe("valid");
    expect(r.body.synthesisCache.schemaVersion).toBe(1);
    expect(r.body.results).toHaveLength(2);
    expect(r.body.results[0]).toMatchObject({ tokenUsage: { totalTokens: 3 }, latencyMs: 120 });
  });

  it("team_reviewer (reviews.submit + assigned + reviewable) → rows lose tokenUsage and latencyMs", async () => {
    mockedAccess.mockResolvedValue(grant(["workspace.read", "research.read", "reviews.submit"]));
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { assignedReviewerUserId: UID } });
    const r = await json(await get());
    expect(r.status).toBe(200);
    expect(r.body.viewerRole).toBe("team_reviewer");
    expect(r.body.results).toHaveLength(2);
    for (const row of r.body.results) {
      expect(row).not.toHaveProperty("tokenUsage");
      expect(row).not.toHaveProperty("latencyMs");
    }
  });

  it("reviewRouting is resolved through the shared resolver for a still-unreviewed run, keyed by the RUN OWNER and the request id", async () => {
    const r = await json(await get(RUN_ID, "", { "x-vercel-id": "vid-9" }));
    expect(mockedReviewRouting).toHaveBeenCalledWith({ runId: RUN_ID, ownerUid: FIXTURE_OWNER_UID, requestId: "vid-9" });
    expect(r.body.adaptive.reviewRouting).toBe("in_queue");
  });
});

describe("Team presentation fields", () => {
  it("emits containment ids, Project label, assignee, ISO dates, provenance kind/dates and a read-only review summary", async () => {
    const r = await json(await get());
    expect(r.body.team).toEqual({
      workspaceId: WS_ID,
      projectId: FIXTURE_PROJECT_ID,
      project: { id: FIXTURE_PROJECT_ID, name: "Launch", status: "active" },
      assignee: { uid: "member-c", displayName: "Cy", state: "active" },
      createdAt: "2026-09-02T10:00:00.000Z",
      completedAt: "2026-09-02T10:05:00.000Z",
      origin: { kind: "personal_research", sourceCreatedAt: "2026-08-01T00:00:00.000Z", sourceCompletedAt: null },
      review: { humanReviewStatus: "unreviewed", conditions: ["cond-a"], decidedVia: "workspace_review", decisionReceipt: { conclusion: "Concluded", sourceBacked: true, humanReviewNeeded: false } },
    });
    expect(mockedGetProject).toHaveBeenCalledWith(FIXTURE_PROJECT_ID);
    expect(mockedAssignees).toHaveBeenCalledWith(WS_ID, [{ docId: RUN_ID, data: runDocs.get(RUN_ID) }]);
  });

  it("never emits the source Personal run id, reviewer identity or comment text anywhere in the body", async () => {
    const text = await (await get()).text();
    expect(text).not.toContain("SECRET-personal-source-run");
    expect(text).not.toContain("rev-secret");
    expect(text).not.toContain("Secret Name");
    expect(text).not.toContain("secret comment");
  });

  it("an archived Project stays readable with its label", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: FIXTURE_PROJECT_ID, workspaceId: WS_ID, name: "Old", status: "archived" }, documentUpdateTime: CREATED });
    const r = await json(await get());
    expect(r.status).toBe(200);
    expect(r.body.team.project).toEqual({ id: FIXTURE_PROJECT_ID, name: "Old", status: "archived" });
  });

  it.each(["not_found", "malformed"])("Project %s → run still readable, label null, projectId kept, anomaly logged", async (status) => {
    mockedGetProject.mockResolvedValue({ status });
    const r = await json(await get());
    expect(r.status).toBe(200);
    expect(r.body.team.project).toBeNull();
    expect(r.body.team.projectId).toBe(FIXTURE_PROJECT_ID);
    expect(mockedLogger.warn).toHaveBeenCalled();
  });

  it.each(["firestore_unavailable", "read_failed"])("Project %s → 503 (infrastructure failure is not a missing label)", async (status) => {
    mockedGetProject.mockResolvedValue({ status });
    const r = await json(await get());
    expect(r.status).toBe(503);
    expect(r.body.errorCode).toBe("team_workspace_unavailable");
  });

  it("missing completedAt, malformed origin and absent governanceRecord degrade to null (never throw, never conceal)", async () => {
    runDocs.set(RUN_ID, teamRun({ completedAt: undefined, origin: { type: "personal_research", runId: "x", sourceCreatedAt: "not-a-timestamp" }, governanceRecord: undefined }));
    mockedAssignees.mockResolvedValue([null]);
    const r = await json(await get());
    expect(r.status).toBe(200);
    expect(r.body.team.completedAt).toBeNull();
    expect(r.body.team.origin).toBeNull();
    expect(r.body.team.review).toBeNull();
    expect(r.body.team.assignee).toBeNull();
  });
});

describe("zero write-on-read (section L)", () => {
  it("one Team detail GET performs no run/governance/review/assignment write, no batch, no transaction, no outbound fetch and no model execution", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("outbound fetch attempted");
    });
    try {
      mockedAccess.mockResolvedValue(grant(["workspace.read", "research.read", "reviews.submit", "research.organize"]));
      mockedGetAssignment.mockResolvedValue({ status: "found", assignment: { assignedReviewerUserId: UID } });
      const r = await json(await get());
      expect(r.status).toBe(200);
      expect(r.body.viewerRole).toBe("team_reviewer");
      expect(writeAttempts).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      // The persisted document is untouched by the read (no in-place mutation either).
      expect(runDocs.get(RUN_ID)).toEqual(teamRun());
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
