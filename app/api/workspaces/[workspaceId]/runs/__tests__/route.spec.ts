/**
 * Team Run Lists, Phase 8C-B2 — GET /api/workspaces/{workspaceId}/runs
 * tests. Mocks every underlying lib function (each independently tested
 * elsewhere) — this suite covers auth, capability-gating, scope parsing,
 * and status-code mapping only.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedResolveTeamRunWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...args: unknown[]) => mockedResolveTeamRunWorkspaceAccess(...args),
}));

const mockedListTeamWorkspaceRuns = jest.fn();
jest.mock("@/lib/workspaces/listTeamWorkspaceRuns", () => ({
  listTeamWorkspaceRuns: (...args: unknown[]) => mockedListTeamWorkspaceRuns(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

// ==================================================
// Phase 8C-D.1 — POST-only mocks. GET's own mocks above are untouched.
// ==================================================

const mockedCheckRateLimit = jest.fn().mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() });
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => mockedCheckRateLimit(...args),
}));

jest.mock("@/lib/security/requestValidation", () => ({
  validateRunPanelRequest: jest.fn().mockReturnValue({ valid: true }),
  validateRequestBodySize: jest.fn().mockReturnValue({ valid: true }),
  MAX_REQUEST_BODY_SIZE: 1_000_000,
}));

let adaptiveSchemasEnabled = false;
let teamWorkspacesEnabled = true;
let teamWorkspacesCanaryUids: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get ADAPTIVE_SCHEMAS_ENABLED() {
    return adaptiveSchemasEnabled;
  },
  get TEAM_WORKSPACES_ENABLED() {
    return teamWorkspacesEnabled;
  },
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return teamWorkspacesCanaryUids;
  },
}));

const mockedPlanAdaptiveRun = jest.fn();
jest.mock("@/lib/adaptiveSchema/orchestrate", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/orchestrate");
  return {
    ...actual,
    planAdaptiveRun: (...args: unknown[]) => mockedPlanAdaptiveRun(...args),
  };
});

jest.mock("@/lib/adaptiveSchema/analytics", () => ({
  trackQueryClassified: jest.fn(),
  trackRoutingOutcome: jest.fn(),
}));

const mockedValidateUserSubscription = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/stripe/subscriptionValidation", () => ({
  validateUserSubscription: (...args: unknown[]) => mockedValidateUserSubscription(...args),
}));

const mockedCheckAndIncrementUsage = jest.fn().mockResolvedValue({
  allowed: true,
  runsThisMonth: 1,
  maxRunsPerMonth: 100,
  maxModelsPerRun: 5,
  plan: "full",
});
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkAndIncrementUsageForRun: (...args: unknown[]) => mockedCheckAndIncrementUsage(...args),
}));

const mockedCreateTeamWorkspaceRun = jest.fn();
jest.mock("@/lib/firestore/teamWorkspaceRuns", () => ({
  createTeamWorkspaceRun: (...args: unknown[]) => mockedCreateTeamWorkspaceRun(...args),
}));

const mockedExecuteOrdinaryRun = jest.fn();
jest.mock("@/lib/runPanelExecution", () => ({
  executeOrdinaryRun: (...args: unknown[]) => mockedExecuteOrdinaryRun(...args),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/workspaces/[workspaceId]/runs/route";

const UID = "member-1";
const WS_ID = "ws-team-1";

function buildRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs${query}`, { method: "GET" });
}

function buildPostRequest(bodyText: string): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyText,
  });
}

function buildPostBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ question: "What is the capital of Kenya?", selectedModels: ["chatgpt", "claude"], ...overrides });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() });
  adaptiveSchemasEnabled = false;
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
  mockedCheckAndIncrementUsage.mockResolvedValue({
    allowed: true,
    runsThisMonth: 1,
    maxRunsPerMonth: 100,
    maxModelsPerRun: 5,
    plan: "full",
  });
});

describe("GET /api/workspaces/[workspaceId]/runs — auth", () => {
  it("missing credentials -> 401 unauthorized", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(401);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });
});

describe("GET /api/workspaces/[workspaceId]/runs — access denial mapping", () => {
  it("team_workspaces_disabled -> 503", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "team_workspaces_disabled" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(503);
  });

  it("lookup_failed -> 503", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(503);
  });

  it("workspace_not_found -> concealed 404", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_not_found" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });

  it("wrong_workspace_type (Personal-B collision path) -> concealed 404, identical shape to workspace_not_found", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "wrong_workspace_type" });
    const res = await GET(buildRequest(), { params: { workspaceId: "personal-B" } });
    expect(res.status).toBe(404);
    const bodyA = await res.json();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_not_found" });
    const res2 = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    const bodyB = await res2.json();
    expect(bodyA.errorCode).toBe(bodyB.errorCode);
  });

  it("membership_not_found -> concealed 404", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_not_found" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });

  it("membership_removed -> concealed 404", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });

  it("owner_integrity_violation -> concealed 404", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "owner_integrity_violation" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });

  it("granted but no research.read capability -> 403 insufficient_capability", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["projects.read"] });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.errorCode).toBe("insufficient_capability");
  });
});

describe("GET /api/workspaces/[workspaceId]/runs — scope handling", () => {
  beforeEach(() => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
  });

  it("no scope param -> scope=all passed to listTeamWorkspaceRuns", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "ok", items: [], hasMore: false });
    await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(mockedListTeamWorkspaceRuns).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS_ID, scope: "all" }));
  });

  it("scope=unfiled -> scope=unfiled passed to listTeamWorkspaceRuns", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "ok", items: [], hasMore: false });
    await GET(buildRequest("?scope=unfiled"), { params: { workspaceId: WS_ID } });
    expect(mockedListTeamWorkspaceRuns).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS_ID, scope: "unfiled" }));
  });

  it("unsupported scope value -> 400 invalid_scope, listTeamWorkspaceRuns never called", async () => {
    const res = await GET(buildRequest("?scope=bogus"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect(mockedListTeamWorkspaceRuns).not.toHaveBeenCalled();
  });

  it("no magic projectId=null sentinel accepted", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "ok", items: [], hasMore: false });
    await GET(buildRequest("?projectId=null"), { params: { workspaceId: WS_ID } });
    // projectId is simply not a recognized query param at all — falls
    // through to scope=all, never a special-cased sentinel.
    expect(mockedListTeamWorkspaceRuns).toHaveBeenCalledWith(expect.objectContaining({ scope: "all" }));
  });
});

describe("GET /api/workspaces/[workspaceId]/runs — result mapping", () => {
  beforeEach(() => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
  });

  it("ok -> 200 with items/hasMore/scope", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "ok", items: [{ id: "r1" }], hasMore: true, nextCursor: "abc" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.items).toEqual([{ id: "r1" }]);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe("abc");
    expect(body.scope).toBe("all");
  });

  it("invalid_cursor -> 400", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "invalid_cursor" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });

  it("integrity_violation -> 500 internal_error (never 404)", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "integrity_violation" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.errorCode).toBe("internal_error");
  });

  it("query_failed -> 500 internal_error", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "query_failed" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(500);
  });
});

describe("GET /api/workspaces/[workspaceId]/runs — no client-side authorization trust", () => {
  it("workspaceId/scope authorization always re-derived server-side from the authenticated uid — never trusts a client-supplied override", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
    mockedListTeamWorkspaceRuns.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID });
  });
});

// ==================================================
// Phase 8C-D.1 — POST /api/workspaces/[workspaceId]/runs
// ==================================================

describe("POST /api/workspaces/[workspaceId]/runs — rate-limit order (Phase 8C-D.0.3 Corrections 1/2)", () => {
  it("authenticated malformed JSON -> rate limiter is called BEFORE the JSON parse failure is even reached", async () => {
    const res = await POST(buildPostRequest("{not valid json"), { params: { workspaceId: WS_ID } });
    expect(mockedCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockedCheckRateLimit).toHaveBeenCalledWith(expect.objectContaining({ identifier: `team-run-create:${UID}` }));
    expect(res.status).toBe(400);
  });

  it("rate-limit denied -> 429, execution stops before rollout/adaptive/quota/create/execution", async () => {
    mockedCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfter: 42, resetAt: new Date() });
    const res = await POST(buildPostRequest(buildPostBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(429);
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedCreateTeamWorkspaceRun).not.toHaveBeenCalled();
    expect(mockedExecuteOrdinaryRun).not.toHaveBeenCalled();
  });

  it("rate-limit identifier is UID-only — never contains the Workspace id", async () => {
    await POST(buildPostRequest(buildPostBody()), { params: { workspaceId: WS_ID } });
    const identifier = mockedCheckRateLimit.mock.calls[0][0].identifier as string;
    expect(identifier).toBe(`team-run-create:${UID}`);
    expect(identifier).not.toContain(WS_ID);
  });

  it("unauthenticated -> 401, rate limiter never called", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await POST(buildPostRequest(buildPostBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(401);
    expect(mockedCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspaces/[workspaceId]/runs — request body contract", () => {
  it("unknown top-level field -> 400 unexpected_field", async () => {
    const res = await POST(buildPostRequest(buildPostBody({ workspaceId: "sneaky" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe("unexpected_field");
  });

  it("fewer than 2 selectedModels -> 400 not_enough_models, before rollout/quota", async () => {
    const res = await POST(buildPostRequest(buildPostBody({ selectedModels: ["chatgpt"] })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
  });

  it("empty-string projectId -> 400 invalid_request_body", async () => {
    const res = await POST(buildPostRequest(buildPostBody({ projectId: "" })), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });

  it("projectId omitted -> createTeamWorkspaceRun called with projectId: null", async () => {
    mockedCreateTeamWorkspaceRun.mockResolvedValueOnce({ status: "created", runId: "run-1", workspaceId: WS_ID, projectId: null });
    mockedExecuteOrdinaryRun.mockResolvedValueOnce({ status: 200, body: { ok: true, results: [], runId: "run-1" } });
    await POST(buildPostRequest(buildPostBody()), { params: { workspaceId: WS_ID } });
    expect(mockedCreateTeamWorkspaceRun).toHaveBeenCalledWith(expect.objectContaining({ projectId: null }));
  });

  it("explicit null projectId -> createTeamWorkspaceRun called with projectId: null", async () => {
    mockedCreateTeamWorkspaceRun.mockResolvedValueOnce({ status: "created", runId: "run-1", workspaceId: WS_ID, projectId: null });
    mockedExecuteOrdinaryRun.mockResolvedValueOnce({ status: 200, body: { ok: true, results: [], runId: "run-1" } });
    await POST(buildPostRequest(buildPostBody({ projectId: null })), { params: { workspaceId: WS_ID } });
    expect(mockedCreateTeamWorkspaceRun).toHaveBeenCalledWith(expect.objectContaining({ projectId: null }));
  });
});

describe("POST /api/workspaces/[workspaceId]/runs — rollout (Correction 2/17/20)", () => {
  it("disabled -> 503 team_workspaces_disabled; quota/adaptive-plan/create/execution all zero calls", async () => {
    teamWorkspacesEnabled = false;
    const res = await POST(buildPostRequest(buildPostBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.errorCode).toBe("team_workspaces_disabled");
    expect(mockedPlanAdaptiveRun).not.toHaveBeenCalled();
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedCreateTeamWorkspaceRun).not.toHaveBeenCalled();
    expect(mockedExecuteOrdinaryRun).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspaces/[workspaceId]/runs — non-active adaptive routing (Correction 3/25)", () => {
  it("non-active routing -> existing non-execution payload; quota/create/execution all zero calls", async () => {
    adaptiveSchemasEnabled = true;
    mockedPlanAdaptiveRun.mockResolvedValueOnce({
      classification: { queryType: "claim_verification" },
      schema: null,
      promptOverrides: {},
      routing: { kind: "handoff", handoffTarget: "claim_verification", response: {} },
    });
    const res = await POST(buildPostRequest(buildPostBody()), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.runId).toBeNull();
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedCreateTeamWorkspaceRun).not.toHaveBeenCalled();
    expect(mockedExecuteOrdinaryRun).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspaces/[workspaceId]/runs — quota (Correction 19/24)", () => {
  it("RUN_LIMIT denied -> existing Personal-style response, no Team create, no execution", async () => {
    mockedCheckAndIncrementUsage.mockResolvedValueOnce({
      allowed: false,
      reason: "RUN_LIMIT",
      runsThisMonth: 8,
      maxRunsPerMonth: 8,
      maxModelsPerRun: 2,
      plan: "free",
      resetsAt: new Date("2026-09-01T00:00:00Z"),
    });
    const res = await POST(buildPostRequest(buildPostBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.errorCode).toBe("RUN_LIMIT_REACHED");
    expect(mockedCreateTeamWorkspaceRun).not.toHaveBeenCalled();
    expect(mockedExecuteOrdinaryRun).not.toHaveBeenCalled();
  });

  it("quota succeeds, Team create denied (membership_removed) -> quota called exactly once, no execution, no refund/decrement", async () => {
    mockedCreateTeamWorkspaceRun.mockResolvedValueOnce({ status: "unauthorized", reason: "membership_removed" });
    const res = await POST(buildPostRequest(buildPostBody()), { params: { workspaceId: WS_ID } });
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
    expect(mockedCreateTeamWorkspaceRun).toHaveBeenCalledTimes(1);
    expect(mockedExecuteOrdinaryRun).not.toHaveBeenCalled();
    expect(res.status).toBe(404); // concealed, matching teamProjectAuthorizationDeniedResponse's non-capability branch
  });

  it("quota succeeds, Team create denied (insufficient_capability) -> 403", async () => {
    mockedCreateTeamWorkspaceRun.mockResolvedValueOnce({ status: "unauthorized", reason: "insufficient_capability" });
    const res = await POST(buildPostRequest(buildPostBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(403);
    expect(mockedExecuteOrdinaryRun).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspaces/[workspaceId]/runs — Team create success (Correction 35)", () => {
  it("Unfiled success -> executeOrdinaryRun called with the created runId, response merges usage + workspaceId + projectId:null", async () => {
    mockedCreateTeamWorkspaceRun.mockResolvedValueOnce({ status: "created", runId: "run-abc", workspaceId: WS_ID, projectId: null });
    mockedExecuteOrdinaryRun.mockResolvedValueOnce({
      status: 200,
      body: { ok: true, results: [{ modelId: "chatgpt", status: "ok" }], runId: "run-abc" },
    });
    const res = await POST(buildPostRequest(buildPostBody()), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockedExecuteOrdinaryRun).toHaveBeenCalledWith(expect.objectContaining({ uid: UID, runId: "run-abc" }));
    expect(body.ok).toBe(true);
    expect(body.runId).toBe("run-abc");
    expect(body.workspaceId).toBe(WS_ID);
    expect(body.projectId).toBeNull();
    expect(body.usage).toEqual({ runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 5 });
    expect(body.status).toBeUndefined(); // no invented top-level `status` field
  });

  it("Project-assigned success -> response includes the assigned projectId", async () => {
    mockedCreateTeamWorkspaceRun.mockResolvedValueOnce({ status: "created", runId: "run-xyz", workspaceId: WS_ID, projectId: "proj-1" });
    mockedExecuteOrdinaryRun.mockResolvedValueOnce({ status: 200, body: { ok: true, results: [], runId: "run-xyz" } });
    const res = await POST(buildPostRequest(buildPostBody({ projectId: "proj-1" })), { params: { workspaceId: WS_ID } });
    const body = await res.json();
    expect(body.projectId).toBe("proj-1");
    expect(mockedCreateTeamWorkspaceRun).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj-1" }));
  });

  it("Team create Project validation failures map correctly: project_not_found -> 404, project_archived -> 409", async () => {
    mockedCreateTeamWorkspaceRun.mockResolvedValueOnce({ status: "project_not_found" });
    const res1 = await POST(buildPostRequest(buildPostBody({ projectId: "proj-missing" })), { params: { workspaceId: WS_ID } });
    expect(res1.status).toBe(404);

    mockedCreateTeamWorkspaceRun.mockResolvedValueOnce({ status: "project_archived" });
    const res2 = await POST(buildPostRequest(buildPostBody({ projectId: "proj-archived" })), { params: { workspaceId: WS_ID } });
    expect(res2.status).toBe(409);

    expect(mockedExecuteOrdinaryRun).not.toHaveBeenCalled();
  });
});

describe("GET behavior is unchanged by the POST addition", () => {
  it("GET still resolves independently of every POST-only mock added above", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "ok", items: [], hasMore: false });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    expect(mockedCheckRateLimit).not.toHaveBeenCalled();
    expect(mockedCreateTeamWorkspaceRun).not.toHaveBeenCalled();
  });
});
