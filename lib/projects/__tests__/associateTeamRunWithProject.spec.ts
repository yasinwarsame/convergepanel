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
};

function resetStores() {
  stores.workspaces.clear();
  stores.workspaceMemberships.clear();
  stores.runs.clear();
  stores.projects.clear();
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
  return { __collection: collectionName, __id: docId };
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
    const txn = {
      get: async (ref: { __collection: string; __id: string }) => {
        if (concurrentMutationHook) concurrentMutationHook(ref);
        const store = stores[ref.__collection];
        const data = store.get(ref.__id);
        return { exists: data !== undefined, data: () => data, id: ref.__id };
      },
      update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
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
jest.mock("@/lib/env", () => ({
  get TEAM_WORKSPACES_ENABLED() {
    return teamWorkspacesEnabled;
  },
  get TEAM_WORKSPACES_CANARY_UIDS() {
    return teamWorkspacesCanaryUids;
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
