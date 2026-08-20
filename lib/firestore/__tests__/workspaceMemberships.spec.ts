/**
 * Team Workspace Core Foundation, Phase 8B —
 * `getWorkspaceMembershipForBinding()` / `createTeamWorkspace()` /
 * `transferTeamWorkspaceOwnership()` tests. Custom in-memory Firestore
 * fake (not reused from `associateRunWithProject.spec.ts`'s) because this
 * suite needs genuine `updateTime` tracking and native-precondition
 * (`{lastUpdateTime}`) enforcement on `tx.update()` — the entire point
 * under test is the OCC contract, which a precondition-blind fake cannot
 * exercise.
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
};

function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    id: docId,
    // Non-transactional `.get()` — used by `getWorkspaceMembershipForBinding()`,
    // which reads a single document directly, never inside a transaction.
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

// Hook a test can set to simulate a concurrent writer mutating a document
// AFTER a transaction has already captured its read snapshot but BEFORE
// that same transaction's write/precondition check runs — exactly the
// race an OCC precondition exists to catch. Deliberately mutates the
// STORE directly (bypassing the transaction), never the snapshot the
// transaction already captured, so the transaction's own `tx.get()`
// result is untouched — only the store's live state moves on.
let concurrentMutationHook: ((ref: { __collection: string; __id: string }) => void) | null = null;

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId?: string) => makeDocRef(name, docId ?? `auto-${++autoIdCounter}`),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    // Real Firestore transactions buffer every write and apply them
    // atomically only once the callback resolves without throwing — a
    // write is never visible (to this store, or to any later call within
    // the SAME callback) until commit. `pendingWrites` reproduces that:
    // `create`/`update` validate immediately (ALREADY_EXISTS / precondition
    // checks read the CURRENT committed store, matching real Firestore's
    // read-your-own-writes-within-a-transaction-are-still-only-applied-
    // at-commit semantics closely enough for this suite's purposes) but
    // only QUEUE the actual mutation; nothing in `stores` changes until
    // every queued write is applied after the callback returns. If the
    // callback throws at any point — including on a LATER write in the
    // same transaction — every earlier-queued write in this attempt is
    // discarded, never applied. Without this buffering, a two-`tx.create()`
    // transaction where the second `create` throws would leave the first
    // write's effect visible in the mock, which would NOT prove atomicity
    // the way a real Firestore transaction does.
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
    for (const applyWrite of pendingWrites) applyWrite();
    return result;
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
import { getWorkspaceMembershipForBinding, createTeamWorkspace, transferTeamWorkspaceOwnership } from "@/lib/firestore/workspaceMemberships";

const OWNER_UID = "owner-1";
const OTHER_UID = "member-1";
const WS_ID = "ws-team-1";

function seedTeamWorkspace(overrides: Record<string, unknown> = {}) {
  const data = {
    schemaVersion: 1,
    id: WS_ID,
    type: "team",
    name: "Team Workspace",
    ownerUserId: OWNER_UID,
    createdByUserId: OWNER_UID,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...overrides,
  };
  const updateTime = nextUpdateTime();
  stores.workspaces.set(WS_ID, { data, updateTime });
  return updateTime;
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
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    invitedByUserId: null,
    removedAt: null,
    removedByUserId: null,
    ...overrides,
  };
  const updateTime = nextUpdateTime();
  stores.workspaceMemberships.set(id, { data, updateTime });
  return updateTime;
}

beforeEach(() => {
  jest.clearAllMocks();
  stores.workspaces.clear();
  stores.workspaceMemberships.clear();
  concurrentMutationHook = null;
  firestoreUnavailableFlag.value = false;
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
});

describe("getWorkspaceMembershipForBinding", () => {
  it("finds a well-formed, correctly-bound membership", async () => {
    seedMembership(OWNER_UID, "owner");
    const result = await getWorkspaceMembershipForBinding({ workspaceId: WS_ID, uid: OWNER_UID });
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.membership.uid).toBe(OWNER_UID);
      expect(result.membership.workspaceId).toBe(WS_ID);
    }
  });

  it("reports not_found when no document exists at the deterministic id", async () => {
    const result = await getWorkspaceMembershipForBinding({ workspaceId: WS_ID, uid: OWNER_UID });
    expect(result.status).toBe("not_found");
  });

  it("rejects (malformed) a document whose embedded workspaceId disagrees with the expected workspaceId, even at the correct doc id", async () => {
    const id = computeMembershipId(WS_ID, OWNER_UID);
    stores.workspaceMemberships.set(id, {
      data: { schemaVersion: 1, id, workspaceId: "some-other-workspace", uid: OWNER_UID, role: "owner", status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), invitedByUserId: null, removedAt: null, removedByUserId: null },
      updateTime: nextUpdateTime(),
    });
    const result = await getWorkspaceMembershipForBinding({ workspaceId: WS_ID, uid: OWNER_UID });
    expect(result.status).toBe("malformed");
  });

  it("rejects (malformed) a document whose embedded uid disagrees with the expected uid", async () => {
    const id = computeMembershipId(WS_ID, OWNER_UID);
    stores.workspaceMemberships.set(id, {
      data: { schemaVersion: 1, id, workspaceId: WS_ID, uid: "someone-else", role: "owner", status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), invitedByUserId: null, removedAt: null, removedByUserId: null },
      updateTime: nextUpdateTime(),
    });
    const result = await getWorkspaceMembershipForBinding({ workspaceId: WS_ID, uid: OWNER_UID });
    expect(result.status).toBe("malformed");
  });

  it("rejects (malformed) a document whose own id doesn't match computeMembershipId(workspaceId, uid)", async () => {
    const id = computeMembershipId(WS_ID, OWNER_UID);
    stores.workspaceMemberships.set(id, {
      data: { schemaVersion: 1, id: "wm_" + "0".repeat(64), workspaceId: WS_ID, uid: OWNER_UID, role: "owner", status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), invitedByUserId: null, removedAt: null, removedByUserId: null },
      updateTime: nextUpdateTime(),
    });
    const result = await getWorkspaceMembershipForBinding({ workspaceId: WS_ID, uid: OWNER_UID });
    expect(result.status).toBe("malformed");
  });

  it("reports firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await getWorkspaceMembershipForBinding({ workspaceId: WS_ID, uid: OWNER_UID });
    expect(result.status).toBe("firestore_unavailable");
  });
});

describe("createTeamWorkspace", () => {
  it("creates the Workspace and founder membership atomically", async () => {
    const result = await createTeamWorkspace({ uid: OWNER_UID, name: "Acme Team" });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.workspace.type).toBe("team");
    expect(result.workspace.ownerUserId).toBe(OWNER_UID);
    expect(result.workspace.createdByUserId).toBe(OWNER_UID);
    expect(result.membership.role).toBe("owner");
    expect(result.membership.status).toBe("active");
    expect(result.membership.invitedByUserId).toBeNull();
    expect(result.membership.workspaceId).toBe(result.workspace.id);
    expect(result.membership.uid).toBe(OWNER_UID);
    expect(result.membership.id).toBe(computeMembershipId(result.workspace.id, OWNER_UID));

    // Both documents genuinely persisted.
    expect(stores.workspaces.get(result.workspace.id)).toBeDefined();
    expect(stores.workspaceMemberships.get(result.membership.id)).toBeDefined();
  });

  it("never accepts a caller-supplied ownerUserId/createdByUserId — both are always the authenticated uid", async () => {
    const result = await createTeamWorkspace({ uid: OWNER_UID, name: "Acme" });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.workspace.ownerUserId).toBe(OWNER_UID);
    expect(result.workspace.createdByUserId).toBe(OWNER_UID);
  });

  it("leaves no partial state when the transaction throws", async () => {
    mockAdminDb.runTransaction.mockImplementationOnce(async () => {
      throw new Error("simulated failure");
    });
    const result = await createTeamWorkspace({ uid: OWNER_UID, name: "Acme" });
    expect(result.status).toBe("create_failed");
    expect(stores.workspaces.size).toBe(0);
    expect(stores.workspaceMemberships.size).toBe(0);
  });

  it("is genuinely atomic: if the SECOND write (founder membership) fails inside the transaction, the FIRST write (Workspace) never commits either — proves this is one transaction, not two independent writes", async () => {
    // Predict the next auto-generated workspace id (the mock's doc()
    // counter is deterministic) and pre-seed a colliding document at the
    // membership id that workspace would produce for OWNER_UID, forcing
    // tx.create(membershipRef, ...) to throw ALREADY_EXISTS mid-transaction.
    const predictedWorkspaceId = `auto-${autoIdCounter + 1}`;
    const collidingMembershipId = computeMembershipId(predictedWorkspaceId, OWNER_UID);
    stores.workspaceMemberships.set(collidingMembershipId, {
      data: { schemaVersion: 1, id: collidingMembershipId, workspaceId: "some-other-ws", uid: "someone-else", role: "member", status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), invitedByUserId: null, removedAt: null, removedByUserId: null },
      updateTime: nextUpdateTime(),
    });

    const result = await createTeamWorkspace({ uid: OWNER_UID, name: "Acme" });

    expect(result.status).toBe("create_failed");
    // The Workspace document must NOT exist — a non-atomic (two-transaction)
    // implementation would have already committed it before the second
    // transaction (membership) failed.
    expect(stores.workspaces.get(predictedWorkspaceId)).toBeUndefined();
    expect(stores.workspaces.size).toBe(0);
  });

  it("never falsifies founder invitedByUserId to the owner's own uid merely to avoid null — the founder was not invited", async () => {
    const result = await createTeamWorkspace({ uid: OWNER_UID, name: "Acme" });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.membership.invitedByUserId).toBeNull();
    expect(result.membership.invitedByUserId).not.toBe(OWNER_UID);
  });

  it("never persists a second updateTime field on the membership document — OCC is the native DocumentSnapshot.updateTime, not a stored domain field", async () => {
    const result = await createTeamWorkspace({ uid: OWNER_UID, name: "Acme" });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(Object.prototype.hasOwnProperty.call(result.membership, "updateTime")).toBe(false);
    const persisted = stores.workspaceMemberships.get(result.membership.id)!.data;
    expect(Object.prototype.hasOwnProperty.call(persisted, "updateTime")).toBe(false);
    expect(Object.keys(persisted).sort()).toEqual(
      ["schemaVersion", "id", "workspaceId", "uid", "role", "status", "createdAt", "updatedAt", "invitedByUserId", "removedAt", "removedByUserId"].sort()
    );
  });

  describe("rollout gate", () => {
    it("reports team_workspaces_disabled and performs no Firestore access when globally off and uid is not in the canary", async () => {
      teamWorkspacesEnabled = false;
      const result = await createTeamWorkspace({ uid: OWNER_UID, name: "Acme" });
      expect(result.status).toBe("team_workspaces_disabled");
      expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
    });

    it("succeeds for a uid in a valid canary list even when the global flag is off", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryUids = OWNER_UID;
      const result = await createTeamWorkspace({ uid: OWNER_UID, name: "Acme" });
      expect(result.status).toBe("created");
    });

    it("fails closed to disabled for a uid NOT in the canary list, even though the list is otherwise valid", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryUids = "some-other-uid";
      const result = await createTeamWorkspace({ uid: OWNER_UID, name: "Acme" });
      expect(result.status).toBe("team_workspaces_disabled");
    });
  });
});

describe("transferTeamWorkspaceOwnership", () => {
  function seedHappyPath() {
    const workspaceUpdateTime = seedTeamWorkspace();
    const oldOwnerUpdateTime = seedMembership(OWNER_UID, "owner");
    const newOwnerUpdateTime = seedMembership(OTHER_UID, "member");
    return { workspaceUpdateTime, oldOwnerUpdateTime, newOwnerUpdateTime };
  }

  it("transfers ownership: old Owner -> Admin, new Owner -> Owner, createdByUserId unchanged", async () => {
    const tokens = seedHappyPath();
    const result = await transferTeamWorkspaceOwnership({
      workspaceId: WS_ID,
      callerUid: OWNER_UID,
      newOwnerUid: OTHER_UID,
      expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime,
      expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
      expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
    });
    expect(result.status).toBe("transferred");
    if (result.status !== "transferred") return;
    expect(result.workspace.ownerUserId).toBe(OTHER_UID);
    expect(result.workspace.createdByUserId).toBe(OWNER_UID); // unchanged
    expect(result.oldOwnerMembership.role).toBe("admin");
    expect(result.oldOwnerMembership.status).toBe("active");
    expect(result.newOwnerMembership.role).toBe("owner");

    // Persisted state agrees.
    const persistedWorkspace = stores.workspaces.get(WS_ID)!.data;
    expect(persistedWorkspace.ownerUserId).toBe(OTHER_UID);
    expect(persistedWorkspace.createdByUserId).toBe(OWNER_UID);
    const persistedOld = stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!.data;
    expect(persistedOld.role).toBe("admin");
    const persistedNew = stores.workspaceMemberships.get(computeMembershipId(WS_ID, OTHER_UID))!.data;
    expect(persistedNew.role).toBe("owner");
  });

  it("rejects self-transfer", async () => {
    const tokens = seedHappyPath();
    const result = await transferTeamWorkspaceOwnership({
      workspaceId: WS_ID,
      callerUid: OWNER_UID,
      newOwnerUid: OWNER_UID,
      expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime,
      expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
      expectedNewOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
    });
    expect(result.status).toBe("self_transfer_rejected");
    expect(stores.workspaces.get(WS_ID)!.data.ownerUserId).toBe(OWNER_UID); // untouched
  });

  it("rejects a removed new-Owner membership", async () => {
    const workspaceUpdateTime = seedTeamWorkspace();
    const oldOwnerUpdateTime = seedMembership(OWNER_UID, "owner");
    const newOwnerUpdateTime = seedMembership(OTHER_UID, "member", { status: "removed", removedAt: Timestamp.now(), removedByUserId: OWNER_UID });
    const result = await transferTeamWorkspaceOwnership({
      workspaceId: WS_ID,
      callerUid: OWNER_UID,
      newOwnerUid: OTHER_UID,
      expectedWorkspaceUpdateTime: workspaceUpdateTime,
      expectedOldOwnerMembershipUpdateTime: oldOwnerUpdateTime,
      expectedNewOwnerMembershipUpdateTime: newOwnerUpdateTime,
    });
    expect(result.status).toBe("new_owner_not_eligible");
    expect(stores.workspaces.get(WS_ID)!.data.ownerUserId).toBe(OWNER_UID);
  });

  it("rejects a new-Owner membership belonging to a different Workspace (cross-workspace)", async () => {
    const workspaceUpdateTime = seedTeamWorkspace();
    const oldOwnerUpdateTime = seedMembership(OWNER_UID, "owner");
    // Seed a membership at what WOULD be OTHER_UID's id for a DIFFERENT
    // workspace, then attempt to transfer into WS_ID — no document exists
    // at computeMembershipId(WS_ID, OTHER_UID), so this exercises the
    // "not found" path for a genuinely foreign uid.
    const foreignId = computeMembershipId("some-other-ws", OTHER_UID);
    stores.workspaceMemberships.set(foreignId, {
      data: { schemaVersion: 1, id: foreignId, workspaceId: "some-other-ws", uid: OTHER_UID, role: "member", status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), invitedByUserId: null, removedAt: null, removedByUserId: null },
      updateTime: nextUpdateTime(),
    });
    const result = await transferTeamWorkspaceOwnership({
      workspaceId: WS_ID,
      callerUid: OWNER_UID,
      newOwnerUid: OTHER_UID,
      expectedWorkspaceUpdateTime: workspaceUpdateTime,
      expectedOldOwnerMembershipUpdateTime: oldOwnerUpdateTime,
      expectedNewOwnerMembershipUpdateTime: nextUpdateTime(),
    });
    expect(result.status).toBe("new_owner_membership_not_found");
  });

  it("rejects a malformed new-Owner membership document (embedded workspaceId mismatch at the correct doc id)", async () => {
    const workspaceUpdateTime = seedTeamWorkspace();
    const oldOwnerUpdateTime = seedMembership(OWNER_UID, "owner");
    const id = computeMembershipId(WS_ID, OTHER_UID);
    stores.workspaceMemberships.set(id, {
      data: { schemaVersion: 1, id, workspaceId: "wrong-ws", uid: OTHER_UID, role: "member", status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), invitedByUserId: null, removedAt: null, removedByUserId: null },
      updateTime: nextUpdateTime(),
    });
    const result = await transferTeamWorkspaceOwnership({
      workspaceId: WS_ID,
      callerUid: OWNER_UID,
      newOwnerUid: OTHER_UID,
      expectedWorkspaceUpdateTime: workspaceUpdateTime,
      expectedOldOwnerMembershipUpdateTime: oldOwnerUpdateTime,
      expectedNewOwnerMembershipUpdateTime: stores.workspaceMemberships.get(id)!.updateTime,
    });
    expect(result.status).toBe("new_owner_not_eligible");
    expect(stores.workspaces.get(WS_ID)!.data.ownerUserId).toBe(OWNER_UID);
  });

  it("rejects when the caller is not the canonical current Owner (wrong role)", async () => {
    const workspaceUpdateTime = seedTeamWorkspace();
    const callerUpdateTime = seedMembership(OTHER_UID, "admin");
    const targetUpdateTime = seedMembership("member-2", "member");
    const result = await transferTeamWorkspaceOwnership({
      workspaceId: WS_ID,
      callerUid: OTHER_UID,
      newOwnerUid: "member-2",
      expectedWorkspaceUpdateTime: workspaceUpdateTime,
      expectedOldOwnerMembershipUpdateTime: callerUpdateTime,
      expectedNewOwnerMembershipUpdateTime: targetUpdateTime,
    });
    expect(result.status).toBe("caller_not_owner");
    expect(stores.workspaces.get(WS_ID)!.data.ownerUserId).toBe(OWNER_UID);
  });

  it("rejects when the caller has an owner-role membership row but workspace.ownerUserId disagrees (integrity violation)", async () => {
    const workspaceUpdateTime = seedTeamWorkspace({ ownerUserId: "totally-different-uid" });
    const callerUpdateTime = seedMembership(OWNER_UID, "owner");
    const targetUpdateTime = seedMembership(OTHER_UID, "member");
    const result = await transferTeamWorkspaceOwnership({
      workspaceId: WS_ID,
      callerUid: OWNER_UID,
      newOwnerUid: OTHER_UID,
      expectedWorkspaceUpdateTime: workspaceUpdateTime,
      expectedOldOwnerMembershipUpdateTime: callerUpdateTime,
      expectedNewOwnerMembershipUpdateTime: targetUpdateTime,
    });
    expect(result.status).toBe("caller_not_owner");
  });

  describe("OCC — caller-supplied expected update-time tokens", () => {
    it("succeeds when all three tokens are current", async () => {
      const tokens = seedHappyPath();
      const result = await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime,
        expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
        expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
      });
      expect(result.status).toBe("transferred");
    });

    it("fails, with NO writes, on a stale Workspace token", async () => {
      const tokens = seedHappyPath();
      const staleWorkspaceToken = new Timestamp(1, 0); // definitely not current
      const result = await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: staleWorkspaceToken,
        expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
        expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
      });
      expect(result.status).toBe("workspace_stale");
      expect(stores.workspaces.get(WS_ID)!.data.ownerUserId).toBe(OWNER_UID);
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!.data.role).toBe("owner");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, OTHER_UID))!.data.role).toBe("member");
    });

    it("fails, with NO writes, on a stale old-Owner-membership token", async () => {
      const tokens = seedHappyPath();
      const staleToken = new Timestamp(1, 0);
      const result = await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime,
        expectedOldOwnerMembershipUpdateTime: staleToken,
        expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
      });
      expect(result.status).toBe("old_owner_membership_stale");
      expect(stores.workspaces.get(WS_ID)!.data.ownerUserId).toBe(OWNER_UID);
    });

    it("fails, with NO writes, on a stale new-Owner-membership token", async () => {
      const tokens = seedHappyPath();
      const staleToken = new Timestamp(1, 0);
      const result = await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime,
        expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
        expectedNewOwnerMembershipUpdateTime: staleToken,
      });
      expect(result.status).toBe("new_owner_membership_stale");
      expect(stores.workspaces.get(WS_ID)!.data.ownerUserId).toBe(OWNER_UID);
    });

    it("uses the CALLER-SUPPLIED token as the authoritative precondition, not a freshly-read snapshot value — a concurrent mutation landing between this transaction's read and its write still fails the transfer", async () => {
      const tokens = seedHappyPath();

      // Simulate a concurrent writer that commits a workspace update
      // AFTER this transaction's own tx.get(workspaceRef) already
      // captured its snapshot (so the transaction's in-memory
      // `workspaceSnap.updateTime` still equals the caller's original,
      // now-stale token — the fast-path comparison would pass) but
      // BEFORE this transaction's own tx.update() runs. The concurrent
      // mutation is applied directly to the store, not through the
      // transaction under test.
      let mutated = false;
      concurrentMutationHook = (ref) => {
        if (ref.__collection === "workspaces" && ref.__id === WS_ID && !mutated) {
          mutated = true;
          const entry = stores.workspaces.get(WS_ID)!;
          stores.workspaces.set(WS_ID, { data: { ...entry.data, name: "Renamed by a concurrent writer" }, updateTime: nextUpdateTime() });
        }
      };

      const result = await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime, // the now-stale original token
        expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
        expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
      });

      // The transaction's own read-time comparison used the snapshot it
      // captured (still equal to the caller's token), but the
      // AUTHORITATIVE native precondition on tx.update() is checked
      // against the store's live state, which has since moved on —
      // proving this implementation does not merely compare
      // "snapshot.updateTime === expected" and stop there; it also
      // relies on Firestore's real precondition semantics as the final
      // backstop. Ownership must NOT have moved.
      expect(result.status === "stale_precondition" || result.status === "workspace_stale").toBe(true);
      expect(stores.workspaces.get(WS_ID)!.data.ownerUserId).toBe(OWNER_UID);
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!.data.role).toBe("owner");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, OTHER_UID))!.data.role).toBe("member");
    });

    it("rejects a malformed update-time token at the route layer (validateUpdateTimeToken) before this function is ever called — smoke test of the shared validator", () => {
      const { validateUpdateTimeToken } = require("@/lib/projects/updateTimeToken");
      expect(validateUpdateTimeToken({ seconds: "not-a-number", nanoseconds: 0 }).ok).toBe(false);
      expect(validateUpdateTimeToken(null).ok).toBe(false);
      expect(validateUpdateTimeToken({ seconds: 1 }).ok).toBe(false);
    });
  });

  describe("rollout gate", () => {
    it("reports team_workspaces_disabled and performs no Firestore access when globally off and callerUid is not in the canary", async () => {
      teamWorkspacesEnabled = false;
      const result = await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: Timestamp.now(),
        expectedOldOwnerMembershipUpdateTime: Timestamp.now(),
        expectedNewOwnerMembershipUpdateTime: Timestamp.now(),
      });
      expect(result.status).toBe("team_workspaces_disabled");
      expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
    });

    it("succeeds for a callerUid in a valid canary list even when the global flag is off", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryUids = OWNER_UID;
      const tokens = seedHappyPath();
      const result = await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime,
        expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
        expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
      });
      expect(result.status).toBe("transferred");
    });
  });
});
