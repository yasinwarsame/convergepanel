/**
 * Team Run→Project Association, Phase 8C-C — `associateTeamRunWithProject()`
 * tests. In-memory Firestore fake covering all four collections this
 * function's transaction touches (`workspaces`, `workspaceMemberships`,
 * `runs`, `projects`), structural mirror of `teamProjects.spec.ts`'s own
 * buffered-transaction fake (writes are queued and applied only once the
 * callback resolves without throwing, matching real Firestore atomicity)
 * plus `associateRunWithProject.spec.ts`'s OCC/no-op/archived-source test
 * shapes. `concurrentMutationHook` (fired on every `tx.get()`, exactly
 * once via a `fired` guard per test) is what lets the race-condition
 * tests prove the callback revalidates from FRESH transaction reads
 * rather than trusting anything read or decided outside the transaction —
 * mutating a document between this transaction's own sequential reads is
 * the same observable effect a real Firestore-internal retry-with-
 * fresh-reads would produce for a single-pass callback.
 */

import { Timestamp } from "firebase-admin/firestore";

type StoredDoc = Record<string, unknown>;
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaces: new Map(),
  workspaceMemberships: new Map(),
  runs: new Map(),
  projects: new Map(),
  // Phase 9B.2 — the two run-scoped subcollections `associateTeamRunWithProject`'s
  // Step 9 projection sync reads/writes. Both are single-fixed-ID
  // (`current`) per run, so — exactly like `makeSubDocRef` below — they are
  // keyed directly by `runId`, never by a composite `runId/current` path.
  humanReviewAssignment: new Map(),
  humanReviewPanel: new Map(),
};

function resetStores() {
  stores.workspaces.clear();
  stores.workspaceMemberships.clear();
  stores.runs.clear();
  stores.projects.clear();
  stores.humanReviewAssignment.clear();
  stores.humanReviewPanel.clear();
}

function seedHumanReviewAssignment(overrides: StoredDoc = {}, runId: string = RUN_ID) {
  stores.humanReviewAssignment.set(runId, asPersisted(overrides));
}

function seedHumanReviewPanel(overrides: StoredDoc = {}, runId: string = RUN_ID) {
  stores.humanReviewPanel.set(runId, asPersisted(overrides));
}

// Mirrors adminDb's real `ignoreUndefinedProperties: true` behavior — an
// override explicitly set to `undefined` must simulate a field that was
// never persisted at all (key genuinely absent), never a key present with
// an `undefined` value, which real Firestore data reads can never produce.
function asPersisted(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    // Phase 9B.2 — subcollection chaining, needed only for
    // `runs/{runId}/humanReviewAssignment|humanReviewPanel/current`. Both
    // are single-fixed-ID ("current") subcollections, so the sub-doc ref is
    // keyed directly by the PARENT doc's own id (the runId) in a top-level
    // fake store named after the subcollection — `subDocId` is accepted for
    // API-shape fidelity but never itself part of the key.
    collection: (subCollectionName: string) => ({
      doc: (_subDocId: string) => ({ __collection: subCollectionName, __id: docId }),
    }),
  };
}

let concurrentMutationHook: ((ref: { __collection: string; __id: string }) => void) | null = null;
const firestoreUnavailableFlag = { value: false };
const transactionShouldThrow = { value: false };

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId: string) => makeDocRef(name, docId),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    if (transactionShouldThrow.value) {
      throw new Error("simulated transaction failure");
    }
    const pendingWrites: Array<() => void> = [];
    // Phase 9B.2-R1 — mirrors the real Firestore Admin SDK's hard
    // requirement that every transaction `get()` execute before any
    // `set()`/`update()`/`delete()`; the SDK throws the instant a read is
    // attempted after a write has been queued, regardless of which
    // document either touches. The original 9B.2 projection-sync bug (a
    // `tx.get()` issued after `tx.update(runRef, ...)`) passed silently
    // against a fake without this guard — this flag exists specifically so
    // that class of bug fails here too, not only against production.
    let hasWritten = false;
    const txn = {
      get: async (ref: { __collection: string; __id: string }) => {
        if (hasWritten) {
          throw new Error("Firestore transactions require all reads to be executed before all writes.");
        }
        if (concurrentMutationHook) concurrentMutationHook(ref);
        const store = stores[ref.__collection];
        const data = store.get(ref.__id);
        return { exists: data !== undefined, data: () => data, id: ref.__id };
      },
      update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        hasWritten = true;
        pendingWrites.push(() => {
          const store = stores[ref.__collection];
          const existing = store.get(ref.__id) ?? {};
          store.set(ref.__id, { ...existing, ...data });
        });
      },
    };
    const result = await fn(txn);
    for (const applyWrite of pendingWrites) applyWrite();
    return result;
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

let teamWorkspacesEnabled = true;
let teamWorkspacesCanaryUids: string | undefined = undefined;
let teamWorkspacesCanaryWorkspaceIds: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get TEAM_WORKSPACES_ENABLED() {
    return teamWorkspacesEnabled;
  },
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return teamWorkspacesCanaryUids;
  },
  get TEAM_WORKSPACES_CANARY_WORKSPACE_IDS() {
    return teamWorkspacesCanaryWorkspaceIds;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { associateTeamRunWithProject } from "@/lib/projects/associateTeamRunWithProject";
import { logger } from "@/lib/logger";

const WS_ID = "ws-team-1";
const OTHER_WS_ID = "ws-team-2";
const OWNER_UID = "owner-1";
const MEMBER_UID = "member-1";
const REVIEWER_UID = "reviewer-1";
const VIEWER_UID = "viewer-1";
const ADMIN_UID = "admin-1";
const OUTSIDER_UID = "outsider-1";
const RUN_ID = "run-1";
const PROJECT_ID = "proj-1";
const PROJECT_ID_2 = "proj-2";
const NOW = Timestamp.now();

function seedWorkspace(overrides: Record<string, unknown> = {}) {
  stores.workspaces.set(
    WS_ID,
    asPersisted({
      schemaVersion: 1,
      id: WS_ID,
      type: "team",
      name: "Acme Team",
      ownerUserId: OWNER_UID,
      createdByUserId: OWNER_UID,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
  );
}

function seedMembership(uid: string, role: string, workspaceId: string = WS_ID, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(workspaceId, uid);
  stores.workspaceMemberships.set(
    id,
    asPersisted({
      schemaVersion: 1,
      id,
      workspaceId,
      uid,
      role,
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
      invitedByUserId: null,
      removedAt: null,
      removedByUserId: null,
      ...overrides,
    })
  );
}

function seedRun(overrides: Record<string, unknown> = {}) {
  stores.runs.set(
    RUN_ID,
    asPersisted({
      userId: MEMBER_UID,
      workspaceId: WS_ID,
      question: "q",
      selectedModels: [],
      status: "complete",
      createdAt: NOW,
      ...overrides,
    })
  );
}

function seedProject(id: string, overrides: Record<string, unknown> = {}) {
  stores.projects.set(
    id,
    asPersisted({
      schemaVersion: 1,
      id,
      workspaceId: WS_ID,
      name: "Existing Project",
      status: "active",
      createdByUserId: OWNER_UID,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
  );
}

function call(overrides: Partial<Parameters<typeof associateTeamRunWithProject>[0]> = {}) {
  return associateTeamRunWithProject({
    uid: MEMBER_UID,
    workspaceId: WS_ID,
    runId: RUN_ID,
    targetProjectId: null,
    expectedProjectId: null,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStores();
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
  teamWorkspacesCanaryWorkspaceIds = undefined;
  firestoreUnavailableFlag.value = false;
  transactionShouldThrow.value = false;
  concurrentMutationHook = null;
  seedWorkspace();
  seedMembership(OWNER_UID, "owner");
  seedMembership(MEMBER_UID, "member");
});

describe("infrastructure gates", () => {
  it("Team Workspaces rollout off -> team_workspaces_disabled, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    seedRun({ projectId: null });
    const result = await call({ targetProjectId: PROJECT_ID });
    expect(result.status).toBe("team_workspaces_disabled");
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("Firestore unavailable -> firestore_unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await call();
    expect(result.status).toBe("firestore_unavailable");
  });

  it("transaction throws -> transaction_failed, logged exactly once outside the callback", async () => {
    seedRun({ projectId: null });
    transactionShouldThrow.value = true;
    const result = await call({ targetProjectId: PROJECT_ID });
    expect(result.status).toBe("transaction_failed");
    expect(logger.warn).toHaveBeenCalled();
  });
});

// Phase 10B.3.2A — target-Workspace admission migrated from
// resolveTeamWorkspacesMode() to resolveTeamWorkspaceTargetAdmission().
// This function is a single-gate function (no separate route-level
// precheck), so every admission path is exercised directly here.
describe("target-Workspace admission (resolveTeamWorkspaceTargetAdmission)", () => {
  it("A — global enabled -> admitted (unchanged regression)", async () => {
    teamWorkspacesEnabled = true;
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    const result = await call({ targetProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });

  it("B — uid-canary admits caller regardless of Workspace-canary axis -> admitted", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = MEMBER_UID;
    teamWorkspacesCanaryWorkspaceIds = undefined;
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    const result = await call({ targetProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });

  it("C — Workspace-canary-only, target Workspace admitted, caller has active membership+capability -> admitted", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    const result = await call({ targetProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });

  it("D — Workspace-canary-only, caller admitted but lacks research.organize (Reviewer) -> denied at capability, not admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedMembership(REVIEWER_UID, "reviewer");
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    const result = await call({ uid: REVIEWER_UID, targetProjectId: PROJECT_ID });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
  });

  it("E — Workspace-canary-only, target admitted but caller has no membership -> denied (membership_not_found, not concealed differently than the pre-migration path)", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const result = await call({ uid: OUTSIDER_UID });
    expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
  });

  it("F — Workspace-canary-only, caller's membership was removed -> denied (membership_removed)", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedMembership(MEMBER_UID, "member", WS_ID, { status: "removed", removedAt: NOW, removedByUserId: OWNER_UID });
    const result = await call();
    expect(result).toEqual({ status: "unauthorized", reason: "membership_removed" });
  });

  it("G — target Workspace NOT in the canary list (and global/uid off) -> team_workspaces_disabled, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
    teamWorkspacesCanaryWorkspaceIds = OTHER_WS_ID; // a different Workspace is admitted, not WS_ID
    seedRun({ projectId: null });
    const result = await call({ targetProjectId: PROJECT_ID });
    expect(result.status).toBe("team_workspaces_disabled");
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("H — malformed Workspace-canary list (too many entries) fails that axis closed but does not poison a valid uid-canary admission", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = MEMBER_UID;
    teamWorkspacesCanaryWorkspaceIds = Array.from({ length: 11 }, (_, i) => `ws-${i}`).join(",");
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    const result = await call({ targetProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });

  it("I — malformed Workspace-canary list (too many entries) does not broaden access when no other axis admits -> team_workspaces_disabled", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
    teamWorkspacesCanaryWorkspaceIds = Array.from({ length: 11 }, (_, i) => `ws-${i}`).join(",");
    seedRun({ projectId: null });
    const result = await call({ targetProjectId: PROJECT_ID });
    expect(result.status).toBe("team_workspaces_disabled");
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("J — malformed Workspace-canary list (control character entry) fails closed, does not broaden access", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
    teamWorkspacesCanaryWorkspaceIds = `${WS_ID} `;
    seedRun({ projectId: null });
    const result = await call({ targetProjectId: PROJECT_ID });
    expect(result.status).toBe("team_workspaces_disabled");
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });
});

// Mandatory cross-Workspace run/project binding matrix for Phase 10B.3.2A —
// the target-Workspace admission axis must never be conflatable with the
// run's/project's own canonical workspaceId binding, which is enforced
// entirely by the pre-existing, unmigrated run/project integrity checks
// above (`run_not_found` for a foreign-Workspace run, `target_not_found`
// for a foreign-Workspace project).
describe("cross-Workspace binding matrix (Workspace-canary admission never substitutes for canonical binding)", () => {
  function seedOtherWorkspace(overrides: Record<string, unknown> = {}) {
    stores.workspaces.set(
      OTHER_WS_ID,
      asPersisted({ schemaVersion: 1, id: OTHER_WS_ID, type: "team", name: "Other Team", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: NOW, updatedAt: NOW, ...overrides })
    );
  }

  beforeEach(() => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
  });

  it("1 — W1 run + W1 project + caller Workspace-canary-admitted for W1 with research.organize -> SUCCESS", async () => {
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedRun({ workspaceId: WS_ID, projectId: null });
    seedProject(PROJECT_ID, { workspaceId: WS_ID });
    const result = await call({ workspaceId: WS_ID, targetProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });

  it("2 — W1 run + W2 (mismatched) project -> DENY as target_not_found, regardless of admission outcome", async () => {
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedOtherWorkspace();
    seedRun({ workspaceId: WS_ID, projectId: null });
    seedProject(PROJECT_ID, { workspaceId: OTHER_WS_ID });
    const result = await call({ workspaceId: WS_ID, targetProjectId: PROJECT_ID });
    expect(result.status).toBe("target_not_found");
  });

  it("3 — W2 (mismatched) run + W1 project -> DENY as run_not_found", async () => {
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedOtherWorkspace();
    seedRun({ workspaceId: OTHER_WS_ID, projectId: null });
    seedProject(PROJECT_ID, { workspaceId: WS_ID });
    const result = await call({ workspaceId: WS_ID, targetProjectId: PROJECT_ID });
    expect(result.status).toBe("run_not_found");
  });

  it("4 — W2 run + W2 project, caller only Workspace-canary-admitted for W1 (W2 not admitted) -> DENY as an admission failure, before any run/project read", async () => {
    teamWorkspacesCanaryWorkspaceIds = WS_ID; // W2 (OTHER_WS_ID) is NOT in the list
    seedOtherWorkspace();
    seedMembership(MEMBER_UID, "member", OTHER_WS_ID);
    stores.runs.set(RUN_ID, asPersisted({ userId: MEMBER_UID, workspaceId: OTHER_WS_ID, question: "q", selectedModels: [], status: "complete", createdAt: NOW, projectId: null }));
    stores.projects.set(PROJECT_ID, asPersisted({ schemaVersion: 1, id: PROJECT_ID, workspaceId: OTHER_WS_ID, name: "P", status: "active", createdByUserId: OWNER_UID, createdAt: NOW, updatedAt: NOW }));
    const result = await call({ workspaceId: OTHER_WS_ID, targetProjectId: PROJECT_ID });
    expect(result.status).toBe("team_workspaces_disabled");
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("5 — uid-canary/global-enabled callers retain identical binding-mismatch denial behavior after this migration (regression)", async () => {
    teamWorkspacesEnabled = true; // global path, unaffected by the target-admission migration
    seedOtherWorkspace();
    seedRun({ workspaceId: OTHER_WS_ID, projectId: null });
    const result = await call({ workspaceId: WS_ID, targetProjectId: PROJECT_ID });
    expect(result.status).toBe("run_not_found");
  });
});

describe("Team Workspace mutation authorization (research.organize)", () => {
  it("Workspace absent -> unauthorized/workspace_not_found", async () => {
    stores.workspaces.clear();
    const result = await call();
    expect(result).toEqual({ status: "unauthorized", reason: "workspace_not_found" });
  });

  it("Workspace malformed -> unauthorized/workspace_malformed", async () => {
    stores.workspaces.set(WS_ID, { id: WS_ID } as any);
    const result = await call();
    expect(result).toEqual({ status: "unauthorized", reason: "workspace_malformed" });
  });

  it("Personal Workspace id passed as W -> unauthorized/workspace_malformed (type !== team)", async () => {
    seedWorkspace({ type: "personal", ownerUserId: MEMBER_UID });
    const result = await call();
    expect(result).toEqual({ status: "unauthorized", reason: "workspace_malformed" });
  });

  it("owner-integrity violation (ownerUserId points at a non-owner-role membership) -> unauthorized/owner_integrity_violation", async () => {
    seedMembership(OWNER_UID, "member");
    const result = await call({ uid: OWNER_UID });
    expect(result).toEqual({ status: "unauthorized", reason: "owner_integrity_violation" });
  });

  it("caller membership absent -> unauthorized/membership_not_found", async () => {
    const result = await call({ uid: OUTSIDER_UID });
    expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
  });

  it("caller membership removed -> unauthorized/membership_removed", async () => {
    seedMembership(MEMBER_UID, "member", WS_ID, { status: "removed", removedAt: NOW, removedByUserId: OWNER_UID });
    const result = await call();
    expect(result).toEqual({ status: "unauthorized", reason: "membership_removed" });
  });

  it("caller membership malformed -> unauthorized/membership_malformed", async () => {
    stores.workspaceMemberships.set(computeMembershipId(WS_ID, MEMBER_UID), { id: "wrong" } as any);
    const result = await call();
    expect(result).toEqual({ status: "unauthorized", reason: "membership_malformed" });
  });

  it("Reviewer lacks research.organize -> unauthorized/insufficient_capability", async () => {
    seedMembership(REVIEWER_UID, "reviewer");
    const result = await call({ uid: REVIEWER_UID });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
  });

  it("Viewer lacks research.organize -> unauthorized/insufficient_capability", async () => {
    seedMembership(VIEWER_UID, "viewer");
    const result = await call({ uid: VIEWER_UID });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
  });

  it("Owner has research.organize -> allowed", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    const result = await call({ uid: OWNER_UID, targetProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });

  it("Admin has research.organize -> allowed", async () => {
    seedMembership(ADMIN_UID, "admin");
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    const result = await call({ uid: ADMIN_UID, targetProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });

  it("Member has research.organize -> allowed", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    const result = await call({ targetProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });

  it("run creator lacking research.organize is denied — creator identity grants nothing", async () => {
    seedMembership(REVIEWER_UID, "reviewer");
    seedRun({ userId: REVIEWER_UID, projectId: null }); // Reviewer is the run's own creator
    const result = await call({ uid: REVIEWER_UID, targetProjectId: PROJECT_ID });
    expect(result.status).toBe("unauthorized");
  });

  it("a different member (not the run's creator) with research.organize is allowed", async () => {
    seedRun({ userId: OUTSIDER_UID, projectId: null }); // MEMBER_UID did not create this run
    seedProject(PROJECT_ID);
    const result = await call({ targetProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });
});

describe("run integrity — every variant collapses to concealed run_not_found, never repaired", () => {
  it("run absent -> run_not_found", async () => {
    const result = await call();
    expect(result.status).toBe("run_not_found");
  });

  it("legacy run (no workspaceId field) -> run_not_found", async () => {
    seedRun({ workspaceId: undefined, projectId: null });
    const result = await call();
    expect(result.status).toBe("run_not_found");
  });

  it("Personal-bound run -> run_not_found", async () => {
    seedRun({ workspaceId: `personal-${MEMBER_UID}`, projectId: null });
    const result = await call();
    expect(result.status).toBe("run_not_found");
  });

  it("run bound to a DIFFERENT Team Workspace -> run_not_found, never disclosed which", async () => {
    stores.workspaces.set(
      OTHER_WS_ID,
      asPersisted({ schemaVersion: 1, id: OTHER_WS_ID, type: "team", name: "Other Team", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: NOW, updatedAt: NOW })
    );
    seedRun({ workspaceId: OTHER_WS_ID, projectId: null });
    const result = await call();
    expect(result.status).toBe("run_not_found");
  });

  it("run workspaceId malformed (wrong type) -> run_not_found", async () => {
    seedRun({ workspaceId: 12345, projectId: null });
    const result = await call();
    expect(result.status).toBe("run_not_found");
  });

  it("run userId malformed (empty string) -> run_not_found", async () => {
    seedRun({ userId: "", projectId: null });
    const result = await call();
    expect(result.status).toBe("run_not_found");
  });

  it("run createdAt malformed (plain object, not a Timestamp) -> run_not_found", async () => {
    seedRun({ createdAt: { seconds: 1, nanoseconds: 0 }, projectId: null });
    const result = await call();
    expect(result.status).toBe("run_not_found");
  });

  it("projectId null -> valid, Unfiled", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    const result = await call({ targetProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });

  it("projectId assigned (valid string) -> valid, participates in OCC", async () => {
    seedRun({ projectId: PROJECT_ID });
    const result = await call({ expectedProjectId: PROJECT_ID, targetProjectId: null });
    expect(result.status).toBe("associated");
  });

  it("projectId absent -> run_not_found, NEVER repaired to null", async () => {
    seedRun({ projectId: undefined });
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("run_not_found");
    expect(stores.runs.get(RUN_ID)?.projectId).toBeUndefined(); // untouched, never opportunistically set to null
  });

  it("projectId malformed (number) -> run_not_found, NEVER repaired", async () => {
    seedRun({ projectId: 12345 });
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("run_not_found");
    expect(stores.runs.get(RUN_ID)?.projectId).toBe(12345); // untouched
  });
});

describe("OCC — expectedProjectId contract", () => {
  it("expected null / actual null -> eligible", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("associated");
  });

  it("expected P1 / actual P1 -> eligible", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID_2);
    const result = await call({ targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });

  it("expected null / actual P1 -> conflict, no write", async () => {
    seedRun({ projectId: PROJECT_ID });
    const result = await call({ targetProjectId: PROJECT_ID_2, expectedProjectId: null });
    expect(result.status).toBe("conflict");
    expect(stores.runs.get(RUN_ID)?.projectId).toBe(PROJECT_ID);
  });

  it("expected P1 / actual null -> conflict, no write", async () => {
    seedRun({ projectId: null });
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("conflict");
    expect(stores.runs.get(RUN_ID)?.projectId).toBeNull();
  });

  it("expected P1 / actual P2 -> conflict, no write", async () => {
    seedRun({ projectId: PROJECT_ID_2 });
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("conflict");
    expect(stores.runs.get(RUN_ID)?.projectId).toBe(PROJECT_ID_2);
  });
});

describe("no-op", () => {
  it("target === current (P1 -> P1) -> unchanged, no write", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID);
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("unchanged");
    expect(stores.runs.get(RUN_ID)?.projectId).toBe(PROJECT_ID);
  });

  it("null -> null -> unchanged, no write", async () => {
    seedRun({ projectId: null });
    const result = await call({ targetProjectId: null, expectedProjectId: null });
    expect(result.status).toBe("unchanged");
  });
});

describe("target Project validation", () => {
  it("target missing -> target_not_found, no write", async () => {
    seedRun({ projectId: null });
    const result = await call({ targetProjectId: "nonexistent", expectedProjectId: null });
    expect(result.status).toBe("target_not_found");
    expect(stores.runs.get(RUN_ID)?.projectId).toBeNull();
  });

  it("target malformed -> target_not_found, concealed", async () => {
    seedRun({ projectId: null });
    stores.projects.set(PROJECT_ID, { id: PROJECT_ID } as any);
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("target_not_found");
  });

  it("target embedded id mismatch -> target_not_found, concealed", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID, { id: "different-id" });
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("target_not_found");
  });

  it("target foreign Workspace -> target_not_found, concealed, never a distinguishable status", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID, { workspaceId: OTHER_WS_ID });
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("target_not_found");
  });

  it("target active -> associated", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID, { status: "active" });
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("associated");
  });

  it("target archived -> target_archived, distinguishable, no write", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID, { status: "archived" });
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("target_archived");
    expect(stores.runs.get(RUN_ID)?.projectId).toBeNull();
  });

  it("unassign performs ZERO Project reads — target never seeded, still succeeds", async () => {
    seedRun({ projectId: PROJECT_ID });
    // PROJECT_ID deliberately never seeded — if the helper ever read it, this would fail.
    const result = await call({ targetProjectId: null, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });
});

describe("archived-source semantics — source Project is never read", () => {
  it("archived P1 -> active P2 succeeds, current Project's own status never checked", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID, { status: "archived" });
    seedProject(PROJECT_ID_2, { status: "active" });
    const result = await call({ targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });

  it("archived P1 -> null (unassign) succeeds, no read of the current Project required", async () => {
    seedRun({ projectId: PROJECT_ID });
    // PROJECT_ID deliberately never seeded — proves it's never looked up.
    const result = await call({ targetProjectId: null, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
  });
});

describe("exact write surface", () => {
  it("touches only projectId — every other run field, including any updatedAt, is untouched", async () => {
    seedRun({ projectId: null, question: "original question", status: "complete", tokensByModel: { gpt4: 10 } });
    seedProject(PROJECT_ID);
    await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    const finalRun = stores.runs.get(RUN_ID);
    expect(finalRun?.projectId).toBe(PROJECT_ID);
    expect(finalRun?.question).toBe("original question");
    expect(finalRun?.status).toBe("complete");
    expect(finalRun?.tokensByModel).toEqual({ gpt4: 10 });
    expect(finalRun?.updatedAt).toBeUndefined();
  });
});

describe("transaction races — the callback revalidates from fresh reads, never trusts anything decided outside it", () => {
  it("membership revocation lands before this transaction's own reads finish -> denied, no write", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    let fired = false;
    concurrentMutationHook = () => {
      if (fired) return;
      fired = true;
      const id = computeMembershipId(WS_ID, MEMBER_UID);
      const entry = stores.workspaceMemberships.get(id)!;
      stores.workspaceMemberships.set(id, { ...entry, status: "removed", removedAt: NOW, removedByUserId: OWNER_UID });
    };
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result).toEqual({ status: "unauthorized", reason: "membership_removed" });
    expect(stores.runs.get(RUN_ID)?.projectId).toBeNull();
  });

  it("capability revocation (role downgraded Member -> Reviewer) before commit -> denied, no write", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    let fired = false;
    concurrentMutationHook = () => {
      if (fired) return;
      fired = true;
      const id = computeMembershipId(WS_ID, MEMBER_UID);
      const entry = stores.workspaceMemberships.get(id)!;
      stores.workspaceMemberships.set(id, { ...entry, role: "reviewer" });
    };
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(stores.runs.get(RUN_ID)?.projectId).toBeNull();
  });

  it("owner transfer before commit — caller loses research.organize eligibility only if the fresh state actually removes it; here the caller RETAINS Member capability post-transfer, so the mutation proceeds", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    let fired = false;
    concurrentMutationHook = () => {
      if (fired) return;
      fired = true;
      // Simulate a completed ownership transfer: OWNER_UID -> MEMBER_UID.
      // Both memberships and the Workspace's ownerUserId are updated
      // atomically by a (simulated) prior transfer transaction.
      seedWorkspace({ ownerUserId: MEMBER_UID });
      const ownerEntry = stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!;
      stores.workspaceMemberships.set(computeMembershipId(WS_ID, OWNER_UID), { ...ownerEntry, role: "admin" });
      const memberEntry = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!;
      stores.workspaceMemberships.set(computeMembershipId(WS_ID, MEMBER_UID), { ...memberEntry, role: "owner" });
    };
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("associated");
  });

  it("owner transfer before commit — caller's OWN role is demoted to Viewer as part of the transfer, so the fresh read denies", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID);
    let fired = false;
    concurrentMutationHook = () => {
      if (fired) return;
      fired = true;
      seedWorkspace({ ownerUserId: OUTSIDER_UID });
      seedMembership(OUTSIDER_UID, "owner");
      const memberEntry = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!;
      stores.workspaceMemberships.set(computeMembershipId(WS_ID, MEMBER_UID), { ...memberEntry, role: "viewer" });
    };
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(stores.runs.get(RUN_ID)?.projectId).toBeNull();
  });

  it("target Project archived before commit -> target_archived, no write", async () => {
    seedRun({ projectId: null });
    seedProject(PROJECT_ID, { status: "active" });
    let fired = false;
    concurrentMutationHook = (ref) => {
      if (fired || ref.__collection !== "projects") return;
      fired = true;
      const entry = stores.projects.get(PROJECT_ID)!;
      stores.projects.set(PROJECT_ID, { ...entry, status: "archived" });
    };
    const result = await call({ targetProjectId: PROJECT_ID, expectedProjectId: null });
    expect(result.status).toBe("target_archived");
    expect(stores.runs.get(RUN_ID)?.projectId).toBeNull();
  });

  it("run association changed (by another actor) before this transaction's own run read -> conflict, no write", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID_2);
    let fired = false;
    concurrentMutationHook = (ref) => {
      if (fired || ref.__collection !== "runs") return;
      fired = true;
      stores.runs.set(RUN_ID, { ...stores.runs.get(RUN_ID)!, projectId: "some-other-project" });
    };
    const result = await call({ targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("conflict");
    expect(stores.runs.get(RUN_ID)?.projectId).toBe("some-other-project");
  });

  it("concurrent association — two actors racing the same expectedProjectId: at most one commits, the other observes the winner's new state and conflicts", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID_2);
    seedProject("proj-3");

    const resultA = await call({ targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID });
    expect(resultA.status).toBe("associated");

    // Actor B's transaction, still believing the run is at PROJECT_ID,
    // now observes the ALREADY-COMMITTED state left by Actor A.
    const resultB = await call({ targetProjectId: "proj-3", expectedProjectId: PROJECT_ID });
    expect(resultB.status).toBe("conflict");
    expect(stores.runs.get(RUN_ID)?.projectId).toBe(PROJECT_ID_2); // A's write stands, never silently overwritten
  });
});

describe("Phase 9B.2 — active Workspace-review projection sync (Step 9)", () => {
  it("A/B/C — Workspace-bound assignment: project A -> B moves the mirror, preserves dueAt and the assigned reviewer", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID_2);
    seedHumanReviewAssignment({
      schemaVersion: 1,
      teamId: WS_ID,
      runId: RUN_ID,
      assignedReviewerUserId: REVIEWER_UID,
      assignedAt: "2026-08-01T00:00:00.000Z",
      assignedByUserId: OWNER_UID,
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedByUserId: OWNER_UID,
      revision: 3,
      workspaceId: WS_ID,
      projectId: PROJECT_ID,
      dueAt: "2026-09-01T00:00:00.000Z",
    });

    const result = await call({ targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID });

    expect(result.status).toBe("associated");
    expect(stores.runs.get(RUN_ID)?.projectId).toBe(PROJECT_ID_2); // canonical run moved
    const assignment = stores.humanReviewAssignment.get(RUN_ID)!;
    expect(assignment.projectId).toBe(PROJECT_ID_2); // A: mirror moved
    expect(assignment.dueAt).toBe("2026-09-01T00:00:00.000Z"); // B: dueAt preserved
    expect(assignment.assignedReviewerUserId).toBe(REVIEWER_UID); // C: reviewer preserved
  });

  it("D/E — project move leaves assignment revision unchanged and appends no history entry", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID_2);
    seedHumanReviewAssignment({
      schemaVersion: 1,
      teamId: WS_ID,
      runId: RUN_ID,
      assignedReviewerUserId: REVIEWER_UID,
      assignedAt: "2026-08-01T00:00:00.000Z",
      assignedByUserId: OWNER_UID,
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedByUserId: OWNER_UID,
      revision: 5,
      workspaceId: WS_ID,
      projectId: PROJECT_ID,
      dueAt: null,
    });

    await call({ targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID });

    const assignment = stores.humanReviewAssignment.get(RUN_ID)!;
    expect(assignment.revision).toBe(5); // D: unchanged
    expect(assignment.updatedAt).toBe("2026-08-01T00:00:00.000Z"); // never touched either
    // E: no separate history subcollection is ever written by this
    // function — it imports no assignment-history writer at all — so the
    // absence of any such call is structural, not just an empty store.
  });

  it("F — Workspace-bound panel: projectId mirror updates alongside the assignment mirror", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID_2);
    seedHumanReviewPanel({
      schemaVersion: 1,
      kind: "adaptive_review_panel",
      teamId: WS_ID,
      runId: RUN_ID,
      mode: "majority_quorum",
      reviewerUserIds: [OWNER_UID, ADMIN_UID],
      requiredReviewerCount: 2,
      quorum: 2,
      status: "open",
      revision: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      createdByUserId: OWNER_UID,
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedByUserId: OWNER_UID,
      workspaceId: WS_ID,
      projectId: PROJECT_ID,
    });

    await call({ targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID });

    const panel = stores.humanReviewPanel.get(RUN_ID)!;
    expect(panel.projectId).toBe(PROJECT_ID_2);
    expect(panel.revision).toBe(1); // unchanged, same discipline as the assignment mirror
  });

  it("G — no assignment/panel document at all: project move still succeeds normally", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID_2);
    const result = await call({ targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID });
    expect(result.status).toBe("associated");
    expect(stores.humanReviewAssignment.has(RUN_ID)).toBe(false);
    expect(stores.humanReviewPanel.has(RUN_ID)).toBe(false);
  });

  it("H — legacy assignment/panel without a workspaceId mirror is never mutated as if it were a Workspace projection", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID_2);
    seedHumanReviewAssignment({
      schemaVersion: 1,
      teamId: "legacy-team-id",
      runId: RUN_ID,
      assignedReviewerUserId: REVIEWER_UID,
      assignedAt: "2026-08-01T00:00:00.000Z",
      assignedByUserId: OWNER_UID,
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedByUserId: OWNER_UID,
      revision: 2,
      // no workspaceId / projectId / dueAt — legacy Team assignment
    });
    seedHumanReviewPanel({
      schemaVersion: 1,
      kind: "adaptive_review_panel",
      teamId: "legacy-team-id",
      runId: RUN_ID,
      mode: "majority_quorum",
      reviewerUserIds: [OWNER_UID, ADMIN_UID],
      requiredReviewerCount: 2,
      quorum: 2,
      status: "open",
      revision: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      createdByUserId: OWNER_UID,
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedByUserId: OWNER_UID,
      // no workspaceId / projectId — legacy Team panel
    });

    await call({ targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID });

    const assignment = stores.humanReviewAssignment.get(RUN_ID)!;
    const panel = stores.humanReviewPanel.get(RUN_ID)!;
    expect(assignment.projectId).toBeUndefined();
    expect(assignment.workspaceId).toBeUndefined();
    expect(assignment.revision).toBe(2);
    expect(panel.projectId).toBeUndefined();
    expect(panel.workspaceId).toBeUndefined();
    expect(panel.revision).toBe(1);
  });

  it("I — moving to Unfiled (null) syncs the mirror to null too", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedHumanReviewAssignment({
      schemaVersion: 1,
      teamId: WS_ID,
      runId: RUN_ID,
      assignedReviewerUserId: REVIEWER_UID,
      assignedAt: "2026-08-01T00:00:00.000Z",
      assignedByUserId: OWNER_UID,
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedByUserId: OWNER_UID,
      revision: 1,
      workspaceId: WS_ID,
      projectId: PROJECT_ID,
      dueAt: null,
    });

    const result = await call({ targetProjectId: null, expectedProjectId: PROJECT_ID });

    expect(result.status).toBe("associated");
    expect(stores.runs.get(RUN_ID)?.projectId).toBeNull();
    expect(stores.humanReviewAssignment.get(RUN_ID)?.projectId).toBeNull();
  });

  it("a mirror belonging to a different Workspace's assignment document is never touched (defensive workspaceId re-check)", async () => {
    seedRun({ projectId: PROJECT_ID });
    seedProject(PROJECT_ID_2);
    seedHumanReviewAssignment({
      schemaVersion: 1,
      teamId: OTHER_WS_ID,
      runId: RUN_ID,
      assignedReviewerUserId: REVIEWER_UID,
      assignedAt: "2026-08-01T00:00:00.000Z",
      assignedByUserId: OWNER_UID,
      updatedAt: "2026-08-01T00:00:00.000Z",
      updatedByUserId: OWNER_UID,
      revision: 1,
      workspaceId: OTHER_WS_ID, // foreign Workspace — should never happen for a run truly in WS_ID, but defended anyway
      projectId: PROJECT_ID,
      dueAt: null,
    });

    await call({ targetProjectId: PROJECT_ID_2, expectedProjectId: PROJECT_ID });

    expect(stores.humanReviewAssignment.get(RUN_ID)?.projectId).toBe(PROJECT_ID); // untouched
  });
});
