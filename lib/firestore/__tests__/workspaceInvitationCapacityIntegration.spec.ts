/**
 * Workspace-Scoped Team Canary, Phase 10B.2 — integration tests proving
 * the invitation lifecycle (`createWorkspaceInvitation()` /
 * `revokeWorkspaceInvitation()` / `acceptWorkspaceInvitation()`) commits
 * atomically with capacity reservation/release, and that target-Workspace
 * admission is correctly wired.
 *
 * Deliberately a SEPARATE file from `workspaceInvitations.spec.ts`: that
 * file's fake never exercises `capacityControlled()===true` (it doesn't
 * mock `TEAM_WORKSPACES_CANARY_WORKSPACE_IDS`, and its `tx.get()` only
 * supports document-ref reads, not the QUERY-based reads
 * `teamWorkspaceCanaryCapacity.ts`'s bootstrap needs). This file's fake
 * combines both: `workspaces` / `workspaceMemberships` /
 * `workspaceInvitations` / `workspaceInvitationKeys` /
 * `teamWorkspaceCanaryCapacity`, with `tx.get()` supporting both doc-ref
 * and query-shaped reads (mirroring `teamWorkspaceCanaryCapacity.spec.ts`'s
 * own fake), plus the same buffered-write +
 * `concurrentMutationHook`/`retriesBeforeSuccess` retry-simulation idiom
 * used throughout this repository's transaction tests.
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

type StoredDoc = { data: Record<string, unknown>; updateTime: Timestamp };
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaces: new Map(),
  workspaceMemberships: new Map(),
  workspaceInvitations: new Map(),
  workspaceInvitationKeys: new Map(),
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
    get: async () => {
      // Non-transactional query support (used by listWorkspaceInvitations()'s guard scan).
      const store = stores[name];
      const docs: Array<{ id: string; data: () => Record<string, unknown>; exists: true }> = [];
      for (const [id, entry] of store.entries()) docs.push({ id, data: () => entry.data, exists: true });
      return { empty: docs.length === 0, docs };
    },
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
          return { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime, id: ref.__id };
        },
        create: (ref: any, data: Record<string, unknown>) => {
          const store = stores[ref.__collection];
          if (store.has(ref.__id)) throw new FirestoreError("6", "ALREADY_EXISTS");
          pendingWrites.push(() => store.set(ref.__id, { data, updateTime: nextUpdateTime() }));
        },
        update: (ref: any, data: Record<string, unknown>) => {
          const store = stores[ref.__collection];
          const entry = store.get(ref.__id);
          if (!entry) throw new FirestoreError("5", "NOT_FOUND");
          pendingWrites.push(() => store.set(ref.__id, { data: { ...entry.data, ...data }, updateTime: nextUpdateTime() }));
        },
        set: (ref: any, data: Record<string, unknown>) => {
          pendingWrites.push(() => stores[ref.__collection].set(ref.__id, { data, updateTime: nextUpdateTime() }));
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
    return mockAdminAuth;
  },
}));

const firestoreUnavailableFlag = { value: false };

let authUsers: Record<string, { email?: string; emailVerified?: boolean }> = {};
const mockAdminAuth = {
  getUser: jest.fn(async (uid: string) => {
    const rec = authUsers[uid];
    if (!rec) throw new Error("USER_NOT_FOUND");
    return rec;
  }),
};

let teamWorkspacesEnabled = false;
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
import { createWorkspaceInvitation, revokeWorkspaceInvitation, acceptWorkspaceInvitation } from "@/lib/firestore/workspaceInvitations";

const WS_ID = "ws-capacity-1";
const OWNER_UID = "owner-1";
const ADMIN_UID = "admin-1";
const INVITEE_EMAIL = "invitee@example.com";
const INVITEE_UID = "invitee-1";

function seedWorkspace() {
  stores.workspaces.set(WS_ID, {
    data: { schemaVersion: 1, id: WS_ID, type: "team", name: "Capacity Test Workspace", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: ts(1000), updatedAt: ts(1000) },
    updateTime: nextUpdateTime(),
  });
}

function seedMembership(uid: string, role: string, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(WS_ID, uid);
  const data = { schemaVersion: 1, id, workspaceId: WS_ID, uid, role, status: "active", createdAt: ts(1000), updatedAt: ts(1000), invitedByUserId: null, removedAt: null, removedByUserId: null, ...overrides };
  stores.workspaceMemberships.set(id, { data, updateTime: nextUpdateTime() });
  return data;
}

/** Seeds N throwaway active members (beyond the Owner) to bring occupancy to a known count. */
function seedFillerMembers(count: number) {
  for (let i = 0; i < count; i++) seedMembership(`filler-${i}`, "member");
}

let guardCounter = 0;
function seedGuardCurrentInvitation(email: string, status: "pending" | "accepted" | "revoked", expiresAtSeconds: number, role = "member") {
  guardCounter += 1;
  const invitationId = `inv-${guardCounter}`;
  const guardKey = computeWorkspaceInvitationKey(WS_ID, email);
  stores.workspaceInvitationKeys.set(guardKey, { data: { workspaceId: WS_ID, normalizedEmail: email, currentInvitationId: invitationId, updatedAt: nextUpdateTime() }, updateTime: nextUpdateTime() });
  const rawToken = `token-${guardCounter}`;
  stores.workspaceInvitations.set(invitationId, {
    data: {
      schemaVersion: 1,
      id: invitationId,
      workspaceId: WS_ID,
      normalizedEmail: email,
      role,
      status,
      tokenHash: hashWorkspaceInvitationToken(rawToken),
      expiresAt: ts(expiresAtSeconds),
      createdAt: ts(1000),
      updatedAt: ts(1000),
      invitedByUserId: OWNER_UID,
      acceptedAt: status === "accepted" ? ts(1500) : null,
      acceptedByUserId: status === "accepted" ? INVITEE_UID : null,
      revokedAt: status === "revoked" ? ts(1500) : null,
      revokedByUserId: status === "revoked" ? OWNER_UID : null,
      deliveryVersion: 1,
      lastDeliveryAttemptAt: null,
      lastDeliveryStatus: null,
      lastDeliveryVersion: null,
      providerMessageId: null,
    },
    updateTime: nextUpdateTime(),
  });
  return { invitationId, rawToken };
}

function capacityDoc() {
  return stores.teamWorkspaceCanaryCapacity.get(WS_ID)?.data as { reservedCount: number; revision: number } | undefined;
}

beforeEach(() => {
  resetStores();
  autoIdCounter = 0;
  updateTimeCounter = 0;
  guardCounter = 0;
  concurrentMutationHook = null;
  retriesBeforeSuccess = 0;
  firestoreUnavailableFlag.value = false;
  authUsers = {};
  teamWorkspacesEnabled = false;
  teamWorkspacesCanaryUids = undefined;
  teamWorkspacesCanaryWorkspaceIds = WS_ID; // capacity-controlled by default in this file
  seedWorkspace();
  seedMembership(OWNER_UID, "owner");
  seedMembership(ADMIN_UID, "admin");
});

describe("target admission wiring", () => {
  it("Workspace-canary-only Admin (not uid-canary) can create — Phase 10B.2 target admission", async () => {
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
  });

  it("neither uid-canary nor Workspace-canary admitted -> team_workspaces_disabled, zero writes", async () => {
    teamWorkspacesCanaryWorkspaceIds = "some-other-workspace";
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "team_workspaces_disabled" });
    expect(stores.workspaceInvitations.size).toBe(0);
  });
});

describe("Part K — create + capacity", () => {
  it("A. occupancy 9 (2 members + 7 fillers), new invite -> created, capacity 10", async () => {
    seedFillerMembers(7); // owner + admin + 7 fillers = 9
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
    expect(capacityDoc()).toMatchObject({ reservedCount: 10, revision: 0 });
  });

  it("B. occupancy 10, new invite -> workspace_member_capacity_reached, zero invitation/guard writes, capacity unchanged", async () => {
    seedFillerMembers(8); // owner + admin + 8 fillers = 10
    const before = stores.workspaceInvitations.size;
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "workspace_member_capacity_reached" });
    expect(stores.workspaceInvitations.size).toBe(before);
    expect(stores.workspaceInvitationKeys.size).toBe(0);
    expect(stores.teamWorkspaceCanaryCapacity.has(WS_ID)).toBe(false); // rejection never persists bootstrap
  });

  it("C. legacy occupancy 11, new invite -> denied, zero writes", async () => {
    seedFillerMembers(9); // owner + admin + 9 fillers = 11
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "workspace_member_capacity_reached" });
    expect(stores.workspaceInvitations.size).toBe(0);
  });

  it("D. expired guard-current pending prior invitation at occupancy 10 -> replacement succeeds, capacity untouched (net 0)", async () => {
    seedFillerMembers(7); // owner + admin + 7 fillers = 9 active
    seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 1); // expired -> base becomes 9+1=10
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
    // No capacity document was ever created — expired-pending replacement never touches it.
    expect(stores.teamWorkspaceCanaryCapacity.has(WS_ID)).toBe(false);
    // Guard now points at a NEW invitation id.
    const guardKey = computeWorkspaceInvitationKey(WS_ID, INVITEE_EMAIL);
    const guard = stores.workspaceInvitationKeys.get(guardKey)!.data;
    expect(result.status === "created" && guard.currentInvitationId === result.invitationId).toBe(true);
  });

  it("E. live guard-current pending, replacement attempt -> duplicate_live_invitation, zero capacity writes", async () => {
    seedFillerMembers(7);
    seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 9_999_999_999); // live
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "duplicate_live_invitation" });
    expect(stores.teamWorkspaceCanaryCapacity.has(WS_ID)).toBe(false);
  });

  it("F. accepted prior, replacement at occupancy 9 -> +1 to 10 (new reservation, prior carries no reservation)", async () => {
    seedFillerMembers(6); // owner + admin + 6 fillers = 8 active
    seedGuardCurrentInvitation(INVITEE_EMAIL, "accepted", 9_999_999_999); // no reservation
    // base = 8 active + 0 (accepted, not pending) = 8 -> reserve -> 9
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
    expect(capacityDoc()).toMatchObject({ reservedCount: 9, revision: 0 });
  });

  it("G. revoked prior, replacement -> +1 (new reservation)", async () => {
    seedFillerMembers(6);
    seedGuardCurrentInvitation(INVITEE_EMAIL, "revoked", 9_999_999_999);
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
    expect(capacityDoc()).toMatchObject({ reservedCount: 9, revision: 0 });
  });

  it("global Team ON -> capacity inert even at occupancy 11", async () => {
    teamWorkspacesEnabled = true;
    seedFillerMembers(9); // 11 active
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
    expect(stores.teamWorkspaceCanaryCapacity.has(WS_ID)).toBe(false); // never even consulted
  });
});

describe("Part L — revoke + capacity", () => {
  it("first revoke of a live-pending invitation -> capacity -1, same transaction as status transition", async () => {
    seedFillerMembers(6); // 8 active
    const { invitationId } = seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 9_999_999_999);
    // Bootstrap this Workspace's capacity via a create first, to reach a known baseline.
    seedFillerMembers(0);
    const revokeResult = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId, expectedDeliveryVersion: 1 });
    expect(revokeResult.status).toBe("revoked");
    // base = 8 active + 1 pending = 9 -> release -> 8
    expect(capacityDoc()).toMatchObject({ reservedCount: 8, revision: 0 });
  });

  it("REGRESSION (Phase 10A.4): expired-pending revoke still releases -1 (state-based, not expiry-based)", async () => {
    seedFillerMembers(6); // 8 active
    const { invitationId } = seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 1); // expired
    const revokeResult = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId, expectedDeliveryVersion: 1 });
    expect(revokeResult.status).toBe("revoked");
    expect(capacityDoc()).toMatchObject({ reservedCount: 8, revision: 0 });
  });

  it("idempotent second revoke -> no capacity delta, no revision movement", async () => {
    seedFillerMembers(6);
    const { invitationId } = seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 9_999_999_999);
    await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId, expectedDeliveryVersion: 1 });
    const afterFirst = { ...capacityDoc()! };
    const secondResult = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId, expectedDeliveryVersion: 1 });
    expect(secondResult.status).toBe("revoked");
    expect(capacityDoc()).toEqual(afterFirst); // untouched — no second decrement
  });

  it("first-use bootstrap via revoke: 8 active + 1 expired pending -> bootstrap 9 -> revoke -> capacity doc created at 8, revision 0, atomic with invitation transition", async () => {
    seedFillerMembers(6); // 8 active
    const { invitationId } = seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 1);
    expect(stores.teamWorkspaceCanaryCapacity.has(WS_ID)).toBe(false); // no capacity doc yet
    const result = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId, expectedDeliveryVersion: 1 });
    expect(result.status).toBe("revoked");
    const cap = capacityDoc()!;
    expect(cap.reservedCount).toBe(8);
    expect(cap.revision).toBe(0);
    // The invitation itself really did transition atomically alongside the capacity create.
    expect(stores.workspaceInvitations.get(invitationId)!.data.status).toBe("revoked");
  });
});

describe("Part M — accept + capacity", () => {
  function seedAcceptable(email: string) {
    return seedGuardCurrentInvitation(email, "pending", 9_999_999_999);
  }

  it("new member at cap (reservedCount 10) -> success; capacity is never consulted or written for a delta-0 acceptance", async () => {
    seedFillerMembers(7); // 9 active
    const { invitationId, rawToken } = seedAcceptable(INVITEE_EMAIL); // 9 active + 1 live pending = true occupancy 10
    authUsers[INVITEE_UID] = { email: INVITEE_EMAIL, emailVerified: true };
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId, rawToken });
    expect(result.status).toBe("accepted");
    expect(result.status === "accepted" && result.alreadyMember).toBe(false);
    // New-membership acceptance is delta 0 and never touches the capacity
    // document at all (Part M/30, Part M/53) — it must succeed even though
    // no capacity document has ever been created for this Workspace.
    expect(stores.teamWorkspaceCanaryCapacity.has(WS_ID)).toBe(false);
  });

  it("reactivation at cap -> success, capacity delta 0", async () => {
    seedFillerMembers(7); // 9 active
    seedMembership(INVITEE_UID, "member", { status: "removed", removedAt: ts(1400), removedByUserId: OWNER_UID });
    // NOTE: seedMembership marks active by default; overwrite as removed directly.
    const removedId = computeMembershipId(WS_ID, INVITEE_UID);
    stores.workspaceMemberships.set(removedId, {
      data: { ...stores.workspaceMemberships.get(removedId)!.data, status: "removed", removedAt: ts(1400), removedByUserId: OWNER_UID },
      updateTime: nextUpdateTime(),
    });
    const { invitationId, rawToken } = seedAcceptable(INVITEE_EMAIL);
    authUsers[INVITEE_UID] = { email: INVITEE_EMAIL, emailVerified: true };
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId, rawToken });
    expect(result.status).toBe("accepted");
    // Reactivation is delta 0 (the reservation converts directly into the
    // reactivated seat) and never touches the capacity document either.
    expect(stores.teamWorkspaceCanaryCapacity.has(WS_ID)).toBe(false);
  });

  it("already-active acceptance releases exactly -1, same transaction", async () => {
    seedFillerMembers(7); // 9 active, including a real active INVITEE_UID membership added below
    seedMembership(INVITEE_UID, "member"); // already active -> 10 active total
    const { invitationId, rawToken } = seedAcceptable(INVITEE_EMAIL); // base = 10 + 1 = 11
    authUsers[INVITEE_UID] = { email: INVITEE_EMAIL, emailVerified: true };
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId, rawToken });
    expect(result.status).toBe("accepted");
    expect(result.status === "accepted" && result.alreadyMember).toBe(true);
    expect(capacityDoc()).toMatchObject({ reservedCount: 10, revision: 0 }); // released once
  });

  it("first-use already-active accept: no capacity doc exists yet, bootstrap includes the redundant reservation, then releases -1 atomically", async () => {
    seedFillerMembers(6); // 8 active
    seedMembership(INVITEE_UID, "member"); // 9 active total
    const { invitationId, rawToken } = seedAcceptable(INVITEE_EMAIL); // base = 9 + 1 = 10
    authUsers[INVITEE_UID] = { email: INVITEE_EMAIL, emailVerified: true };
    expect(stores.teamWorkspaceCanaryCapacity.has(WS_ID)).toBe(false);
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId, rawToken });
    expect(result.status).toBe("accepted");
    const cap = capacityDoc()!;
    expect(cap.reservedCount).toBe(9);
    expect(cap.revision).toBe(0);
  });

  it("expired invitation -> denied by expiration, capacity untouched, invitation remains pending", async () => {
    seedFillerMembers(6);
    const { invitationId, rawToken } = seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 1); // expired
    authUsers[INVITEE_UID] = { email: INVITEE_EMAIL, emailVerified: true };
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId, rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
    expect(stores.teamWorkspaceCanaryCapacity.has(WS_ID)).toBe(false);
    expect(stores.workspaceInvitations.get(invitationId)!.data.status).toBe("pending");
  });
});

describe("Part N/54-56 — acceptance oracle parity", () => {
  it("wrong-email + Workspace admitted vs wrong-email + Workspace NOT admitted -> identical result", async () => {
    seedFillerMembers(6);
    const { invitationId, rawToken } = seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 9_999_999_999);
    authUsers[INVITEE_UID] = { email: "wrong@example.com", emailVerified: true };

    const admittedResult = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId, rawToken });

    teamWorkspacesCanaryWorkspaceIds = "some-other-workspace";
    const notAdmittedResult = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId, rawToken });

    expect(admittedResult).toEqual({ status: "invitation_email_mismatch" });
    expect(notAdmittedResult).toEqual({ status: "invitation_email_mismatch" });
    expect(admittedResult).toEqual(notAdmittedResult);
  });

  it("correct recipient, Workspace not admitted -> generic concealed invitation_invalid_or_expired, never team_workspaces_disabled", async () => {
    seedFillerMembers(6);
    const { invitationId, rawToken } = seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 9_999_999_999);
    authUsers[INVITEE_UID] = { email: INVITEE_EMAIL, emailVerified: true };
    teamWorkspacesCanaryWorkspaceIds = "some-other-workspace";
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId, rawToken });
    expect(result).toEqual({ status: "invitation_invalid_or_expired" });
  });
});

describe("Part Q — concurrency / atomicity", () => {
  it("62. create/create at capacity 9: exactly one reservation commits, final capacity 10", async () => {
    seedFillerMembers(7); // 9 active
    retriesBeforeSuccess = 1;
    let fired = false;
    concurrentMutationHook = (ref) => {
      if (fired || ref.__collection !== "teamWorkspaceCanaryCapacity" || ref.__kind !== "doc") return;
      fired = true;
      // Simulate a concurrent create winning first: capacity now at 10.
      stores.teamWorkspaceCanaryCapacity.set(WS_ID, { data: { schemaVersion: 1, workspaceId: WS_ID, reservedCount: 10, revision: 0, updatedAt: nextUpdateTime() }, updateTime: nextUpdateTime() });
    };
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: "second@example.com", role: "member" });
    // The kept (retried) attempt re-reads fresh state (10) and correctly rejects.
    expect(result).toEqual({ status: "workspace_member_capacity_reached" });
  });

  it("role check fails BEFORE capacity is ever consulted -> zero capacity writes (capacity reserve is the last validation step, never the first)", async () => {
    seedFillerMembers(7); // 9 active, room for one more
    // ADMIN may never create an Admin-target invitation — this denial
    // happens before the guard/capacity read at all in createWorkspaceInvitation().
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "admin" });
    expect(result).toEqual({ status: "role_target_forbidden" });
    expect(stores.teamWorkspaceCanaryCapacity.has(WS_ID)).toBe(false);
    expect(stores.workspaceInvitations.size).toBe(0);
  });

  it("66. transaction abort atomicity: corrupt capacity state during an already-active accept aborts the WHOLE acceptance — no invitation accepted, no membership mutation, no capacity mutation", async () => {
    seedFillerMembers(6);
    seedMembership(INVITEE_UID, "member"); // already active
    const { invitationId, rawToken } = seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 9_999_999_999);
    authUsers[INVITEE_UID] = { email: INVITEE_EMAIL, emailVerified: true };
    // Seed a malformed capacity document (negative reservedCount) so the
    // release this already-active branch requires fails closed.
    stores.teamWorkspaceCanaryCapacity.set(WS_ID, { data: { schemaVersion: 1, workspaceId: WS_ID, reservedCount: -1, revision: 0, updatedAt: ts(1000) }, updateTime: nextUpdateTime() });

    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId, rawToken });

    expect(result).toEqual({ status: "state_corruption" });
    // Nothing committed: invitation still pending, membership untouched, capacity untouched.
    expect(stores.workspaceInvitations.get(invitationId)!.data.status).toBe("pending");
    const membership = stores.workspaceMemberships.get(computeMembershipId(WS_ID, INVITEE_UID))!.data;
    expect(membership.status).toBe("active");
    expect(membership.updatedAt).toEqual(ts(1000));
    expect(capacityDoc()).toMatchObject({ reservedCount: -1, revision: 0 }); // unchanged, not "repaired"
  });
});
