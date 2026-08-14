/**
 * Workspace-Aware Writes for New Personal Adaptive Runs, Phase 3 —
 * confirms the deliberate "zero read-route changes" design decision
 * (docs/workspaces/architecture.md's Phase 3 section) actually holds:
 * a run document carrying the new optional `workspaceId` field is
 * entirely inert to GET /api/user/runs/[runId]'s existing, UNTOUCHED
 * owner/reviewer access logic — `userId` remains the sole, authoritative
 * ownership field this route reads, exactly as before Phase 3. Mirrors
 * personalReviewerAccess.spec.ts's scaffolding.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
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

jest.mock("@/lib/user/runDocumentToPublicResults", () => ({
  runDocumentToPublicResults: jest.fn().mockReturnValue([{ modelId: "chatgpt" }]),
}));
jest.mock("@/lib/panel/publicize", () => ({
  publicizePanelResults: jest.fn(),
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
jest.mock("@/lib/firestore/teamRuns", () => ({
  getAdaptiveTeamRunProjection: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/runs/[runId]/route";

const OWNER_UID = "owner-1";
const OTHER_UID = "other-1";
const RUN_ID = "run-1";

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
  mockedGetPersonalAssignment.mockResolvedValue({ status: "unassigned" });
  mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: null });
});

describe("GET /api/user/runs/[runId] — workspaceId field is inert (Phase 3 zero-read-route-change proof)", () => {
  it("a run with workspaceId present still grants its true owner full access, viewerRole: owner — no different from a legacy run", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: "personal-owner-1" }));
    const { res, json } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("owner");
    expect(json.ok).toBe(true);
  });

  it("a run with workspaceId present still denies a non-owner, non-reviewer exactly as before — the extra field grants nothing extra", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: "personal-owner-1" }));
    const { res, json } = await callRouteAs(OTHER_UID);
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("forbidden");
  });

  it("response shape (viewerRole, ok, adaptive.output) is byte-identical whether workspaceId is present or absent, for the same owner", async () => {
    mockedRunGet.mockResolvedValue(runDoc()); // no workspaceId
    const legacyResult = await callRouteAs(OWNER_UID);
    jest.clearAllMocks();
    mockedGetPersonalAssignment.mockResolvedValue({ status: "unassigned" });
    mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: null });
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: "personal-owner-1" })); // workspace-bound
    const boundResult = await callRouteAs(OWNER_UID);

    expect(boundResult.json.viewerRole).toBe(legacyResult.json.viewerRole);
    expect(boundResult.json.ok).toBe(legacyResult.json.ok);
    expect(boundResult.json.adaptive.output).toEqual(legacyResult.json.adaptive.output);
  });
});
