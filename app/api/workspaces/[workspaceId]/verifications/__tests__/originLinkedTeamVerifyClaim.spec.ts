/**
 * Evidence Workspace, Phase 11A.3 — origin-linked request-mode tests for
 * `POST /api/workspaces/{workspaceId}/verifications`. Mocks
 * `resolveClaimVerificationOrigin()` directly (independently tested in
 * `claimVerificationOrigin.spec.ts`) — this suite covers request-mode
 * classification, Gate 1 -> resolve-origin -> Gate 2 ordering, project
 * inheritance, length enforcement, and ordinary-path non-regression only.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedCheckRateLimit = jest.fn();
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => mockedCheckRateLimit(...args),
}));

let teamWorkspacesCanaryWorkspaceIds: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  XAI_API_KEY: "test",
  PERPLEXITY_API_KEY: "test",
  GEMINI_API_KEY: "test",
  TEAM_WORKSPACES_ENABLED: true,
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return undefined;
  },
  get TEAM_WORKSPACES_CANARY_WORKSPACE_IDS() {
    return teamWorkspacesCanaryWorkspaceIds;
  },
}));

const mockedResolveTeamWorkspacesMode = jest.fn();
jest.mock("@/lib/workspaces/teamWorkspacesRollout", () => ({
  resolveTeamWorkspacesMode: (...args: unknown[]) => mockedResolveTeamWorkspacesMode(...args),
}));

const mockedAuthorizeGate1 = jest.fn();
const mockedSaveGate2 = jest.fn();
jest.mock("@/lib/firestore/teamClaimVerifications", () => ({
  authorizeTeamClaimVerificationAdmission: (...args: unknown[]) => mockedAuthorizeGate1(...args),
  saveTeamClaimVerification: (...args: unknown[]) => mockedSaveGate2(...args),
}));

jest.mock("@/lib/stripe/subscriptionValidation", () => ({ validateUserSubscription: jest.fn().mockResolvedValue(undefined) }));

const mockedCheckAndIncrementUsage = jest.fn();
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkAndIncrementUsageForRun: (...args: unknown[]) => mockedCheckAndIncrementUsage(...args),
}));

const mockedRunClaimVerificationPanel = jest.fn();
jest.mock("@/lib/verification/runClaimVerificationPanel", () => ({
  runClaimVerificationPanel: (...args: unknown[]) => mockedRunClaimVerificationPanel(...args),
}));

jest.mock("@/lib/firestore/userTokens", () => ({ incrementUserTokenUsage: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/governance/evaluateAndStore", () => ({ evaluateAndStoreGovernance: jest.fn().mockResolvedValue(null) }));
jest.mock("@/lib/governance/teamGovernancePipeline", () => ({
  applyTeamGovernancePipeline: jest.fn().mockResolvedValue({}),
  mergeGovernanceIntoBody: (body: unknown) => body,
}));
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ email: "user@example.com" }) }) }) }) },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockedResolveClaimVerificationOrigin = jest.fn();
jest.mock("@/lib/verification/claimVerificationOrigin", () => ({
  resolveClaimVerificationOrigin: (...args: unknown[]) => mockedResolveClaimVerificationOrigin(...args),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/workspaces/[workspaceId]/verifications/route";

const UID = "member-1";
const WS_ID = "ws-team-1";
const ORIGIN = { type: "deep_research_claim" as const, runId: "run-1", claimId: "v1:findings:0:" + "a".repeat(43) };

function modelResult(modelId: string, verdict: string) {
  return {
    modelId,
    status: "ok",
    rawText: JSON.stringify({ verdict, confidence: "high", summary: "s", correctParts: [], incorrectParts: [], unverifiableParts: [] }),
    latencyMs: 5,
    tokenUsage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
  };
}

function buildPostRequest(bodyText: string): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/verifications`, { method: "POST", headers: { "Content-Type": "application/json" }, body: bodyText });
}

async function post(body: Record<string, unknown>) {
  return POST(buildPostRequest(JSON.stringify(body)), { params: { workspaceId: WS_ID } });
}

beforeEach(() => {
  jest.clearAllMocks();
  teamWorkspacesCanaryWorkspaceIds = undefined;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() });
  mockedResolveTeamWorkspacesMode.mockReturnValue({ enabled: true, source: "global" });
  mockedAuthorizeGate1.mockResolvedValue({ status: "authorized", workspaceId: WS_ID, projectId: null });
  mockedCheckAndIncrementUsage.mockResolvedValue({ allowed: true, runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 5, plan: "full" });
  mockedRunClaimVerificationPanel.mockResolvedValue([modelResult("claude", "accurate"), modelResult("chatgpt", "accurate")]);
  mockedSaveGate2.mockResolvedValue({ status: "created", verificationId: "vcl-team-1", workspaceId: WS_ID, projectId: null });
});

describe("POST /api/workspaces/[workspaceId]/verifications — origin-linked mode classification", () => {
  it("claim + runId together -> ambiguous_request_mode", async () => {
    const res = await post({ claim: "x", runId: "run-1", claimId: "id" });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("ambiguous_request_mode");
  });

  it("runId without claimId -> invalid_origin_locator", async () => {
    const res = await post({ runId: "run-1" });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("invalid_origin_locator");
  });

  it("origin-linked request with client-supplied projectId -> unexpected_field, rejected rather than competing with the source run's authoritative projectId", async () => {
    const res = await post({ runId: "run-1", claimId: "id", projectId: "sneaky-project" });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("unexpected_field");
    expect(mockedResolveClaimVerificationOrigin).not.toHaveBeenCalled();
  });

  it("origin-linked request with client-supplied origin -> unexpected_field", async () => {
    const res = await post({ runId: "run-1", claimId: "id", origin: { type: "deep_research_claim", runId: "x", claimId: "y" } });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("unexpected_field");
  });
});

describe("POST /api/workspaces/[workspaceId]/verifications — Gate 1 -> resolve-origin -> Gate 2 ordering", () => {
  it("Gate 1 is called BEFORE resolveClaimVerificationOrigin, with projectId: null (unknown at that point)", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: null, evidenceSources: [] });
    await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(mockedAuthorizeGate1).toHaveBeenCalledWith(expect.objectContaining({ uid: UID, workspaceId: WS_ID, projectId: null }));
    const gate1Order = mockedAuthorizeGate1.mock.invocationCallOrder[0];
    const resolveOrder = mockedResolveClaimVerificationOrigin.mock.invocationCallOrder[0];
    expect(gate1Order).toBeLessThan(resolveOrder);
  });

  it("resolveClaimVerificationOrigin is called with expectedWorkspaceId = URL workspaceId, closing cross-Workspace origin linkage", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: null, evidenceSources: [] });
    await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(mockedResolveClaimVerificationOrigin).toHaveBeenCalledWith({ runId: ORIGIN.runId, claimId: ORIGIN.claimId, callerUid: UID, expectedWorkspaceId: WS_ID });
  });

  it("Gate 1 denial (removed member) -> denied before origin is ever resolved", async () => {
    mockedAuthorizeGate1.mockResolvedValue({ status: "unauthorized", reason: "membership_removed" });
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockedResolveClaimVerificationOrigin).not.toHaveBeenCalled();
  });

  it("Gate 1 denial (missing research.create capability) -> denied", async () => {
    mockedAuthorizeGate1.mockResolvedValue({ status: "unauthorized", reason: "insufficient_capability" });
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockedResolveClaimVerificationOrigin).not.toHaveBeenCalled();
  });

  it("origin resolver cannot substitute for Team authorization — Gate 2 is still called with a fresh reauthorization even after a successful resolve", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: null, evidenceSources: [] });
    await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(mockedSaveGate2).toHaveBeenCalledTimes(1);
  });

  it("stale membership caught at Gate 2 (write-time reauthorization) -> denied, no verification document (Gate 2 itself denies -> no artifact)", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: null, evidenceSources: [] });
    mockedSaveGate2.mockResolvedValue({ status: "unauthorized", reason: "membership_removed" });
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("POST /api/workspaces/[workspaceId]/verifications — project-aware pre-execution preflight (Phase 11A.3C1)", () => {
  /**
   * Reuses the exact same `authorizeTeamClaimVerificationAdmission()`
   * (Gate 1) function as the preflight — its own project-state policy
   * (archived/not-found/foreign-workspace/capability/null-project) is
   * already exhaustively covered, against the real transactional fake, in
   * lib/firestore/__tests__/teamClaimVerifications.spec.ts. These tests
   * verify only that the ROUTE wires that reused, already-tested function
   * in correctly: after origin resolution, with the resolver-derived
   * projectId, before quota/model execution, and that Gate 2 still runs
   * as the independent write-time race guard regardless.
   */

  it("preflight (second authorizeTeamClaimVerificationAdmission call) runs AFTER origin resolution and BEFORE quota/model execution, using the resolver-derived projectId", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: "proj-resolved-1", evidenceSources: [] });
    await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });

    expect(mockedAuthorizeGate1).toHaveBeenCalledTimes(2);
    expect(mockedAuthorizeGate1).toHaveBeenNthCalledWith(1, expect.objectContaining({ uid: UID, workspaceId: WS_ID, projectId: null }));
    expect(mockedAuthorizeGate1).toHaveBeenNthCalledWith(2, expect.objectContaining({ uid: UID, workspaceId: WS_ID, projectId: "proj-resolved-1" }));

    const resolveOrder = mockedResolveClaimVerificationOrigin.mock.invocationCallOrder[0];
    const preflightOrder = mockedAuthorizeGate1.mock.invocationCallOrder[1];
    const usageOrder = mockedCheckAndIncrementUsage.mock.invocationCallOrder[0];
    const panelOrder = mockedRunClaimVerificationPanel.mock.invocationCallOrder[0];
    expect(resolveOrder).toBeLessThan(preflightOrder);
    expect(preflightOrder).toBeLessThan(usageOrder);
    expect(preflightOrder).toBeLessThan(panelOrder);
  });

  it("archived source project -> denied BEFORE quota/model execution, zero writes", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: "proj-archived-1", evidenceSources: [] });
    mockedAuthorizeGate1.mockImplementation(async (args: { projectId: string | null }) =>
      args.projectId === null ? { status: "authorized", workspaceId: WS_ID, projectId: null } : { status: "project_archived" }
    );
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
  });

  it("nonexistent/deleted (or malformed, or foreign-Workspace) source project -> project_not_found -> denied BEFORE quota/model execution, zero writes (the underlying policy collapses all three to the identical status/response, preserving the existing concealment contract — see teamClaimVerifications.spec.ts for that policy's own dedicated coverage)", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: "proj-gone-1", evidenceSources: [] });
    mockedAuthorizeGate1.mockImplementation(async (args: { projectId: string | null }) =>
      args.projectId === null ? { status: "authorized", workspaceId: WS_ID, projectId: null } : { status: "project_not_found" }
    );
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
  });

  it("missing research.organize capability for the resolved project -> insufficient_capability -> denied BEFORE quota/model execution, zero writes", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: "proj-restricted-1", evidenceSources: [] });
    mockedAuthorizeGate1.mockImplementation(async (args: { projectId: string | null }) =>
      args.projectId === null ? { status: "authorized", workspaceId: WS_ID, projectId: null } : { status: "unauthorized", reason: "insufficient_capability" }
    );
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
  });

  it("active project + fully authorized -> preflight succeeds -> quota exactly once, model execution exactly once, persistence exactly once", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: "proj-active-1", evidenceSources: [] });
    mockedAuthorizeGate1.mockResolvedValue({ status: "authorized", workspaceId: WS_ID, projectId: null }); // returned for BOTH calls regardless of projectId — proves a uniformly-authorizing preflight still lets the request through exactly once per stage
    mockedSaveGate2.mockResolvedValue({ status: "created", verificationId: "vcl-3", workspaceId: WS_ID, projectId: "proj-active-1" });
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBe(200);
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledTimes(1);
    expect(mockedSaveGate2).toHaveBeenCalledTimes(1);
  });

  it("no-project source run (projectId: null) -> preflight still runs (called with projectId: null) and succeeds -> existing Workspace-only authorization preserved, no project invented", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: null, evidenceSources: [] });
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBe(200);
    expect(mockedAuthorizeGate1).toHaveBeenCalledTimes(2);
    expect(mockedAuthorizeGate1).toHaveBeenNthCalledWith(2, expect.objectContaining({ projectId: null }));
  });

  it("client cannot influence the preflight's projectId — it is always the resolver's own return value, never anything from the request body (which cannot even contain projectId in origin-linked mode — see the unexpected_field test above)", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: "resolver-owned-project", evidenceSources: [] });
    await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(mockedAuthorizeGate1).toHaveBeenNthCalledWith(2, expect.objectContaining({ projectId: "resolver-owned-project" }));
  });

  it("NO TOCTOU REGRESSION: preflight authorizes (project active at that moment), but the source project is archived/access is revoked before Gate 2 runs -> quota and model execution already happened (unavoidable, pre-existing race semantics), but Gate 2 still independently denies persistence -> zero artifact", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: "proj-race-1", evidenceSources: [] });
    mockedAuthorizeGate1.mockResolvedValue({ status: "authorized", workspaceId: WS_ID, projectId: null }); // preflight authorizes for both calls
    mockedSaveGate2.mockResolvedValue({ status: "project_archived" }); // but the project changed state before Gate 2's own fresh re-derivation
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledTimes(1);
    // Gate 2 was called and is the one that denied — it was NOT skipped or short-circuited by the preflight having already authorized.
    expect(mockedSaveGate2).toHaveBeenCalledTimes(1);
  });

  it("stale membership revoked after preflight but before Gate 2 -> Gate 2 (not the preflight) still independently denies persistence -> zero artifact, proving the preflight has not made Gate 2 redundant", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: "proj-race-2", evidenceSources: [] });
    mockedAuthorizeGate1.mockResolvedValue({ status: "authorized", workspaceId: WS_ID, projectId: null });
    mockedSaveGate2.mockResolvedValue({ status: "unauthorized", reason: "membership_removed" });
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockedSaveGate2).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/workspaces/[workspaceId]/verifications — origin-linked success + persistence", () => {
  it("authorized Team member with matching source Workspace -> success", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "The sky is blue.", projectId: null, evidenceSources: [] });
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("resolved projectId inherited into Gate 2 / the persisted document", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: "proj-abc", evidenceSources: [] });
    mockedSaveGate2.mockResolvedValue({ status: "created", verificationId: "vcl-2", workspaceId: WS_ID, projectId: "proj-abc" });
    await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(mockedSaveGate2).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj-abc" }));
  });

  it("no-project source run -> Gate 2 called with projectId: null", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: null, evidenceSources: [] });
    await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(mockedSaveGate2).toHaveBeenCalledWith(expect.objectContaining({ projectId: null }));
  });

  it("origin persisted by saveTeamClaimVerification()", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: null, evidenceSources: [] });
    await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(mockedSaveGate2).toHaveBeenCalledWith(expect.objectContaining({ origin: ORIGIN }));
  });

  it("claim snapshot equals the resolved finding.summary (claimText) exactly", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "Canonical summary text.", projectId: null, evidenceSources: [] });
    await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(mockedSaveGate2).toHaveBeenCalledWith(expect.objectContaining({ claim: "Canonical summary text." }));
  });

  it("successful origin-linked verification: quota exactly once, model execution exactly once, persistence exactly once", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "x", projectId: null, evidenceSources: [] });
    await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(mockedCheckAndIncrementUsage).toHaveBeenCalledTimes(1);
    expect(mockedRunClaimVerificationPanel).toHaveBeenCalledTimes(1);
    expect(mockedSaveGate2).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/workspaces/[workspaceId]/verifications — cross-scope denials via the resolver", () => {
  it("source run from another Team Workspace -> workspace_mismatch -> denied", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "denied", reason: "workspace_mismatch" });
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBe(404);
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
  });

  it("Personal source run via the Team route -> workspace_mismatch -> denied", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "denied", reason: "workspace_mismatch" });
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBe(404);
  });

  it("forged/stale claimId -> claim_not_found -> denied", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "denied", reason: "claim_not_found" });
    const res = await post({ runId: ORIGIN.runId, claimId: "tampered" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workspaces/[workspaceId]/verifications — claim length enforcement (origin-linked)", () => {
  it("claim length == MAX_CLAIM_LEN (2000) -> accepted", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "a".repeat(2000), projectId: null, evidenceSources: [] });
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBe(200);
  });

  it("claim length > MAX_CLAIM_LEN -> claim_too_long, zero quota/model/write", async () => {
    mockedResolveClaimVerificationOrigin.mockResolvedValue({ status: "resolved", origin: ORIGIN, claimText: "a".repeat(2001), projectId: null, evidenceSources: [] });
    const res = await post({ runId: ORIGIN.runId, claimId: ORIGIN.claimId });
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("claim_too_long");
    expect(mockedCheckAndIncrementUsage).not.toHaveBeenCalled();
    expect(mockedRunClaimVerificationPanel).not.toHaveBeenCalled();
    expect(mockedSaveGate2).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspaces/[workspaceId]/verifications — ordinary Team verification remains unchanged", () => {
  it("ordinary claim + explicit projectId request -> 200, existing behavior preserved, origin resolver never called", async () => {
    const res = await post({ claim: "The sky is blue.", projectId: "proj-1" });
    expect(res.status).toBe(200);
    expect(mockedResolveClaimVerificationOrigin).not.toHaveBeenCalled();
    expect(mockedSaveGate2).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj-1" }));
    const gate2Call = mockedSaveGate2.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(gate2Call, "origin")).toBe(false);
  });
});
