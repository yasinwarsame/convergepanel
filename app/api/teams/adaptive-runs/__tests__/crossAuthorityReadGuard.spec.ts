/**
 * PHASE 1 REVIEW STACK CROSS-AUTHORITY READ GUARD — the single-run legacy
 * Team read routes.
 *
 * Companion to `app/api/teams/runs/__tests__/crossAuthorityReadGuard.spec.ts`,
 * which covers the list and export surfaces. Guarding the queue alone would
 * leave every per-run endpoint as an unchanged back door into exactly the same
 * canonical Workspace-governed state, so each one is asserted here
 * independently rather than assumed to inherit the fix.
 *
 * Each route is driven twice, with ONE difference between the two runs: the
 * canonical run document's Workspace binding. Every other input — the legacy
 * Team admin actor, the valid `teamRuns` projection, the review documents
 * themselves — is held identical, so a denial can only be attributable to the
 * binding.
 *
 * The denial assertion is deliberately paired with a NOT-CALLED assertion on
 * the downstream review getter. A route that returns 404 only after loading a
 * panel, its votes and its reviewer identities has not closed the disclosure;
 * the data left the database either way. The not-called assertion is also what
 * makes the legacy control non-vacuous: for a genuinely legacy run the getter
 * MUST be reached, so a guard that simply refused everything would fail here.
 */

const mockedGetRequestUid = jest.fn();
const mockedLoadUserAndTeam = jest.fn();
const mockedMemberRole = jest.fn();
const mockedIsTeamAdmin = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({
  getRequestUid: (...args: any[]) => mockedGetRequestUid(...args),
  loadUserAndTeam: (...args: any[]) => mockedLoadUserAndTeam(...args),
  memberRole: (...args: any[]) => mockedMemberRole(...args),
  isTeamAdmin: (...args: any[]) => mockedIsTeamAdmin(...args),
}));

const mockedGetProjection = jest.fn();
jest.mock("@/lib/firestore/teamRuns", () => ({
  getAdaptiveTeamRunProjection: (...args: any[]) => mockedGetProjection(...args),
}));

const mockedGetPanel = jest.fn();
const mockedGetVote = jest.fn();
const mockedGetAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  getAdaptiveHumanReviewPanel: (...args: any[]) => mockedGetPanel(...args),
  getAdaptiveHumanReviewVote: (...args: any[]) => mockedGetVote(...args),
  getAdaptiveHumanReviewAssignment: (...args: any[]) => mockedGetAssignment(...args),
  submitAdaptiveHumanReviewPanel: jest.fn(),
  cancelAdaptiveHumanReviewPanel: jest.fn(),
  submitAdaptiveHumanReviewVote: jest.fn(),
  submitAdaptiveHumanReviewAssignment: jest.fn(),
}));

const runDocs = new Map<string, Record<string, any>>();
/** Every path read, so "never fetched" is checkable rather than assumed. */
const readPaths: string[] = [];

function makeDocRef(path: string): any {
  return {
    get: async () => {
      readPaths.push(path);
      return { exists: runDocs.has(path), data: () => runDocs.get(path) };
    },
    collection: (name: string) => makeCollectionRef(`${path}/${name}`),
  };
}
function makeCollectionRef(path: string): any {
  return {
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    get: async () => {
      readPaths.push(path);
      return { docs: [] };
    },
  };
}
const mockAdminDb: any = { collection: (name: string) => makeCollectionRef(name) };
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { GET as detailGET } from "@/app/api/teams/adaptive-runs/[runId]/route";
import { GET as historyGET } from "@/app/api/teams/adaptive-runs/[runId]/history/route";
import { GET as panelGET } from "@/app/api/teams/adaptive-runs/[runId]/review-panel/route";
import { GET as votesGET } from "@/app/api/teams/adaptive-runs/[runId]/votes/route";
import { GET as assignmentGET } from "@/app/api/teams/adaptive-runs/[runId]/assignment/route";

const TEAM_ID = "team-1";
const RUN_ID = "run-1";
const OWNER = "owner-uid";

function governanceRecord() {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: {
      conclusion: "The panel recommends option A.",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: [],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: false,
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function seedRun(binding: Record<string, unknown> = {}) {
  runDocs.set(`runs/${RUN_ID}`, { userId: OWNER, governanceRecord: governanceRecord(), ...binding });
}

const req = () => new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}`);
const params = { params: { runId: RUN_ID } };

/** Canonical review reads performed through adminDb (the history route's path). */
function canonicalReviewPathsRead(): string[] {
  return readPaths.filter((p) => p.includes("/humanReview"));
}

/** Every downstream review getter across all five routes. */
function anyReviewGetterCalled(): boolean {
  return mockedGetPanel.mock.calls.length > 0 || mockedGetVote.mock.calls.length > 0 || mockedGetAssignment.mock.calls.length > 0;
}

beforeEach(() => {
  runDocs.clear();
  readPaths.length = 0;
  [mockedGetRequestUid, mockedLoadUserAndTeam, mockedMemberRole, mockedIsTeamAdmin, mockedGetProjection, mockedGetPanel, mockedGetVote, mockedGetAssignment].forEach(
    (m) => m.mockReset()
  );

  // The strongest legitimate legacy actor: a Team ADMIN, with a VALID
  // projection for this exact run. No Workspace membership exists anywhere.
  mockedGetRequestUid.mockResolvedValue("caller-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "caller@test.com" }, team: { id: TEAM_ID, members: [] } });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
  mockedGetProjection.mockResolvedValue({
    status: "found",
    projection: { projectionVersion: 1, adaptive: true, teamId: TEAM_ID, runId: RUN_ID, humanReviewStatus: "unreviewed" },
  });
  mockedGetPanel.mockResolvedValue({ status: "absent" });
  mockedGetVote.mockResolvedValue({ status: "absent" });
  mockedGetAssignment.mockResolvedValue({ status: "absent" });
});

const ROUTES: [name: string, handler: (r: NextRequest, p: typeof params) => Promise<Response>][] = [
  ["adaptive-run detail", detailGET as any],
  ["review history", historyGET as any],
  ["review-panel GET", panelGET as any],
  ["votes GET", votesGET as any],
  ["assignment GET", assignmentGET as any],
];

describe.each(ROUTES)("%s — Workspace-bound run", (_name, handler) => {
  it.each([
    ["a Team Workspace", { workspaceId: "ws-team-1" }],
    ["its owner's Personal Workspace", { workspaceId: `personal-${OWNER}` }],
    ["a malformed binding", { workspaceId: 12345 }],
  ])("is concealed as a plain not-found when bound to %s", async (_label, binding) => {
    seedRun(binding as Record<string, unknown>);

    const res = await handler(req(), params);
    const body = await res.json();

    // Byte-identical to a genuinely absent run: no Workspace is named, no
    // alternative authority domain is hinted at, no distinct status is used.
    expect({ status: res.status, body }).toEqual({
      status: 404,
      body: { ok: false, error: { code: "not_found", message: "Run not found." } },
    });
    // And nothing canonical was fetched on the way to saying so.
    expect(anyReviewGetterCalled()).toBe(false);
    expect(canonicalReviewPathsRead()).toEqual([]);
  });
});

describe.each(ROUTES)("%s — genuinely legacy run (control)", (_name, handler) => {
  it("is not concealed", async () => {
    seedRun();
    const res = await handler(req(), params);
    const body = await res.json().catch(() => ({}));
    // The guard must not fire. Asserted on the CONCEALMENT CONTRACT rather than
    // the bare status: `votes` legitimately answers 404 `panel_absent` for a
    // legacy run that simply has no panel, which is a different answer with a
    // different meaning and must not be mistaken for the guard firing.
    expect(body?.error?.code === "not_found").toBe(false);
  });
});

describe("legacy control reaches the downstream review getters", () => {
  // Proves the not-called assertions above are not vacuous: on a legacy run the
  // very same getters ARE invoked.
  it("review-panel GET loads the panel", async () => {
    seedRun();
    await panelGET(req(), params);
    expect(mockedGetPanel).toHaveBeenCalledWith(RUN_ID, TEAM_ID);
  });

  it("votes GET loads the panel", async () => {
    seedRun();
    await votesGET(req(), params);
    expect(mockedGetPanel).toHaveBeenCalledWith(RUN_ID, TEAM_ID);
  });

  it("assignment GET loads the assignment", async () => {
    seedRun();
    await assignmentGET(req(), params);
    expect(mockedGetAssignment).toHaveBeenCalledWith(RUN_ID);
  });

  it("history GET reads the review history subcollection", async () => {
    seedRun();
    await historyGET(req(), params);
    expect(canonicalReviewPathsRead()).toContain(`runs/${RUN_ID}/humanReviewHistory`);
  });
});

describe("the legacy projection cannot confer read authority", () => {
  it("a valid projection does not unlock a Workspace-bound run", async () => {
    seedRun({ workspaceId: "ws-team-1" });
    // Projection is valid and matches the caller's own team exactly.
    const res = await panelGET(req(), params);
    expect(res.status).toBe(404);
    expect(mockedGetPanel).not.toHaveBeenCalled();
  });

  it("an absent canonical run is refused rather than assumed legacy", async () => {
    // No seedRun() — binding unprovable, so the route must not proceed.
    const res = await panelGET(req(), params);
    expect(res.status).toBe(404);
    expect(mockedGetPanel).not.toHaveBeenCalled();
  });
});
