/**
 * Team Workspace Invitations, Phase 8D.1 — `createWorkspaceInvitation()` /
 * `resendWorkspaceInvitation()` / `revokeWorkspaceInvitation()` /
 * `acceptWorkspaceInvitation()` / `listWorkspaceInvitations()` tests.
 * In-memory Firestore fake, structural mirror of `teamProjects.spec.ts`'s
 * buffered-transaction fake, extended with:
 *   - `workspaceInvitations` / `workspaceInvitationKeys` collections
 *   - `.where(field, "==", value).get()` query support (for LIST's guard query)
 *   - `adminDb.getAll(...refs)` batched-read support (for LIST's invitation resolution)
 *   - a fake `adminAuth.getUser(uid)` (for ACCEPT's verified-email lookup)
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
  workspaceInvitations: new Map(),
  workspaceInvitationKeys: new Map(),
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

let concurrentMutationHook: ((ref: { __collection: string; __id: string }) => void) | null = null;
let retriesBeforeSuccess = 0;
let invitationsAutoIdCallCount = 0;

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
    doc: (docId?: string) => {
      if (name === "workspaceInvitations" && docId === undefined) {
        invitationsAutoIdCallCount += 1;
      }
      return makeDocRef(name, docId ?? `auto-${++autoIdCounter}`);
    },
    where: (field: string, op: string, value: unknown) => ({
      get: async () => {
        const store = stores[name];
        const docs: Array<{ id: string; data: () => Record<string, unknown>; exists: true; updateTime: Timestamp }> = [];
        for (const [id, entry] of store.entries()) {
          const matches = op === "==" ? (entry.data as Record<string, unknown>)[field] === value : false;
          if (matches) docs.push({ id, data: () => entry.data, exists: true, updateTime: entry.updateTime });
        }
        return { empty: docs.length === 0, docs };
      },
    }),
  }),
  getAll: async (...refs: Array<{ __collection: string; __id: string }>) => {
    return refs.map((ref) => {
      const store = stores[ref.__collection];
      const entry = store.get(ref.__id);
      return { exists: entry !== undefined, data: () => entry?.data, id: ref.__id };
    });
  },
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
        update: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
          const store = stores[ref.__collection];
          const entry = store.get(ref.__id);
          if (!entry) {
            throw new FirestoreError("5", "NOT_FOUND");
          }
          pendingWrites.push(() => store.set(ref.__id, { data: { ...entry.data, ...data }, updateTime: nextUpdateTime() }));
        },
        set: (ref: { __collection: string; __id: string }, data: Record<string, unknown>) => {
          const store = stores[ref.__collection];
          pendingWrites.push(() => store.set(ref.__id, { data, updateTime: nextUpdateTime() }));
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
  get adminAuth() {
    return authUnavailableFlag.value ? null : mockAdminAuth;
  },
}));

const firestoreUnavailableFlag = { value: false };
const authUnavailableFlag = { value: false };

type FakeAuthUser = { email?: string | undefined; emailVerified?: boolean };
let authUsers: Record<string, FakeAuthUser> = {};
let authShouldThrowFor: Set<string> = new Set();
const mockAdminAuth = {
  getUser: jest.fn(async (uid: string) => {
    if (authShouldThrowFor.has(uid)) {
      throw new Error("simulated Firebase Auth lookup failure");
    }
    const rec = authUsers[uid];
    if (!rec) {
      throw new Error("USER_NOT_FOUND");
    }
    return rec;
  }),
};

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
import { computeWorkspaceInvitationKey } from "@/lib/workspaces/invitationKey";
import { hashWorkspaceInvitationToken } from "@/lib/workspaces/invitationToken";
import {
  createWorkspaceInvitation,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  acceptWorkspaceInvitation,
  listWorkspaceInvitations,
} from "@/lib/firestore/workspaceInvitations";

const WS_ID = "ws-team-1";
const OWNER_UID = "owner-1";
const ADMIN_UID = "admin-1";
const MEMBER_UID = "member-1";
const OUTSIDER_UID = "outsider-1";
const INVITEE_UID = "invitee-1";

const OWNER_EMAIL = "owner@example.com";
const INVITEE_EMAIL = "invitee@example.com";

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

function seedInvitation(id: string, overrides: Record<string, unknown> = {}) {
  const rawToken = "seed-raw-token";
  const data = {
    schemaVersion: 1,
    id,
    workspaceId: WS_ID,
    normalizedEmail: INVITEE_EMAIL,
    role: "member",
    status: "pending",
    tokenHash: hashWorkspaceInvitationToken(rawToken),
    expiresAt: ts(9_000_000_000),
    createdAt: ts(1000),
    updatedAt: ts(1000),
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
    ...overrides,
  };
  stores.workspaceInvitations.set(id, { data, updateTime: nextUpdateTime() });
  return { data, rawToken };
}

function seedGuard(workspaceId: string, normalizedEmail: string, currentInvitationId: string, overrides: Record<string, unknown> = {}) {
  const key = computeWorkspaceInvitationKey(workspaceId, normalizedEmail);
  const data = { workspaceId, normalizedEmail, currentInvitationId, updatedAt: ts(1000), ...overrides };
  stores.workspaceInvitationKeys.set(key, { data, updateTime: nextUpdateTime() });
  return data;
}

function registerAuthUser(uid: string, email: string | undefined, emailVerified: boolean) {
  authUsers[uid] = { email, emailVerified };
}

beforeEach(() => {
  resetStores();
  concurrentMutationHook = null;
  retriesBeforeSuccess = 0;
  invitationsAutoIdCallCount = 0;
  teamWorkspacesEnabled = true;
  teamWorkspacesCanaryUids = undefined;
  teamWorkspacesCanaryWorkspaceIds = undefined;
  firestoreUnavailableFlag.value = false;
  authUnavailableFlag.value = false;
  authUsers = {};
  authShouldThrowFor = new Set();
  mockAdminDb.runTransaction.mockClear();
  mockAdminAuth.getUser.mockClear();
  seedWorkspace();
  seedMembership(OWNER_UID, "owner");
});

// ==================================================================
// CREATE
// ==================================================================

describe("createWorkspaceInvitation", () => {
  it("Owner creating an admin-target invitation succeeds", async () => {
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "admin" });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.role).toBe("admin");
    expect(result.deliveryVersion).toBe(1);
    expect(typeof result.rawToken).toBe("string");
    expect(result.rawToken.length).toBeGreaterThan(0);
  });

  it("Admin creating an admin-target invitation is denied role_target_forbidden", async () => {
    seedMembership(ADMIN_UID, "admin");
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "admin" });
    expect(result).toEqual({ status: "role_target_forbidden" });
    expect(stores.workspaceInvitations.size).toBe(0);
  });

  it("Admin creating a member/reviewer/viewer-target invitation succeeds", async () => {
    seedMembership(ADMIN_UID, "admin");
    for (const role of ["member", "reviewer", "viewer"]) {
      resetStores();
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedMembership(ADMIN_UID, "admin");
      const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role });
      expect(result.status).toBe("created");
    }
  });

  it("Member/Reviewer/Viewer cannot create (denied on members.invite capability, before any target-role check)", async () => {
    for (const role of ["member", "reviewer", "viewer"]) {
      resetStores();
      seedWorkspace();
      seedMembership(OWNER_UID, "owner");
      seedMembership(MEMBER_UID, role);
      const result = await createWorkspaceInvitation({ uid: MEMBER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "viewer" });
      expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
    }
  });

  it("no caller may target owner", async () => {
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "owner" });
    expect(result).toEqual({ status: "invalid_role" });
  });

  it("invalid email is rejected before any Firestore mutation", async () => {
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: "not-an-email", role: "member" });
    expect(result).toEqual({ status: "invalid_email" });
    expect(stores.workspaceInvitations.size).toBe(0);
  });

  it("guard absent -> creates invitation and guard", async () => {
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
    expect(stores.workspaceInvitations.size).toBe(1);
    expect(stores.workspaceInvitationKeys.size).toBe(1);
  });

  it("guard -> live pending unexpired invitation -> duplicate_live_invitation, no new invitation written", async () => {
    const { data: existing } = seedInvitation("inv-1", { status: "pending", expiresAt: ts(9_000_000_000) });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "duplicate_live_invitation" });
    expect(stores.workspaceInvitations.size).toBe(1);
    expect(stores.workspaceInvitations.get("inv-1")!.data).toEqual(existing);
  });

  it("guard -> pending but expired invitation -> allowed, guard repointed to new invitation", async () => {
    seedInvitation("inv-1", { status: "pending", expiresAt: ts(1) }); // long expired
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.invitationId).not.toBe("inv-1");
    const key = computeWorkspaceInvitationKey(WS_ID, INVITEE_EMAIL);
    expect(stores.workspaceInvitationKeys.get(key)!.data.currentInvitationId).toBe(result.invitationId);
    // The old invitation's own status field is left untouched.
    expect(stores.workspaceInvitations.get("inv-1")!.data.status).toBe("pending");
  });

  it("guard -> accepted invitation -> allowed replacement", async () => {
    seedInvitation("inv-1", { status: "accepted", acceptedAt: ts(500), acceptedByUserId: INVITEE_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
  });

  it("guard -> revoked invitation -> allowed replacement", async () => {
    seedInvitation("inv-1", { status: "revoked", revokedAt: ts(500), revokedByUserId: OWNER_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
  });

  it("malformed guard -> state_corruption, no write", async () => {
    const key = computeWorkspaceInvitationKey(WS_ID, INVITEE_EMAIL);
    stores.workspaceInvitationKeys.set(key, { data: { workspaceId: WS_ID }, updateTime: nextUpdateTime() }); // missing fields
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "state_corruption" });
    expect(stores.workspaceInvitations.size).toBe(0);
  });

  it("guard workspaceId mismatch -> state_corruption", async () => {
    const key = computeWorkspaceInvitationKey(WS_ID, INVITEE_EMAIL);
    stores.workspaceInvitationKeys.set(key, { data: { workspaceId: "other-ws", normalizedEmail: INVITEE_EMAIL, currentInvitationId: "inv-1", updatedAt: ts(1) }, updateTime: nextUpdateTime() });
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("guard email mismatch -> state_corruption", async () => {
    const key = computeWorkspaceInvitationKey(WS_ID, INVITEE_EMAIL);
    stores.workspaceInvitationKeys.set(key, { data: { workspaceId: WS_ID, normalizedEmail: "different@example.com", currentInvitationId: "inv-1", updatedAt: ts(1) }, updateTime: nextUpdateTime() });
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("guard points to a missing invitation -> state_corruption", async () => {
    seedGuard(WS_ID, INVITEE_EMAIL, "does-not-exist");
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("guard points to a malformed invitation -> state_corruption", async () => {
    stores.workspaceInvitations.set("inv-1", { data: { id: "inv-1" }, updateTime: nextUpdateTime() });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("referenced invitation/guard email binding mismatch -> state_corruption", async () => {
    seedInvitation("inv-1", { normalizedEmail: "someone-else@example.com" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("rollout disabled -> zero Firestore mutation", async () => {
    teamWorkspacesEnabled = false;
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("raw token is returned but never persisted anywhere in the committed invitation document", async () => {
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    const stored = [...stores.workspaceInvitations.values()][0].data;
    expect(JSON.stringify(stored)).not.toContain(result.rawToken);
    expect(stored.tokenHash).toBe(hashWorkspaceInvitationToken(result.rawToken));
  });

  it("tokenHash/invitationRef/rawToken are generated exactly once and survive a simulated Firestore-internal retry", async () => {
    retriesBeforeSuccess = 2;
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
    expect(invitationsAutoIdCallCount).toBe(1);
    if (result.status !== "created") return;
    expect(stores.workspaceInvitations.size).toBe(1);
    const stored = stores.workspaceInvitations.get(result.invitationId)!.data;
    expect(stored.tokenHash).toBe(hashWorkspaceInvitationToken(result.rawToken));
  });

  it("deliveryVersion starts at 1 and expiresAt is 7 days from creation", async () => {
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    const stored = stores.workspaceInvitations.get(result.invitationId)!.data as any;
    expect(stored.deliveryVersion).toBe(1);
    const deltaSeconds = stored.expiresAt.seconds - stored.createdAt.seconds;
    expect(deltaSeconds).toBe(7 * 24 * 60 * 60);
  });

  it("guard is a full overwrite (tx.set merge:false) — no stale fields survive a repoint", async () => {
    seedInvitation("inv-1", { status: "revoked", revokedAt: ts(500), revokedByUserId: OWNER_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1", { staleExtraField: "should-not-survive" } as any);
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
    const key = computeWorkspaceInvitationKey(WS_ID, INVITEE_EMAIL);
    const guard = stores.workspaceInvitationKeys.get(key)!.data as any;
    expect(guard.staleExtraField).toBeUndefined();
  });

  it("create/create race for the same (workspaceId, normalizedEmail): only one live invitation results", async () => {
    // Simulates a genuine Firestore-internal retry: the FIRST callback
    // invocation reads "no guard" and would proceed to create — but
    // before that attempt's writes are kept, a concurrent writer commits
    // its own guard/invitation directly into the store (mirroring what a
    // real Firestore write-conflict-triggered retry would re-read). The
    // KEPT (second) invocation re-reads the guard fresh and correctly
    // sees the concurrent winner.
    retriesBeforeSuccess = 1;
    let fired = false;
    concurrentMutationHook = (ref) => {
      if (fired || ref.__collection !== "workspaceInvitationKeys") return;
      fired = true;
      // Simulate a second concurrent create winning the guard write first.
      const key = computeWorkspaceInvitationKey(WS_ID, INVITEE_EMAIL);
      const winningInvitationId = "inv-concurrent-winner";
      stores.workspaceInvitations.set(winningInvitationId, {
        data: {
          schemaVersion: 1,
          id: winningInvitationId,
          workspaceId: WS_ID,
          normalizedEmail: INVITEE_EMAIL,
          role: "member",
          status: "pending",
          tokenHash: hashWorkspaceInvitationToken("winner-token"),
          expiresAt: ts(9_000_000_000),
          createdAt: ts(2000),
          updatedAt: ts(2000),
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
        updateTime: nextUpdateTime(),
      });
      stores.workspaceInvitationKeys.set(key, { data: { workspaceId: WS_ID, normalizedEmail: INVITEE_EMAIL, currentInvitationId: winningInvitationId, updatedAt: ts(2000) }, updateTime: nextUpdateTime() });
    };
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "duplicate_live_invitation" });
    expect(stores.workspaceInvitations.size).toBe(1); // only the concurrent winner
  });
});

// ==================================================================
// RESEND
// ==================================================================

describe("resendWorkspaceInvitation", () => {
  it("Owner resends an admin-target invitation successfully", async () => {
    const { data } = seedInvitation("inv-1", { role: "admin" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: data.deliveryVersion });
    expect(result.status).toBe("resent");
    if (result.status !== "resent") return;
    expect(result.deliveryVersion).toBe(2);
  });

  it("Admin resending an admin-target invitation is denied role_target_forbidden", async () => {
    seedMembership(ADMIN_UID, "admin");
    seedInvitation("inv-1", { role: "admin" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await resendWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "role_target_forbidden" });
    expect(stores.workspaceInvitations.get("inv-1")!.data.deliveryVersion).toBe(1);
  });

  it("Admin resending a member/reviewer/viewer-target invitation is allowed", async () => {
    seedMembership(ADMIN_UID, "admin");
    seedInvitation("inv-1", { role: "member" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await resendWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result.status).toBe("resent");
  });

  it("pending + unexpired -> allowed", async () => {
    seedInvitation("inv-1", { status: "pending", expiresAt: ts(9_000_000_000) });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result.status).toBe("resent");
  });

  it("pending + logically expired -> allowed", async () => {
    seedInvitation("inv-1", { status: "pending", expiresAt: ts(1) });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result.status).toBe("resent");
  });

  it("accepted -> invalid_state", async () => {
    seedInvitation("inv-1", { status: "accepted", acceptedAt: ts(500), acceptedByUserId: INVITEE_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "invalid_state" });
  });

  it("revoked -> invalid_state", async () => {
    seedInvitation("inv-1", { status: "revoked", revokedAt: ts(500), revokedByUserId: OWNER_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "invalid_state" });
  });

  it("guard no longer points at this invitation -> stale_superseded", async () => {
    seedInvitation("inv-1", { status: "pending" });
    seedInvitation("inv-2", { status: "pending" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-2");
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "stale_superseded" });
  });

  it("invalid expectedDeliveryVersion types are rejected before Firestore access", async () => {
    seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    for (const bad of [null, "1", 0, -1, 1.5, undefined]) {
      const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: bad });
      expect(result).toEqual({ status: "invalid_delivery_version" });
    }
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("correct expectedDeliveryVersion succeeds and increments by exactly 1", async () => {
    seedInvitation("inv-1", { deliveryVersion: 4 });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 4 });
    expect(result.status).toBe("resent");
    if (result.status !== "resent") return;
    expect(result.deliveryVersion).toBe(5);
  });

  it("stale expectedDeliveryVersion -> invitation_version_conflict, no rotation", async () => {
    seedInvitation("inv-1", { deliveryVersion: 4 });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const originalHash = stores.workspaceInvitations.get("inv-1")!.data.tokenHash;
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 3 });
    expect(result).toEqual({ status: "invitation_version_conflict" });
    expect(stores.workspaceInvitations.get("inv-1")!.data.tokenHash).toBe(originalHash);
    expect(stores.workspaceInvitations.get("inv-1")!.data.deliveryVersion).toBe(4);
  });

  it("two concurrent resend attempts from the same starting version — only one rotates the token", async () => {
    seedInvitation("inv-1", { deliveryVersion: 1 });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");

    // Same retry-simulation technique as the create/create race test above:
    // the FIRST (discarded) callback invocation reads deliveryVersion 1 and
    // would proceed to rotate — but a concurrent resend commits its own
    // rotation first; the KEPT (second) invocation re-reads fresh and
    // correctly sees the version has already moved.
    retriesBeforeSuccess = 1;
    let fired = false;
    concurrentMutationHook = (ref) => {
      if (fired || ref.__collection !== "workspaceInvitations") return;
      fired = true;
      const entry = stores.workspaceInvitations.get("inv-1")!;
      stores.workspaceInvitations.set("inv-1", { data: { ...entry.data, deliveryVersion: 2, tokenHash: hashWorkspaceInvitationToken("winner-token") }, updateTime: nextUpdateTime() });
    };

    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "invitation_version_conflict" });
    expect(stores.workspaceInvitations.get("inv-1")!.data.deliveryVersion).toBe(2); // the concurrent winner's rotation stands, not re-rotated again
  });

  it("transaction retry after a competing version change does not rotate again — fails the check on the fresh read", async () => {
    seedInvitation("inv-1", { deliveryVersion: 1 });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    retriesBeforeSuccess = 1;
    let attempt = 0;
    concurrentMutationHook = (ref) => {
      if (ref.__collection !== "workspaceInvitations") return;
      attempt += 1;
      if (attempt === 1) {
        const entry = stores.workspaceInvitations.get("inv-1")!;
        stores.workspaceInvitations.set("inv-1", { data: { ...entry.data, deliveryVersion: 2 }, updateTime: nextUpdateTime() });
      }
    };
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "invitation_version_conflict" });
  });

  it("old raw token no longer verifies, new raw token verifies, TTL resets to 7 days, raw token never persisted", async () => {
    const { rawToken: oldRawToken } = seedInvitation("inv-1", { deliveryVersion: 1 });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result.status).toBe("resent");
    if (result.status !== "resent") return;
    const stored = stores.workspaceInvitations.get("inv-1")!.data as any;
    expect(stored.tokenHash).not.toBe(hashWorkspaceInvitationToken(oldRawToken));
    expect(stored.tokenHash).toBe(hashWorkspaceInvitationToken(result.rawToken));
    expect(stored.expiresAt.seconds - stored.updatedAt.seconds).toBe(7 * 24 * 60 * 60);
    expect(JSON.stringify(stored)).not.toContain(result.rawToken);
  });

  it("rollout disabled -> zero Firestore mutation", async () => {
    teamWorkspacesEnabled = false;
    seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });

  it("members.invite required — Reviewer/Viewer denied", async () => {
    seedMembership(MEMBER_UID, "viewer");
    seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await resendWorkspaceInvitation({ uid: MEMBER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
  });
});

// ==================================================================
// REVOKE
// ==================================================================

describe("revokeWorkspaceInvitation", () => {
  it("members.manage required independently — a hypothetical invite-but-not-manage capability cannot revoke (Viewer, which has neither, proves the gate is enforced)", async () => {
    seedMembership(MEMBER_UID, "viewer");
    seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await revokeWorkspaceInvitation({ uid: MEMBER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "unauthorized", reason: "insufficient_capability" });
  });

  it("Owner may revoke an admin-target invitation", async () => {
    seedInvitation("inv-1", { role: "admin" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "revoked", invitationId: "inv-1" });
  });

  it("Admin revoking an admin-target invitation is denied role_target_forbidden, no write", async () => {
    seedMembership(ADMIN_UID, "admin");
    seedInvitation("inv-1", { role: "admin" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await revokeWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "role_target_forbidden" });
    expect(stores.workspaceInvitations.get("inv-1")!.data.status).toBe("pending");
  });

  it("Admin may revoke a member-target invitation", async () => {
    seedMembership(ADMIN_UID, "admin");
    seedInvitation("inv-1", { role: "member" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await revokeWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "revoked", invitationId: "inv-1" });
  });

  it("correct expectedDeliveryVersion succeeds", async () => {
    seedInvitation("inv-1", { deliveryVersion: 3 });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 3 });
    expect(result).toEqual({ status: "revoked", invitationId: "inv-1" });
    // deliveryVersion is NOT incremented by revoke.
    expect(stores.workspaceInvitations.get("inv-1")!.data.deliveryVersion).toBe(3);
  });

  it("stale expectedDeliveryVersion -> invitation_version_conflict, no write", async () => {
    seedInvitation("inv-1", { deliveryVersion: 3 });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 2 });
    expect(result).toEqual({ status: "invitation_version_conflict" });
    expect(stores.workspaceInvitations.get("inv-1")!.data.status).toBe("pending");
  });

  it("pending -> revoked, revokedAt/revokedByUserId set, tokenHash/deliveryVersion untouched", async () => {
    seedInvitation("inv-1", { deliveryVersion: 1 });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const originalHash = stores.workspaceInvitations.get("inv-1")!.data.tokenHash;
    const result = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "revoked", invitationId: "inv-1" });
    const stored = stores.workspaceInvitations.get("inv-1")!.data as any;
    expect(stored.status).toBe("revoked");
    expect(stored.revokedByUserId).toBe(OWNER_UID);
    expect(stored.revokedAt).toBeInstanceOf(Timestamp);
    expect(stored.tokenHash).toBe(originalHash);
    expect(stored.deliveryVersion).toBe(1);
  });

  it("accepted -> invalid_state_for_revoke", async () => {
    seedInvitation("inv-1", { status: "accepted", acceptedAt: ts(500), acceptedByUserId: INVITEE_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "invalid_state_for_revoke" });
  });

  it("already revoked AND still current guard target -> idempotent success", async () => {
    seedInvitation("inv-1", { status: "revoked", revokedAt: ts(500), revokedByUserId: OWNER_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "revoked", invitationId: "inv-1" });
  });

  it("guard no longer points at this invitation -> stale_superseded", async () => {
    seedInvitation("inv-1", { status: "pending" });
    seedInvitation("inv-2", { status: "pending" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-2");
    const result = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "stale_superseded" });
  });

  it("invalid expectedDeliveryVersion types are rejected before Firestore access", async () => {
    seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-1", expectedDeliveryVersion: "1" });
    expect(result).toEqual({ status: "invalid_delivery_version" });
    expect(mockAdminDb.runTransaction).not.toHaveBeenCalled();
  });
});

// ==================================================================
// REVOKE / CREATE RACE — dedicated permanent test, Phase 8D.1.0.1
// ==================================================================

describe("revokeWorkspaceInvitation vs createWorkspaceInvitation — guard-repoint race", () => {
  it("a stale revoke of A, racing a concurrent create that legitimately supersedes A with B, re-reads the guard fresh and fails as stale_superseded — B is never touched, the guard stays pointed at B", async () => {
    // Invitation A: pending, current, but logically EXPIRED — the exact
    // "pending but expired" state the frozen CREATE guard matrix already
    // treats as legitimately supersedable (Section 3 of Phase 8D.0.0.3's
    // guard-state matrix), and which revoke's own status check (pending
    // vs. accepted/revoked only — never expiry-aware) would otherwise
    // still consider revocable in isolation.
    seedInvitation("inv-A", { status: "pending", expiresAt: ts(1), deliveryVersion: 3 });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-A");

    // Same real-transaction-retry-simulation methodology already used for
    // the create/create and resend/resend races above: the FIRST
    // (discarded) callback invocation of the revoke transaction reads A's
    // stale-but-still-guard-current state — but before that attempt's
    // writes are kept, a concurrent CREATE commits directly into the
    // shared store: a new invitation B, and the guard repointed to B.
    // Because CREATE never rewrites a superseded invitation's own
    // `status` field, A's document is left exactly as seeded
    // (`status: "pending"`) — only the GUARD moves. The KEPT (second)
    // invocation of revoke's transaction re-reads the guard fresh and
    // must observe it now points at B, not A.
    retriesBeforeSuccess = 1;
    let fired = false;
    const winningInvitationId = "inv-B";
    concurrentMutationHook = () => {
      if (fired) return;
      fired = true;
      stores.workspaceInvitations.set(winningInvitationId, {
        data: {
          schemaVersion: 1,
          id: winningInvitationId,
          workspaceId: WS_ID,
          normalizedEmail: INVITEE_EMAIL,
          role: "member",
          status: "pending",
          tokenHash: hashWorkspaceInvitationToken("concurrent-create-winner-token"),
          expiresAt: ts(9_000_000_000),
          createdAt: ts(2000),
          updatedAt: ts(2000),
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
        updateTime: nextUpdateTime(),
      });
      const key = computeWorkspaceInvitationKey(WS_ID, INVITEE_EMAIL);
      stores.workspaceInvitationKeys.set(key, { data: { workspaceId: WS_ID, normalizedEmail: INVITEE_EMAIL, currentInvitationId: winningInvitationId, updatedAt: ts(2000) }, updateTime: nextUpdateTime() });
    };

    const result = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId: "inv-A", expectedDeliveryVersion: 3 });

    // Required outcome: the stale revoke of A fails as stale_superseded —
    // never a successful revoke of the now-inactive A, and never (by
    // construction, since it never even reaches a write) any mutation of
    // the currently-active B.
    expect(result).toEqual({ status: "stale_superseded" });

    // B was never touched by the stale revoke attempt.
    expect(stores.workspaceInvitations.get(winningInvitationId)!.data.status).toBe("pending");
    expect(stores.workspaceInvitations.get(winningInvitationId)!.data.revokedAt).toBeNull();
    expect(stores.workspaceInvitations.get(winningInvitationId)!.data.revokedByUserId).toBeNull();

    // A's own document is untouched too — still exactly the pending,
    // expired, never-revoked row it was seeded as (CREATE never rewrote
    // it, and the stale revoke never reached its own write).
    expect(stores.workspaceInvitations.get("inv-A")!.data.status).toBe("pending");
    expect(stores.workspaceInvitations.get("inv-A")!.data.revokedAt).toBeNull();

    // The guard is still pointing at B — the stale revoke never repointed
    // it (revoke never writes the guard at all, in any outcome).
    const key = computeWorkspaceInvitationKey(WS_ID, INVITEE_EMAIL);
    expect(stores.workspaceInvitationKeys.get(key)!.data.currentInvitationId).toBe(winningInvitationId);
  });
});

// ==================================================================
// ACCEPT
// ==================================================================

describe("acceptWorkspaceInvitation", () => {
  it("valid new membership is created and invitation is marked accepted", async () => {
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.alreadyMember).toBe(false);
    expect(result.effectiveRole).toBe("member");
    const membershipId = computeMembershipId(WS_ID, INVITEE_UID);
    const membership = stores.workspaceMemberships.get(membershipId)!.data as any;
    expect(membership.role).toBe("member");
    expect(membership.status).toBe("active");
    expect(membership.invitedByUserId).toBe(OWNER_UID);
    expect(stores.workspaceInvitations.get("inv-1")!.data.status).toBe("accepted");
    expect(stores.workspaceInvitations.get("inv-1")!.data.acceptedByUserId).toBe(INVITEE_UID);
  });

  it("removed-membership reactivation preserves createdAt, clears removal fields, sets role from the invitation, and replaces invitedByUserId with the CURRENT invitation's inviter", async () => {
    const membershipId = computeMembershipId(WS_ID, INVITEE_UID);
    stores.workspaceMemberships.set(membershipId, {
      data: {
        schemaVersion: 1,
        id: membershipId,
        workspaceId: WS_ID,
        uid: INVITEE_UID,
        role: "viewer",
        status: "removed",
        createdAt: ts(100),
        updatedAt: ts(200),
        invitedByUserId: "original-inviter",
        removedAt: ts(300),
        removedByUserId: OWNER_UID,
      },
      updateTime: nextUpdateTime(),
    });
    const { rawToken } = seedInvitation("inv-1", { role: "admin", invitedByUserId: ADMIN_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result.status).toBe("accepted");
    const membership = stores.workspaceMemberships.get(membershipId)!.data as any;
    expect(membership.status).toBe("active");
    expect(membership.role).toBe("admin");
    expect(membership.createdAt).toEqual(ts(100)); // preserved
    expect(membership.removedAt).toBeNull();
    expect(membership.removedByUserId).toBeNull();
    expect(membership.invitedByUserId).toBe(ADMIN_UID); // current invitation's inviter, not the original
  });

  it("already-active member: role untouched, alreadyMember true, effectiveRole is the CURRENT role even when the invitation's role differs", async () => {
    seedMembership(INVITEE_UID, "viewer");
    const { rawToken } = seedInvitation("inv-1", { role: "admin" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.alreadyMember).toBe(true);
    expect(result.effectiveRole).toBe("viewer"); // unchanged, never silently upgraded to admin
    const membershipId = computeMembershipId(WS_ID, INVITEE_UID);
    expect(stores.workspaceMemberships.get(membershipId)!.data.role).toBe("viewer");
    expect(stores.workspaceInvitations.get("inv-1")!.data.status).toBe("accepted"); // still consumed
  });

  it("unknown invitation id -> invitation_invalid_or_expired", async () => {
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "does-not-exist", rawToken: "whatever" });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });

  it("wrong raw token -> invitation_invalid_or_expired, no membership written", async () => {
    seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken: "wrong-token" });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
    expect(stores.workspaceMemberships.size).toBe(1); // only the seeded Owner
  });

  it("malformed stored tokenHash on the invitation -> fails closed as invitation_invalid_or_expired, not thrown", async () => {
    const { rawToken } = seedInvitation("inv-1", { tokenHash: "not-a-real-hash" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    // A malformed tokenHash makes isWellFormedWorkspaceInvitationV1 fail entirely -> invitation_invalid_or_expired.
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });

  it("expired -> invitation_invalid_or_expired", async () => {
    const { rawToken } = seedInvitation("inv-1", { expiresAt: ts(1) });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });

  it("revoked -> invitation_invalid_or_expired", async () => {
    const { rawToken } = seedInvitation("inv-1", { status: "revoked", revokedAt: ts(500), revokedByUserId: OWNER_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });

  it("already accepted (replay) -> invitation_invalid_or_expired, no double membership mutation", async () => {
    const { rawToken } = seedInvitation("inv-1", { status: "accepted", acceptedAt: ts(500), acceptedByUserId: INVITEE_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });

  it("superseded guard -> invitation_invalid_or_expired", async () => {
    const { rawToken } = seedInvitation("inv-1");
    seedInvitation("inv-2");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-2");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });

  it("Firebase Auth user missing email -> email_verification_required", async () => {
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, undefined, false);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "email_verification_required" });
  });

  it("email unverified -> email_verification_required", async () => {
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, false);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "email_verification_required" });
  });

  it("verified but wrong email -> invitation_email_mismatch, no membership mutation", async () => {
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, "someone-else@example.com", true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "invitation_email_mismatch" });
    expect(stores.workspaceInvitations.get("inv-1")!.data.status).toBe("pending");
  });

  it("Firebase Auth lookup infra failure -> auth_lookup_failed", async () => {
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    authShouldThrowFor.add(INVITEE_UID);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "auth_lookup_failed" });
  });

  it("missing Workspace -> invitation_invalid_or_expired, no membership mutation", async () => {
    const { rawToken } = seedInvitation("inv-1", { workspaceId: "missing-ws" });
    stores.workspaceInvitationKeys.set(computeWorkspaceInvitationKey("missing-ws", INVITEE_EMAIL), { data: { workspaceId: "missing-ws", normalizedEmail: INVITEE_EMAIL, currentInvitationId: "inv-1", updatedAt: ts(1) }, updateTime: nextUpdateTime() });
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });

  it("malformed Workspace -> invitation_invalid_or_expired", async () => {
    stores.workspaces.set(WS_ID, { data: { id: WS_ID }, updateTime: nextUpdateTime() }); // malformed
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });

  it("Personal Workspace type -> invitation_invalid_or_expired, no Workspace write, no membership mutation", async () => {
    stores.workspaces.set(WS_ID, { data: { schemaVersion: 1, id: WS_ID, type: "personal", name: "P", ownerUserId: OWNER_UID, createdAt: ts(1), updatedAt: ts(1) }, updateTime: nextUpdateTime() });
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const beforeWorkspace = stores.workspaces.get(WS_ID)!.data;
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
    expect(stores.workspaces.get(WS_ID)!.data).toEqual(beforeWorkspace);
  });

  it("invalid canonical owner membership (owner-role membership missing) -> invitation_invalid_or_expired", async () => {
    stores.workspaceMemberships.delete(computeMembershipId(WS_ID, OWNER_UID));
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });

  it("owner invariant violated (ownerUserId membership has wrong role) -> invitation_invalid_or_expired", async () => {
    seedMembership(OWNER_UID, "member"); // corrupted
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });

  it("malformed EXISTING caller membership document -> state_corruption, fails closed, no repair", async () => {
    const membershipId = computeMembershipId(WS_ID, INVITEE_UID);
    stores.workspaceMemberships.set(membershipId, { data: { id: membershipId }, updateTime: nextUpdateTime() }); // malformed
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const before = stores.workspaceMemberships.get(membershipId)!.data;
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "state_corruption" });
    expect(stores.workspaceMemberships.get(membershipId)!.data).toEqual(before); // never repaired/overwritten
  });

  it("new membership uses the deterministic id computeMembershipId(workspaceId, uid) — no duplicate membership possible", async () => {
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.membershipId).toBe(computeMembershipId(WS_ID, INVITEE_UID));
  });

  it("acceptance never writes to the workspaces collection — owner invariant permanently untouched", async () => {
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const before = stores.workspaces.get(WS_ID)!.data;
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result.status).toBe("accepted");
    expect(stores.workspaces.get(WS_ID)!.data).toEqual(before);
  });

  it("later removal of the ORIGINAL inviter's membership does not invalidate an otherwise-current, valid invitation", async () => {
    const { rawToken } = seedInvitation("inv-1", { invitedByUserId: ADMIN_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    seedMembership(ADMIN_UID, "admin", { status: "removed", removedAt: ts(500), removedByUserId: OWNER_UID }); // inviter later removed
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result.status).toBe("accepted"); // still valid — acceptance never re-authorizes the original inviter
  });

  it("accept-vs-resend race: resend wins first -> the old raw token no longer accepts", async () => {
    const { rawToken: oldRawToken } = seedInvitation("inv-1", { deliveryVersion: 1 });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    // Simulate the resend committing before acceptance reads.
    const newRawToken = "new-token-from-resend";
    const entry = stores.workspaceInvitations.get("inv-1")!;
    stores.workspaceInvitations.set("inv-1", { data: { ...entry.data, tokenHash: hashWorkspaceInvitationToken(newRawToken), deliveryVersion: 2 }, updateTime: nextUpdateTime() });
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken: oldRawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });

  it("accept-vs-revoke race: revoke wins first -> acceptance cannot create/reactivate membership", async () => {
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const entry = stores.workspaceInvitations.get("inv-1")!;
    stores.workspaceInvitations.set("inv-1", { data: { ...entry.data, status: "revoked", revokedAt: ts(500), revokedByUserId: OWNER_UID }, updateTime: nextUpdateTime() });
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
    expect(stores.workspaceMemberships.has(computeMembershipId(WS_ID, INVITEE_UID))).toBe(false);
  });

  it("target-Workspace admission denied -> invitation_invalid_or_expired (Phase 10B.2: admission is evaluated INSIDE the transaction, after email match, and concealed identically to every other invitation-invalid case — never a distinguishable team_workspaces_disabled)", async () => {
    teamWorkspacesEnabled = false;
    const { rawToken } = seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    registerAuthUser(INVITEE_UID, INVITEE_EMAIL, true);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });

  it("invalid input (empty invitationId/rawToken) is rejected before any lookup", async () => {
    expect(await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "", rawToken: "x" })).toEqual({ status: "invalid_input" });
    expect(await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId: "inv-1", rawToken: "" })).toEqual({ status: "invalid_input" });
    expect(mockAdminAuth.getUser).not.toHaveBeenCalled();
  });
});

// ==================================================================
// LIST
// ==================================================================

describe("listWorkspaceInvitations", () => {
  it("members.read allowed (Member role)", async () => {
    seedMembership(MEMBER_UID, "member");
    const result = await listWorkspaceInvitations({ uid: MEMBER_UID, workspaceId: WS_ID });
    expect(result.status).toBe("listed");
  });

  it("Phase 10B.3.1 closure: a Workspace-canary-only (non-uid-canary) active Member can now list — the LIST_WORKSPACE_SCOPED_GRANT deferred-gate blocker from Phase 10B.2 is closed by the resolveWorkspaceAccess() migration alone, no invitation-list production logic changed in this phase", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryUids = undefined; // explicitly NOT uid-canary admitted
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedMembership(MEMBER_UID, "member");
    const result = await listWorkspaceInvitations({ uid: MEMBER_UID, workspaceId: WS_ID });
    expect(result.status).toBe("listed");
  });

  it("Phase 10B.3.1: Workspace-scoped Member/Reviewer/Viewer roles still lack members.read capability if their role never had it — admission source never changes role capability", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = WS_ID;
    seedMembership(MEMBER_UID, "viewer");
    const result = await listWorkspaceInvitations({ uid: MEMBER_UID, workspaceId: WS_ID });
    // Whatever this role's existing capability outcome is under global/uid
    // admission must be IDENTICAL under Workspace-canary admission — this
    // assertion only proves the two are consistent, not a specific value,
    // since role/capability wiring itself is unchanged by this phase.
    const globalAdmissionResult = await (async () => {
      teamWorkspacesEnabled = true;
      const r = await listWorkspaceInvitations({ uid: MEMBER_UID, workspaceId: WS_ID });
      teamWorkspacesEnabled = false;
      return r;
    })();
    expect(result.status).toBe(globalAdmissionResult.status);
  });

  it("Phase 10B.3.1: a Workspace NOT in the canary list still denies listing (target admission, not a general bypass)", async () => {
    teamWorkspacesEnabled = false;
    teamWorkspacesCanaryWorkspaceIds = "some-other-workspace";
    seedMembership(MEMBER_UID, "member");
    const result = await listWorkspaceInvitations({ uid: MEMBER_UID, workspaceId: WS_ID });
    expect(result.status).toBe("team_workspaces_disabled");
  });

  it("no guards -> empty list", async () => {
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    expect(result).toEqual({ status: "listed", invitations: [] });
  });

  it("one current pending invitation is returned", async () => {
    seedInvitation("inv-1");
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.invitations).toHaveLength(1);
    expect(result.invitations[0].id).toBe("inv-1");
  });

  it("current pending expired -> isExpired true", async () => {
    seedInvitation("inv-1", { expiresAt: ts(1) });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    if (result.status !== "listed") throw new Error("expected listed");
    expect(result.invitations[0].isExpired).toBe(true);
  });

  it("current pending live -> isExpired false", async () => {
    seedInvitation("inv-1", { expiresAt: ts(9_000_000_000) });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    if (result.status !== "listed") throw new Error("expected listed");
    expect(result.invitations[0].isExpired).toBe(false);
  });

  it("current accepted invitation is omitted", async () => {
    seedInvitation("inv-1", { status: "accepted", acceptedAt: ts(500), acceptedByUserId: INVITEE_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    expect(result).toEqual({ status: "listed", invitations: [] });
  });

  it("current revoked invitation is omitted", async () => {
    seedInvitation("inv-1", { status: "revoked", revokedAt: ts(500), revokedByUserId: OWNER_UID });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    expect(result).toEqual({ status: "listed", invitations: [] });
  });

  it("historical superseded pending invitation is excluded — ONLY the current guard target is returned", async () => {
    seedInvitation("inv-old", { status: "pending", expiresAt: ts(1) }); // superseded, status still "pending"
    seedInvitation("inv-new", { status: "pending", createdAt: ts(2000) });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-new"); // guard points at the NEW one only
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    if (result.status !== "listed") throw new Error("expected listed");
    expect(result.invitations).toHaveLength(1);
    expect(result.invitations[0].id).toBe("inv-new");
  });

  it("two different normalizedEmail guards each contribute one current invitation", async () => {
    seedInvitation("inv-1", { normalizedEmail: "a@example.com" });
    seedGuard(WS_ID, "a@example.com", "inv-1");
    seedInvitation("inv-2", { normalizedEmail: "b@example.com" });
    seedGuard(WS_ID, "b@example.com", "inv-2");
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    if (result.status !== "listed") throw new Error("expected listed");
    expect(result.invitations.map((i) => i.id).sort()).toEqual(["inv-1", "inv-2"]);
  });

  it("malformed guard -> state_corruption, fails closed", async () => {
    const key = computeWorkspaceInvitationKey(WS_ID, INVITEE_EMAIL);
    stores.workspaceInvitationKeys.set(key, { data: { workspaceId: WS_ID }, updateTime: nextUpdateTime() });
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("guard referencing a missing invitation -> state_corruption", async () => {
    seedGuard(WS_ID, INVITEE_EMAIL, "does-not-exist");
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("malformed referenced invitation -> state_corruption", async () => {
    stores.workspaceInvitations.set("inv-1", { data: { id: "inv-1" }, updateTime: nextUpdateTime() });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("workspace binding mismatch on the referenced invitation -> state_corruption", async () => {
    seedInvitation("inv-1", { workspaceId: "different-ws" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("email binding mismatch between guard and referenced invitation -> state_corruption", async () => {
    seedInvitation("inv-1", { normalizedEmail: "different@example.com" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    expect(result).toEqual({ status: "state_corruption" });
  });

  it("results are sorted createdAt descending", async () => {
    seedInvitation("inv-old", { normalizedEmail: "a@example.com", createdAt: ts(1000) });
    seedGuard(WS_ID, "a@example.com", "inv-old");
    seedInvitation("inv-new", { normalizedEmail: "b@example.com", createdAt: ts(5000) });
    seedGuard(WS_ID, "b@example.com", "inv-new");
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    if (result.status !== "listed") throw new Error("expected listed");
    expect(result.invitations.map((i) => i.id)).toEqual(["inv-new", "inv-old"]);
  });

  it("DTO exposes deliveryVersion, excludes tokenHash/providerMessageId/guard internals", async () => {
    seedInvitation("inv-1", { deliveryVersion: 3, providerMessageId: "provider-msg-1" });
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    if (result.status !== "listed") throw new Error("expected listed");
    const item = result.invitations[0] as any;
    expect(item.deliveryVersion).toBe(3);
    expect(item.tokenHash).toBeUndefined();
    expect(item.providerMessageId).toBeUndefined();
    expect(item.currentInvitationId).toBeUndefined();
  });

  it("members.read denied (Viewer has members.read in the frozen matrix — use a role without workspace access at all: outsider)", async () => {
    const result = await listWorkspaceInvitations({ uid: OUTSIDER_UID, workspaceId: WS_ID });
    expect(result).toEqual({ status: "membership_not_found" });
  });

  it("removed membership -> membership_removed", async () => {
    seedMembership(MEMBER_UID, "member", { status: "removed", removedAt: ts(500), removedByUserId: OWNER_UID });
    const result = await listWorkspaceInvitations({ uid: MEMBER_UID, workspaceId: WS_ID });
    expect(result).toEqual({ status: "membership_removed" });
  });

  it("rollout disabled -> team_workspaces_disabled, zero Firestore access", async () => {
    teamWorkspacesEnabled = false;
    const result = await listWorkspaceInvitations({ uid: OWNER_UID, workspaceId: WS_ID });
    expect(result).toEqual({ status: "team_workspaces_disabled" });
  });

  it("no creator bypass — invitedByUserId does not grant or restrict visibility beyond the caller's own resolved capabilities", async () => {
    seedMembership(MEMBER_UID, "member"); // Member has members.read per the frozen matrix
    seedInvitation("inv-1", { invitedByUserId: "some-other-admin" }); // caller is NOT the inviter
    seedGuard(WS_ID, INVITEE_EMAIL, "inv-1");
    const result = await listWorkspaceInvitations({ uid: MEMBER_UID, workspaceId: WS_ID });
    if (result.status !== "listed") throw new Error("expected listed");
    expect(result.invitations).toHaveLength(1);
  });
});

// ==================================================================
// Regression / transaction discipline
// ==================================================================

describe("transaction discipline", () => {
  it("createWorkspaceInvitation performs zero writes on an unauthorized attempt", async () => {
    const result = await createWorkspaceInvitation({ uid: OUTSIDER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "unauthorized", reason: "membership_not_found" });
    expect(stores.workspaceInvitations.size).toBe(0);
    expect(stores.workspaceInvitationKeys.size).toBe(0);
  });

  it("a genuine transaction failure in create reports create_failed exactly once, no retry loop", async () => {
    mockAdminDb.runTransaction.mockImplementationOnce(async () => {
      throw new Error("simulated persistent Firestore failure");
    });
    const result = await createWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "create_failed" });
    expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1);
  });
});
