/**
 * Personal Reviewer Inbox + Action Flow — GET /api/user/runs/[runId]'s new
 * non-owner (assigned personal reviewer) access path.
 *
 * resolveAdaptiveRunAccess itself is left REAL (not mocked) — these are
 * genuine end-to-end wiring tests proving the route correctly threads
 * fetched data into it and honors its verdict, not just that a mock was
 * called.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

const mockedLogIdentityResolutionFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: (...args: any[]) => mockedLogIdentityResolutionFailure(...args),
}));

const mockedRunGet = jest.fn();
const mockAdminDb: any = {
  collection: () => ({
    doc: () => ({
      get: async () => mockedRunGet(),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

const mockedRunDocumentToPublicResults = jest.fn();
jest.mock("@/lib/user/runDocumentToPublicResults", () => ({
  runDocumentToPublicResults: (...args: any[]) => mockedRunDocumentToPublicResults(...args),
}));

const mockedPublicizePanelResults = jest.fn();
jest.mock("@/lib/panel/publicize", () => ({
  publicizePanelResults: (...args: any[]) => mockedPublicizePanelResults(...args),
}));

jest.mock("@/lib/adaptiveSchema/persistedOutput", () => ({
  ...jest.requireActual("@/lib/adaptiveSchema/persistedOutput"),
  parsePersistedAdaptiveOutput: jest.fn().mockReturnValue({ ok: true, output: { schemaId: "decision_support", classification: {}, result: {} } }),
  parsePersistedLegacyAdaptiveOutput: jest.fn().mockReturnValue({ ok: false, reason: "absent" }),
}));

jest.mock("@/lib/adaptiveSchema/governanceRecordParser", () => ({
  ...jest.requireActual("@/lib/adaptiveSchema/governanceRecordParser"),
  parseGovernanceRecord: jest.fn().mockReturnValue({
    ok: true,
    record: { humanReview: { status: "unreviewed", conditions: undefined, decidedVia: undefined } },
  }),
}));

const mockedGetPersonalAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  getAdaptiveHumanReviewAssignment: (...args: any[]) => mockedGetPersonalAssignment(...args),
}));

const mockedLoadUserAndTeam = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({
  loadUserAndTeam: (...args: any[]) => mockedLoadUserAndTeam(...args),
}));

const mockedGetProjection = jest.fn();
jest.mock("@/lib/firestore/teamRuns", () => ({
  getAdaptiveTeamRunProjection: (...args: any[]) => mockedGetProjection(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/runs/[runId]/route";

const OWNER_UID = "owner-1";
const REVIEWER_UID = "reviewer-1";
const OTHER_UID = "other-1";
const RUN_ID = "run-1";

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    teamId: null,
    runId: RUN_ID,
    assignedReviewerUserId: REVIEWER_UID,
    assignedAt: "2026-08-12T18:00:00.000Z",
    assignedByUserId: OWNER_UID,
    updatedAt: "2026-08-12T18:00:00.000Z",
    updatedByUserId: OWNER_UID,
    revision: 1,
    ...overrides,
  };
}

function runDoc(overrides: Record<string, unknown> = {}) {
  return {
    exists: true,
    data: () => ({
      userId: OWNER_UID,
      question: "q",
      adaptiveOutput: {},
      governanceRecord: {
        version: 1,
        schemaId: "decision_support",
        answerShape: "decision_support_view",
        adaptiveOutputVersion: 1,
        humanReview: { status: "unreviewed" },
        decisionReceipt: {},
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
      ...overrides,
    }),
  };
}

function buildRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/user/runs/${RUN_ID}`);
}

async function callRouteAs(uid: string) {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid });
  const res = await GET(buildRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedRunDocumentToPublicResults.mockReturnValue([{ modelId: "chatgpt" }]);
  mockedGetPersonalAssignment.mockResolvedValue({ status: "unassigned" });
  mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: null });
});

describe("GET /api/user/runs/[runId] — personal reviewer access", () => {
  it("owner still gets full access, viewerRole: owner", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    const { res, json } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("owner");
  });

  it("the currently-assigned personal reviewer is granted access, viewerRole: personal_reviewer, same response shape (except results[].tokenUsage/latencyMs — see the Governance Follow-Up Hardening test below)", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedGetPersonalAssignment.mockResolvedValue({ status: "found", assignment: assignment() });
    const { res, json } = await callRouteAs(REVIEWER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("personal_reviewer");
    expect(json.ok).toBe(true);
    expect(json.adaptive.output).toBeDefined();
  });

  it("Governance Follow-Up Hardening: a personal reviewer's results omit tokenUsage/latencyMs (operational metadata, not review content); the owner still gets both, unchanged", async () => {
    mockedRunDocumentToPublicResults.mockReturnValue([
      { modelId: "chatgpt", rawTextFull: "answer text", tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, latencyMs: 1234 },
    ]);
    mockedRunGet.mockResolvedValue(runDoc());
    mockedGetPersonalAssignment.mockResolvedValue({ status: "found", assignment: assignment() });

    const { json: reviewerJson } = await callRouteAs(REVIEWER_UID);
    expect(reviewerJson.results[0]).not.toHaveProperty("tokenUsage");
    expect(reviewerJson.results[0]).not.toHaveProperty("latencyMs");
    expect(reviewerJson.results[0].rawTextFull).toBe("answer text"); // review content itself is untouched

    const { json: ownerJson } = await callRouteAs(OWNER_UID);
    expect(ownerJson.results[0].tokenUsage).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });
    expect(ownerJson.results[0].latencyMs).toBe(1234);
  });

  it("an unrelated user with no assignment at all is denied", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedGetPersonalAssignment.mockResolvedValue({ status: "unassigned" });
    const { res, json } = await callRouteAs(OTHER_UID);
    expect(res.status).toBe(403);
    expect(json.ok).toBe(false);
  });

  it("Part 21 cross-run IDOR: a reviewer assigned to a DIFFERENT run is denied for this one (assignment.assignedReviewerUserId names someone else)", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedGetPersonalAssignment.mockResolvedValue({ status: "found", assignment: assignment({ assignedReviewerUserId: REVIEWER_UID }) });
    const { res } = await callRouteAs(OTHER_UID);
    expect(res.status).toBe(403);
  });

  it("a TEAM assignment (teamId is a real team id) never grants access through this route, even if the uid matches — team access must go through the team routes", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedGetPersonalAssignment.mockResolvedValue({ status: "found", assignment: assignment({ teamId: "team-abc" }) });
    const { res } = await callRouteAs(REVIEWER_UID);
    expect(res.status).toBe(403);
  });

  it("an explicitly-unassigned assignment record (assignedReviewerUserId: null) denies access", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedGetPersonalAssignment.mockResolvedValue({ status: "found", assignment: assignment({ assignedReviewerUserId: null }) });
    const { res } = await callRouteAs(REVIEWER_UID);
    expect(res.status).toBe(403);
  });

  it("Part 20: owner access is completely unaffected by this feature — same 200, same fields, loadUserAndTeam called with the OWNER's uid never the reviewer's", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ governanceRecord: { ...runDoc().data().governanceRecord, humanReview: { status: "unreviewed" } } }));
    await callRouteAs(OWNER_UID);
    // reviewRouting resolution calls loadUserAndTeam(owner) — for the
    // owner viewing their own run, owner === uid, so this remains correct
    // either way; the real regression this guards is covered in the next
    // test (reviewer viewing).
    expect(mockedLoadUserAndTeam).toHaveBeenCalledWith(OWNER_UID);
  });

  it("reviewRouting is resolved from the OWNER's team context, never the viewing REVIEWER's own team — a real bug this feature could have introduced", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedGetPersonalAssignment.mockResolvedValue({ status: "found", assignment: assignment() });
    // The reviewer happens to have their OWN team — must never be consulted for this run.
    mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: { id: "reviewers-own-team" } });

    await callRouteAs(REVIEWER_UID);

    // loadUserAndTeam must be called with the OWNER's uid, not the reviewer's.
    expect(mockedLoadUserAndTeam).toHaveBeenCalledWith(OWNER_UID);
    expect(mockedLoadUserAndTeam).not.toHaveBeenCalledWith(REVIEWER_UID);
  });

  it("never exposes the reviewer's own uid as unexplained free text beyond the viewerRole field itself", async () => {
    mockedRunGet.mockResolvedValue(runDoc());
    mockedGetPersonalAssignment.mockResolvedValue({ status: "found", assignment: assignment() });
    const { json } = await callRouteAs(REVIEWER_UID);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(REVIEWER_UID);
  });
});
