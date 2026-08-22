/**
 * Team Workspace Invitations, Phase 8D.1 —
 * `recordWorkspaceInvitationDeliveryResult()` tests. No provider/network
 * call exists in this module — every test asserts pure Firestore
 * transaction behavior.
 */

import { Timestamp } from "firebase-admin/firestore";

let updateTimeCounter = 0;
function nextUpdateTime(): Timestamp {
  updateTimeCounter += 1;
  return new Timestamp(1_700_000_000 + updateTimeCounter, 0);
}

type StoredDoc = { data: Record<string, unknown>; updateTime: Timestamp };
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaceInvitations: new Map(),
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

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId: string) => makeDocRef(name, docId),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    const pendingWrites: Array<() => void> = [];
    const txn = {
      get: async (ref: { __collection: string; __id: string }) => {
        const store = stores[ref.__collection];
        const entry = store.get(ref.__id);
        return { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime };
      },
      update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
        const store = stores[ref.__collection];
        const entry = store.get(ref.__id);
        if (!entry) throw new FirestoreError("5", "NOT_FOUND");
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

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { recordWorkspaceInvitationDeliveryResult } from "@/lib/firestore/workspaceInvitationDelivery";

function ts(seconds: number): Timestamp {
  return new Timestamp(seconds, 0);
}

function seedInvitation(id: string, overrides: Record<string, unknown> = {}) {
  const data = {
    schemaVersion: 1,
    id,
    workspaceId: "ws-1",
    normalizedEmail: "user@example.com",
    role: "member",
    status: "pending",
    tokenHash: "a".repeat(64),
    expiresAt: ts(9_000_000_000),
    createdAt: ts(1000),
    updatedAt: ts(1000),
    invitedByUserId: "owner-1",
    acceptedAt: null,
    acceptedByUserId: null,
    revokedAt: null,
    revokedByUserId: null,
    deliveryVersion: 2,
    lastDeliveryAttemptAt: null,
    lastDeliveryStatus: null,
    lastDeliveryVersion: null,
    providerMessageId: null,
    ...overrides,
  };
  stores.workspaceInvitations.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

beforeEach(() => {
  resetStores();
  firestoreUnavailableFlag.value = false;
  mockAdminDb.runTransaction.mockClear();
});

describe("recordWorkspaceInvitationDeliveryResult", () => {
  it("v2 success while current deliveryVersion is 2 -> metadata updated", async () => {
    seedInvitation("inv-1", { deliveryVersion: 2 });
    const result = await recordWorkspaceInvitationDeliveryResult({ invitationId: "inv-1", deliveryVersion: 2, status: "sent", providerMessageId: "msg-1" });
    expect(result).toEqual({ status: "recorded" });
    const stored = stores.workspaceInvitations.get("inv-1")!.data as any;
    expect(stored.lastDeliveryStatus).toBe("sent");
    expect(stored.lastDeliveryVersion).toBe(2);
    expect(stored.providerMessageId).toBe("msg-1");
    expect(stored.lastDeliveryAttemptAt).toBeInstanceOf(Timestamp);
  });

  it("v2 failure while current deliveryVersion is 2 -> metadata updated as failed", async () => {
    seedInvitation("inv-1", { deliveryVersion: 2 });
    const result = await recordWorkspaceInvitationDeliveryResult({ invitationId: "inv-1", deliveryVersion: 2, status: "failed", providerMessageId: null });
    expect(result).toEqual({ status: "recorded" });
    const stored = stores.workspaceInvitations.get("inv-1")!.data as any;
    expect(stored.lastDeliveryStatus).toBe("failed");
    expect(stored.providerMessageId).toBeNull();
  });

  it("v2 result arrives after the invitation has already advanced to v3 -> stale_delivery_result, v3 metadata untouched", async () => {
    seedInvitation("inv-1", { deliveryVersion: 3, lastDeliveryStatus: "sent", lastDeliveryVersion: 3, providerMessageId: "v3-msg" });
    const before = stores.workspaceInvitations.get("inv-1")!.data;
    const result = await recordWorkspaceInvitationDeliveryResult({ invitationId: "inv-1", deliveryVersion: 2, status: "sent", providerMessageId: "v2-msg-late" });
    expect(result).toEqual({ status: "stale_delivery_result" });
    expect(stores.workspaceInvitations.get("inv-1")!.data).toEqual(before); // completely untouched
  });

  it("a stale result changes zero fields: tokenHash, expiresAt, deliveryVersion, status all untouched", async () => {
    seedInvitation("inv-1", { deliveryVersion: 3, tokenHash: "b".repeat(64), status: "pending" });
    const before = stores.workspaceInvitations.get("inv-1")!.data;
    await recordWorkspaceInvitationDeliveryResult({ invitationId: "inv-1", deliveryVersion: 1, status: "sent", providerMessageId: "old" });
    expect(stores.workspaceInvitations.get("inv-1")!.data).toEqual(before);
  });

  it("malformed invitation -> state_corruption, fails closed", async () => {
    stores.workspaceInvitations.set("inv-1", { data: { id: "inv-1" }, updateTime: nextUpdateTime() });
    const result = await recordWorkspaceInvitationDeliveryResult({ invitationId: "inv-1", deliveryVersion: 1, status: "sent", providerMessageId: null });
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("missing invitation -> invitation_not_found", async () => {
    const result = await recordWorkspaceInvitationDeliveryResult({ invitationId: "does-not-exist", deliveryVersion: 1, status: "sent", providerMessageId: null });
    expect(result).toEqual({ status: "invitation_not_found" });
  });

  it("invalid input: non-positive-integer deliveryVersion", async () => {
    for (const bad of [0, -1, 1.5, "1", null, undefined]) {
      const result = await recordWorkspaceInvitationDeliveryResult({ invitationId: "inv-1", deliveryVersion: bad, status: "sent", providerMessageId: null });
      expect(result).toEqual({ status: "invalid_input" });
    }
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("invalid input: bad status value", async () => {
    const result = await recordWorkspaceInvitationDeliveryResult({ invitationId: "inv-1", deliveryVersion: 1, status: "delivered", providerMessageId: null });
    expect(result).toEqual({ status: "invalid_input" });
  });

  it("invalid input: providerMessageId neither null nor a non-empty string", async () => {
    const result = await recordWorkspaceInvitationDeliveryResult({ invitationId: "inv-1", deliveryVersion: 1, status: "sent", providerMessageId: "" });
    expect(result).toEqual({ status: "invalid_input" });
  });

  it("providerMessageId is not required on a failed delivery", async () => {
    seedInvitation("inv-1", { deliveryVersion: 1 });
    const result = await recordWorkspaceInvitationDeliveryResult({ invitationId: "inv-1", deliveryVersion: 1, status: "failed", providerMessageId: null });
    expect(result).toEqual({ status: "recorded" });
  });

  it("no provider/network call is ever made — this module performs Firestore access only", async () => {
    seedInvitation("inv-1", { deliveryVersion: 1 });
    await recordWorkspaceInvitationDeliveryResult({ invitationId: "inv-1", deliveryVersion: 1, status: "sent", providerMessageId: "msg" });
    expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1);
  });

  it("firestore unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await recordWorkspaceInvitationDeliveryResult({ invitationId: "inv-1", deliveryVersion: 1, status: "sent", providerMessageId: null });
    expect(result).toEqual({ status: "firestore_unavailable" });
  });

  it("a genuine transaction failure reports record_failed", async () => {
    seedInvitation("inv-1", { deliveryVersion: 1 });
    mockAdminDb.runTransaction.mockImplementationOnce(async () => {
      throw new Error("simulated failure");
    });
    const result = await recordWorkspaceInvitationDeliveryResult({ invitationId: "inv-1", deliveryVersion: 1, status: "sent", providerMessageId: null });
    expect(result).toEqual({ status: "record_failed" });
  });
});
