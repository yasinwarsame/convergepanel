/**
 * TEAM-VERIFICATION-PARITY-R3 —
 * `GET /api/workspaces/{W}/verifications/{verificationId}`: the canonical
 * Team-native Claim detail. Real row validator, `getProject()` and the
 * canonical stored mapper run against the in-memory Firestore fake; identity,
 * Team Workspace access and the Team source-link resolver are controlled
 * boundaries; execution/quota/governance modules are throwing spies.
 */

jest.mock("firebase-admin/firestore", () => require("@/lib/workspaces/__tests__/teamClaimFakeFirestore").fakeFirestoreModule);
let mockState: import("@/lib/workspaces/__tests__/teamClaimFakeFirestore").FakeState;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    const { makeFakeDb } = require("@/lib/workspaces/__tests__/teamClaimFakeFirestore");
    return mockState.unavailable ? null : makeFakeDb(mockState);
  },
}));
const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
const mockedLogIdentityResolutionFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: (...a: unknown[]) => mockedLogIdentityResolutionFailure(...a) }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
const mockedTeamSourceLink = jest.fn();
jest.mock("@/lib/verification/resolveTeamSourceResearchLink", () => ({ resolveTeamSourceResearchLink: (...a: unknown[]) => mockedTeamSourceLink(...a) }));
const mockedPersonalSourceLink = jest.fn(() => {
  throw new Error("Personal source resolver reached from Team detail");
});
jest.mock("@/lib/verification/resolvePersonalSourceResearchLink", () => ({ resolvePersonalSourceResearchLink: (...a: unknown[]) => (mockedPersonalSourceLink as any)(...a) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockSpy = (name: string) =>
  jest.fn(() => {
    throw new Error(`side effect reached from a durable read: ${name}`);
  });
const mockedPanel = mockSpy("panel");
const mockedUsage = mockSpy("usage");
const mockedTokens = mockSpy("tokens");
const mockedGovernance = mockSpy("governance");
jest.mock("@/lib/verification/runClaimVerificationPanel", () => ({ runClaimVerificationPanel: (...a: unknown[]) => (mockedPanel as any)(...a) }));
jest.mock("@/lib/stripe/usageCheck", () => ({ checkAndIncrementUsageForRun: (...a: unknown[]) => (mockedUsage as any)(...a), checkUsageAllowanceForRun: (...a: unknown[]) => (mockedUsage as any)(...a) }));
jest.mock("@/lib/firestore/userTokens", () => ({ incrementUserTokenUsage: (...a: unknown[]) => (mockedTokens as any)(...a) }));
jest.mock("@/lib/governance/evaluateAndStore", () => ({ evaluateAndStoreGovernance: (...a: unknown[]) => (mockedGovernance as any)(...a) }));

import { NextRequest } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { GET } from "@/app/api/workspaces/[workspaceId]/verifications/[verificationId]/route";
import { capabilitiesForRole } from "@/lib/workspaces/capabilities";
import { createFakeState, projectDoc, TEAM_W, teamClaimDoc } from "@/lib/workspaces/__tests__/teamClaimFakeFirestore";

const T = 1_700_000_000_000;
const VID = "vcl-team-1";
const NUL = String.fromCharCode(0);
const CONCEALED = { status: 404, body: { ok: false, errorCode: "not_found", message: "Claim not found." } };
const grant = (role: "owner" | "admin" | "member" | "reviewer" | "viewer" = "member") => ({ granted: true, workspace: { id: TEAM_W, type: "team" }, membership: { role }, capabilities: [...capabilitiesForRole(role)] });

async function detail(verificationId = VID, query = "", uid = "reader-b") {
  mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "authenticated", uid, source: "session_cookie" });
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/verifications/x${query}`), { params: { workspaceId: TEAM_W, verificationId } });
  return { status: res.status, body: await res.json() };
}
function store(...docs: ReturnType<typeof teamClaimDoc>[]) {
  mockState.collections.verifications = docs;
}
function expectZeroSideEffects() {
  expect(mockState.writeAttempts).toEqual([]);
  for (const spy of [mockedPanel, mockedUsage, mockedTokens, mockedGovernance, mockedPersonalSourceLink]) expect(spy).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState = createFakeState();
  mockState.collections.projects = [projectDoc("p1")];
  mockedAccess.mockResolvedValue(grant());
  mockedTeamSourceLink.mockResolvedValue(null);
});

describe("identity and authorization", () => {
  it("missing credentials -> 401 unauthorized (GET telemetry); other failures -> 401 auth_error; no read", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    let res = await GET(new NextRequest("http://localhost/x"), { params: { workspaceId: TEAM_W, verificationId: VID } });
    expect(await res.json()).toEqual({ ok: false, errorCode: "unauthorized", message: "Please sign in." });
    expect(mockedLogIdentityResolutionFailure).toHaveBeenCalledWith({ route: "GET /api/workspaces/[workspaceId]/verifications/[verificationId]", method: "GET", failureCategory: "missing_credentials" });
    for (const reason of ["invalid_bearer_token", "revoked_session", "credential_mismatch"]) {
      mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason });
      res = await GET(new NextRequest("http://localhost/x"), { params: { workspaceId: TEAM_W, verificationId: VID } });
      expect(res.status).toBe(401);
      expect((await res.json()).errorCode).toBe("auth_error");
    }
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockState.docGets).toEqual([]);
  });

  it.each(["team_workspaces_disabled", "workspace_not_found", "wrong_workspace_type", "membership_not_found", "membership_removed", "membership_malformed", "owner_integrity_violation"])("denial %s -> concealed team_workspace_not_found, no artifact read", async (reason) => {
    store(teamClaimDoc(VID));
    mockedAccess.mockResolvedValueOnce({ granted: false, reason });
    const r = await detail();
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe("team_workspace_not_found");
    expect(mockState.docGets).toEqual([]);
  });

  it("lookup_failed -> 503; missing research.read -> 403; neither reads the artifact", async () => {
    store(teamClaimDoc(VID));
    mockedAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    expect((await detail()).status).toBe(503);
    mockedAccess.mockResolvedValueOnce({ ...grant(), capabilities: ["workspace.read"] });
    expect((await detail()).body.errorCode).toBe("insufficient_capability");
    expect(mockState.docGets).toEqual([]);
  });

  it("never authorizes by the creator: another member reads it; the creator who lost membership is concealed", async () => {
    store(teamClaimDoc(VID, { userId: "creator-a" }));
    expect((await detail(VID, "", "reader-b")).status).toBe(200);
    mockedAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    expect((await detail(VID, "", "creator-a")).status).toBe(404);
  });

  it.each(["owner", "admin", "member", "reviewer", "viewer"] as const)("role %s reads the same artifact", async (role) => {
    store(teamClaimDoc(VID));
    mockedAccess.mockResolvedValueOnce(grant(role));
    expect((await detail()).status).toBe(200);
  });
});

describe("concealment — one identical not-found for every non-readable artifact", () => {
  it("a Personal Claim row at the Team address is concealed (no Personal fallback)", async () => {
    const personal = teamClaimDoc(VID, { userId: "reader-b" });
    delete personal.data.workspaceId;
    delete personal.data.projectId;
    store(personal);
    expect(await detail()).toEqual(CONCEALED);
    expectZeroSideEffects();
  });

  it.each([
    ["foreign Workspace", { workspaceId: "ws-other" }],
    ["empty workspaceId", { workspaceId: "" }],
    ["null workspaceId", { workspaceId: null }],
    ["wrong type", { type: "video_verification" }],
    ["malformed timestamp", { timestamp: "2026-09-01" }],
    ["malformed projectId", { projectId: 7 }],
    ["empty userId", { userId: "" }],
  ])("%s -> concealed", async (_l, over) => {
    store(teamClaimDoc(VID, over));
    expect(await detail()).toEqual(CONCEALED);
  });

  it("absent projectId on a Team row -> concealed", async () => {
    const row = teamClaimDoc(VID);
    delete row.data.projectId;
    store(row);
    expect(await detail()).toEqual(CONCEALED);
  });

  it("missing artifact -> concealed", async () => {
    expect(await detail("vcl-missing")).toEqual(CONCEALED);
  });

  it.each(["", " vcl", "a/b", "..", `vcl${NUL}x`])("malformed verification id %j -> concealed before any access lookup", async (bad) => {
    expect(await detail(bad)).toEqual(CONCEALED);
    expect(mockedAccess).not.toHaveBeenCalled();
  });
});

describe("optional Project containment", () => {
  it("Project-bound Claim + matching ?projectId -> 200", async () => {
    store(teamClaimDoc(VID, { projectId: "p1" }));
    expect((await detail(VID, "?projectId=p1")).status).toBe(200);
  });

  it("Project-bound Claim + wrong ?projectId -> concealed; Unfiled Claim + any ?projectId -> concealed", async () => {
    store(teamClaimDoc(VID, { projectId: "p1" }), teamClaimDoc("vcl-unfiled"));
    expect(await detail(VID, "?projectId=p2")).toEqual(CONCEALED);
    expect(await detail("vcl-unfiled", "?projectId=p1")).toEqual(CONCEALED);
  });

  it.each(["", " p1", "a/b"])("malformed ?projectId=%j -> concealed before any access lookup", async (bad) => {
    store(teamClaimDoc(VID, { projectId: "p1" }));
    expect(await detail(VID, `?projectId=${encodeURIComponent(bad)}`)).toEqual(CONCEALED);
    expect(mockedAccess).not.toHaveBeenCalled();
  });

  it("without ?projectId, both Project-bound and Unfiled Claims in the Workspace are readable", async () => {
    store(teamClaimDoc(VID, { projectId: "p1" }), teamClaimDoc("vcl-unfiled"));
    expect((await detail()).status).toBe(200);
    expect((await detail("vcl-unfiled")).status).toBe(200);
  });
});

describe("Project label", () => {
  it("Unfiled -> project null and no Project read", async () => {
    store(teamClaimDoc(VID));
    const r = await detail();
    expect(r.body.team.project).toBeNull();
    expect(mockState.docGets.filter((p) => p.startsWith("projects/"))).toEqual([]);
  });

  it("archived Project -> readable with its label; the Project is read exactly once", async () => {
    mockState.collections.projects = [projectDoc("p1", { status: "archived", name: "Archive" })];
    store(teamClaimDoc(VID, { projectId: "p1" }));
    const r = await detail();
    expect(r.status).toBe(200);
    expect(r.body.team.project).toEqual({ id: "p1", name: "Archive", status: "archived" });
    expect(mockState.docGets.filter((p) => p.startsWith("projects/"))).toEqual(["projects/p1"]);
  });

  it("missing or malformed Project -> artifact stays readable with project null (Team Research precedent)", async () => {
    store(teamClaimDoc(VID, { projectId: "p-gone" }), teamClaimDoc("vcl-malformed-project", { projectId: "p-bad" }));
    mockState.collections.projects = [projectDoc("p-bad", { schemaVersion: 9 })];
    const gone = await detail();
    expect(gone.status).toBe(200);
    expect(gone.body.team).toMatchObject({ projectId: "p-gone", project: null });
    const bad = await detail("vcl-malformed-project");
    expect(bad.status).toBe(200);
    expect(bad.body.team.project).toBeNull();
  });

  it("a Project belonging to another Workspace -> the Claim is concealed as an integrity anomaly", async () => {
    mockState.collections.projects = [projectDoc("p1", { workspaceId: "ws-other" })];
    store(teamClaimDoc(VID, { projectId: "p1" }));
    expect(await detail()).toEqual(CONCEALED);
  });

  it("Project read infrastructure failure -> 503 team_workspace_unavailable", async () => {
    mockState.throwOnDocGetCollections.add("projects");
    store(teamClaimDoc(VID, { projectId: "p1" }));
    const r = await detail();
    expect(r.status).toBe(503);
    expect(r.body.errorCode).toBe("team_workspace_unavailable");
  });

  it("artifact read failure -> 503; Firestore unavailable -> 503", async () => {
    mockState.throwOnDocGetCollections.add("verifications");
    expect((await detail()).status).toBe(503);
    mockState.unavailable = true;
    expect((await detail()).status).toBe(503);
  });
});

describe("detail DTO and sourceResearch", () => {
  it("returns the canonical stored payload plus a presentation-safe team block", async () => {
    store(teamClaimDoc(VID, { projectId: "p1", governanceStatus: "approved", userId: "creator-secret" }, T));
    const r = await detail();
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["ok", "payload", "team"]);
    expect(r.body.team).toEqual({ workspaceId: TEAM_W, projectId: "p1", project: { id: "p1", name: "Project p1", status: "active" }, createdAt: new Date(T).toISOString() });
    expect(r.body.payload).toMatchObject({ verificationId: VID, claim: `Claim ${VID}`, verdict: "confirmed", consensusScore: 80, confidenceLabel: "High", evidenceQuality: "strong", governanceStatus: "approved", sourceResearch: null });
    expect(r.body.payload.modelEvidence).toHaveLength(1);
    const json = JSON.stringify(r.body);
    for (const leaked of ["creator-secret", "userId", "reviewer", "capabilities", "membership", '"seconds"', "nanoseconds", "createdByUserId", "schemaVersion", "governanceReviewedBy"]) {
      expect(json).not.toContain(leaked);
    }
    expectZeroSideEffects();
  });

  it("sourceResearch comes only from the Team resolver, called with the caller and the ADDRESSED Workspace", async () => {
    const origin = { type: "deep_research_claim", runId: "team-run-1", claimId: "v1:findings:0:x" };
    store(teamClaimDoc(VID, { origin, evidenceSources: [] }));
    mockedTeamSourceLink.mockResolvedValueOnce({ type: "deep_research_claim", runId: "team-run-1", claimId: "v1:findings:0:x" });
    const r = await detail();
    expect(mockedTeamSourceLink).toHaveBeenCalledWith({ origin, callerUid: "reader-b", expectedWorkspaceId: TEAM_W });
    expect(r.body.payload.sourceResearch).toEqual({ type: "deep_research_claim", runId: "team-run-1", claimId: "v1:findings:0:x" });
    expect(mockedPersonalSourceLink).not.toHaveBeenCalled();
  });

  it("a denied, stale or failing source link collapses to null and never fails the authorized read", async () => {
    store(teamClaimDoc(VID, { origin: { type: "deep_research_claim", runId: "r", claimId: "c" }, evidenceSources: [] }));
    mockedTeamSourceLink.mockResolvedValueOnce(null);
    expect((await detail()).body.payload.sourceResearch).toBeNull();
    mockedTeamSourceLink.mockRejectedValueOnce(new Error("resolver exploded"));
    const r = await detail();
    expect(r.status).toBe(200);
    expect(r.body.payload.sourceResearch).toBeNull();
  });

  it("the route source makes no live governance call and imports no Personal source resolver", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "app/api/workspaces/[workspaceId]/verifications/[verificationId]/route.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\*\*|\/\/)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/run-governance|resolvePersonalSourceResearchLink|authedFetch|fetch\(/);
  });
});
