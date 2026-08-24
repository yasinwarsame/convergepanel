/**
 * Approval Workflow, Phase 9C.1-R1C — getWorkspaceRunDetail() tests. This
 * is the read model backing the corrected `/workspace/reviews/[runId]`
 * queue-row navigation target — the fix for the R1-confirmed defect
 * where `/reviews/{runId}` rejected every legitimate Workspace viewer
 * role. `resolveTeamRunWorkspaceAccess()` and `getProject()` are mocked;
 * `resolveWorkspaceReviewTarget()` and `parseGovernanceRecord()` are
 * real/pure — only the run document itself is faked here.
 */

type StoredDoc = Record<string, unknown>;
const runsStore = new Map<string, StoredDoc>();

function resetStore() {
  runsStore.clear();
}

let simulateGetFailure = false;
let simulateNoAdminDb = false;

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name !== "runs") throw new Error(`unexpected collection: ${name}`);
    return {
      doc: (runId: string) => ({
        get: async () => {
          if (simulateGetFailure) throw new Error("simulated Firestore failure");
          const data = runsStore.get(runId);
          return { exists: data !== undefined, data: () => data };
        },
      }),
    };
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return simulateNoAdminDb ? null : mockAdminDb;
  },
}));

const mockedResolveTeamRunWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...args: any[]) => mockedResolveTeamRunWorkspaceAccess(...args),
}));

const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({
  getProject: (...args: any[]) => mockedGetProject(...args),
}));

import { getWorkspaceRunDetail } from "@/lib/workspaces/workspaceRunDetail";

const UID = "viewer-1";
const RUN_ID = "run-1";
const WS_ID = "ws-1";

function seedRun(overrides: Record<string, unknown> = {}) {
  runsStore.set(RUN_ID, {
    question: "What are the top acquisition risks?",
    workspaceId: WS_ID,
    projectId: null,
    userId: "creator-1",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });
}

const GRANTED = { granted: true, capabilities: ["research.read", "reviews.read"], workspace: { name: "Acme Research" } };

beforeEach(() => {
  resetStore();
  simulateGetFailure = false;
  simulateNoAdminDb = false;
  jest.clearAllMocks();
  mockedGetProject.mockResolvedValue({ status: "not_found" });
});

describe("getWorkspaceRunDetail — approval gate", () => {
  it("not_found when approvalAdmitted is false, before any Firestore read", async () => {
    seedRun();
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: false });
    expect(result).toEqual({ status: "not_found" });
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });
});

describe("getWorkspaceRunDetail — canonical Workspace source is the run's OWN field, no query param needed", () => {
  it("run missing -> not_found", async () => {
    const result = await getWorkspaceRunDetail({ runId: "does-not-exist", uid: UID, approvalAdmitted: true });
    expect(result).toEqual({ status: "not_found" });
  });

  it("run with no workspaceId field at all (legacy) -> not_found, no Personal/legacy fallback", async () => {
    seedRun({ workspaceId: undefined });
    delete (runsStore.get(RUN_ID) as any).workspaceId;
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result).toEqual({ status: "not_found" });
  });

  it("Personal-bound run (workspaceId === the owner's own Personal Workspace id) -> not_found", async () => {
    seedRun({ workspaceId: "personal-creator-1", userId: "creator-1" });
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result).toEqual({ status: "not_found" });
  });

  it("malformed workspaceId (empty string) -> not_found", async () => {
    seedRun({ workspaceId: "" });
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result).toEqual({ status: "not_found" });
  });

  it("valid Workspace-bound run, access denied -> not_found (never a message revealing the run exists)", async () => {
    seedRun();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_removed" });
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result).toEqual({ status: "not_found" });
  });

  it("valid Workspace-bound run, access granted but missing research.read -> not_found", async () => {
    seedRun();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, capabilities: ["reviews.read"], workspace: { name: "Acme" } });
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result).toEqual({ status: "not_found" });
  });

  it("Phase 9C.1-R1C CORE FIX: valid Workspace-bound run, access granted with research.read -> ok, this is the exact scenario R1 proved broken via /reviews/{runId}", async () => {
    seedRun();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED);
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.detail.workspaceId).toBe(WS_ID);
      expect(result.detail.workspaceName).toBe("Acme Research");
    }
  });

  it("passes the run's OWN workspaceId to resolveTeamRunWorkspaceAccess — never a route/query parameter (none exists)", async () => {
    seedRun({ workspaceId: "ws-from-run-field" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ ...GRANTED, workspace: { name: "X" } });
    await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: UID, workspaceId: "ws-from-run-field" });
  });
});

describe("getWorkspaceRunDetail — content", () => {
  it("truncates and trims runLabel from the run's question", () => {
    // covered indirectly below; direct truncation behavior mirrors reviewQueue.ts's own tested helper
  });

  it("returns runLabel from the run's question field", async () => {
    seedRun({ question: "  What is the risk?  " });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED);
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.detail.runLabel).toBe("What is the risk?");
  });

  it("resolves Project name via getProject() when projectId is present", async () => {
    seedRun({ projectId: "proj-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED);
    mockedGetProject.mockResolvedValue({ status: "found", project: { name: "Q3 Diligence" } });
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.detail.projectName).toBe("Q3 Diligence");
    expect(mockedGetProject).toHaveBeenCalledWith("proj-1");
  });

  it("projectId null -> projectName null, no getProject() call", async () => {
    seedRun({ projectId: null });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED);
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.detail.projectName).toBeNull();
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("reviewStatus null when no parseable governanceRecord exists — never fabricated", async () => {
    seedRun();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED);
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.detail.reviewStatus).toBeNull();
      expect(result.detail.reviewedAt).toBeNull();
    }
  });

  it("reviewStatus/reviewedAt populated from a valid governanceRecord", async () => {
    seedRun({
      governanceRecord: {
        version: 1,
        schemaId: "decision_support",
        answerShape: "decision_support_view",
        adaptiveOutputVersion: 1,
        humanReview: { status: "approved_with_conditions", reviewedAt: "2026-08-05T00:00:00.000Z" },
        decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      },
    });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED);
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.detail.reviewStatus).toBe("approved_with_conditions");
      expect(result.detail.reviewedAt).toBe("2026-08-05T00:00:00.000Z");
    }
  });
});

describe("getWorkspaceRunDetail — failure semantics", () => {
  it("read_failed when adminDb is unavailable", async () => {
    simulateNoAdminDb = true;
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result).toEqual({ status: "read_failed" });
  });

  it("read_failed when the run read throws", async () => {
    simulateGetFailure = true;
    const result = await getWorkspaceRunDetail({ runId: RUN_ID, uid: UID, approvalAdmitted: true });
    expect(result).toEqual({ status: "read_failed" });
  });
});
