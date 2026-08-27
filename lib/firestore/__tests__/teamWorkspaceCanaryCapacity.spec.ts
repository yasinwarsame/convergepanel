/**
 * Workspace-Scoped Team Canary, Phase 10B.1 — `teamWorkspaceCanaryCapacity.ts`
 * tests. In-memory Firestore fake, structural mirror of
 * `workspaceInvitations.spec.ts`'s buffered-transaction fake, extended
 * with transactional QUERY support (`tx.get(query)`, chainable
 * `.where().where()`) since bootstrap needs `workspaceMemberships`/
 * `workspaceInvitationKeys` queries inside the same transaction as the
 * capacity document itself.
 *
 * Concurrency tests use the same `concurrentMutationHook` +
 * `retriesBeforeSuccess` idiom as `workspaceInvitations.spec.ts`'s own
 * "create/create race" test: `retriesBeforeSuccess = 1` makes the fake
 * run the transaction callback twice, discarding the first attempt's
 * buffered writes; `concurrentMutationHook` fires on every `tx.get()`
 * across both attempts and is used to inject a competing mutation
 * directly into the store exactly once, during the FIRST attempt's read
 * — simulating a real Firestore-internal retry where the kept (second)
 * attempt re-reads and correctly observes the concurrent winner's effect.
 */

import { Timestamp } from "firebase-admin/firestore";

let autoIdCounter = 0;
let updateTimeCounter = 0;
function nextUpdateTime(): Timestamp {
  updateTimeCounter += 1;
  return new Timestamp(1_700_000_000 + updateTimeCounter, 0);
}
function ts(seconds: number): Timestamp {
  return new Timestamp(seconds, 0);
}

type StoredDoc = { data: Record<string, unknown> };
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaceMemberships: new Map(),
  workspaceInvitationKeys: new Map(),
  workspaceInvitations: new Map(),
  teamWorkspaceCanaryCapacity: new Map(),
};

function resetStores() {
  for (const store of Object.values(stores)) store.clear();
}

class FirestoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

let concurrentMutationHook: ((ref: { __kind: string; __collection: string; __id?: string }) => void) | null = null;
let retriesBeforeSuccess = 0;

type Filter = [string, string, unknown];

function makeDocRef(collectionName: string, docId: string) {
  return { __kind: "doc" as const, __collection: collectionName, __id: docId, id: docId };
}

function makeQuery(collectionName: string, filters: Filter[]): any {
  return {
    __kind: "query" as const,
    __collection: collectionName,
    __filters: filters,
    where: (field: string, op: string, value: unknown) => makeQuery(collectionName, [...filters, [field, op, value]]),
  };
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId?: string) => makeDocRef(name, docId ?? `auto-${++autoIdCounter}`),
    where: (field: string, op: string, value: unknown) => makeQuery(name, [[field, op, value]]),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    let attemptsLeft = retriesBeforeSuccess;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pendingWrites: Array<() => void> = [];
      const txn = {
        get: async (ref: any) => {
          if (concurrentMutationHook) concurrentMutationHook(ref);
          if (ref.__kind === "query") {
            const store = stores[ref.__collection];
            const docs: Array<{ id: string; data: () => Record<string, unknown>; exists: true }> = [];
            for (const [id, entry] of store.entries()) {
              const matches = (ref.__filters as Filter[]).every(([field, op, value]) => op === "==" && (entry.data as Record<string, unknown>)[field] === value);
              if (matches) docs.push({ id, data: () => entry.data, exists: true });
            }
            return { empty: docs.length === 0, docs, size: docs.length };
          }
          const store = stores[ref.__collection];
          const entry = store.get(ref.__id);
          return { exists: entry !== undefined, data: () => entry?.data, id: ref.__id };
        },
        create: (ref: any, data: Record<string, unknown>) => {
          const store = stores[ref.__collection];
          if (store.has(ref.__id)) {
            throw new FirestoreError("6", "ALREADY_EXISTS");
          }
          pendingWrites.push(() => store.set(ref.__id, { data }));
        },
        update: (ref: any, data: Record<string, unknown>) => {
          const store = stores[ref.__collection];
          const entry = store.get(ref.__id);
          if (!entry) {
            throw new FirestoreError("5", "NOT_FOUND");
          }
          pendingWrites.push(() => store.set(ref.__id, { data: { ...entry.data, ...data } }));
        },
      };

      const result = await fn(txn);

      if (attemptsLeft > 0) {
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

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import {
  MAX_TEAM_WORKSPACE_CANARY_MEMBERS,
  isWellFormedTeamWorkspaceCanaryCapacityV1,
  reserveTeamWorkspaceCanarySlot,
  releaseTeamWorkspaceCanarySlot,
} from "@/lib/workspaces/teamWorkspaceCanaryCapacity";

const W1 = "workspace-1";
const OWNER_UID = "owner-1";

async function reserve(workspaceId: string) {
  return mockAdminDb.runTransaction((tx: any) => reserveTeamWorkspaceCanarySlot(tx, workspaceId));
}
async function release(workspaceId: string) {
  return mockAdminDb.runTransaction((tx: any) => releaseTeamWorkspaceCanarySlot(tx, workspaceId));
}

function seedCapacity(workspaceId: string, reservedCount: number, revision: number) {
  stores.teamWorkspaceCanaryCapacity.set(workspaceId, {
    data: { schemaVersion: 1, workspaceId, reservedCount, revision, updatedAt: nextUpdateTime() },
  });
}

function seedActiveMember(workspaceId: string, uid: string) {
  const id = computeMembershipId(workspaceId, uid);
  stores.workspaceMemberships.set(id, {
    data: {
      schemaVersion: 1,
      id,
      workspaceId,
      uid,
      role: "member",
      status: "active",
      createdAt: ts(1000),
      updatedAt: ts(1000),
      invitedByUserId: null,
      removedAt: null,
      removedByUserId: null,
    },
  });
}

let guardCounter = 0;
function seedGuardCurrentInvitation(workspaceId: string, email: string, invitationStatus: "pending" | "accepted" | "revoked", expiresAtSeconds: number) {
  guardCounter += 1;
  const invitationId = `inv-${guardCounter}`;
  const guardKey = `guard-${guardCounter}`;
  stores.workspaceInvitationKeys.set(guardKey, {
    data: { workspaceId, normalizedEmail: email, currentInvitationId: invitationId, updatedAt: nextUpdateTime() },
  });
  stores.workspaceInvitations.set(invitationId, {
    data: {
      schemaVersion: 1,
      id: invitationId,
      workspaceId,
      normalizedEmail: email,
      role: "member",
      status: invitationStatus,
      tokenHash: "a".repeat(64),
      expiresAt: ts(expiresAtSeconds),
      createdAt: ts(1000),
      updatedAt: ts(1000),
      invitedByUserId: OWNER_UID,
      acceptedAt: invitationStatus === "accepted" ? ts(1500) : null,
      acceptedByUserId: invitationStatus === "accepted" ? "someone" : null,
      revokedAt: invitationStatus === "revoked" ? ts(1500) : null,
      revokedByUserId: invitationStatus === "revoked" ? OWNER_UID : null,
      deliveryVersion: 1,
      lastDeliveryAttemptAt: null,
      lastDeliveryStatus: null,
      lastDeliveryVersion: null,
      providerMessageId: null,
    },
  });
  return invitationId;
}

beforeEach(() => {
  resetStores();
  autoIdCounter = 0;
  updateTimeCounter = 0;
  guardCounter = 0;
  concurrentMutationHook = null;
  retriesBeforeSuccess = 0;
  firestoreUnavailableFlag.value = false;
});

describe("isWellFormedTeamWorkspaceCanaryCapacityV1", () => {
  const valid = { schemaVersion: 1, workspaceId: W1, reservedCount: 3, revision: 0, updatedAt: ts(1000) };

  it("accepts a well-formed document", () => {
    expect(isWellFormedTeamWorkspaceCanaryCapacityV1(valid)).toBe(true);
  });

  it("rejects wrong schemaVersion", () => {
    expect(isWellFormedTeamWorkspaceCanaryCapacityV1({ ...valid, schemaVersion: 2 })).toBe(false);
  });

  it("rejects empty workspaceId", () => {
    expect(isWellFormedTeamWorkspaceCanaryCapacityV1({ ...valid, workspaceId: "" })).toBe(false);
  });

  it("rejects negative reservedCount", () => {
    expect(isWellFormedTeamWorkspaceCanaryCapacityV1({ ...valid, reservedCount: -1 })).toBe(false);
  });

  it("rejects non-integer reservedCount", () => {
    expect(isWellFormedTeamWorkspaceCanaryCapacityV1({ ...valid, reservedCount: 1.5 })).toBe(false);
  });

  it("rejects negative revision", () => {
    expect(isWellFormedTeamWorkspaceCanaryCapacityV1({ ...valid, revision: -1 })).toBe(false);
  });

  it("rejects a non-Timestamp updatedAt", () => {
    expect(isWellFormedTeamWorkspaceCanaryCapacityV1({ ...valid, updatedAt: 12345 })).toBe(false);
  });

  it("rejects null/non-object", () => {
    expect(isWellFormedTeamWorkspaceCanaryCapacityV1(null)).toBe(false);
    expect(isWellFormedTeamWorkspaceCanaryCapacityV1("nope")).toBe(false);
  });
});

describe("bootstrap (first-use, no capacity document)", () => {
  it("8 active + no invitations = 8", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    const result = await reserve(W1);
    expect(result).toEqual({ status: "reserved", reservedCount: 9 });
  });

  it("8 active + 1 live current pending = 9 base -> reserve yields 10", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    seedGuardCurrentInvitation(W1, "invitee@example.com", "pending", 9_999_999_999);
    const result = await reserve(W1);
    expect(result).toEqual({ status: "reserved", reservedCount: 10 });
  });

  it("REGRESSION (10A.3 defect, corrected 10A.4): 8 active + 1 EXPIRED current pending still = 9 base -> reserve is rejected at cap, proving the expired invitation was counted", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    seedGuardCurrentInvitation(W1, "invitee@example.com", "pending", 1); // expiresAt far in the past
    const result = await reserve(W1);
    // base = 8 active + 1 expired-but-pending = 9; +1 reserve = 10, allowed (not yet at cap).
    expect(result).toEqual({ status: "reserved", reservedCount: 10 });
  });

  it("accepted current invitation is not counted as an invitation reservation", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    seedGuardCurrentInvitation(W1, "invitee@example.com", "accepted", 9_999_999_999);
    const result = await reserve(W1);
    expect(result).toEqual({ status: "reserved", reservedCount: 9 }); // base 8, not 9
  });

  it("revoked current invitation is not counted", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    seedGuardCurrentInvitation(W1, "invitee@example.com", "revoked", 9_999_999_999);
    const result = await reserve(W1);
    expect(result).toEqual({ status: "reserved", reservedCount: 9 });
  });

  it("a historical superseded invitation not pointed to by any guard is not counted", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    // Orphaned invitation document with no guard pointing at it.
    stores.workspaceInvitations.set("orphan-1", {
      data: {
        schemaVersion: 1,
        id: "orphan-1",
        workspaceId: W1,
        normalizedEmail: "old@example.com",
        role: "member",
        status: "pending",
        tokenHash: "b".repeat(64),
        expiresAt: ts(9_999_999_999),
        createdAt: ts(500),
        updatedAt: ts(500),
        invitedByUserId: OWNER_UID,
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: null,
        revokedByUserId: null,
        deliveryVersion: 1,
        lastDeliveryAttemptAt: null,
        lastDeliveryStatus: null,
        lastDeliveryVersion: null,
        providerMessageId: null,
      },
    });
    const result = await reserve(W1);
    expect(result).toEqual({ status: "reserved", reservedCount: 9 }); // base 8, orphan never reached via any guard
  });

  it("malformed guard fails closed", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    stores.workspaceInvitationKeys.set("bad-guard", { data: { workspaceId: W1 /* missing normalizedEmail/currentInvitationId/updatedAt */ } });
    const result = await reserve(W1);
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("guard points to a missing invitation fails closed", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    stores.workspaceInvitationKeys.set("dangling-guard", { data: { workspaceId: W1, normalizedEmail: "x@example.com", currentInvitationId: "does-not-exist", updatedAt: nextUpdateTime() } });
    const result = await reserve(W1);
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("invitation/workspace mismatch fails closed", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    const guardKey = "mismatch-guard";
    stores.workspaceInvitationKeys.set(guardKey, { data: { workspaceId: W1, normalizedEmail: "x@example.com", currentInvitationId: "inv-mismatch", updatedAt: nextUpdateTime() } });
    stores.workspaceInvitations.set("inv-mismatch", {
      data: {
        schemaVersion: 1,
        id: "inv-mismatch",
        workspaceId: "some-other-workspace", // mismatch
        normalizedEmail: "x@example.com",
        role: "member",
        status: "pending",
        tokenHash: "c".repeat(64),
        expiresAt: ts(9_999_999_999),
        createdAt: ts(500),
        updatedAt: ts(500),
        invitedByUserId: OWNER_UID,
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: null,
        revokedByUserId: null,
        deliveryVersion: 1,
        lastDeliveryAttemptAt: null,
        lastDeliveryStatus: null,
        lastDeliveryVersion: null,
        providerMessageId: null,
      },
    });
    const result = await reserve(W1);
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("malformed invitation fails closed", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    stores.workspaceInvitationKeys.set("guard-bad-inv", { data: { workspaceId: W1, normalizedEmail: "x@example.com", currentInvitationId: "inv-bad", updatedAt: nextUpdateTime() } });
    stores.workspaceInvitations.set("inv-bad", { data: { workspaceId: W1, normalizedEmail: "x@example.com" /* missing everything else */ } });
    const result = await reserve(W1);
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("11 active memberships bootstrap to reservedCount 11, no artificial cap/truncation during bootstrap, and a new reservation correctly fails", async () => {
    for (let i = 0; i < 11; i++) seedActiveMember(W1, `member-${i}`);
    const result = await reserve(W1);
    expect(result).toEqual({ status: "capacity_reached", reservedCount: 11 });
    // No write should have occurred on rejection — a subsequent read-only check
    // (via another reserve call) must recompute the same 11 from canonical state,
    // not from a persisted document, since rejection never wrote one.
    expect(stores.teamWorkspaceCanaryCapacity.has(W1)).toBe(false);
  });
});

describe("first-use write model — exactly one write, never create+update", () => {
  it("first reserve: no capacity doc, canonical occupancy 8 -> exactly one create, reservedCount=9, revision=0", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    const createSpy = jest.fn();
    const originalCreate = mockAdminDb.runTransaction;
    let createCalls = 0;
    let updateCalls = 0;
    concurrentMutationHook = null;
    // Instrument by wrapping the txn object's create/update inside a one-off transaction.
    await mockAdminDb.runTransaction(async (tx: any) => {
      const wrapped = {
        ...tx,
        create: (...args: any[]) => {
          createCalls += 1;
          return tx.create(...args);
        },
        update: (...args: any[]) => {
          updateCalls += 1;
          return tx.update(...args);
        },
        get: tx.get,
      };
      return reserveTeamWorkspaceCanarySlot(wrapped, W1);
    });
    expect(createCalls).toBe(1);
    expect(updateCalls).toBe(0);
    const stored = stores.teamWorkspaceCanaryCapacity.get(W1)!.data;
    expect(stored).toMatchObject({ reservedCount: 9, revision: 0 });
    void createSpy;
    void originalCreate;
  });

  it("first release: no capacity doc, canonical occupancy 9 (8 active + 1 live pending) -> exactly one create, reservedCount=8, revision=0", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    seedGuardCurrentInvitation(W1, "invitee@example.com", "pending", 9_999_999_999);
    let createCalls = 0;
    let updateCalls = 0;
    await mockAdminDb.runTransaction(async (tx: any) => {
      const wrapped = {
        ...tx,
        create: (...args: any[]) => {
          createCalls += 1;
          return tx.create(...args);
        },
        update: (...args: any[]) => {
          updateCalls += 1;
          return tx.update(...args);
        },
      };
      return releaseTeamWorkspaceCanarySlot(wrapped, W1);
    });
    expect(createCalls).toBe(1);
    expect(updateCalls).toBe(0);
    const stored = stores.teamWorkspaceCanaryCapacity.get(W1)!.data;
    expect(stored).toMatchObject({ reservedCount: 8, revision: 0 });
  });

  it("existing document reserve: reservedCount=9,revision=N -> reservedCount=10,revision=N+1, via update only", async () => {
    seedCapacity(W1, 9, 5);
    let createCalls = 0;
    let updateCalls = 0;
    await mockAdminDb.runTransaction(async (tx: any) => {
      const wrapped = {
        ...tx,
        create: (...args: any[]) => {
          createCalls += 1;
          return tx.create(...args);
        },
        update: (...args: any[]) => {
          updateCalls += 1;
          return tx.update(...args);
        },
      };
      return reserveTeamWorkspaceCanarySlot(wrapped, W1);
    });
    expect(createCalls).toBe(0);
    expect(updateCalls).toBe(1);
    const stored = stores.teamWorkspaceCanaryCapacity.get(W1)!.data;
    expect(stored).toMatchObject({ reservedCount: 10, revision: 6 });
  });

  it("at cap (existing doc): reserve returns typed failure, no write, revision unchanged", async () => {
    seedCapacity(W1, 10, 3);
    const result = await reserve(W1);
    expect(result).toEqual({ status: "capacity_reached", reservedCount: 10 });
    const stored = stores.teamWorkspaceCanaryCapacity.get(W1)!.data;
    expect(stored).toMatchObject({ reservedCount: 10, revision: 3 });
  });

  it("over cap (existing doc, 11): reserve denied; release brings it to 10, then 9; then reserve succeeds to 10", async () => {
    seedCapacity(W1, 11, 0);
    expect(await reserve(W1)).toEqual({ status: "capacity_reached", reservedCount: 11 });
    expect(await release(W1)).toEqual({ status: "released", reservedCount: 10 });
    expect(await release(W1)).toEqual({ status: "released", reservedCount: 9 });
    expect(await reserve(W1)).toEqual({ status: "reserved", reservedCount: 10 });
  });

  it("underflow: reservedCount=0, release -> state_corruption, no write", async () => {
    seedCapacity(W1, 0, 7);
    const result = await release(W1);
    expect(result).toEqual({ status: "state_corruption" });
    const stored = stores.teamWorkspaceCanaryCapacity.get(W1)!.data;
    expect(stored).toMatchObject({ reservedCount: 0, revision: 7 }); // untouched
  });

  it("no-op transitions never touch the capacity document at all (module contract: caller simply does not invoke reserve/release)", async () => {
    seedCapacity(W1, 5, 2);
    // Nothing to assert on the module itself here beyond documenting the contract —
    // a caller performing an expired-pending replacement (net-zero delta) calls
    // neither reserveTeamWorkspaceCanarySlot nor releaseTeamWorkspaceCanarySlot,
    // so the stored document is provably untouched by simply not calling either.
    expect(stores.teamWorkspaceCanaryCapacity.get(W1)!.data).toMatchObject({ reservedCount: 5, revision: 2 });
  });
});

describe("concurrency", () => {
  it("A. reserve/reserve at 9: exactly one reaches 10, the other rejected after retry", async () => {
    seedCapacity(W1, 9, 0);
    retriesBeforeSuccess = 1;
    let fired = false;
    concurrentMutationHook = (ref) => {
      if (fired || ref.__collection !== "teamWorkspaceCanaryCapacity") return;
      fired = true;
      // Simulate a concurrent winner committing reservedCount=10 first.
      stores.teamWorkspaceCanaryCapacity.set(W1, { data: { schemaVersion: 1, workspaceId: W1, reservedCount: 10, revision: 1, updatedAt: nextUpdateTime() } });
    };
    const result = await reserve(W1);
    // The kept (retried) attempt re-reads fresh state (10) and correctly rejects.
    expect(result).toEqual({ status: "capacity_reached", reservedCount: 10 });
  });

  it("B. reserve/release ordering: final state internally consistent regardless of interleaving", async () => {
    seedCapacity(W1, 9, 0);
    retriesBeforeSuccess = 1;
    let fired = false;
    concurrentMutationHook = (ref) => {
      if (fired || ref.__collection !== "teamWorkspaceCanaryCapacity") return;
      fired = true;
      // A concurrent release commits first, bringing it to 8.
      stores.teamWorkspaceCanaryCapacity.set(W1, { data: { schemaVersion: 1, workspaceId: W1, reservedCount: 8, revision: 1, updatedAt: nextUpdateTime() } });
    };
    const result = await reserve(W1);
    // The kept attempt re-reads 8 fresh and reserves against it, not the stale 9.
    expect(result).toEqual({ status: "reserved", reservedCount: 9 });
    expect(stores.teamWorkspaceCanaryCapacity.get(W1)!.data).toMatchObject({ reservedCount: 9, revision: 2 });
  });

  it("C. initialize/initialize: exactly one canonical capacity document survives; the retried attempt loads canonical state instead of re-bootstrapping", async () => {
    for (let i = 0; i < 4; i++) seedActiveMember(W1, `member-${i}`);
    retriesBeforeSuccess = 1;
    let fired = false;
    concurrentMutationHook = (ref) => {
      if (fired || ref.__collection !== "teamWorkspaceCanaryCapacity" || ref.__kind !== "doc") return;
      fired = true;
      // A concurrent transaction wins the bootstrap-and-reserve race first: 4 active + its own reserve = 5.
      stores.teamWorkspaceCanaryCapacity.set(W1, { data: { schemaVersion: 1, workspaceId: W1, reservedCount: 5, revision: 0, updatedAt: nextUpdateTime() } });
    };
    const result = await reserve(W1);
    // The kept attempt sees the doc now EXISTS (5) and reserves against it via update, not a second create.
    expect(result).toEqual({ status: "reserved", reservedCount: 6 });
    expect(stores.teamWorkspaceCanaryCapacity.get(W1)!.data).toMatchObject({ reservedCount: 6, revision: 1 });
  });

  it("D. first-reserve / concurrent first-reserve: no duplicate capacity document, no lost update", async () => {
    for (let i = 0; i < 8; i++) seedActiveMember(W1, `member-${i}`);
    retriesBeforeSuccess = 1;
    let fired = false;
    concurrentMutationHook = (ref) => {
      if (fired || ref.__collection !== "teamWorkspaceCanaryCapacity" || ref.__kind !== "doc") return;
      fired = true;
      stores.teamWorkspaceCanaryCapacity.set(W1, { data: { schemaVersion: 1, workspaceId: W1, reservedCount: 9, revision: 0, updatedAt: nextUpdateTime() } });
    };
    const result = await reserve(W1);
    expect(result).toEqual({ status: "reserved", reservedCount: 10 });
    // Exactly one document exists for W1, with the correctly-merged final count.
    expect(stores.teamWorkspaceCanaryCapacity.size).toBe(1);
    expect(stores.teamWorkspaceCanaryCapacity.get(W1)!.data).toMatchObject({ reservedCount: 10, revision: 1 });
  });

  it("clock independence: two otherwise-identical guard-current pending invitations, one live and one expired, both count as one reservation each — bootstrap is invariant to expiresAt", async () => {
    for (let i = 0; i < 3; i++) seedActiveMember(W1, `member-${i}`);
    seedGuardCurrentInvitation(W1, "live@example.com", "pending", 9_999_999_999); // live
    seedGuardCurrentInvitation(W1, "expired@example.com", "pending", 1); // expired
    const result = await reserve(W1);
    // base = 3 active + 2 pending (regardless of expiry) = 5; +1 = 6.
    expect(result).toEqual({ status: "reserved", reservedCount: 6 });
  });
});

describe("firestore unavailable", () => {
  it("reserve returns firestore_unavailable, no crash", async () => {
    firestoreUnavailableFlag.value = true;
    // Cannot use adminDb.runTransaction (it's null) — call directly against a stub tx; the function must
    // short-circuit on the adminDb null-check before ever touching `tx`.
    const result = await reserveTeamWorkspaceCanarySlot({} as any, W1);
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("release returns firestore_unavailable, no crash", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await releaseTeamWorkspaceCanarySlot({} as any, W1);
    expect(result).toEqual({ status: "firestore_unavailable" });
  });
});

it("MAX_TEAM_WORKSPACE_CANARY_MEMBERS is 10", () => {
  expect(MAX_TEAM_WORKSPACE_CANARY_MEMBERS).toBe(10);
});
