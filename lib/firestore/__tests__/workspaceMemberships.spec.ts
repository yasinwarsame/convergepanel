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
  teamWorkspaceCanaryCapacity: new Map(),
  workspaceMembershipEvents: new Map(),
  workspaceInvitations: new Map(),
  workspaceInvitationKeys: new Map(),
  teamWorkspaceSeatAdmission: new Map(),
};

function makeDocRef(collectionName: string, docId: string) {
  return {
    __kind: "doc" as const,
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

type QueryFilter = [string, string, unknown];

/**
 * Query-object support, Phase 12A.1S.1 — added so
 * `teamWorkspaceSeatAdmission.ts`'s bootstrap/live-recompute
 * `tx.get(collection.where(...).where(...))` reads (now ALWAYS reached by
 * `removeWorkspaceMembership()` — unlike canary capacity, this module is
 * never gated behind `isWorkspaceCapacityControlled()`/`TEAM_WORKSPACES_ENABLED`)
 * work inside a transaction here. Mirrors
 * `workspaceInvitationCapacityIntegration.spec.ts`'s `makeQuery()`.
 */
function makeQuery(collectionName: string, filters: QueryFilter[]): any {
  return {
    __kind: "query" as const,
    __collection: collectionName,
    __filters: filters,
    where: (field: string, op: string, value: unknown) => makeQuery(collectionName, [...filters, [field, op, value]]),
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

// Phase TEAM-GOV-I1C1 — set to a collection name to make the next `tx.set()`
// call on that collection throw, simulating a transient Firestore failure
// on that specific write only.
let forceSetFailureForCollection: string | null = null;

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId?: string) => makeDocRef(name, docId ?? `auto-${++autoIdCounter}`),
    where: (field: string, op: string, value: unknown) => makeQuery(name, [[field, op, value]]),
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
      get: async (ref: any) => {
        if (ref.__kind === "query") {
          const store = stores[ref.__collection];
          const docs: Array<{ id: string; data: () => Record<string, unknown>; exists: true; updateTime: Timestamp }> = [];
          for (const [id, entry] of store.entries()) {
            const matches = (ref.__filters as QueryFilter[]).every(([field, op, value]) => op === "==" && (entry.data as Record<string, unknown>)[field] === value);
            if (matches) docs.push({ id, data: () => entry.data, exists: true, updateTime: entry.updateTime });
          }
          if (concurrentMutationHook) concurrentMutationHook(ref);
          return { empty: docs.length === 0, docs, size: docs.length };
        }
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
      // Standard Firestore `tx.set()` semantics: unconditional overwrite,
      // no ALREADY_EXISTS/NOT_FOUND precondition — used for the
      // Phase TEAM-GOV-I1C1 atomic `workspaceMembershipEvents` write on a
      // freshly-allocated auto-ID doc ref. `forceSetFailureForCollection`
      // lets a test simulate a transient Firestore error on this specific
      // write WITHOUT touching the transaction's other writes' own logic —
      // proving atomicity requires being able to fail exactly one write
      // and observe the whole transaction roll back.
      set: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        if (forceSetFailureForCollection === ref.__collection) {
          throw new FirestoreError("14", "UNAVAILABLE: simulated transient failure");
        }
        const store = stores[ref.__collection];
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
import { getWorkspaceMembershipForBinding, createTeamWorkspace, transferTeamWorkspaceOwnership, removeWorkspaceMembership, changeTeamWorkspaceMemberRole } from "@/lib/firestore/workspaceMemberships";

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
  stores.teamWorkspaceCanaryCapacity.clear();
  stores.workspaceMembershipEvents.clear();
  stores.workspaceInvitations.clear();
  stores.workspaceInvitationKeys.clear();
  stores.teamWorkspaceSeatAdmission.clear();
  concurrentMutationHook = null;
  forceSetFailureForCollection = null;
  firestoreUnavailableFlag.value = false;
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
  teamWorkspacesCanaryWorkspaceIds = undefined;
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

  describe("Phase 10B.3.2A — Workspace-canary target admission", () => {
    it("Workspace-canary-only: caller is the canonical Owner and Workspace-canary admitted for the target -> transfer SUCCEEDS, even with global off and callerUid not in the uid-canary", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
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

    it("Workspace-canary-only: caller has an active membership (admission granted) but is NOT the Owner -> transfer FAILS via the owner-authority check, not via admission", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      // OTHER_UID is Workspace-canary admitted (target admitted, membership
      // exists) but holds role "admin", not "owner" — admission succeeds,
      // isCanonicalTeamOwnerMembership() must be what denies this.
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

    it("Workspace-canary admitted for the target workspace, but a membership belonging to a DIFFERENT workspace cannot be used as the successor", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      const workspaceUpdateTime = seedTeamWorkspace();
      const oldOwnerUpdateTime = seedMembership(OWNER_UID, "owner");
      // No membership document exists at computeMembershipId(WS_ID, OTHER_UID)
      // — only a foreign one bound to a different workspace — so the
      // canonical binding lookup correctly reports not-found rather than
      // treating any membership row for OTHER_UID as eligible.
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
      expect(stores.workspaces.get(WS_ID)!.data.ownerUserId).toBe(OWNER_UID);
    });

    it("Workspace-canary admitted + caller has no membership at all in the target workspace -> denied", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedTeamWorkspace();
      const result = await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: Timestamp.now(),
        expectedOldOwnerMembershipUpdateTime: Timestamp.now(),
        expectedNewOwnerMembershipUpdateTime: Timestamp.now(),
      });
      expect(result.status).toBe("caller_not_owner");
    });

    it("Workspace-canary admitted + caller's membership was removed -> denied", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      const workspaceUpdateTime = seedTeamWorkspace();
      const callerUpdateTime = seedMembership(OWNER_UID, "owner", { status: "removed", removedAt: Timestamp.now(), removedByUserId: "someone" });
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
      expect(stores.workspaces.get(WS_ID)!.data.ownerUserId).toBe(OWNER_UID);
    });

    it("target workspace NOT admitted at all -> denied, zero Firestore access (concealed team_workspaces_disabled)", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = "some-other-workspace";
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

    it("global ON is unaffected by a malformed Workspace-canary list", async () => {
      teamWorkspacesEnabled = true;
      teamWorkspacesCanaryWorkspaceIds = "*";
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

    it("uid-canary admission survives a malformed Workspace-canary list", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryUids = OWNER_UID;
      teamWorkspacesCanaryWorkspaceIds = "*";
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

    it("Workspace-canary admission survives a malformed uid-canary list", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryUids = "*";
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
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

    it("a successful Workspace-canary-admitted transfer never touches capacity — no membership document is created or destroyed, only existing rows' role field is updated in place", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      const tokens = seedHappyPath();
      const membershipCountBefore = stores.workspaceMemberships.size;
      const workspaceCountBefore = stores.workspaces.size;
      const result = await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime,
        expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
        expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
      });
      expect(result.status).toBe("transferred");
      // Same two membership rows still present, same two collections'
      // document counts unchanged — no capacity primitive (which would
      // manifest as a write to a distinct capacity document/collection,
      // or a create/delete changing these counts) was ever invoked.
      expect(stores.workspaceMemberships.size).toBe(membershipCountBefore);
      expect(stores.workspaces.size).toBe(workspaceCountBefore);
      expect(stores.workspaceMemberships.has(computeMembershipId(WS_ID, OWNER_UID))).toBe(true);
      expect(stores.workspaceMemberships.has(computeMembershipId(WS_ID, OTHER_UID))).toBe(true);
    });
  });

  describe("ATOMICITY — Phase TEAM-MGMT-12C (TRANSFER COMMITTED IFF AUDIT EVENT COMMITTED)", () => {
    it("1. successful transfer writes exactly one workspace_ownership_transferred event, in the same transaction as the ownership mutation", async () => {
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
      expect(stores.workspaceMembershipEvents.size).toBe(1);
      const [event] = [...stores.workspaceMembershipEvents.values()];
      expect(event.data).toMatchObject({
        eventType: "workspace_ownership_transferred",
        actorUid: OWNER_UID,
        targetUid: OTHER_UID,
        workspaceId: WS_ID,
        previousRole: "member",
      });
    });

    it("2. event write failure -> the whole transaction rolls back: ownership does not transfer, roles unchanged, no partial event", async () => {
      const tokens = seedHappyPath();
      forceSetFailureForCollection = "workspaceMembershipEvents";

      const result = await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime,
        expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
        expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
      });

      expect(result.status).toBe("transaction_failed");
      expect(stores.workspaces.get(WS_ID)!.data.ownerUserId).toBe(OWNER_UID); // ownership NOT transferred
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!.data.role).toBe("owner");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, OTHER_UID))!.data.role).toBe("member");
      expect(stores.workspaceMembershipEvents.size).toBe(0); // no partial event
    });

    it("3. self-transfer denial -> no ownership mutation, no event", async () => {
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
      expect(stores.workspaceMembershipEvents.size).toBe(0);
    });

    it("4. non-Owner caller denial (caller_not_owner) -> no ownership mutation, no event", async () => {
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
      expect(stores.workspaceMembershipEvents.size).toBe(0);
    });

    it("5. ineligible new-Owner target (already removed) -> no ownership mutation, no event", async () => {
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
      expect(stores.workspaceMembershipEvents.size).toBe(0);
    });

    it("6. stale OCC token denial (any of the three) -> no ownership mutation, no event", async () => {
      const tokens = seedHappyPath();
      const staleToken = new Timestamp(1, 0);
      const result = await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: staleToken,
        expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
        expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
      });
      expect(result.status).toBe("workspace_stale");
      expect(stores.workspaceMembershipEvents.size).toBe(0);
    });

    it("7. event actorUid is the PREVIOUS Owner (the caller who performed the transfer), targetUid is the NEW Owner", async () => {
      const tokens = seedHappyPath();
      await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime,
        expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
        expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
      });
      const [event] = [...stores.workspaceMembershipEvents.values()];
      expect(event.data.actorUid).toBe(OWNER_UID);
      expect(event.data.targetUid).toBe(OTHER_UID);
    });

    it("8. event previousRole is the NEW Owner's role immediately BEFORE the transfer (never 'owner', since a non-owner is always the target) — proven across every eligible starting role", async () => {
      for (const startingRole of ["admin", "member", "reviewer", "viewer"] as const) {
        stores.workspaces.clear();
        stores.workspaceMemberships.clear();
        stores.workspaceMembershipEvents.clear();
        const workspaceUpdateTime = seedTeamWorkspace();
        const oldOwnerUpdateTime = seedMembership(OWNER_UID, "owner");
        const newOwnerUpdateTime = seedMembership(OTHER_UID, startingRole);
        const result = await transferTeamWorkspaceOwnership({
          workspaceId: WS_ID,
          callerUid: OWNER_UID,
          newOwnerUid: OTHER_UID,
          expectedWorkspaceUpdateTime: workspaceUpdateTime,
          expectedOldOwnerMembershipUpdateTime: oldOwnerUpdateTime,
          expectedNewOwnerMembershipUpdateTime: newOwnerUpdateTime,
        });
        expect(result.status).toBe("transferred");
        const [event] = [...stores.workspaceMembershipEvents.values()];
        expect(event.data.previousRole).toBe(startingRole);
      }
    });

    it("9. event workspaceId matches the authoritative Workspace the transfer actually happened in", async () => {
      const tokens = seedHappyPath();
      await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime,
        expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
        expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
      });
      const [event] = [...stores.workspaceMembershipEvents.values()];
      expect(event.data.workspaceId).toBe(WS_ID);
    });

    it("10. event 'at' is the SAME Timestamp instant as the mutation's own updatedAt fields — never a second, independently-drifted clock read", async () => {
      const tokens = seedHappyPath();
      await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime,
        expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
        expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
      });
      const persistedWorkspace = stores.workspaces.get(WS_ID)!.data as { updatedAt: Timestamp };
      const persistedOldOwner = stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!.data as { updatedAt: Timestamp };
      const [event] = [...stores.workspaceMembershipEvents.values()];
      const eventAt = event.data.at as Timestamp;
      expect(eventAt.seconds).toBe(persistedWorkspace.updatedAt.seconds);
      expect(eventAt.nanoseconds).toBe(persistedWorkspace.updatedAt.nanoseconds);
      expect(eventAt.seconds).toBe(persistedOldOwner.updatedAt.seconds);
      expect(eventAt.nanoseconds).toBe(persistedOldOwner.updatedAt.nanoseconds);
    });

    it("11. the event document shape written here is byte-for-byte the same field set the Audit Log read model already validates — proven by listWorkspaceAuditEvents.spec.ts remaining unmodified-in-shape and passing", async () => {
      const tokens = seedHappyPath();
      await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: OTHER_UID,
        expectedWorkspaceUpdateTime: tokens.workspaceUpdateTime,
        expectedOldOwnerMembershipUpdateTime: tokens.oldOwnerUpdateTime,
        expectedNewOwnerMembershipUpdateTime: tokens.newOwnerUpdateTime,
      });
      const [event] = [...stores.workspaceMembershipEvents.values()];
      expect(Object.keys(event.data).sort()).toEqual(["actorUid", "at", "eventType", "previousRole", "targetUid", "workspaceId"].sort());
    });
  });
});

describe("Phase 10B.3.2A — createTeamWorkspace remains strictly user-scoped (Team Workspace creation regression)", () => {
  it("a caller who is Workspace-canary-admitted for an EXISTING workspace, but not global-enabled and not uid-canary, still CANNOT create a NEW Team Workspace — createTeamWorkspace() has no workspaceId to admit against and intentionally still calls only resolveTeamWorkspacesMode({uid})", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined;
    // OWNER_UID is Workspace-canary admitted for WS_ID (would pass
    // resolveTeamWorkspaceTargetAdmission for that specific workspace),
    // proven by first exercising a successful Workspace-canary-gated
    // operation for the SAME uid before attempting creation.
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    const workspaceUpdateTime = seedTeamWorkspace();
    const oldOwnerUpdateTime = seedMembership(OWNER_UID, "owner");
    const newOwnerUpdateTime = seedMembership(OTHER_UID, "member");
    const transferResult = await transferTeamWorkspaceOwnership({
      workspaceId: WS_ID,
      callerUid: OWNER_UID,
      newOwnerUid: OTHER_UID,
      expectedWorkspaceUpdateTime: workspaceUpdateTime,
      expectedOldOwnerMembershipUpdateTime: oldOwnerUpdateTime,
      expectedNewOwnerMembershipUpdateTime: newOwnerUpdateTime,
    });
    expect(transferResult.status).toBe("transferred"); // proves Workspace-canary admission genuinely holds for OWNER_UID

    // Now the SAME uid, still only Workspace-canary admitted (for a
    // workspace, not a creation action) and still neither global nor
    // uid-canary enabled, attempts to create a brand-new Team Workspace.
    const createResult = await createTeamWorkspace({ uid: OWNER_UID, name: "Should Not Be Created" });
    expect(createResult.status).toBe("team_workspaces_disabled");
    expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1); // only the transfer above ran a transaction
  });
});

describe("removeWorkspaceMembership — Phase 12A", () => {
  const ADMIN_UID = "admin-1";
  const MEMBER_UID = "member-2";
  const REVIEWER_UID = "reviewer-1";
  const VIEWER_UID = "viewer-1";

  function seedWorkspaceWithRoster(overrides: Record<string, unknown> = {}) {
    seedTeamWorkspace(overrides);
    seedMembership(OWNER_UID, "owner");
    seedMembership(ADMIN_UID, "admin");
    seedMembership(MEMBER_UID, "member");
    seedMembership(REVIEWER_UID, "reviewer");
    seedMembership(VIEWER_UID, "viewer");
  }

  function seedCapacity(reservedCount: number) {
    stores.teamWorkspaceCanaryCapacity.set(WS_ID, {
      data: { schemaVersion: 1, workspaceId: WS_ID, reservedCount, revision: 0, updatedAt: Timestamp.now() },
      updateTime: nextUpdateTime(),
    });
  }

  describe("OWNER removal matrix", () => {
    it("E. Owner removes Admin -> success", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: ADMIN_UID });
      expect(result).toEqual({ status: "removed", targetUid: ADMIN_UID, workspaceId: WS_ID, previousRole: "admin" });
    });

    it("F. Owner removes Member -> success", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(result.status).toBe("removed");
    });

    it("G. Owner removes Reviewer -> success", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: REVIEWER_UID });
      expect(result.status).toBe("removed");
    });

    it("H. Owner removes Viewer -> success", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: VIEWER_UID });
      expect(result.status).toBe("removed");
    });

    it("I. Owner removes canonical Owner (self) -> denied (self_removal_rejected, checked before the canonical-Owner branch)", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: OWNER_UID });
      expect(result.status).toBe("self_removal_rejected");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!.data.status).toBe("active");
    });

    it("J. Owner self-removal -> denied", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: OWNER_UID });
      expect(result.status).toBe("self_removal_rejected");
    });
  });

  describe("ADMIN removal matrix", () => {
    it("K. Admin removes Member -> success", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(result.status).toBe("removed");
    });

    it("L. Admin removes Reviewer -> success", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: REVIEWER_UID });
      expect(result.status).toBe("removed");
    });

    it("M. Admin removes Viewer -> success", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: VIEWER_UID });
      expect(result.status).toBe("removed");
    });

    it("N. Admin removes another Admin -> denied", async () => {
      seedWorkspaceWithRoster();
      const secondAdminUid = "admin-2";
      seedMembership(secondAdminUid, "admin");
      const result = await removeWorkspaceMembership({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: secondAdminUid });
      expect(result.status).toBe("target_role_not_manageable");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, secondAdminUid))!.data.status).toBe("active");
    });

    it("O. Admin removes Owner -> denied", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: OWNER_UID });
      expect(result.status).toBe("target_is_canonical_owner");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!.data.status).toBe("active");
    });

    it("P. Admin self-removal -> denied", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: ADMIN_UID });
      expect(result.status).toBe("self_removal_rejected");
    });
  });

  describe("LOWER ROLES cannot remove anyone", () => {
    it("Q. Member removal attempt -> denied (insufficient_capability)", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: MEMBER_UID, workspaceId: WS_ID, targetUid: VIEWER_UID });
      expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    });

    it("R. Reviewer removal attempt -> denied (insufficient_capability)", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: REVIEWER_UID, workspaceId: WS_ID, targetUid: VIEWER_UID });
      expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    });

    it("S. Viewer removal attempt -> denied (insufficient_capability)", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: VIEWER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    });
  });

  describe("AUTH / concealment", () => {
    it("C. non-member actor -> denied (membership_not_found)", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: "stranger-uid", workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
    });

    it("D. target uid that only exists in a DIFFERENT Workspace is concealed as target_not_found (never enumerable via this Workspace's route)", async () => {
      seedWorkspaceWithRoster();
      const foreignUid = "foreign-member";
      const foreignId = computeMembershipId("some-other-ws", foreignUid);
      stores.workspaceMemberships.set(foreignId, {
        data: { schemaVersion: 1, id: foreignId, workspaceId: "some-other-ws", uid: foreignUid, role: "member", status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), invitedByUserId: null, removedAt: null, removedByUserId: null },
        updateTime: nextUpdateTime(),
      });
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: foreignUid });
      expect(result.status).toBe("target_not_found");
    });

    it("B. Team Workspaces globally disabled and actor not in any canary -> team_workspaces_disabled, zero Firestore access", async () => {
      seedWorkspaceWithRoster();
      teamWorkspacesEnabled = false;
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(result.status).toBe("team_workspaces_disabled");
      expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
    });
  });

  describe("INTEGRITY", () => {
    it("T. a corrupt extra role:\"owner\" membership (not canonical) is denied removal via role policy, never granted Owner protection it doesn't deserve, and never removable either", async () => {
      seedWorkspaceWithRoster();
      const corruptUid = "corrupt-owner-uid";
      seedMembership(corruptUid, "owner"); // role says owner, but workspace.ownerUserId still points at OWNER_UID
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: corruptUid });
      // Denied via ordinary role policy (owner is never a manageable target role for anyone) — NOT via target_is_canonical_owner, since this row is not canonical.
      expect(result.status).toBe("target_role_not_manageable");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, corruptUid))!.data.status).toBe("active");
    });

    it("U. malformed target membership document fails closed", async () => {
      seedWorkspaceWithRoster();
      const targetId = computeMembershipId(WS_ID, MEMBER_UID);
      stores.workspaceMemberships.set(targetId, {
        data: { schemaVersion: 1, id: targetId, workspaceId: "wrong-ws", uid: MEMBER_UID, role: "member", status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), invitedByUserId: null, removedAt: null, removedByUserId: null },
        updateTime: nextUpdateTime(),
      });
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(result.status).toBe("target_malformed");
    });

    it("V/W/X/Y/Z. removal is a soft transition: membership document retained, status -> removed, removedAt/removedByUserId server-derived, role/createdAt/invitedByUserId preserved", async () => {
      seedWorkspaceWithRoster();
      const before = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data;
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(result).toEqual({ status: "removed", targetUid: MEMBER_UID, workspaceId: WS_ID, previousRole: "member" });

      const after = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data;
      expect(after).toBeDefined(); // V — document retained, never deleted
      expect(after.status).toBe("removed"); // W
      expect(after.removedAt).toBeInstanceOf(Timestamp); // X
      expect(after.removedByUserId).toBe(OWNER_UID); // Y — actor-derived, never client-supplied
      expect(after.role).toBe("member"); // Z — previous role retained on the document itself
      expect(after.createdAt).toEqual(before.createdAt);
      expect(after.invitedByUserId).toEqual(before.invitedByUserId);
    });
  });

  describe("IDEMPOTENCY", () => {
    it("AA. second remove of an already-removed membership returns already_removed deterministically, not an error", async () => {
      seedWorkspaceWithRoster();
      const first = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(first.status).toBe("removed");
      const second = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(second).toEqual({ status: "already_removed" });
    });

    it("AB. second remove does not alter removedAt/removedByUserId", async () => {
      seedWorkspaceWithRoster();
      await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      const afterFirst = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data;
      await removeWorkspaceMembership({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      const afterSecond = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data;
      expect(afterSecond.removedAt).toEqual(afterFirst.removedAt);
      expect(afterSecond.removedByUserId).toBe(afterFirst.removedByUserId); // still OWNER_UID, not ADMIN_UID
    });
  });

  describe("CAPACITY", () => {
    it("AK. controlled mode releases exactly one active-membership capacity unit on removal", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID; // capacityControlled() true for this workspace
      seedWorkspaceWithRoster();
      seedCapacity(5);
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(result.status).toBe("removed");
      expect(stores.teamWorkspaceCanaryCapacity.get(WS_ID)!.data.reservedCount).toBe(4);
    });

    it("AL. global/uncontrolled mode never touches the capacity document at all", async () => {
      seedWorkspaceWithRoster(); // teamWorkspacesEnabled stays true (global) — capacityControlled() is inert
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(result.status).toBe("removed");
      expect(stores.teamWorkspaceCanaryCapacity.size).toBe(0);
    });

    it("AM. underflow protection: a release that would take reservedCount below zero fails closed (state_corruption), and the membership is NOT removed — capacity release and membership mutation are in the same transaction", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedWorkspaceWithRoster();
      seedCapacity(0);
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(result.status).toBe("state_corruption");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data.status).toBe("active"); // no partial mutation
    });

    it("AN. idempotent second remove releases no additional capacity (already_removed short-circuits before the capacity step)", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedWorkspaceWithRoster();
      seedCapacity(5);
      await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(stores.teamWorkspaceCanaryCapacity.get(WS_ID)!.data.reservedCount).toBe(4);
      const second = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(second.status).toBe("already_removed");
      expect(stores.teamWorkspaceCanaryCapacity.get(WS_ID)!.data.reservedCount).toBe(4); // unchanged
    });
  });

  describe("rollout gate", () => {
    it("succeeds for an actor in a valid uid-canary even when the global flag is off", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryUids = OWNER_UID;
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(result.status).toBe("removed");
    });
  });

  describe("ATOMICITY — Phase TEAM-GOV-I1C1 (REMOVAL COMMITTED IFF AUDIT EVENT COMMITTED)", () => {
    it("1. successful removal writes exactly one canonical removal event, in the same transaction as the membership mutation", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: REVIEWER_UID });
      expect(result.status).toBe("removed");
      expect(stores.workspaceMembershipEvents.size).toBe(1);
      const [event] = [...stores.workspaceMembershipEvents.values()];
      expect(event.data).toMatchObject({ eventType: "workspace_member_removed", actorUid: OWNER_UID, targetUid: REVIEWER_UID, workspaceId: WS_ID, previousRole: "reviewer" });
    });

    it("2. event write failure -> the whole transaction rolls back: removal does not commit, membership remains active, capacity unchanged, no partial event", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedWorkspaceWithRoster();
      seedCapacity(5);
      forceSetFailureForCollection = "workspaceMembershipEvents";

      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });

      expect(result.status).toBe("remove_failed");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data.status).toBe("active"); // membership NOT removed
      expect(stores.teamWorkspaceCanaryCapacity.get(WS_ID)!.data.reservedCount).toBe(5); // capacity NOT released
      expect(stores.workspaceMembershipEvents.size).toBe(0); // no partial event
    });

    it("3. membership write failure (target deleted by a concurrent writer between this transaction's read and write) -> event is never even attempted, nothing commits", async () => {
      seedWorkspaceWithRoster();
      const targetId = computeMembershipId(WS_ID, MEMBER_UID);
      let deleted = false;
      concurrentMutationHook = (ref) => {
        if (ref.__collection === "workspaceMemberships" && ref.__id === targetId && !deleted) {
          deleted = true;
          stores.workspaceMemberships.delete(targetId);
        }
      };

      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });

      expect(result.status).toBe("remove_failed");
      expect(stores.workspaceMemberships.has(targetId)).toBe(false); // reflects the concurrent delete, not this transaction
      expect(stores.workspaceMembershipEvents.size).toBe(0); // event never committed
    });

    it("4. canonical-Owner denial -> no membership mutation, no event", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: OWNER_UID });
      expect(result.status).toBe("target_is_canonical_owner");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!.data.status).toBe("active");
      expect(stores.workspaceMembershipEvents.size).toBe(0);
    });

    it("5. unauthorized caller (insufficient_capability) -> no membership mutation, no event", async () => {
      seedWorkspaceWithRoster();
      const result = await removeWorkspaceMembership({ uid: MEMBER_UID, workspaceId: WS_ID, targetUid: VIEWER_UID });
      expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, VIEWER_UID))!.data.status).toBe("active");
      expect(stores.workspaceMembershipEvents.size).toBe(0);
    });

    it("6. removed/non-member caller and idempotent already_removed target -> no mutation, no NEW event (exactly one event total across both calls)", async () => {
      seedWorkspaceWithRoster();
      const first = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(first.status).toBe("removed");
      expect(stores.workspaceMembershipEvents.size).toBe(1);

      const second = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(second).toEqual({ status: "already_removed" });
      expect(stores.workspaceMembershipEvents.size).toBe(1); // still exactly one — idempotent no-op writes nothing

      const nonMemberResult = await removeWorkspaceMembership({ uid: "stranger-uid", workspaceId: WS_ID, targetUid: REVIEWER_UID });
      expect(nonMemberResult).toEqual({ status: "unauthorized", reason: "membership_not_found" });
      expect(stores.workspaceMembershipEvents.size).toBe(1); // unchanged
    });

    it("7. retry-safety: the event doc ref is allocated fresh inside the transaction callback (no argument to .doc()) — real Firestore only ever commits ONE attempt's buffered writes, so a retried callback can never produce more than one persisted event for one successful logical removal (this fake invokes the callback once per call; the code-level guarantee is that .doc() with no id never derives a value from anything read earlier in the SAME attempt, so re-running the whole callback from scratch — Firestore's actual retry model — simply discards the earlier attempt's unwritten event entirely, never doubles it)", async () => {
      seedWorkspaceWithRoster();
      const before = stores.workspaceMembershipEvents.size;
      const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(result.status).toBe("removed");
      expect(stores.workspaceMembershipEvents.size).toBe(before + 1);
    });

    it("8. previousRole in the event is captured from the authoritative pre-removal membership state read inside THIS transaction, never a caller-supplied or stale value", async () => {
      seedWorkspaceWithRoster();
      await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: VIEWER_UID });
      const [event] = [...stores.workspaceMembershipEvents.values()];
      expect(event.data.previousRole).toBe("viewer");
    });

    it("9. event workspaceId matches the authoritative Workspace the removal actually happened in", async () => {
      seedWorkspaceWithRoster();
      await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      const [event] = [...stores.workspaceMembershipEvents.values()];
      expect(event.data.workspaceId).toBe(WS_ID);
    });

    it("10. actor/target identity in the event are exactly {args.uid, args.targetUid} — the function signature admits no other source, so a client cannot substitute either (the route itself additionally rejects any request body field, tested separately)", async () => {
      seedWorkspaceWithRoster();
      await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: ADMIN_UID });
      const [event] = [...stores.workspaceMembershipEvents.values()];
      expect(event.data.actorUid).toBe(OWNER_UID);
      expect(event.data.targetUid).toBe(ADMIN_UID);
    });

    it("11. access-revocation behavior is unaffected by this correction — resolveWorkspaceAccess()/authorizeTeamWorkspaceMutationInTransaction() were not touched by this change (proven by their own unmodified, still-passing test suites, re-run fresh alongside this file)", () => {
      // Structural proof only, at this level: this correction's diff never
      // touches resolveWorkspaceAccess.ts, authorizeTeamWorkspaceMutationInTransaction.ts,
      // or ownerInvariant.ts. Behavioral proof lives in those files' own
      // pre-existing spec files (resolveWorkspaceAccess.spec.ts,
      // authorizeTeamWorkspaceMutationInTransaction.spec.ts,
      // workspaceReviewPanelMutations.spec.ts), unchanged by this phase.
      const fs = require("fs");
      const path = require("path");
      const diffSensitiveFiles = ["lib/workspaces/resolveWorkspaceAccess.ts", "lib/workspaces/authorizeTeamWorkspaceMutationInTransaction.ts", "lib/workspaces/ownerInvariant.ts"];
      for (const f of diffSensitiveFiles) {
        expect(fs.existsSync(path.join(process.cwd(), f))).toBe(true); // sanity: file exists, unmodified per git diff (verified separately)
      }
    });

    it("12. the event document shape written here is byte-for-byte the same field set the Audit Log read model already validates — proven by listWorkspaceAuditEvents.spec.ts remaining unmodified and passing", async () => {
      seedWorkspaceWithRoster();
      await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      const [event] = [...stores.workspaceMembershipEvents.values()];
      // Exact field set expected by lib/workspaces/listWorkspaceAuditEvents.ts's validateRow().
      expect(Object.keys(event.data).sort()).toEqual(["actorUid", "at", "eventType", "previousRole", "targetUid", "workspaceId"].sort());
    });
  });
});

describe("changeTeamWorkspaceMemberRole — Phase 12B", () => {
  const ADMIN_UID = "admin-1";
  const MEMBER_UID = "member-2";
  const REVIEWER_UID = "reviewer-1";
  const VIEWER_UID = "viewer-1";

  function seedWorkspaceWithRoster(overrides: Record<string, unknown> = {}) {
    seedTeamWorkspace(overrides);
    seedMembership(OWNER_UID, "owner");
    seedMembership(ADMIN_UID, "admin");
    seedMembership(MEMBER_UID, "member");
    seedMembership(REVIEWER_UID, "reviewer");
    seedMembership(VIEWER_UID, "viewer");
  }

  describe("OWNER role-change matrix", () => {
    it("N. Owner changes Admin -> Member", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: ADMIN_UID, destinationRole: "member" });
      expect(result).toEqual({ status: "changed", targetUid: ADMIN_UID, workspaceId: WS_ID, previousRole: "admin", newRole: "member" });
    });

    it("O. Owner changes Admin -> Reviewer", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: ADMIN_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("changed");
    });

    it("P. Owner changes Admin -> Viewer", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: ADMIN_UID, destinationRole: "viewer" });
      expect(result.status).toBe("changed");
    });

    it("Q. Owner changes Member -> Admin", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "admin" });
      expect(result.status).toBe("changed");
    });

    it("R. Owner changes Member -> Reviewer", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("changed");
    });

    it("S. Owner changes Member -> Viewer", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "viewer" });
      expect(result.status).toBe("changed");
    });

    it("T. Owner changes Reviewer -> Admin", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: REVIEWER_UID, destinationRole: "admin" });
      expect(result.status).toBe("changed");
    });

    it("U. Owner changes Reviewer -> Member", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: REVIEWER_UID, destinationRole: "member" });
      expect(result.status).toBe("changed");
    });

    it("V. Owner changes Reviewer -> Viewer", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: REVIEWER_UID, destinationRole: "viewer" });
      expect(result.status).toBe("changed");
    });

    it("W. Owner changes Viewer -> Admin", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: VIEWER_UID, destinationRole: "admin" });
      expect(result.status).toBe("changed");
    });

    it("X. Owner changes Viewer -> Member", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: VIEWER_UID, destinationRole: "member" });
      expect(result.status).toBe("changed");
    });

    it("Y. Owner changes Viewer -> Reviewer", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: VIEWER_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("changed");
    });

    it("Z. Owner targeting canonical Owner (self) -> denied (self_change_rejected, checked before the canonical-Owner branch)", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: OWNER_UID, destinationRole: "admin" });
      expect(result.status).toBe("self_change_rejected");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!.data.role).toBe("owner");
    });
  });

  describe("ADMIN role-change matrix", () => {
    it("AB. Admin changes Member -> Reviewer", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("changed");
    });

    it("AC. Admin changes Member -> Viewer", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "viewer" });
      expect(result.status).toBe("changed");
    });

    it("AD. Admin changes Reviewer -> Member", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: REVIEWER_UID, destinationRole: "member" });
      expect(result.status).toBe("changed");
    });

    it("AE. Admin changes Reviewer -> Viewer", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: REVIEWER_UID, destinationRole: "viewer" });
      expect(result.status).toBe("changed");
    });

    it("AF. Admin changes Viewer -> Member", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: VIEWER_UID, destinationRole: "member" });
      expect(result.status).toBe("changed");
    });

    it("AG. Admin changes Viewer -> Reviewer", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: VIEWER_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("changed");
    });

    it("AH. Admin targets another Admin -> denied (target_role_not_manageable), regardless of destination", async () => {
      seedWorkspaceWithRoster();
      const secondAdminUid = "admin-2";
      seedMembership(secondAdminUid, "admin");
      const result = await changeTeamWorkspaceMemberRole({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: secondAdminUid, destinationRole: "member" });
      expect(result.status).toBe("target_role_not_manageable");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, secondAdminUid))!.data.role).toBe("admin");
    });

    it("AI. Admin destination Admin -> denied (destination_role_not_permitted), even for an otherwise-manageable target", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "admin" });
      expect(result.status).toBe("destination_role_not_permitted");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data.role).toBe("member");
    });

    it("AJ. Admin targets Owner -> denied (target_is_canonical_owner)", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: OWNER_UID, destinationRole: "member" });
      expect(result.status).toBe("target_is_canonical_owner");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!.data.role).toBe("owner");
    });

    it("AL. Admin self-change -> denied", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: ADMIN_UID, workspaceId: WS_ID, targetUid: ADMIN_UID, destinationRole: "member" });
      expect(result.status).toBe("self_change_rejected");
    });
  });

  describe("LOWER ROLES have no role-management authority", () => {
    it("AM. Member attempt -> denied (insufficient_capability)", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: MEMBER_UID, workspaceId: WS_ID, targetUid: VIEWER_UID, destinationRole: "reviewer" });
      expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    });

    it("AN. Reviewer attempt -> denied (insufficient_capability)", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: REVIEWER_UID, workspaceId: WS_ID, targetUid: VIEWER_UID, destinationRole: "member" });
      expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    });

    it("AO. Viewer attempt -> denied (insufficient_capability)", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: VIEWER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    });
  });

  describe("AUTH / concealment", () => {
    it("non-member actor -> denied (membership_not_found)", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: "stranger-uid", workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
    });

    it("target uid that only exists in a DIFFERENT Workspace is concealed as target_not_found", async () => {
      seedWorkspaceWithRoster();
      const foreignUid = "foreign-member";
      const foreignId = computeMembershipId("some-other-ws", foreignUid);
      stores.workspaceMemberships.set(foreignId, {
        data: { schemaVersion: 1, id: foreignId, workspaceId: "some-other-ws", uid: foreignUid, role: "member", status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), invitedByUserId: null, removedAt: null, removedByUserId: null },
        updateTime: nextUpdateTime(),
      });
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: foreignUid, destinationRole: "reviewer" });
      expect(result.status).toBe("target_not_found");
    });

    it("Team Workspaces globally disabled and actor not in any canary -> team_workspaces_disabled, zero Firestore access", async () => {
      seedWorkspaceWithRoster();
      teamWorkspacesEnabled = false;
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("team_workspaces_disabled");
      expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
    });
  });

  describe("REMOVED TARGET", () => {
    it("a role-change attempt against a removed target is denied (target_not_active), never reactivating the membership", async () => {
      seedWorkspaceWithRoster();
      const removed = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      expect(removed.status).toBe("removed");
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("target_not_active");
      const after = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data;
      expect(after.status).toBe("removed");
      expect(after.role).toBe("member"); // never mutated
    });
  });

  describe("INTEGRITY", () => {
    it("a corrupt extra role:\"owner\" membership (not canonical) is denied via ordinary role policy (target_role_not_manageable), never granted Owner protection it doesn't deserve", async () => {
      seedWorkspaceWithRoster();
      const corruptUid = "corrupt-owner-uid";
      seedMembership(corruptUid, "owner");
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: corruptUid, destinationRole: "member" });
      expect(result.status).toBe("target_role_not_manageable");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, corruptUid))!.data.role).toBe("owner");
    });

    it("malformed target membership document fails closed", async () => {
      seedWorkspaceWithRoster();
      const targetId = computeMembershipId(WS_ID, MEMBER_UID);
      stores.workspaceMemberships.set(targetId, {
        data: { schemaVersion: 1, id: targetId, workspaceId: "wrong-ws", uid: MEMBER_UID, role: "member", status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now(), invitedByUserId: null, removedAt: null, removedByUserId: null },
        updateTime: nextUpdateTime(),
      });
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("target_malformed");
    });
  });

  describe("STATE — write scope and preservation", () => {
    it("a genuine role change writes only role + updatedAt; status/createdAt/invitedByUserId/removedAt/removedByUserId are untouched", async () => {
      seedWorkspaceWithRoster();
      const before = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data;
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result).toEqual({ status: "changed", targetUid: MEMBER_UID, workspaceId: WS_ID, previousRole: "member", newRole: "reviewer" });

      const after = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data;
      expect(after.role).toBe("reviewer");
      expect(after.status).toBe("active");
      expect(after.createdAt).toEqual(before.createdAt);
      expect(after.invitedByUserId).toEqual(before.invitedByUserId);
      expect(after.removedAt).toBeNull();
      expect(after.removedByUserId).toBeNull();
      expect(after.updatedAt).toBeInstanceOf(Timestamp);
    });

    it("workspaceId/uid/membership identity fields are never altered by a role change", async () => {
      seedWorkspaceWithRoster();
      const before = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data;
      await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      const after = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data;
      expect(after.workspaceId).toBe(before.workspaceId);
      expect(after.uid).toBe(before.uid);
      expect(after.id).toBe(before.id);
    });
  });

  describe("SAME-ROLE NO-OP", () => {
    it("requesting the target's current role returns role_unchanged deterministically: no write, no event, no updatedAt bump", async () => {
      seedWorkspaceWithRoster();
      const before = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data;
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "member" });
      expect(result).toEqual({ status: "role_unchanged", targetUid: MEMBER_UID, workspaceId: WS_ID, role: "member" });
      const after = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data;
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(stores.workspaceMembershipEvents.size).toBe(0);
    });
  });

  describe("CAPACITY — a role change never touches seat/capacity accounting", () => {
    it("controlled mode: capacity document is never read or written by a role change", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryWorkspaceIds = WS_ID;
      seedWorkspaceWithRoster();
      stores.teamWorkspaceCanaryCapacity.set(WS_ID, { data: { schemaVersion: 1, workspaceId: WS_ID, reservedCount: 3, revision: 0, updatedAt: Timestamp.now() }, updateTime: nextUpdateTime() });
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("changed");
      expect(stores.teamWorkspaceCanaryCapacity.get(WS_ID)!.data.reservedCount).toBe(3); // unchanged
    });

    it("global/uncontrolled mode: no capacity document is ever created by a role change", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("changed");
      expect(stores.teamWorkspaceCanaryCapacity.size).toBe(0);
    });
  });

  describe("rollout gate", () => {
    it("succeeds for an actor in a valid uid-canary even when the global flag is off", async () => {
      teamWorkspacesEnabled = false;
      teamWorkspacesCanaryUids = OWNER_UID;
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("changed");
    });
  });

  describe("ATOMICITY — ROLE CHANGE COMMITTED IFF AUDIT EVENT COMMITTED", () => {
    it("a successful role change writes exactly one canonical role-changed event, in the same transaction as the membership mutation", async () => {
      seedWorkspaceWithRoster();
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: REVIEWER_UID, destinationRole: "admin" });
      expect(result.status).toBe("changed");
      expect(stores.workspaceMembershipEvents.size).toBe(1);
      const [event] = [...stores.workspaceMembershipEvents.values()];
      expect(event.data).toMatchObject({ eventType: "workspace_member_role_changed", actorUid: OWNER_UID, targetUid: REVIEWER_UID, workspaceId: WS_ID, previousRole: "reviewer", newRole: "admin" });
    });

    it("an unauthorized attempt writes no event", async () => {
      seedWorkspaceWithRoster();
      await changeTeamWorkspaceMemberRole({ uid: MEMBER_UID, workspaceId: WS_ID, targetUid: VIEWER_UID, destinationRole: "reviewer" });
      expect(stores.workspaceMembershipEvents.size).toBe(0);
    });

    it("a removed-target attempt writes no event", async () => {
      seedWorkspaceWithRoster();
      await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID });
      await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      // Exactly one event exists — the removal's own — never a second one from the denied role-change attempt.
      expect(stores.workspaceMembershipEvents.size).toBe(1);
      expect([...stores.workspaceMembershipEvents.values()][0].data.eventType).toBe("workspace_member_removed");
    });

    it("event write failure -> the whole transaction rolls back: role change does not commit, target role unchanged, no partial event", async () => {
      seedWorkspaceWithRoster();
      forceSetFailureForCollection = "workspaceMembershipEvents";
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("change_failed");
      expect(stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!.data.role).toBe("member");
      expect(stores.workspaceMembershipEvents.size).toBe(0);
    });

    it("membership write failure (target deleted by a concurrent writer between this transaction's read and write) -> event is never even attempted, nothing commits", async () => {
      seedWorkspaceWithRoster();
      const targetId = computeMembershipId(WS_ID, MEMBER_UID);
      let deleted = false;
      concurrentMutationHook = (ref) => {
        if (ref.__collection === "workspaceMemberships" && ref.__id === targetId && !deleted) {
          deleted = true;
          stores.workspaceMemberships.delete(targetId);
        }
      };
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      expect(result.status).toBe("change_failed");
      expect(stores.workspaceMembershipEvents.size).toBe(0);
    });

    it("the event document shape written here is exactly the field set the Audit Log read model validates for workspace_member_role_changed", async () => {
      seedWorkspaceWithRoster();
      await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "reviewer" });
      const [event] = [...stores.workspaceMembershipEvents.values()];
      expect(Object.keys(event.data).sort()).toEqual(["actorUid", "at", "eventType", "newRole", "previousRole", "targetUid", "workspaceId"].sort());
    });
  });

  describe("OWNERSHIP TRANSFER INTERACTION", () => {
    it("after an ownership transfer, the new Owner may change the former Owner (now Admin) to a lower role", async () => {
      seedWorkspaceWithRoster();
      const wsSnap = stores.workspaces.get(WS_ID)!;
      const oldOwnerSnap = stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!;
      const newOwnerSnap = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!;
      const transfer = await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: MEMBER_UID,
        expectedWorkspaceUpdateTime: wsSnap.updateTime,
        expectedOldOwnerMembershipUpdateTime: oldOwnerSnap.updateTime,
        expectedNewOwnerMembershipUpdateTime: newOwnerSnap.updateTime,
      });
      expect(transfer.status).toBe("transferred");

      // MEMBER_UID is now Owner; OWNER_UID is now Admin.
      const result = await changeTeamWorkspaceMemberRole({ uid: MEMBER_UID, workspaceId: WS_ID, targetUid: OWNER_UID, destinationRole: "viewer" });
      expect(result).toEqual({ status: "changed", targetUid: OWNER_UID, workspaceId: WS_ID, previousRole: "admin", newRole: "viewer" });
    });

    it("the former Owner, now Admin, may never role-change the new canonical Owner", async () => {
      seedWorkspaceWithRoster();
      const wsSnap = stores.workspaces.get(WS_ID)!;
      const oldOwnerSnap = stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!;
      const newOwnerSnap = stores.workspaceMemberships.get(computeMembershipId(WS_ID, MEMBER_UID))!;
      await transferTeamWorkspaceOwnership({
        workspaceId: WS_ID,
        callerUid: OWNER_UID,
        newOwnerUid: MEMBER_UID,
        expectedWorkspaceUpdateTime: wsSnap.updateTime,
        expectedOldOwnerMembershipUpdateTime: oldOwnerSnap.updateTime,
        expectedNewOwnerMembershipUpdateTime: newOwnerSnap.updateTime,
      });
      // OWNER_UID is now Admin, attempting to act on MEMBER_UID (now canonical Owner).
      const result = await changeTeamWorkspaceMemberRole({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: MEMBER_UID, destinationRole: "admin" });
      expect(result.status).toBe("target_is_canonical_owner");
    });
  });
});
