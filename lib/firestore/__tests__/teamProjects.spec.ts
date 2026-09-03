/**
 * Team Project Backend, Phase 8C-A — `createTeamProject()` /
 * `updateTeamProjectFields()` tests. In-memory Firestore fake, structural
 * mirror of `workspaceMemberships.spec.ts`'s buffered-transaction fake
 * (writes are queued and applied only once the callback resolves without
 * throwing — matching real Firestore atomicity), extended with:
 *   - a `projects` collection alongside `workspaces`/`workspaceMemberships`
 *   - a `retriesBeforeSuccess` knob that makes `runTransaction()` re-invoke
 *     the SAME callback N times before letting it actually commit — this
 *     is what lets the Project-ID-stability test prove the id captured
 *     OUTSIDE the transaction survives a Firestore-internal retry
 *     unchanged (Section 5/Mutation S), a genuine functional assertion,
 *     not just code inspection.
 *   - `concurrentMutationHook`, reused identically for the revocation-race
 *     tests (Section 18/26/31).
 */

import { Timestamp } from "firebase-admin/firestore";

let autoIdCounter = 0;
let updateTimeCounter = 0;
function nextUpdateTime(): Timestamp {
  updateTimeCounter += 1;
  return new Timestamp(1_700_000_000 + updateTimeCounter, 0);
}

type StoredDoc = { data: Record<string, unknown>; updateTime: Timestamp };
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaces: new Map(),
  workspaceMemberships: new Map(),
  projects: new Map(),
  workspaceMembershipEvents: new Map(),
};

function resetStores() {
  stores.workspaces.clear();
  stores.workspaceMemberships.clear();
  stores.projects.clear();
  stores.workspaceMembershipEvents.clear();
}

/** Phase PROJECT-AUDIT-AR-I1 — when set, `tx.set()` on this collection throws (simulated transient failure of the Workspace Audit event write) so a test can prove the WHOLE transaction rolls back, lifecycle write included. */
let forceSetFailureForCollection: string | null = null;

/** When true, the NEXT non-transactional `.get()` call (i.e. the post-commit projection read — `projectRef.get()`, never `tx.get()`) throws instead of resolving, then resets itself. Simulates a transient Firestore read failure that happens strictly AFTER a transaction has already committed. */
let failNextPostCommitGet = false;

function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    id: docId,
    get: async () => {
      if (failNextPostCommitGet) {
        failNextPostCommitGet = false;
        throw new FirestoreError("14", "UNAVAILABLE: simulated post-commit read failure");
      }
      const store = stores[collectionName];
      const entry = store.get(docId);
      return { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime };
    },
  };
}

class FirestoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

let concurrentMutationHook: ((ref: { __collection: string; __id: string }) => void) | null = null;

/** Auto-id generator calls are tracked globally so a test can assert `.doc()` (no-arg) for the "projects" collection was called exactly once per `createTeamProject()` invocation, regardless of how many times the transaction callback internally re-runs. */
let projectsAutoIdCallCount = 0;

/** When > 0, `runTransaction()` invokes the callback this many times BEFORE the one whose result/writes are actually kept — simulating a Firestore-internal retry (e.g. a write-conflict on a document this transaction read). Each discarded invocation's writes are never applied to the store, exactly like a real retried Firestore transaction. */
let retriesBeforeSuccess = 0;

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId?: string) => {
      if (name === "projects" && docId === undefined) {
        projectsAutoIdCallCount += 1;
      }
      return makeDocRef(name, docId ?? `auto-${++autoIdCounter}`);
    },
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    let attemptsLeft = retriesBeforeSuccess;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pendingWrites: Array<() => void> = [];
      const txn = {
        get: async (ref: { __collection: string; __id: string }) => {
          const store = stores[ref.__collection];
          const entry = store.get(ref.__id);
          const snapshot = { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime };
          if (concurrentMutationHook) concurrentMutationHook(ref);
          return snapshot;
        },
        create: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
          const store = stores[ref.__collection];
          if (store.has(ref.__id)) {
            throw new FirestoreError("6", "ALREADY_EXISTS");
          }
          pendingWrites.push(() => store.set(ref.__id, { data, updateTime: nextUpdateTime() }));
        },
        update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>, precondition?: { lastUpdateTime?: Timestamp }) => {
          const store = stores[ref.__collection];
          const entry = store.get(ref.__id);
          if (!entry) {
            throw new FirestoreError("5", "NOT_FOUND");
          }
          if (precondition?.lastUpdateTime) {
            const expected = precondition.lastUpdateTime;
            if (entry.updateTime.seconds !== expected.seconds || entry.updateTime.nanoseconds !== expected.nanoseconds) {
              throw new FirestoreError("9", "FAILED_PRECONDITION: the document has changed");
            }
          }
          pendingWrites.push(() => store.set(ref.__id, { data: { ...entry.data, ...data }, updateTime: nextUpdateTime() }));
        },
        // Standard `tx.set()` semantics (unconditional overwrite, buffered
        // until commit) — used by the AR-I1 Workspace Audit event write on a
        // freshly-allocated auto-ID ref. Mirrors workspaceMemberships.spec.ts.
        set: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
          if (forceSetFailureForCollection === ref.__collection) {
            throw new FirestoreError("14", "UNAVAILABLE: simulated transient failure");
          }
          const store = stores[ref.__collection];
          pendingWrites.push(() => store.set(ref.__id, { data, updateTime: nextUpdateTime() }));
        },
      };

      const result = await fn(txn);

      if (attemptsLeft > 0) {
        // Simulated retry: this attempt's writes are DISCARDED (never
        // applied), exactly like a real Firestore transaction whose
        // commit lost a write-conflict race — only the final, kept
        // attempt's writes are ever applied to the store.
        attemptsLeft -= 1;
        continue;
      }

      for (const applyWrite of pendingWrites) applyWrite();
      return result;
    }
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

const firestoreUnavailableFlag = { value: false };

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
import { createTeamProject, updateTeamProjectFields } from "@/lib/firestore/teamProjects";

const WS_ID = "ws-team-1";
const OWNER_UID = "owner-1";
const MEMBER_UID = "member-1";
const REVIEWER_UID = "reviewer-1";
const OUTSIDER_UID = "outsider-1";

function ts(seconds: number): Timestamp {
  return new Timestamp(seconds, 0);
}

function seedWorkspace(overrides: Record<string, unknown> = {}) {
  const data = {
    schemaVersion: 1,
    id: WS_ID,
    type: "team",
    name: "Acme Team",
    ownerUserId: OWNER_UID,
    createdByUserId: OWNER_UID,
    createdAt: ts(1000),
    updatedAt: ts(1000),
    ...overrides,
  };
  stores.workspaces.set(WS_ID, { data, updateTime: nextUpdateTime() });
  return data;
}

function seedMembership(uid: string, role: string, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(WS_ID, uid);
  const data = {
    schemaVersion: 1,
    id,
    workspaceId: WS_ID,
    uid,
    role,
    status: "active",
    createdAt: ts(1000),
    updatedAt: ts(1000),
    invitedByUserId: null,
    removedAt: null,
    removedByUserId: null,
    ...overrides,
  };
  stores.workspaceMemberships.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

function seedProject(id: string, overrides: Record<string, unknown> = {}) {
  const data = {
    schemaVersion: 1,
    id,
    workspaceId: WS_ID,
    name: "Existing Project",
    status: "active",
    createdByUserId: OWNER_UID,
    createdAt: ts(1000),
    updatedAt: ts(1000),
    ...overrides,
  };
  stores.projects.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

beforeEach(() => {
  resetStores();
  concurrentMutationHook = null;
  forceSetFailureForCollection = null;
  retriesBeforeSuccess = 0;
  projectsAutoIdCallCount = 0;
  failNextPostCommitGet = false;
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
  teamWorkspacesCanaryWorkspaceIds = undefined;
  mockAdminDb.runTransaction.mockClear();
});

describe("createTeamProject", () => {
  it("creates a Project with server-derived createdByUserId, never a client-supplied one", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    const result = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "New Project" });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.project.createdByUserId).toBe(OWNER_UID);
    expect(result.project.workspaceId).toBe(WS_ID);
    expect(result.project.status).toBe("active");
    expect(result.documentUpdateTime).toBeInstanceOf(Timestamp);
  });

  it("Owner/Admin/Member can create; Reviewer/Viewer cannot", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    for (const role of ["admin", "member"]) {
      resetStores();
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedMembership(MEMBER_UID, role);
      const result = await createTeamProject({ uid: MEMBER_UID, workspaceId: WS_ID, name: "P" });
      expect(result.status).toBe("created");
    }
    for (const role of ["reviewer", "viewer"]) {
      resetStores();
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedMembership(REVIEWER_UID, role);
      const result = await createTeamProject({ uid: REVIEWER_UID, workspaceId: WS_ID, name: "P" });
      expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    }
  });

  it("denies with no Project written when caller has no membership", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    const result = await createTeamProject({ uid: OUTSIDER_UID, workspaceId: WS_ID, name: "P" });
    expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
    expect(stores.projects.size).toBe(0);
  });

  it("fails closed with team_workspaces_disabled and performs zero Firestore access when rollout is off", async () => {
    teamWorkspacesEnabled = false;
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    const result = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "P" });
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
    expect(stores.projects.size).toBe(0);
  });

  it("allocates the opaque Project id exactly once, and the SAME id survives a simulated Firestore-internal retry (Mutation S)", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    retriesBeforeSuccess = 2; // simulate two discarded attempts before the kept one
    const result = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "P" });
    expect(result.status).toBe("created");
    expect(projectsAutoIdCallCount).toBe(1);
    if (result.status !== "created") return;
    // Only one Project document should exist in the store — no
    // retry-generated duplicate under a different id.
    expect(stores.projects.size).toBe(1);
    expect(stores.projects.has(result.project.id)).toBe(true);
  });
});

describe("updateTeamProjectFields — rename", () => {
  it("renames when caller has projects.manage", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    const project = seedProject("proj-1");
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "Renamed" }, expectedUpdateTime: preUpdateTime });
    expect(result.status).toBe("updated");
    if (result.status !== "updated") return;
    expect(result.project.name).toBe("Renamed");
    expect(result.project.createdByUserId).toBe(project.createdByUserId); // immutable
  });

  it("rename has no status precondition — works on an archived Project too", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1", { status: "archived" });
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "Renamed" }, expectedUpdateTime: preUpdateTime });
    expect(result.status).toBe("updated");
  });

  it("a concurrent write to the Project document lands between this transaction's read and its commit — the fast-path check alone would miss it, but the AUTHORITATIVE tx.update() precondition catches it (Mutation L coverage)", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1");
    const callerToken = stores.projects.get("proj-1")!.updateTime; // what the caller believes is current

    // Fire once, on the SECOND tx.get() of this transaction (the Project
    // read) — mutates the LIVE store's updateTime immediately after this
    // transaction captured its own read snapshot, simulating a second
    // writer's commit landing in the gap. The fast-path comparison inside
    // updateTeamProjectFields() uses the transaction's OWN snapshot (still
    // the pre-mutation value), so it would pass — only the authoritative
    // precondition on tx.update(), checked against the store's CURRENT
    // state at commit time, can catch this.
    let getCount = 0;
    concurrentMutationHook = (ref) => {
      if (ref.__collection !== "projects") return;
      getCount += 1;
      if (getCount !== 1) return;
      const entry = stores.projects.get("proj-1")!;
      stores.projects.set("proj-1", { data: { ...entry.data, name: "Renamed By Someone Else" }, updateTime: nextUpdateTime() });
    };

    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "My Rename" }, expectedUpdateTime: callerToken });
    expect(result).toEqual({ status: "precondition_failed" });
    expect(stores.projects.get("proj-1")!.data.name).toBe("Renamed By Someone Else"); // the concurrent writer's change survives untouched
  });
});

describe("updateTeamProjectFields — archive/restore lifecycle", () => {
  it("archive succeeds from active", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1", { status: "active" });
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: preUpdateTime });
    expect(result.status).toBe("updated");
    if (result.status === "updated") expect(result.project.status).toBe("archived");
  });

  it("archive rejects an already-archived Project as invalid_transition, without writing", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1", { status: "archived" });
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: preUpdateTime });
    expect(result).toEqual({ status: "invalid_transition" });
    expect(stores.projects.get("proj-1")!.data.status).toBe("archived");
  });

  it("restore succeeds from archived", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1", { status: "archived" });
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "restore" }, expectedUpdateTime: preUpdateTime });
    expect(result.status).toBe("updated");
    if (result.status === "updated") expect(result.project.status).toBe("active");
  });

  it("restore rejects an already-active Project as invalid_transition", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1", { status: "active" });
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "restore" }, expectedUpdateTime: preUpdateTime });
    expect(result).toEqual({ status: "invalid_transition" });
  });
});

describe("updateTeamProjectFields — capability, integrity, OCC", () => {
  it("Reviewer/Viewer cannot manage (rename/archive/restore)", async () => {
    for (const role of ["reviewer", "viewer"]) {
      resetStores();
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedMembership(REVIEWER_UID, role);
      seedProject("proj-1");
      const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
      const result = await updateTeamProjectFields({ uid: REVIEWER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "X" }, expectedUpdateTime: preUpdateTime });
      expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    }
  });

  it("cross-Workspace concealment: a Project belonging to a DIFFERENT workspaceId is reported as project_not_found, never partially read or revealed", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1", { workspaceId: "some-other-workspace" });
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "X" }, expectedUpdateTime: preUpdateTime });
    expect(result).toEqual({ status: "project_not_found" });
    // Never mutated.
    expect(stores.projects.get("proj-1")!.data.name).toBe("Existing Project");
  });

  it("reports project_not_found for a genuinely missing Project id", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "does-not-exist", mutation: { kind: "rename", name: "X" }, expectedUpdateTime: ts(1) });
    expect(result).toEqual({ status: "project_not_found" });
  });

  it("stale expectedUpdateTime (fast-path) -> precondition_failed, no write", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1");
    const staleToken = ts(1); // does not match the real seeded updateTime
    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "X" }, expectedUpdateTime: staleToken });
    expect(result).toEqual({ status: "precondition_failed" });
    expect(stores.projects.get("proj-1")!.data.name).toBe("Existing Project");
  });

  it("fresh expectedUpdateTime succeeds and native updateTime (not updatedAt) is what the fast-path check uses", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1", { updatedAt: ts(9999) }); // app-level updatedAt deliberately divergent from the store's native updateTime
    const freshToken = stores.projects.get("proj-1")!.updateTime; // the REAL native updateTime, not updatedAt
    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "X" }, expectedUpdateTime: freshToken });
    expect(result.status).toBe("updated");
  });

  it("fails closed with team_workspaces_disabled and performs zero Firestore access when rollout is off", async () => {
    teamWorkspacesEnabled = false;
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1");
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "X" }, expectedUpdateTime: preUpdateTime });
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });
});

describe("revocation serialization (Section 18/26)", () => {
  it("Case A — resource mutation commits first; a later membership revocation does not retroactively undo it", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedMembership(MEMBER_UID, "member");
    const created = await createTeamProject({ uid: MEMBER_UID, workspaceId: WS_ID, name: "P" });
    expect(created.status).toBe("created");

    // Revoke AFTER the mutation already committed.
    const membershipId = computeMembershipId(WS_ID, MEMBER_UID);
    const entry = stores.workspaceMemberships.get(membershipId)!;
    stores.workspaceMemberships.set(membershipId, { data: { ...entry.data, status: "removed", removedAt: ts(5000), removedByUserId: OWNER_UID }, updateTime: nextUpdateTime() });

    expect(stores.projects.size).toBe(1); // still there — never retroactively undone
  });

  it("Case B — membership revocation commits BEFORE the resource transaction's own read; fresh authorization denies, no Project is created", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedMembership(MEMBER_UID, "member");

    // Force the revocation to land the FIRST time this transaction reads
    // ANY document (i.e. before the transaction's own membership read
    // resolves) — this is "revocation commits first" from the caller's
    // perspective inside a single-attempt transaction.
    let fired = false;
    concurrentMutationHook = () => {
      if (fired) return;
      fired = true;
      const membershipId = computeMembershipId(WS_ID, MEMBER_UID);
      const entry = stores.workspaceMemberships.get(membershipId)!;
      stores.workspaceMemberships.set(membershipId, { data: { ...entry.data, status: "removed", removedAt: ts(5000), removedByUserId: OWNER_UID }, updateTime: nextUpdateTime() });
    };

    const result = await createTeamProject({ uid: MEMBER_UID, workspaceId: WS_ID, name: "P" });
    expect(result).toEqual({ status: "unauthorized", reason: "membership_removed" });
    expect(stores.projects.size).toBe(0);
  });

  it("role-downgrade race — Member has projects.manage, is downgraded to Reviewer before the transaction reads membership; the retry sees Reviewer and denies", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedMembership(MEMBER_UID, "member");
    seedProject("proj-1");
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;

    let fired = false;
    concurrentMutationHook = () => {
      if (fired) return;
      fired = true;
      const membershipId = computeMembershipId(WS_ID, MEMBER_UID);
      const entry = stores.workspaceMemberships.get(membershipId)!;
      stores.workspaceMemberships.set(membershipId, { data: { ...entry.data, role: "reviewer" }, updateTime: nextUpdateTime() });
    };

    const result = await updateTeamProjectFields({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "Renamed" }, expectedUpdateTime: preUpdateTime });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    expect(stores.projects.get("proj-1")!.data.name).toBe("Existing Project"); // never renamed
  });
});

describe("transaction discipline (Section 30)", () => {
  it("authorization is derived from the SAME transaction as the write — an unauthorized attempt performs zero Project writes", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    const before = stores.projects.size;
    const result = await createTeamProject({ uid: OUTSIDER_UID, workspaceId: WS_ID, name: "P" });
    expect(result.status).toBe("unauthorized");
    expect(stores.projects.size).toBe(before);
  });

  it("owner-integrity failure causes zero Project mutation even when the caller's own role would otherwise suffice", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "member"); // corrupted: workspace.ownerUserId points at a non-owner-role membership
    seedMembership(MEMBER_UID, "member");
    const result = await createTeamProject({ uid: MEMBER_UID, workspaceId: WS_ID, name: "P" });
    expect(result).toEqual({ status: "unauthorized", reason: "owner_integrity_violation" });
    expect(stores.projects.size).toBe(0);
  });

  it("no application-level retry: a genuine transaction failure calls runTransaction() exactly once and reports create_failed, never re-attempting under a fresh id (Mutation R baseline)", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    mockAdminDb.runTransaction.mockImplementationOnce(async () => {
      throw new Error("simulated persistent Firestore failure");
    });
    const result = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "P" });
    expect(result).toEqual({ status: "create_failed" });
    expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1);
    expect(stores.projects.size).toBe(0);
  });
});

describe("Phase 8C-A.1 — direct creator-without-membership proof (Section 2)", () => {
  it("A creates Project P (createdByUserId = A); A's membership is then removed; A's subsequent mutation attempt is denied purely on current membership state — createdByUserId never grants access", async () => {
    const A = "creator-a";
    seedWorkspace({ ownerUserId: OWNER_UID, createdByUserId: OWNER_UID });
    seedMembership(OWNER_UID, "owner");
    seedMembership(A, "member");

    const created = await createTeamProject({ uid: A, workspaceId: WS_ID, name: "A's Project" });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    expect(created.project.createdByUserId).toBe(A);
    const projectId = created.project.id;

    // Remove A's membership entirely (not merely downgrade).
    const aMembershipId = computeMembershipId(WS_ID, A);
    stores.workspaceMemberships.delete(aMembershipId);

    const preUpdateTime = stores.projects.get(projectId)!.updateTime;
    const deniedResult = await updateTeamProjectFields({ uid: A, workspaceId: WS_ID, projectId, mutation: { kind: "rename", name: "A tries to rename own Project" }, expectedUpdateTime: preUpdateTime });
    expect(deniedResult).toEqual({ status: "unauthorized", reason: "membership_not_found" });
    expect(stores.projects.get(projectId)!.data.name).toBe("A's Project"); // untouched

    // Also prove creation-time capability check has the same property: A
    // (now with no membership at all) cannot create a SECOND Project either.
    const secondCreateAttempt = await createTeamProject({ uid: A, workspaceId: WS_ID, name: "A tries again" });
    expect(secondCreateAttempt).toEqual({ status: "unauthorized", reason: "membership_not_found" });
  });

  it("A creates Project P; A is REMOVED (status: removed, not merely missing); B (a current authorized Admin) can rename P; P.createdByUserId remains A throughout", async () => {
    const A = "creator-a";
    const B = "admin-b";
    seedWorkspace({ ownerUserId: OWNER_UID, createdByUserId: OWNER_UID });
    seedMembership(OWNER_UID, "owner");
    seedMembership(A, "member");
    seedMembership(B, "admin");

    const created = await createTeamProject({ uid: A, workspaceId: WS_ID, name: "A's Project" });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    const projectId = created.project.id;

    const aMembershipId = computeMembershipId(WS_ID, A);
    const aEntry = stores.workspaceMemberships.get(aMembershipId)!;
    stores.workspaceMemberships.set(aMembershipId, { data: { ...aEntry.data, status: "removed", removedAt: ts(9999), removedByUserId: OWNER_UID }, updateTime: nextUpdateTime() });

    // A, now removed, is denied.
    const preUpdateTimeForA = stores.projects.get(projectId)!.updateTime;
    const aAttempt = await updateTeamProjectFields({ uid: A, workspaceId: WS_ID, projectId, mutation: { kind: "rename", name: "A tries" }, expectedUpdateTime: preUpdateTimeForA });
    expect(aAttempt).toEqual({ status: "unauthorized", reason: "membership_removed" });

    // B, a current authorized non-creator Admin, CAN manage P per capability.
    const preUpdateTimeForB = stores.projects.get(projectId)!.updateTime;
    const bResult = await updateTeamProjectFields({ uid: B, workspaceId: WS_ID, projectId, mutation: { kind: "rename", name: "Renamed by B" }, expectedUpdateTime: preUpdateTimeForB });
    expect(bResult.status).toBe("updated");
    if (bResult.status !== "updated") return;
    expect(bResult.project.name).toBe("Renamed by B");
    expect(bResult.project.createdByUserId).toBe(A); // provenance preserved, never rewritten
  });
});

describe("Phase 8C-A.1 — post-commit projection read failure (Sections 4-9)", () => {
  it("createTeamProject: transaction commits, post-commit get() fails -> created_projection_unavailable, exactly ONE Project write, no second id generated, no automatic retry", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    failNextPostCommitGet = true;

    const result = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "P" });
    expect(result.status).toBe("created_projection_unavailable");
    if (result.status !== "created_projection_unavailable") return;
    expect(result.project.name).toBe("P");
    expect((result as any).documentUpdateTime).toBeUndefined();

    // Exactly one Project document exists — the canonical write committed,
    // and no application-level retry generated a duplicate under a second id.
    expect(stores.projects.size).toBe(1);
    expect(projectsAutoIdCallCount).toBe(1);
    expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1);
  });

  it("createTeamProject: a client that naively re-calls createTeamProject after created_projection_unavailable creates a SECOND, genuinely distinct Project — proving the server itself never does this automatically, only an external re-invocation would (and this phase intentionally builds no idempotency-key protection against that)", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    failNextPostCommitGet = true;
    const first = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "P" });
    expect(first.status).toBe("created_projection_unavailable");

    // The server made NO second attempt on its own — confirmed above
    // (runTransaction called once). A second explicit call, as an
    // uninformed client might issue, is a NEW request the server has no
    // way to distinguish from a genuine second create — this is the
    // documented, accepted duplicate-risk surface this phase does not
    // attempt to close (no idempotency-key infra exists in this repo).
    const second = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "P" });
    expect(second.status).toBe("created");
    expect(stores.projects.size).toBe(2);
  });

  it("updateTeamProjectFields (rename): transaction commits, post-commit get() fails -> updated_projection_unavailable; the rename is NOT rolled back, no fabricated updateTime, no automatic retry", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1");
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
    failNextPostCommitGet = true;

    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "Renamed" }, expectedUpdateTime: preUpdateTime });
    expect(result.status).toBe("updated_projection_unavailable");
    if (result.status !== "updated_projection_unavailable") return;
    expect(result.project.name).toBe("Renamed");
    expect((result as any).documentUpdateTime).toBeUndefined();

    // The store shows the rename genuinely committed — not rolled back.
    expect(stores.projects.get("proj-1")!.data.name).toBe("Renamed");
    expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1);
  });

  it("updateTeamProjectFields (archive): transaction commits, post-commit get() fails -> updated_projection_unavailable; archive is NOT rolled back", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1", { status: "active" });
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
    failNextPostCommitGet = true;

    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: preUpdateTime });
    expect(result.status).toBe("updated_projection_unavailable");
    expect(stores.projects.get("proj-1")!.data.status).toBe("archived");
  });

  it("updateTeamProjectFields (restore): transaction commits, post-commit get() fails -> updated_projection_unavailable; restore is NOT rolled back", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1", { status: "archived" });
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
    failNextPostCommitGet = true;

    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "restore" }, expectedUpdateTime: preUpdateTime });
    expect(result.status).toBe("updated_projection_unavailable");
    expect(stores.projects.get("proj-1")!.data.status).toBe("active");
  });

  it("a genuine PRE-commit transaction failure (not a post-commit read failure) still reports the ordinary *_failed status, never projection_unavailable — the two are never conflated", async () => {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    seedProject("proj-1");
    const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
    mockAdminDb.runTransaction.mockImplementationOnce(async () => {
      throw new Error("simulated pre-commit transaction failure");
    });
    const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "X" }, expectedUpdateTime: preUpdateTime });
    expect(result).toEqual({ status: "update_failed" });
    expect(stores.projects.get("proj-1")!.data.name).toBe("Existing Project"); // never applied
  });
});

describe("Phase 10B.3.2A — Workspace-canary target admission", () => {
  const WS_ID_2 = "ws-team-2";

  function seedSecondWorkspace(overrides: Record<string, unknown> = {}) {
    const data = {
      schemaVersion: 1,
      id: WS_ID_2,
      type: "team",
      name: "Second Team",
      ownerUserId: OWNER_UID,
      createdByUserId: OWNER_UID,
      createdAt: ts(1000),
      updatedAt: ts(1000),
      ...overrides,
    };
    stores.workspaces.set(WS_ID_2, { data, updateTime: nextUpdateTime() });
    return data;
  }

  function seedMembershipIn(workspaceId: string, uid: string, role: string, overrides: Record<string, unknown> = {}) {
    const id = computeMembershipId(workspaceId, uid);
    const data = {
      schemaVersion: 1,
      id,
      workspaceId,
      uid,
      role,
      status: "active",
      createdAt: ts(1000),
      updatedAt: ts(1000),
      invitedByUserId: null,
      removedAt: null,
      removedByUserId: null,
      ...overrides,
    };
    stores.workspaceMemberships.set(id, { data, updateTime: nextUpdateTime() });
    return data;
  }

  describe("createTeamProject", () => {
    it("global disabled, uid-canary admits caller -> created (source: uid_canary)", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryUids = OWNER_UID;
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      const result = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "P" });
      expect(result.status).toBe("created");
    });

    it("global disabled, uid-canary unset, target Workspace admitted via Workspace-canary, caller has active membership with projects.create -> created", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      const result = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "P" });
      expect(result.status).toBe("created");
    });

    it("Workspace-canary-only: caller has membership but lacks projects.create (Reviewer) -> denied at the CAPABILITY check, not admission", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedMembership(REVIEWER_UID, "reviewer");
      const result = await createTeamProject({ uid: REVIEWER_UID, workspaceId: WS_ID, name: "P" });
      expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    });

    it("Workspace-canary-only: target Workspace admitted but caller has no membership at all -> denied membership_not_found, zero Project writes", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      const result = await createTeamProject({ uid: OUTSIDER_UID, workspaceId: WS_ID, name: "P" });
      expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
      expect(stores.projects.size).toBe(0);
    });

    it("Workspace-canary-only: caller's membership is removed -> denied membership_removed", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedMembership(MEMBER_UID, "member", { status: "removed", removedAt: ts(2000), removedByUserId: OWNER_UID });
      const result = await createTeamProject({ uid: MEMBER_UID, workspaceId: WS_ID, name: "P" });
      expect(result).toEqual({ status: "unauthorized", reason: "membership_removed" });
      expect(stores.projects.size).toBe(0);
    });

    it("caller has an active membership in the target Workspace, but that Workspace is NOT in the canary list and global/uid are off -> team_workspaces_disabled, zero Firestore access", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID_2; // admits a DIFFERENT workspace only
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      const result = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "P" });
      expect(result).toEqual({ status: "team_workspaces_disabled" });
      expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
      expect(stores.projects.size).toBe(0);
    });

    it("malformed TEAM_WORKSPACES_CANARY_WORKSPACE_IDS fails that axis closed WITHOUT poisoning a valid uid-canary admission", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryUids = OWNER_UID;
      teamWorkspacesCanaryWorkspaceIds = "*"; // malformed
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      const result = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "P" });
      expect(result.status).toBe("created");
    });

    it("malformed TEAM_WORKSPACES_CANARY_WORKSPACE_IDS fails that axis closed WITHOUT poisoning global admission", async () => {
      teamWorkspacesEnabled = true;
      teamWorkspacesCanaryWorkspaceIds = "*"; // malformed
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      const result = await createTeamProject({ uid: OWNER_UID, workspaceId: WS_ID, name: "P" });
      expect(result.status).toBe("created");
    });
  });

  describe("updateTeamProjectFields", () => {
    it("global disabled, uid-canary admits caller -> updated (source: uid_canary)", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryUids = OWNER_UID;
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedProject("proj-1");
      const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "Renamed" }, expectedUpdateTime: preUpdateTime });
      expect(result.status).toBe("updated");
    });

    it("global disabled, uid-canary unset, target Workspace admitted via Workspace-canary, caller has projects.manage -> updated", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedProject("proj-1");
      const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "Renamed" }, expectedUpdateTime: preUpdateTime });
      expect(result.status).toBe("updated");
    });

    it("Workspace-canary-only: caller has membership but lacks projects.manage (Reviewer) -> denied at the CAPABILITY check, not admission", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedMembership(REVIEWER_UID, "reviewer");
      seedProject("proj-1");
      const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
      const result = await updateTeamProjectFields({ uid: REVIEWER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "X" }, expectedUpdateTime: preUpdateTime });
      expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    });

    it("Workspace-canary-only: target Workspace admitted but caller has no membership -> denied membership_not_found", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedProject("proj-1");
      const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
      const result = await updateTeamProjectFields({ uid: OUTSIDER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "X" }, expectedUpdateTime: preUpdateTime });
      expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
      expect(stores.projects.get("proj-1")!.data.name).toBe("Existing Project");
    });

    it("Workspace-canary-only: caller's membership is removed -> denied membership_removed", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedMembership(MEMBER_UID, "member", { status: "removed", removedAt: ts(2000), removedByUserId: OWNER_UID });
      seedProject("proj-1");
      const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
      const result = await updateTeamProjectFields({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "X" }, expectedUpdateTime: preUpdateTime });
      expect(result).toEqual({ status: "unauthorized", reason: "membership_removed" });
    });

    it("caller has an active membership in the target Workspace, but that Workspace is NOT in the canary list and global/uid are off -> team_workspaces_disabled, zero Firestore access", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID_2;
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedProject("proj-1");
      const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "X" }, expectedUpdateTime: preUpdateTime });
      expect(result).toEqual({ status: "team_workspaces_disabled" });
      expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
      expect(stores.projects.get("proj-1")!.data.name).toBe("Existing Project");
    });

    it("MANDATORY cross-Workspace test: caller is Workspace-canary-admitted for W1 with a valid active W1 membership carrying projects.manage; the targeted Project actually belongs to W2 -> denied project_not_found, never renamed. Admission to W1 must never let the function trust a caller-supplied workspaceId over the Project's own canonical field.", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID; // admits W1 (WS_ID) ONLY, not W2 (WS_ID_2)
      seedWorkspace(); // W1
      seedSecondWorkspace(); // W2
      seedMembership(OWNER_UID, "owner"); // active W1 membership, owner has projects.manage
      seedProject("proj-1", { workspaceId: WS_ID_2 }); // Project actually lives in W2
      const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "Hijacked" }, expectedUpdateTime: preUpdateTime });
      expect(result).toEqual({ status: "project_not_found" });
      expect(stores.projects.get("proj-1")!.data.name).toBe("Existing Project"); // never mutated
    });

    it("malformed TEAM_WORKSPACES_CANARY_WORKSPACE_IDS fails that axis closed WITHOUT poisoning a valid uid-canary admission", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryUids = OWNER_UID;
      teamWorkspacesCanaryWorkspaceIds = "*"; // malformed
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedProject("proj-1");
      const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "Renamed" }, expectedUpdateTime: preUpdateTime });
      expect(result.status).toBe("updated");
    });

    it("malformed TEAM_WORKSPACES_CANARY_WORKSPACE_IDS fails that axis closed WITHOUT poisoning global admission", async () => {
      teamWorkspacesEnabled = true;
      teamWorkspacesCanaryWorkspaceIds = "*"; // malformed
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedProject("proj-1");
      const preUpdateTime = stores.projects.get("proj-1")!.updateTime;
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "Renamed" }, expectedUpdateTime: preUpdateTime });
      expect(result.status).toBe("updated");
    });
  });
});

describe("updateTeamProjectFields — Workspace Audit atomicity, Phase PROJECT-AUDIT-AR-I1", () => {
  const PROJECT_NAME = "Quarterly Diligence";
  function events() {
    return [...stores.workspaceMembershipEvents.values()].map((e) => e.data);
  }
  function seedAll(status: "active" | "archived", actorRole = "owner", actorUid = OWNER_UID) {
    seedWorkspace();
    seedMembership(OWNER_UID, "owner");
    if (actorUid !== OWNER_UID) seedMembership(actorUid, actorRole);
    seedProject("proj-1", { status, name: PROJECT_NAME });
    return stores.projects.get("proj-1")!.updateTime;
  }

  describe("ARCHIVE SUCCESS", () => {
    it("one successful archive commits exactly one workspace_project_archived event, derived entirely from transaction-read state, with at === the Project's new updatedAt", async () => {
      const token = seedAll("active", "admin", MEMBER_UID);
      const before = stores.projects.get("proj-1")!.data;
      const result = await updateTeamProjectFields({ uid: MEMBER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: token });
      expect(result.status).toBe("updated");
      const after = stores.projects.get("proj-1")!.data;
      expect(after.status).toBe("archived");
      expect(after.updatedAt).not.toEqual(before.updatedAt);
      expect(events()).toHaveLength(1);
      const [event] = events();
      expect(event).toEqual({ eventType: "workspace_project_archived", actorUid: MEMBER_UID, workspaceId: WS_ID, projectId: "proj-1", projectName: PROJECT_NAME, at: after.updatedAt });
      expect(Object.keys(event).sort()).toEqual(["actorUid", "at", "eventType", "projectId", "projectName", "workspaceId"]);
      // Never member-shaped, never status-shaped, never a display name.
      for (const forbidden of ["targetUid", "previousRole", "newRole", "previousStatus", "newStatus", "displayName", "createdByUserId"]) expect(event).not.toHaveProperty(forbidden);
    });

    it("projectName is the TRANSACTION-READ snapshot — a name that differs from anything the caller could supply is what gets stored", async () => {
      const token = seedAll("active");
      stores.projects.get("proj-1")!.data.name = "Name As Stored In Firestore";
      await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: token });
      expect(events()[0].projectName).toBe("Name As Stored In Firestore");
    });

    it("event.workspaceId is the VALIDATED Project's workspaceId (which the writer has already proven equals the authorized Workspace) — a Project whose embedded workspaceId differs from the route is concealed and produces no event", async () => {
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedProject("proj-1", { workspaceId: "some-other-workspace", name: PROJECT_NAME });
      const token = stores.projects.get("proj-1")!.updateTime;
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: token });
      expect(result).toEqual({ status: "project_not_found" });
      expect(stores.projects.get("proj-1")!.data.status).toBe("active");
      expect(events()).toHaveLength(0);
    });

    it("event provenance (non-vacuity fixture for Mutation M2): the event's workspaceId equals the validated Project's own embedded workspaceId, proven with a fixture where Workspace id and Project id strings differ", async () => {
      const token = seedAll("active");
      await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: token });
      const [event] = events();
      expect(event.workspaceId).toBe(stores.projects.get("proj-1")!.data.workspaceId);
      expect(event.projectId).toBe(stores.projects.get("proj-1")!.data.id);
      expect(event.projectId).not.toBe(event.workspaceId);
    });
  });

  describe("RESTORE SUCCESS", () => {
    it("one successful restore commits exactly one workspace_project_restored event with the same provenance and at === updatedAt", async () => {
      const token = seedAll("archived");
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "restore" }, expectedUpdateTime: token });
      expect(result.status).toBe("updated");
      const after = stores.projects.get("proj-1")!.data;
      expect(after.status).toBe("active");
      expect(events()).toEqual([{ eventType: "workspace_project_restored", actorUid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", projectName: PROJECT_NAME, at: after.updatedAt }]);
    });
  });

  describe("NO EVENT WITHOUT A COMMITTED LIFECYCLE CHANGE", () => {
    it("unauthorized (Reviewer) archive/restore: no lifecycle write, no event", async () => {
      for (const kind of ["archive", "restore"] as const) {
        resetStores();
        const token = seedAll(kind === "archive" ? "active" : "archived", "reviewer", REVIEWER_UID);
        const result = await updateTeamProjectFields({ uid: REVIEWER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind }, expectedUpdateTime: token });
        expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
        expect(stores.projects.get("proj-1")!.data.status).toBe(kind === "archive" ? "active" : "archived");
        expect(events()).toHaveLength(0);
      }
    });

    it("non-member actor: concealed, no lifecycle write, no event", async () => {
      const token = seedAll("active");
      const result = await updateTeamProjectFields({ uid: OUTSIDER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: token });
      expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
      expect(events()).toHaveLength(0);
    });

    it("same-state: archive of an archived Project and restore of an active Project are rejected (invalid_transition) with no write and no event", async () => {
      let token = seedAll("archived");
      expect(await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: token })).toEqual({ status: "invalid_transition" });
      expect(events()).toHaveLength(0);
      resetStores();
      token = seedAll("active");
      expect(await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "restore" }, expectedUpdateTime: token })).toEqual({ status: "invalid_transition" });
      expect(events()).toHaveLength(0);
    });

    it("stale expectedUpdateTime: no lifecycle change, no event", async () => {
      seedAll("active");
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: ts(1) });
      expect(result).toEqual({ status: "precondition_failed" });
      expect(stores.projects.get("proj-1")!.data.status).toBe("active");
      expect(events()).toHaveLength(0);
    });

    it("missing Project: no event", async () => {
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      expect(await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "nope", mutation: { kind: "archive" }, expectedUpdateTime: ts(1) })).toEqual({ status: "project_not_found" });
      expect(events()).toHaveLength(0);
    });
  });

  describe("RENAME stays outside Workspace Audit", () => {
    it("a rename (active or archived Project) behaves exactly as before and creates NO Workspace Audit event of any type", async () => {
      for (const status of ["active", "archived"] as const) {
        resetStores();
        const token = seedAll(status);
        const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "rename", name: "Renamed" }, expectedUpdateTime: token });
        expect(result.status).toBe("updated");
        expect(stores.projects.get("proj-1")!.data.name).toBe("Renamed");
        expect(stores.projects.get("proj-1")!.data.status).toBe(status);
        expect(events()).toHaveLength(0);
      }
    });
  });

  describe("ATOMICITY — PROJECT LIFECYCLE CHANGE COMMITTED IFF WORKSPACE AUDIT EVENT COMMITTED", () => {
    it("A. event write failure -> the whole transaction fails: archive does NOT commit, status unchanged, no orphan event", async () => {
      const token = seedAll("active");
      forceSetFailureForCollection = "workspaceMembershipEvents";
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: token });
      expect(result).toEqual({ status: "update_failed" });
      expect(stores.projects.get("proj-1")!.data.status).toBe("active");
      expect(stores.projects.get("proj-1")!.updateTime).toEqual(token); // native updateTime untouched — nothing was applied
      expect(events()).toHaveLength(0);
    });

    it("A'. event write failure on restore -> same rollback", async () => {
      const token = seedAll("archived");
      forceSetFailureForCollection = "workspaceMembershipEvents";
      expect(await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "restore" }, expectedUpdateTime: token })).toEqual({ status: "update_failed" });
      expect(stores.projects.get("proj-1")!.data.status).toBe("archived");
      expect(events()).toHaveLength(0);
    });

    it("B. Firestore-internal retry: two discarded callback attempts leave NO event; the kept attempt commits exactly ONE event and exactly one lifecycle change", async () => {
      const token = seedAll("active");
      retriesBeforeSuccess = 2;
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: token });
      expect(result.status).toBe("updated");
      expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1);
      expect(stores.projects.get("proj-1")!.data.status).toBe("archived");
      expect(events()).toHaveLength(1);
      expect(events()[0].at).toEqual(stores.projects.get("proj-1")!.data.updatedAt);
    });

    it("C. between-read-and-commit conflict: a concurrent write lands after this transaction's Project read; the authoritative precondition rejects the lifecycle write and NO orphan event is left — committed state and committed audit history agree", async () => {
      const token = seedAll("active");
      let getCount = 0;
      concurrentMutationHook = (ref) => {
        if (ref.__collection !== "projects") return;
        getCount += 1;
        if (getCount !== 1) return;
        const entry = stores.projects.get("proj-1")!;
        stores.projects.set("proj-1", { data: { ...entry.data, name: "Renamed By Someone Else" }, updateTime: nextUpdateTime() });
      };
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: token });
      expect(result).toEqual({ status: "precondition_failed" });
      expect(stores.projects.get("proj-1")!.data.status).toBe("active");
      expect(events()).toHaveLength(0);
    });

    it("D. both directions: the lifecycle write and the event write are buffered in the SAME attempt — the event is only ever observable together with the committed status, never before it and never without it", async () => {
      const token = seedAll("active");
      // Observe the store from inside the callback (after both writes are
      // staged but before commit): neither the status nor the event is
      // visible yet — nothing leaks out of an uncommitted attempt.
      let observedMidTransaction: { status: unknown; eventCount: number } | null = null;
      const originalImpl = mockAdminDb.runTransaction.getMockImplementation();
      mockAdminDb.runTransaction.mockImplementationOnce(async (fn: (txn: any) => Promise<any>) => {
        return originalImpl(async (txn: any) => {
          const r = await fn(txn);
          observedMidTransaction = { status: stores.projects.get("proj-1")!.data.status, eventCount: stores.workspaceMembershipEvents.size };
          return r;
        });
      });
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: token });
      expect(result.status).toBe("updated");
      expect(observedMidTransaction).toEqual({ status: "active", eventCount: 0 });
      expect(stores.projects.get("proj-1")!.data.status).toBe("archived");
      expect(events()).toHaveLength(1);
    });

    it("the post-commit projection read failing does NOT affect the already-committed event (updated_projection_unavailable still has exactly one event)", async () => {
      const token = seedAll("active");
      failNextPostCommitGet = true;
      const result = await updateTeamProjectFields({ uid: OWNER_UID, workspaceId: WS_ID, projectId: "proj-1", mutation: { kind: "archive" }, expectedUpdateTime: token });
      expect(result.status).toBe("updated_projection_unavailable");
      expect(events()).toHaveLength(1);
    });
  });
});

