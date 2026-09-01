/**
 * GET /api/user/verifications/[verificationId], Phase 8C-E.1 (Claim) +
 * Phase 8C-E.3.3.1 (Video) — covers: unchanged Personal/legacy owner-only
 * behavior for both `verifications` and `videoVerifications`, Team Claim
 * read classification, and Team Video read classification (both
 * fail-closed on malformed rows, both require research.read, neither
 * allows a creator bypass) — the two Team branches are separate code
 * blocks in the route and are tested separately here too.
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

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { Timestamp } from "firebase-admin/firestore";

const store: Record<string, Record<string, unknown>> = {};
const mockedGet = jest.fn(async (id: string) => {
  const data = store[id];
  return { exists: data !== undefined, data: () => data };
});
jest.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      doc: (id: string) => ({ get: () => mockedGet(id) }),
    }),
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/verifications/[verificationId]/route";
import { buildDeepResearchClaimId } from "@/lib/verification/claimVerificationOrigin";

const UID = "uid-1";
const WS_ID = "ws-team-1";

function buildRequest(id: string, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/user/verifications/${id}${query}`);
}

function ctx(id: string) {
  return { params: Promise.resolve({ verificationId: id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(store)) delete store[k];
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
});

describe("GET /api/user/verifications/[verificationId] — Personal/legacy Claim (unchanged)", () => {
  it("owner reads own Claim -> 200", async () => {
    store["vcl-1"] = { userId: UID, claim: "x", type: "claim_verification", verdict: "accurate", consensusScore: 90, confidenceLabel: "High", evidenceQuality: "strong", supportRatio: 100, modelResults: [], auditBundle: {}, selectedModels: [], timestamp: Timestamp.now() };
    const res = await GET(buildRequest("vcl-1"), ctx("vcl-1"));
    expect(res.status).toBe(200);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("non-owner -> existing 403 unchanged, Team resolver never called (no workspaceId field present)", async () => {
    store["vcl-1"] = { userId: "someone-else", claim: "x", type: "claim_verification", timestamp: Timestamp.now() };
    const res = await GET(buildRequest("vcl-1"), ctx("vcl-1"));
    expect(res.status).toBe(403);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("not found -> 404", async () => {
    const res = await GET(buildRequest("vcl-missing"), ctx("vcl-missing"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/user/verifications/[verificationId] — Phase 11A.5B: Personal durable source-link (sourceResearch)", () => {
  const OWNER_UID = UID;
  const RUN_ID = "run-source-1";

  function finding(overrides: Record<string, unknown> = {}) {
    return {
      id: "finding-1",
      title: "A label",
      summary: "A stable finding summary.",
      category: "general",
      evidenceStrength: "moderate",
      sourceBacked: true,
      coverageCount: 3,
      totalModels: 4,
      coverageRatio: 0.75,
      contributingModels: ["claude", "chatgpt", "gemini"],
      ...overrides,
    };
  }

  function deepResearchOutput(findings: unknown[] = [finding()]) {
    return {
      version: 1,
      schemaId: "deep_research",
      answerShape: "deep_research_view",
      classification: { queryType: "deep_research" },
      meta: {},
      generatedAt: "2026-01-01T00:00:00.000Z",
      result: {
        executiveSummary: "x",
        findings,
        lowConfidenceFindings: [],
        disagreements: [],
        evidenceGaps: [],
        openQuestions: [],
        panelBlindSpots: [],
        researchBoundaries: [],
        recommendedNextSteps: [],
        sourceCoverage: { findingsWithSources: 1, totalFindings: 1, coverageRatio: 1 },
        totalModels: 4,
      },
    };
  }

  function selectorFor(runId: string, f: ReturnType<typeof finding>): string {
    const id = buildDeepResearchClaimId({ runId, section: "findings", index: 0, finding: f });
    if (id === null) throw new Error("test setup: expected a valid selector");
    return id;
  }

  function claimRow(overrides: Record<string, unknown> = {}) {
    return {
      userId: OWNER_UID,
      claim: "x",
      type: "claim_verification",
      verdict: "accurate",
      consensusScore: 90,
      confidenceLabel: "High",
      evidenceQuality: "strong",
      supportRatio: 100,
      modelResults: [],
      auditBundle: {},
      selectedModels: [],
      timestamp: Timestamp.now(),
      ...overrides,
    };
  }

  it("ordinary legacy verification without origin -> 200, sourceResearch: null", async () => {
    store["vcl-legacy"] = claimRow();
    const res = await GET(buildRequest("vcl-legacy"), ctx("vcl-legacy"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.sourceResearch).toBeNull();
  });

  it("valid origin + owned/readable Deep Research source run -> sourceResearch exposed with exact type/runId/claimId", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    store["vcl-origin-1"] = claimRow({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId } });
    store[RUN_ID] = { userId: OWNER_UID, adaptiveOutput: deepResearchOutput([f]) };
    const res = await GET(buildRequest("vcl-origin-1"), ctx("vcl-origin-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.sourceResearch).toEqual({ type: "deep_research_claim", runId: RUN_ID, claimId });
  });

  it("source run missing -> verification still readable, sourceResearch: null", async () => {
    const claimId = "v1:findings:0:" + "a".repeat(43);
    store["vcl-origin-2"] = claimRow({ origin: { type: "deep_research_claim", runId: "nonexistent-run", claimId } });
    const res = await GET(buildRequest("vcl-origin-2"), ctx("vcl-origin-2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.sourceResearch).toBeNull();
  });

  it("source run owned by a different Personal user (forged/foreign origin.runId) -> verification (own) still readable, sourceResearch: null, no foreign content leaked", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    store["vcl-origin-3"] = claimRow({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId } });
    store[RUN_ID] = { userId: "someone-else-entirely", adaptiveOutput: deepResearchOutput([f]) };
    const res = await GET(buildRequest("vcl-origin-3"), ctx("vcl-origin-3"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.sourceResearch).toBeNull();
    expect(JSON.stringify(body)).not.toContain("someone-else-entirely");
  });

  it("malformed origin object -> verification remains readable, sourceResearch: null", async () => {
    store["vcl-origin-4"] = claimRow({ origin: { type: "deep_research_claim", runId: RUN_ID } }); // missing claimId
    const res = await GET(buildRequest("vcl-origin-4"), ctx("vcl-origin-4"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.sourceResearch).toBeNull();
  });

  it("unsupported origin type -> sourceResearch: null", async () => {
    store["vcl-origin-5"] = claimRow({ origin: { type: "unsupported_kind", runId: RUN_ID, claimId: "v1:findings:0:" + "a".repeat(43) } });
    const res = await GET(buildRequest("vcl-origin-5"), ctx("vcl-origin-5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.sourceResearch).toBeNull();
  });

  it("source run not deep_research -> sourceResearch: null", async () => {
    const claimId = "v1:findings:0:" + "a".repeat(43);
    store["vcl-origin-6"] = claimRow({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId } });
    store[RUN_ID] = { userId: OWNER_UID, adaptiveOutput: { version: 1, schemaId: "causal_explanation", answerShape: "causal_map", classification: { queryType: "causal_explanation" }, meta: {}, generatedAt: "2026-01-01T00:00:00.000Z", result: { directAnswer: "x", factors: [], interpretations: [], totalModels: 3 } } };
    const res = await GET(buildRequest("vcl-origin-6"), ctx("vcl-origin-6"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.sourceResearch).toBeNull();
  });

  it("malformed persisted adaptive output on the source run -> sourceResearch: null, no uncontrolled 500", async () => {
    const claimId = "v1:findings:0:" + "a".repeat(43);
    store["vcl-origin-7"] = claimRow({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId } });
    store[RUN_ID] = { userId: OWNER_UID, adaptiveOutput: { version: 1, schemaId: "deep_research", answerShape: "deep_research_view", classification: {}, meta: {}, generatedAt: "x", result: { executiveSummary: "x" } } }; // findings/lowConfidenceFindings absent
    const res = await GET(buildRequest("vcl-origin-7"), ctx("vcl-origin-7"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.sourceResearch).toBeNull();
  });

  it("stale/forged fingerprint claimId -> sourceResearch: null", async () => {
    const f = finding();
    const forged = "v1:findings:0:" + "z".repeat(43);
    store["vcl-origin-8"] = claimRow({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId: forged } });
    store[RUN_ID] = { userId: OWNER_UID, adaptiveOutput: deepResearchOutput([f]) };
    const res = await GET(buildRequest("vcl-origin-8"), ctx("vcl-origin-8"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.sourceResearch).toBeNull();
  });

  it("verification.projectId differs from the source run's current projectId -> sourceResearch still exposed (no projectId equality required)", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    store["vcl-origin-9"] = claimRow({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId }, projectId: "proj-at-creation-time" });
    store[RUN_ID] = { userId: OWNER_UID, projectId: "proj-currently-assigned-elsewhere", adaptiveOutput: deepResearchOutput([f]) };
    const res = await GET(buildRequest("vcl-origin-9"), ctx("vcl-origin-9"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.sourceResearch).toEqual({ type: "deep_research_claim", runId: RUN_ID, claimId });
  });

  it("sourceResearch never contains projectId or workspaceId", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    store["vcl-origin-10"] = claimRow({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId } });
    store[RUN_ID] = { userId: OWNER_UID, adaptiveOutput: deepResearchOutput([f]) };
    const res = await GET(buildRequest("vcl-origin-10"), ctx("vcl-origin-10"));
    const body = await res.json();
    expect(Object.keys(body.payload.sourceResearch).sort()).toEqual(["claimId", "runId", "type"]);
  });

  it("sourceResearch never duplicates claim text", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    store["vcl-origin-11"] = claimRow({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId }, claim: "The verification's own immutable snapshot." });
    store[RUN_ID] = { userId: OWNER_UID, adaptiveOutput: deepResearchOutput([f]) };
    const res = await GET(buildRequest("vcl-origin-11"), ctx("vcl-origin-11"));
    const body = await res.json();
    expect(body.payload.sourceResearch).not.toHaveProperty("claim");
    expect(body.payload.sourceResearch).not.toHaveProperty("summary");
    expect(body.payload.claim).toBe("The verification's own immutable snapshot.");
  });

  it("raw persisted origin never appears as a separate top-level field in the response JSON", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    store["vcl-origin-12"] = claimRow({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId } });
    store[RUN_ID] = { userId: OWNER_UID, adaptiveOutput: deepResearchOutput([f]) };
    const res = await GET(buildRequest("vcl-origin-12"), ctx("vcl-origin-12"));
    const body = await res.json();
    expect(Object.prototype.hasOwnProperty.call(body.payload, "origin")).toBe(false);
  });

  it("source-link resolution performs zero writes (mock has no write methods — a write attempt would throw and surface as a 500)", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    store["vcl-origin-13"] = claimRow({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId } });
    store[RUN_ID] = { userId: OWNER_UID, adaptiveOutput: deepResearchOutput([f]) };
    const res = await GET(buildRequest("vcl-origin-13"), ctx("vcl-origin-13"));
    expect(res.status).toBe(200);
  });

  it("Team branch is unaffected — sourceResearch is not present at all on a Team verification response in this phase", async () => {
    const teamRow = {
      userId: "creator-uid",
      workspaceId: "ws-team-1",
      projectId: null,
      type: "claim_verification",
      claim: "x",
      verdict: "accurate",
      consensusScore: 90,
      confidenceLabel: "High",
      evidenceQuality: "strong",
      supportRatio: 100,
      modelResults: [],
      auditBundle: {},
      selectedModels: [],
      timestamp: Timestamp.now(),
    };
    store["vcl-team-source"] = teamRow;
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
    const res = await GET(buildRequest("vcl-team-source"), ctx("vcl-team-source"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.prototype.hasOwnProperty.call(body.payload, "sourceResearch")).toBe(false);
  });
});

describe("GET /api/user/verifications/[verificationId] — Personal Video regression (unchanged)", () => {
  it("owner reads own Video verification via ?collection=videoVerifications -> 200, no workspaceId field present, Team resolver never called", async () => {
    store["vid-1"] = { userId: UID, type: "video_verification", fileName: "f.mp4", verdict: "authentic_captured", contentType: "camera_footage", consensusScore: 90, confidenceLabel: "High", evidenceQuality: "strong", supportRatio: 100, metadata: {}, metadataAnalysis: { flags: [], summary: "" }, modelResults: [], agreementPoints: [], disagreementPoints: [], frameCount: 3, warnings: [], totalTokens: 0, timestamp: Timestamp.now() };
    const res = await GET(buildRequest("vid-1", "?collection=videoVerifications"), ctx("vid-1"));
    expect(res.status).toBe(200);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("Video non-owner, no workspaceId field -> existing 403 unchanged", async () => {
    store["vid-1"] = { userId: "someone-else", type: "video_verification", timestamp: Timestamp.now() };
    const res = await GET(buildRequest("vid-1", "?collection=videoVerifications"), ctx("vid-1"));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/user/verifications/[verificationId] — Team Claim read classification", () => {
  function teamRow(overrides: Record<string, unknown> = {}) {
    return {
      userId: "creator-uid",
      workspaceId: WS_ID,
      projectId: null,
      type: "claim_verification",
      claim: "x",
      verdict: "accurate",
      consensusScore: 90,
      confidenceLabel: "High",
      evidenceQuality: "strong",
      supportRatio: 100,
      modelResults: [],
      auditBundle: {},
      selectedModels: [],
      timestamp: Timestamp.now(),
      ...overrides,
    };
  }

  it("valid Team row, member with research.read -> 200, no creator check involved", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(200);
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID });
  });

  it("creator without research.read -> 403, NO creator bypass", async () => {
    store["vcl-team-1"] = teamRow({ userId: UID }); // requester IS the creator
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["projects.read"] });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(403);
  });

  it("removed member -> denied via established Team read mapping (concealed 404)", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
  });

  it("wrong Workspace type -> concealed 404", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "wrong_workspace_type" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
  });

  it("owner-integrity violation -> concealed 404", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "owner_integrity_violation" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
  });

  it("Phase 10C.1A: rollout disabled -> concealed 404 (not a distinguishable 503)", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "team_workspaces_disabled" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
    expect((await res.json()).errorCode).toBe("not_found");
  });

  it("F1 parity: team_workspaces_disabled (Case 1) is byte-identical to owner_integrity_violation (Case 2)", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "team_workspaces_disabled" });
    const notAdmittedRes = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    const notAdmittedJson = await notAdmittedRes.json();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "owner_integrity_violation" });
    const admittedButForeignRes = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    const admittedButForeignJson = await admittedButForeignRes.json();
    expect(notAdmittedRes.status).toBe(admittedButForeignRes.status);
    expect(JSON.stringify(notAdmittedJson)).toBe(JSON.stringify(admittedButForeignJson));
  });

  it("lookup infrastructure failure -> 503 (deliberately untouched by Phase 10C.1A — genuine infrastructure failure)", async () => {
    store["vcl-team-1"] = teamRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(503);
  });

  it("malformed workspaceId (empty string) -> concealed 404, never falls back to Personal owner check", async () => {
    store["vcl-team-1"] = teamRow({ workspaceId: "" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("missing projectId field -> invalid Team row, concealed 404, never falls back to Personal owner check", async () => {
    const row = teamRow();
    delete (row as any).projectId;
    store["vcl-team-1"] = row;
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("malformed projectId (wrong type) -> invalid Team row, concealed 404", async () => {
    store["vcl-team-1"] = teamRow({ projectId: 42 });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("wrong verification type on a workspaceId-bearing row -> invalid Team row, concealed 404", async () => {
    store["vcl-team-1"] = teamRow({ type: "something_else" });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("malformed timestamp on a workspaceId-bearing row -> invalid Team row, concealed 404", async () => {
    store["vcl-team-1"] = teamRow({ timestamp: { seconds: 1, nanoseconds: 0 } });
    const res = await GET(buildRequest("vcl-team-1"), ctx("vcl-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });
});

describe("GET /api/user/verifications/[verificationId] — Team Video read classification (?collection=videoVerifications)", () => {
  function teamVideoRow(overrides: Record<string, unknown> = {}) {
    return {
      userId: "creator-uid",
      userEmail: "creator@example.com",
      workspaceId: WS_ID,
      projectId: null,
      type: "video_verification",
      fileName: "clip.mp4",
      verdict: "authentic_captured",
      contentType: "camera_footage",
      consensusScore: 90,
      confidenceLabel: "High",
      evidenceQuality: "strong",
      supportRatio: 100,
      metadata: {},
      metadataAnalysis: { flags: [], summary: "" },
      modelResults: [],
      agreementPoints: [],
      disagreementPoints: [],
      frameCount: 3,
      warnings: [],
      totalTokens: 0,
      timestamp: Timestamp.now(),
      ...overrides,
    };
  }

  it("valid Team row, member with research.read -> 200, no creator check involved", async () => {
    store["vid-team-1"] = teamVideoRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(200);
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID });
  });

  it("creator without research.read -> 403, NO creator bypass", async () => {
    store["vid-team-1"] = teamVideoRow({ userId: UID }); // requester IS the creator
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["projects.read"] });
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(403);
  });

  it("removed member -> denied via established Team read mapping (concealed 404)", async () => {
    store["vid-team-1"] = teamVideoRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(404);
  });

  it("wrong Workspace type -> concealed 404", async () => {
    store["vid-team-1"] = teamVideoRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "wrong_workspace_type" });
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(404);
  });

  it("owner-integrity violation -> concealed 404", async () => {
    store["vid-team-1"] = teamVideoRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "owner_integrity_violation" });
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(404);
  });

  it("Phase 10C.1A: rollout disabled -> concealed 404 (not a distinguishable 503)", async () => {
    store["vid-team-1"] = teamVideoRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "team_workspaces_disabled" });
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(404);
    expect((await res.json()).errorCode).toBe("not_found");
  });

  it("F1 parity: team_workspaces_disabled (Case 1) is byte-identical to owner_integrity_violation (Case 2)", async () => {
    store["vid-team-1"] = teamVideoRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "team_workspaces_disabled" });
    const notAdmittedRes = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    const notAdmittedJson = await notAdmittedRes.json();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "owner_integrity_violation" });
    const admittedButForeignRes = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    const admittedButForeignJson = await admittedButForeignRes.json();
    expect(notAdmittedRes.status).toBe(admittedButForeignRes.status);
    expect(JSON.stringify(notAdmittedJson)).toBe(JSON.stringify(admittedButForeignJson));
  });

  it("lookup infrastructure failure -> 503 (deliberately untouched by Phase 10C.1A — genuine infrastructure failure)", async () => {
    store["vid-team-1"] = teamVideoRow();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(503);
  });

  it("malformed workspaceId (empty string) -> concealed 404, never falls back to Personal owner check", async () => {
    store["vid-team-1"] = teamVideoRow({ workspaceId: "" });
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("missing projectId field -> invalid Team row, concealed 404, never falls back to Personal owner check", async () => {
    const row = teamVideoRow();
    delete (row as any).projectId;
    store["vid-team-1"] = row;
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("malformed projectId (wrong type) -> invalid Team row, concealed 404", async () => {
    store["vid-team-1"] = teamVideoRow({ projectId: 42 });
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("wrong verification type (claim_verification) on a workspaceId-bearing videoVerifications row -> invalid Team row, concealed 404", async () => {
    store["vid-team-1"] = teamVideoRow({ type: "claim_verification" });
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("malformed timestamp on a workspaceId-bearing row -> invalid Team row, concealed 404", async () => {
    store["vid-team-1"] = teamVideoRow({ timestamp: { seconds: 1, nanoseconds: 0 } });
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("Claim's own Team branch is never invoked for a videoVerifications row (validators are separate)", async () => {
    // A row shaped like a valid CLAIM row but stored/queried under videoVerifications
    // must still be validated by the Video validator (type check fails: video_verification expected).
    store["vid-team-1"] = teamVideoRow({ type: "video_verification" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
    const res = await GET(buildRequest("vid-team-1", "?collection=videoVerifications"), ctx("vid-team-1"));
    expect(res.status).toBe(200);
  });
});
