/**
 * PHASE 1 — `decidedVia` is a Team-panel EXISTENCE oracle.
 *
 * Suppressing the panel object, the reviewer names and the votes still left
 * one Team-derived signal on a sibling route: `adaptive.humanReview.decidedVia`.
 * `"multi_reviewer_panel"` / `"multi_reviewer_owner_override"` are positive
 * assertions that a legacy Team panel exists on this run — exactly what the
 * governance route's `historyScope` was corrected to stop betraying, leaking
 * through `GET /api/user/runs/[runId]` instead.
 *
 * Driven through the REAL route handler, not the payload builder, because the
 * defect is that the route hands the builder a role and the builder used to
 * ignore it for this field. The owner control is what keeps the suppression
 * assertion non-vacuous: the same fixture must still carry `decidedVia` for
 * the owner.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: any[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockedGetAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({ getAdaptiveHumanReviewAssignment: (...a: any[]) => mockedGetAssignment(...a) }));

jest.mock("@/lib/user/runDocumentToPublicResults", () => ({ runDocumentToPublicResults: jest.fn().mockReturnValue([{ modelId: "chatgpt" }]) }));
jest.mock("@/lib/panel/publicize", () => ({ publicizePanelResults: jest.fn() }));
jest.mock("@/lib/adaptiveSchema/persistedOutput", () => ({
  ...jest.requireActual("@/lib/adaptiveSchema/persistedOutput"),
  parsePersistedAdaptiveOutput: jest.fn().mockReturnValue({ ok: true, output: { schemaId: "decision_support", classification: {}, result: {} } }),
  parsePersistedLegacyAdaptiveOutput: jest.fn().mockReturnValue({ ok: false, reason: "absent" }),
}));
jest.mock("@/lib/runs/resolveRunReviewRouting", () => ({ resolveRunReviewRouting: jest.fn().mockResolvedValue({ destination: "unknown" }) }));
jest.mock("@/lib/teams/teamApiAuth", () => ({ loadUserAndTeam: jest.fn().mockResolvedValue(null) }));
jest.mock("@/lib/firestore/teamRuns", () => ({ getAdaptiveTeamRunProjection: jest.fn() }));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: jest.fn().mockResolvedValue(null) }));

let runDoc: any = null;
const mockAdminDb: any = { collection: () => ({ doc: () => ({ get: async () => ({ exists: runDoc !== null, data: () => runDoc }) }) }) };
jest.mock("@/lib/firebase/admin", () => ({ get adminDb() { return mockAdminDb; } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/runs/[runId]/route";

const RUN = "run-legacy-1";
const OWNER = "owner-uid";
const REVIEWER = "personal-reviewer-uid";

/** LEGACY run finalized by a Team PANEL. */
function seedPanelFinalizedRun() {
  runDoc = {
    userId: OWNER,
    question: "q",
    adaptiveOutput: { schemaId: "decision_support" },
    governanceRecord: {
      version: 1,
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      adaptiveOutputVersion: 1,
      humanReview: { status: "approved", reviewerId: "TEAM_PANELIST_UID", reviewedAt: "2026-08-03T00:00:00.000Z", decidedVia: "multi_reviewer_panel" },
      decisionReceipt: { conclusion: "C", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: false },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    },
  };
}

const call = async () => {
  const res = await GET(new NextRequest(`http://localhost/api/user/runs/${RUN}`), { params: Promise.resolve({ runId: RUN }) } as any);
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  jest.clearAllMocks();
  seedPanelFinalizedRun();
  mockedGetAssignment.mockResolvedValue({
    status: "found",
    assignment: { version: 1, runId: RUN, teamId: null, assignedReviewerUserId: REVIEWER, assignedByUserId: OWNER, assignedAt: "2026-08-01T00:00:00.000Z", revision: 1 },
  });
});

it("a Personal reviewer cannot detect the Team panel through decidedVia", async () => {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER });
  const r = await call();
  expect(r.status).toBe(200);
  expect(r.body.viewerRole).toBe("personal_reviewer");
  // The review STATUS is legitimate and still present; only the provenance goes.
  expect(r.body.adaptive.humanReview.status).toBe("approved");
  expect(r.body.adaptive.humanReview).not.toHaveProperty("decidedVia");
  expect(JSON.stringify(r.body)).not.toContain("multi_reviewer_panel");
  expect(JSON.stringify(r.body)).not.toContain("TEAM_PANELIST_UID");
});

it("CONTROL: the owner still receives decidedVia from the identical fixture", async () => {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER });
  const r = await call();
  expect(r.status).toBe(200);
  expect(r.body.viewerRole).toBe("owner");
  expect(r.body.adaptive.humanReview.decidedVia).toBe("multi_reviewer_panel");
});
