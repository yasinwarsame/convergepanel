/**
 * Phase 4B — Mandatory Workspace Integrity for Workspace-Bound Run Reads.
 *
 * Formerly `phase3WorkspaceIdInert.spec.ts`. Phase 3 deliberately made
 * `workspaceId` inert on every read route ("zero read-route changes"),
 * and this file proved exactly that premise. Phase 4B's entire purpose is
 * to end that inertness for `workspaceId`-bearing runs: presence is now
 * mandatorily validated, and only a genuinely VALID association behaves
 * identically to a legacy run — an INVALID one must deny even the run's
 * own owner. This file is rewritten (not just patched) to test the new,
 * correct invariant rather than the old, now-intentionally-false one.
 *
 * The acceptance test this program cares about most: a valid reviewer
 * assignment on a CORRUPTED Workspace-bound run must still be denied
 * (covered in personalReviewerAccess.spec.ts's own Phase 4B additions);
 * this file covers the owner/unrelated-user side of that same invariant.
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

// Phase 4B — the Layer-A dependency. Mocked as its own module (never
// routed through the generic `mockAdminDb` above, which is shared with
// the run-doc lookup and would otherwise return run data when Layer A
// asks for a Workspace document).
const mockedGetWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaces", () => ({
  getWorkspace: (...args: any[]) => mockedGetWorkspace(...args),
}));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/runs/[runId]/route";

const OWNER_UID = "owner-1";
const OTHER_UID = "other-1";
const RUN_ID = "run-1";
const BOUND_WORKSPACE_ID = "personal-owner-1";

function validWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    status: "found",
    workspace: {
      schemaVersion: 1,
      id: BOUND_WORKSPACE_ID,
      type: "personal",
      name: "Personal Workspace",
      ownerUserId: OWNER_UID,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      ...overrides,
    },
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
  mockedGetPersonalAssignment.mockResolvedValue({ status: "unassigned" });
  mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: null });
});

describe("GET /api/user/runs/[runId] — legacy runs remain byte-for-byte unchanged (zero Workspace lookup)", () => {
  it("a run with workspaceId truly absent never calls getWorkspace at all", async () => {
    mockedRunGet.mockResolvedValue(runDoc()); // no workspaceId key
    const { res, json } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("owner");
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });
});

describe("GET /api/user/runs/[runId] — a genuinely VALID bound run behaves identically to a legacy run", () => {
  it("grants its true owner full access, viewerRole: owner — same as a legacy run", async () => {
    mockedGetWorkspace.mockResolvedValue(validWorkspace());
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: BOUND_WORKSPACE_ID }));
    const { res, json } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("owner");
    expect(json.ok).toBe(true);
  });

  it("still denies a non-owner, non-reviewer exactly as before — Workspace validity grants nothing extra", async () => {
    mockedGetWorkspace.mockResolvedValue(validWorkspace());
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: BOUND_WORKSPACE_ID }));
    const { res, json } = await callRouteAs(OTHER_UID);
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("forbidden");
  });

  it("response shape (viewerRole, ok, adaptive.output) is byte-identical whether workspaceId is present-and-valid or absent, for the same owner", async () => {
    mockedRunGet.mockResolvedValue(runDoc()); // no workspaceId
    const legacyResult = await callRouteAs(OWNER_UID);

    jest.clearAllMocks();
    mockedGetPersonalAssignment.mockResolvedValue({ status: "unassigned" });
    mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: null });
    mockedGetWorkspace.mockResolvedValue(validWorkspace());
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: BOUND_WORKSPACE_ID })); // workspace-bound, valid
    const boundResult = await callRouteAs(OWNER_UID);

    expect(boundResult.json.viewerRole).toBe(legacyResult.json.viewerRole);
    expect(boundResult.json.ok).toBe(legacyResult.json.ok);
    expect(boundResult.json.adaptive.output).toEqual(legacyResult.json.adaptive.output);
  });
});

describe("GET /api/user/runs/[runId] — Phase 4B: an INVALID bound run denies even the true owner (the core acceptance test)", () => {
  it("Workspace document missing -> 404, denies the owner, never falls back to legacy access", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "not_found" });
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: BOUND_WORKSPACE_ID }));
    const { res, json } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(404);
    expect(json.ok).toBe(false);
    expect(json.errorCode).toBe("not_found");
  });

  it("Workspace.ownerUserId mutated to a different uid -> denies the owner, never falls back to legacy access", async () => {
    mockedGetWorkspace.mockResolvedValue(validWorkspace({ ownerUserId: "attacker-or-corruption-uid" }));
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: BOUND_WORKSPACE_ID }));
    const { res } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(404);
  });

  it("Workspace.type is 'team' (unsupported) -> denies the owner", async () => {
    mockedGetWorkspace.mockResolvedValue(validWorkspace({ type: "team" }));
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: BOUND_WORKSPACE_ID }));
    const { res } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(404);
  });

  it("run.workspaceId does not match the deterministic id for its own owner -> denies the owner, no Firestore Workspace lookup even attempted", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: "personal-someone-else" }));
    const { res } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(404);
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });

  it("Workspace lookup throws -> denies the owner (fail closed on transient failure too)", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "read_failed" });
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: BOUND_WORKSPACE_ID }));
    const { res } = await callRouteAs(OWNER_UID);
    expect(res.status).toBe(404);
  });
});
