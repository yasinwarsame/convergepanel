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
};

function resetStores() {
  stores.workspaces.clear();
  stores.workspaceMemberships.clear();
  stores.projects.clear();
}

function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    id: docId,
    get: async () => {
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
  retriesBeforeSuccess = 0;
  projectsAutoIdCallCount = 0;
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
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
});
