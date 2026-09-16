/**
 * Team Research Parity, Phase R1 — the user-route contract proof.
 *
 * Runs BOTH `GET /api/user/runs/[runId]` and
 * `GET /api/workspaces/[workspaceId]/runs/[runId]` in one module graph, over
 * the SAME run documents, with the SAME mocked I/O boundaries, and asserts
 * the Team route's body minus its `team` block is byte-for-byte the user
 * route's body — same keys, same order, same values, same serialization —
 * for every viewer role and every envelope state. Parsers, rehydration,
 * claim-id attachment, the viewer-role helper and the builder are REAL.
 */

jest.mock("@/lib/env", () => ({
  WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_CANARY_UIDS: undefined,
  TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined,
}));
const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({ validateRunWorkspaceAssociation: jest.fn() }));
const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...a: unknown[]) => mockedGetProject(...a) }));
const mockedAssignees = jest.fn();
jest.mock("@/lib/workspaces/teamRunAssigneeEnrichment", () => ({ resolveRunAssigneesForPage: (...a: unknown[]) => mockedAssignees(...a) }));
const mockedGetAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({ getAdaptiveHumanReviewAssignment: (...a: unknown[]) => mockedGetAssignment(...a) }));
const mockedLoadUserAndTeam = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({ loadUserAndTeam: (...a: unknown[]) => mockedLoadUserAndTeam(...a) }));
const mockedProjection = jest.fn();
jest.mock("@/lib/firestore/teamRuns", () => ({ getAdaptiveTeamRunProjection: (...a: unknown[]) => mockedProjection(...a) }));
const runDocs = new Map<string, Record<string, unknown>>();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return { collection: () => ({ doc: (id: string) => ({ get: async () => ({ exists: runDocs.has(id), data: () => runDocs.get(id) }) }) }) };
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET as userGet } from "@/app/api/user/runs/[runId]/route";
import { GET as teamGet } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/route";
import {
  FIXTURE_PROJECT_ID,
  FIXTURE_RUN_ID,
  FIXTURE_WORKSPACE_ID,
  comparisonMatrixAdaptiveOutput,
  fullTeamRunData,
  governanceRecord,
} from "@/lib/runs/__tests__/runReadFixtures";

const UID = "member-b";
const WS_ID = FIXTURE_WORKSPACE_ID;
const RUN_ID = FIXTURE_RUN_ID;
const CREATED = Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z"));

function grant(capabilities: string[]) {
  return { granted: true, workspace: { id: WS_ID, type: "team" }, membership: { role: "member" }, capabilities };
}
async function callUser(headers: Record<string, string> = {}) {
  const res = await userGet(new NextRequest(`http://localhost/api/user/runs/${RUN_ID}`, { headers }), { params: Promise.resolve({ runId: RUN_ID }) });
  return { status: res.status, text: await res.text() };
}
async function callTeam(headers: Record<string, string> = {}) {
  const res = await teamGet(new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}`, { headers }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
  return { status: res.status, text: await res.text() };
}
function withoutTeam(text: string): { stripped: string; team: unknown } {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const { team, ...rest } = parsed;
  return { stripped: JSON.stringify(rest), team };
}

/** Every envelope state the read surfaces, each as a complete Team-bound run document. */
/** `reviewable`: the governance record's human-review status is unreviewed/pending (team_reviewer is possible). */
const DOCUMENT_VARIANTS: Array<{ name: string; reviewable: boolean; data: () => Record<string, unknown> }> = [
  { name: "deep_research, unreviewed, synthesis cache, legacy envelope, org governance", reviewable: true, data: () => fullTeamRunData({ createdAt: CREATED }) },
  { name: "deep_research, pending review", reviewable: true, data: () => fullTeamRunData({ createdAt: CREATED, governanceRecord: governanceRecord("pending") }) },
  { name: "comparison_matrix, approved with conditions", reviewable: false, data: () => fullTeamRunData({ createdAt: CREATED, adaptiveOutput: comparisonMatrixAdaptiveOutput(), governanceRecord: governanceRecord("approved_with_conditions", { schemaId: "comparison_matrix", answerShape: "comparison_grid" }) }) },
  { name: "legacy-only run (adaptive absent, no governance)", reviewable: false, data: () => fullTeamRunData({ createdAt: CREATED, adaptiveOutput: undefined, governanceRecord: undefined }) },
  { name: "plain panel run (no envelopes, no synthesis cache, legacy results[] fallback)", reviewable: false, data: () => fullTeamRunData({ createdAt: CREATED, adaptiveOutput: undefined, legacyAdaptiveOutput: undefined, governanceRecord: undefined, synthesizedStructuredReport: undefined, runDocument: undefined, results: [{ modelId: "grok", status: "ok", rawText: "legacy" }], teamGovernance: undefined, governanceStatus: undefined }) },
  { name: "malformed adaptive envelope beside a valid governance record", reviewable: true, data: () => fullTeamRunData({ createdAt: CREATED, adaptiveOutput: { version: 1, schemaId: "deep_research" } }) },
  { name: "unsupported adaptive version", reviewable: true, data: () => fullTeamRunData({ createdAt: CREATED, adaptiveOutput: { version: 2 } }) },
  { name: "Unfiled run", reviewable: true, data: () => fullTeamRunData({ createdAt: CREATED, projectId: null }) },
];

const VIEWERS: Array<{ name: string; capabilities: string[]; assignment: unknown; assignedWithSubmit: boolean }> = [
  { name: "viewer-role member (research.read only)", capabilities: ["workspace.read", "research.read"], assignment: { status: "unassigned" }, assignedWithSubmit: false },
  { name: "member with reviews.submit but not assigned", capabilities: ["workspace.read", "research.read", "reviews.submit"], assignment: { status: "found", assignment: { assignedReviewerUserId: "someone-else" } }, assignedWithSubmit: false },
  { name: "assigned reviewer with reviews.submit", capabilities: ["workspace.read", "research.read", "reviews.submit"], assignment: { status: "found", assignment: { assignedReviewerUserId: UID } }, assignedWithSubmit: true },
];

beforeEach(() => {
  jest.clearAllMocks();
  runDocs.clear();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedGetProject.mockResolvedValue({ status: "found", project: { id: FIXTURE_PROJECT_ID, workspaceId: WS_ID, name: "Launch", status: "active" }, documentUpdateTime: CREATED });
  mockedAssignees.mockResolvedValue([null]);
  // Review routing goes through the REAL resolver for both routes: owner has a legacy team whose projection is present → "in_queue".
  mockedLoadUserAndTeam.mockResolvedValue({ team: { id: "legacy-team-1" } });
  mockedProjection.mockResolvedValue({ status: "found", projection: { projectionVersion: 1, adaptive: true, teamId: "legacy-team-1", runId: RUN_ID } });
});

describe("Team route body minus `team` === user route body, byte for byte", () => {
  for (const viewer of VIEWERS) {
    for (const variant of DOCUMENT_VARIANTS) {
      it(`${viewer.name} × ${variant.name}`, async () => {
        runDocs.set(RUN_ID, variant.data());
        mockedAccess.mockResolvedValue(grant(viewer.capabilities));
        mockedGetAssignment.mockResolvedValue(viewer.assignment);

        const user = await callUser({ "x-vercel-id": "vid-1" });
        const team = await callTeam({ "x-vercel-id": "vid-1" });
        expect(user.status).toBe(200);
        expect(team.status).toBe(200);

        const { stripped, team: teamBlock } = withoutTeam(team.text);
        expect(stripped).toBe(user.text);
        // The comparison is not vacuous: both bodies are real, populated payloads for the expected role.
        const parsed = JSON.parse(user.text);
        expect(parsed.ok).toBe(true);
        expect(parsed.runId).toBe(RUN_ID);
        expect(parsed.viewerRole).toBe(viewer.assignedWithSubmit && variant.reviewable ? "team_reviewer" : "team_member");
        expect(parsed.results.length).toBeGreaterThan(0);
        expect(teamBlock).toMatchObject({ workspaceId: WS_ID });
        // Key order is the frozen user-route order on both.
        expect(Object.keys(JSON.parse(stripped))).toEqual(["ok", "runId", "viewerRole", "question", "selectedModels", "status", "results", "synthesisCache", "governance", "governanceStatus", "adaptive", "legacyAdaptive"]);
      });
    }
  }

  it("reviewRouting is derived identically (same owner-keyed resolver, same log-free happy path) — including the 'unknown' fail-closed outcome", async () => {
    runDocs.set(RUN_ID, fullTeamRunData({ createdAt: CREATED }));
    mockedAccess.mockResolvedValue(grant(["workspace.read", "research.read"]));
    mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
    mockedProjection.mockResolvedValue({ status: "read_failed" });
    const user = await callUser();
    const team = await callTeam();
    expect(withoutTeam(team.text).stripped).toBe(user.text);
    expect(JSON.parse(user.text).adaptive.reviewRouting).toBe("unknown");
    expect(mockedLoadUserAndTeam).toHaveBeenCalledTimes(2);
  });

  it("the user route's Team denial mapping is UNCHANGED (403 forbidden for membership_not_found) while the Team route conceals with 404", async () => {
    runDocs.set(RUN_ID, fullTeamRunData({ createdAt: CREATED }));
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
    const user = await callUser();
    const team = await callTeam();
    expect(user.status).toBe(403);
    expect(JSON.parse(user.text)).toEqual({ ok: false, errorCode: "forbidden", message: "You do not have access to this run." });
    expect(team.status).toBe(404);
    expect(JSON.parse(team.text).errorCode).toBe("team_workspace_not_found");
  });
});
