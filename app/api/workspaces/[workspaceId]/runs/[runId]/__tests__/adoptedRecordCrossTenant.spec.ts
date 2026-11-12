/**
 * Order 40 C, owner ruling O-1: a cross-tenant negative test for the saved adopted-result record
 * (`runs/{runId}.adaptiveDisplayResults`) on the Team research detail read,
 * `GET /api/workspaces/{workspaceId}/runs/{runId}`.
 *
 * The record is stored in its own document `runs/{runId}/adaptiveDisplayResults/v1` (owner ruling O-2); a denied
 * request never even reads it.
 *
 * REAL: the route, `resolveTeamRunWorkspaceAccess` → `resolveWorkspaceAccess` (admission, membership status, Team-type
 * guard, capabilities), the row validator, `buildRunReadPayload` and `readAdoptedDisplayResults`. Mocked only at their
 * module boundaries: identity, the two Firestore readers the access resolver uses (`getWorkspace`,
 * `getWorkspaceMembershipForBinding`), the run document read, and the enrichment readers.
 *
 * The record's text (ADOPTED) is unique to the record: it is in no other field of the run document. The positive control
 * proves that a member's 200 response carries it, so each denial asserting its absence can fail. Every denial is the
 * concealed 404 of the Team run family (access denial: team_workspace_not_found, the same bytes as a Workspace that does
 * not exist; containment denial: run_not_found), it carries none of the record's text, and the payload builder is never
 * reached.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/env", () => ({
  ...jest.requireActual("@/lib/env"),
  WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_CANARY_UIDS: undefined,
  TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined,
}));
const workspaces = new Map<string, Record<string, unknown>>();
const memberships = new Map<string, Record<string, unknown>>();
jest.mock("@/lib/firestore/workspaces", () => ({
  getWorkspace: async (id: string) => (workspaces.has(id) ? { status: "found", workspace: workspaces.get(id) } : { status: "not_found" }),
}));
jest.mock("@/lib/firestore/workspaceMemberships", () => ({
  getWorkspaceMembershipForBinding: async ({ workspaceId, uid }: { workspaceId: string; uid: string }) => {
    const m = memberships.get(`${workspaceId}/${uid}`);
    return m ? { status: "found", membership: m, documentUpdateTime: m.updatedAt } : { status: "not_found" };
  },
}));
jest.mock("@/lib/firestore/projects", () => ({ getProject: jest.fn(async () => ({ status: "not_found" })) }));
jest.mock("@/lib/workspaces/teamRunAssigneeEnrichment", () => ({ resolveRunAssigneesForPage: jest.fn(async () => []) }));
jest.mock("@/lib/firestore/runs", () => ({ getAdaptiveHumanReviewAssignment: jest.fn(async () => ({ status: "unassigned" })) }));
jest.mock("@/lib/runs/resolveRunReviewRouting", () => ({ resolveRunReviewRouting: jest.fn(async () => "in_queue") }));
const runDocs = new Map<string, Record<string, unknown>>();
/** `runs/{runId}/adaptiveDisplayResults/v1`, keyed by run id; every read is recorded. */
const displayDocs = new Map<string, Record<string, unknown>>();
const displayReads: string[] = [];
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {
      collection: (name: string) => ({
        doc: (id: string) => ({
          get: async () => {
            if (name !== "runs") throw new Error(`unexpected collection ${name}`);
            return { exists: runDocs.has(id), data: () => runDocs.get(id) };
          },
          collection: (sub: string) => ({
            doc: (docId: string) => ({
              get: async () => {
                if (name !== "runs" || sub !== "adaptiveDisplayResults" || docId !== "v1") throw new Error(`unexpected path ${name}/${id}/${sub}/${docId}`);
                displayReads.push(id);
                return { exists: displayDocs.has(id), data: () => displayDocs.get(id) };
              },
            }),
          }),
        }),
      }),
    };
  },
}));
const builder = jest.fn();
jest.mock("@/lib/runs/runReadPayload", () => {
  const actual = jest.requireActual("@/lib/runs/runReadPayload");
  return { ...actual, buildRunReadPayload: (...a: unknown[]) => (builder(...a), actual.buildRunReadPayload(...a)) };
});
jest.mock("@/lib/connectors", () => new Proxy({}, { get: (_t, key) => { throw new Error(`model connector touched: ${String(key)}`); } }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/route";
import { buildAdaptiveDisplayResultsRecord, ADAPTIVE_DISPLAY_RESULTS_FIELD } from "@/lib/adaptiveSchema/adoptedDisplayResults";
import { FIXTURE_OWNER_UID, FIXTURE_RUN_ID, fullTeamRunData } from "@/lib/runs/__tests__/runReadFixtures";

const WS_B = "ws-tenant-b";
const WS_A = "ws-tenant-a";
const MEMBER_B = "uid-member-of-b";
const MEMBER_A = "uid-member-of-a-only";
const OUTSIDER = "uid-no-membership";
const REMOVED_B = "uid-removed-from-b";
const ADOPTED = "ADOPTED-RECORD-ONLY-7f3c1e";
const T = Timestamp.fromDate(new Date("2026-11-01T00:00:00.000Z"));

function teamWorkspace(id: string, ownerUserId: string) {
  return { schemaVersion: 1, id, type: "team", name: id, ownerUserId, createdByUserId: ownerUserId, createdAt: T, updatedAt: T };
}
function membership(workspaceId: string, uid: string, status: "active" | "removed" = "active") {
  return {
    schemaVersion: 1, id: uid, workspaceId, uid, role: "member", status, createdAt: T, updatedAt: T, invitedByUserId: null,
    removedAt: status === "removed" ? T : null, removedByUserId: status === "removed" ? FIXTURE_OWNER_UID : null,
  };
}
function runInB() {
  const built = buildAdaptiveDisplayResultsRecord({
    runId: FIXTURE_RUN_ID,
    schemaId: "deep_research",
    panelResults: [{ modelId: "chatgpt", status: "ok" }, { modelId: "claude", status: "ok" }],
    adaptiveResults: [
      { modelId: "chatgpt", schemaId: "deep_research", ok: true, data: { executiveSummary: ADOPTED, findings: [] } },
      { modelId: "claude", schemaId: "deep_research", ok: true, data: { executiveSummary: `${ADOPTED}-claude`, findings: [] } },
    ] as never,
  });
  if (!built.ok) throw new Error(`fixture record not built: ${built.reason}`);
  const data = fullTeamRunData({ workspaceId: WS_B, projectId: null, createdAt: T, completedAt: T });
  // The record lives only in its own document (O-2); its text exists nowhere in the run document.
  expect(JSON.stringify(data)).not.toContain(ADOPTED);
  expect(data[ADAPTIVE_DISPLAY_RESULTS_FIELD]).toBeUndefined();
  displayDocs.set(FIXTURE_RUN_ID, built.record as unknown as Record<string, unknown>);
  return data;
}
async function read(uid: string, workspaceId: string) {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid, source: "session_cookie" });
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${workspaceId}/runs/${FIXTURE_RUN_ID}`, { method: "GET" }), {
    params: { workspaceId, runId: FIXTURE_RUN_ID },
  });
  const text = await res.text();
  return { status: res.status, text };
}
/** Containment denial (the run is not in the addressed Workspace). */
const RUN_CONCEALED = JSON.stringify({ ok: false, errorCode: "run_not_found", message: "This run could not be found." });
/** Access denial: byte-identical to addressing a Workspace that does not exist (asserted below). */
const WORKSPACE_CONCEALED = JSON.stringify({ ok: false, errorCode: "team_workspace_not_found", message: "This Team Workspace could not be found." });

beforeEach(() => {
  jest.clearAllMocks();
  workspaces.clear();
  memberships.clear();
  runDocs.clear();
  displayDocs.clear();
  displayReads.length = 0;
  workspaces.set(WS_B, teamWorkspace(WS_B, FIXTURE_OWNER_UID));
  workspaces.set(WS_A, teamWorkspace(WS_A, "uid-owner-a"));
  memberships.set(`${WS_B}/${MEMBER_B}`, membership(WS_B, MEMBER_B));
  memberships.set(`${WS_A}/${MEMBER_A}`, membership(WS_A, MEMBER_A));
  memberships.set(`${WS_B}/${REMOVED_B}`, membership(WS_B, REMOVED_B, "removed"));
  runDocs.set(FIXTURE_RUN_ID, runInB());
});

describe("O-1: the saved adopted-result record never crosses a tenant boundary", () => {
  it("control: an active member of the run's Team Workspace reads it, and the response carries the record's text", async () => {
    const r = await read(MEMBER_B, WS_B);
    expect(r.status).toBe(200);
    expect(r.text).toContain(ADOPTED);
    expect(builder).toHaveBeenCalledTimes(1);
    expect(displayReads).toEqual([FIXTURE_RUN_ID]);
    // The record itself is never returned, only its effect on adaptive.modelResults.
    expect(r.text).not.toContain(ADAPTIVE_DISPLAY_RESULTS_FIELD);
  });

  it("a signed-in user with no membership in the run's Workspace is concealed (404) and receives none of the record", async () => {
    const r = await read(OUTSIDER, WS_B);
    expect(r).toEqual({ status: 404, text: WORKSPACE_CONCEALED });
    expect(builder).not.toHaveBeenCalled();
    expect(displayReads).toEqual([]);
  });

  it("a member of ANOTHER tenant addressing the run through their own Workspace is concealed (cross-tenant containment)", async () => {
    const r = await read(MEMBER_A, WS_A);
    expect(r).toEqual({ status: 404, text: RUN_CONCEALED });
    expect(builder).not.toHaveBeenCalled();
    expect(displayReads).toEqual([]);
  });

  it("the access denial is indistinguishable from addressing a Workspace that does not exist", async () => {
    const denied = await read(OUTSIDER, WS_B);
    const absent = await read(OUTSIDER, "ws-does-not-exist");
    expect(denied).toEqual(absent);
    expect(denied.text).not.toContain(ADOPTED);
  });

  it("a member of ANOTHER tenant addressing the run's own Workspace is concealed (no membership there)", async () => {
    const r = await read(MEMBER_A, WS_B);
    expect(r).toEqual({ status: 404, text: WORKSPACE_CONCEALED });
    expect(builder).not.toHaveBeenCalled();
    expect(displayReads).toEqual([]);
  });

  it("a removed member of the run's Workspace is concealed", async () => {
    const r = await read(REMOVED_B, WS_B);
    expect(r).toEqual({ status: 404, text: WORKSPACE_CONCEALED });
    expect(builder).not.toHaveBeenCalled();
    expect(displayReads).toEqual([]);
  });

  it("the run's own creator, without a membership, gets no bypass", async () => {
    workspaces.set(WS_B, teamWorkspace(WS_B, "uid-other-owner"));
    const r = await read(FIXTURE_OWNER_UID, WS_B);
    expect(r).toEqual({ status: 404, text: WORKSPACE_CONCEALED });
    expect(builder).not.toHaveBeenCalled();
    expect(displayReads).toEqual([]);
  });
});
