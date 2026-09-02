/**
 * Permanent Team Workspace Collaborator-Seat Limit, Phase 12A.1S.1 —
 * integration tests proving the SEAT-DELTA reasoning at every invitation/
 * membership call site (Sections R/S/T/U/V/W), independent of
 * `workspaceInvitationCapacityIntegration.spec.ts` (which covers the
 * SEPARATE, still-untouched canary mechanism). Canary is left fully
 * uncontrolled here (`teamWorkspacesCanaryWorkspaceIds` undefined — its
 * default off-state) so only the permanent module's own behavior is under
 * test. In-memory Firestore fake — same doc-ref + query-object shape used
 * throughout this phase's other test files.
 */

import { Timestamp } from "firebase-admin/firestore";

let autoIdCounter = 0;
function ts(seconds: number): Timestamp {
  return new Timestamp(seconds, 0);
}

type StoredDoc = { data: Record<string, unknown> };
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaces: new Map(),
  workspaceMemberships: new Map(),
  workspaceInvitations: new Map(),
  workspaceInvitationKeys: new Map(),
  teamWorkspaceCanaryCapacity: new Map(),
  teamWorkspaceSeatAdmission: new Map(),
  workspaceMembershipEvents: new Map(),
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

type QueryFilter = [string, string, unknown];
function makeDocRef(collectionName: string, docId: string) {
  return { __kind: "doc" as const, __collection: collectionName, __id: docId, id: docId };
}
function makeQuery(collectionName: string, filters: QueryFilter[]): any {
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
    const pendingWrites: Array<() => void> = [];
    const txn = {
      get: async (ref: any) => {
        if (ref.__kind === "query") {
          const store = stores[ref.__collection];
          const docs: Array<{ id: string; data: () => Record<string, unknown>; exists: true }> = [];
          for (const [id, entry] of store.entries()) {
            const matches = (ref.__filters as QueryFilter[]).every(([field, op, value]) => op === "==" && (entry.data as Record<string, unknown>)[field] === value);
            if (matches) docs.push({ id, data: () => entry.data, exists: true });
          }
          return { empty: docs.length === 0, docs, size: docs.length };
        }
        const store = stores[ref.__collection];
        const entry = store.get(ref.__id);
        return { exists: entry !== undefined, data: () => entry?.data };
      },
      create: (ref: any, data: Record<string, unknown>) => {
        const store = stores[ref.__collection];
        if (store.has(ref.__id)) throw new FirestoreError("6", "ALREADY_EXISTS");
        pendingWrites.push(() => store.set(ref.__id, { data }));
      },
      update: (ref: any, data: Record<string, unknown>) => {
        const store = stores[ref.__collection];
        const entry = store.get(ref.__id);
        if (!entry) throw new FirestoreError("5", "NOT_FOUND");
        pendingWrites.push(() => store.set(ref.__id, { data: { ...entry.data, ...data } }));
      },
      set: (ref: any, data: Record<string, unknown>) => {
        pendingWrites.push(() => stores[ref.__collection].set(ref.__id, { data }));
      },
    };
    const result = await fn(txn);
    for (const applyWrite of pendingWrites) applyWrite();
    return result;
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
  get adminAuth() {
    return mockAdminAuth;
  },
}));

let authUsers: Record<string, { email?: string; emailVerified?: boolean }> = {};
const mockAdminAuth = {
  getUser: jest.fn(async (uid: string) => {
    const rec = authUsers[uid];
    if (!rec) throw new Error("USER_NOT_FOUND");
    return rec;
  }),
};

const teamWorkspacesEnabled = false;
// Target-Workspace admission is granted via UID canary (so every test's
// callers are admitted at all) — deliberately NOT via
// TEAM_WORKSPACES_CANARY_WORKSPACE_IDS, which is what `capacityControlled()`
// keys off of. This keeps canary CAPACITY fully uncontrolled/off for every
// test in this file (its own default off-state) while still letting the
// permanent, always-on seat-limit module — which never consults either of
// these — be exercised in isolation.
const teamWorkspacesCanaryUids: string | undefined = "owner-1,admin-1,invitee-1";
const teamWorkspacesCanaryWorkspaceIds: string | undefined = undefined;
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
import { createWorkspaceInvitation, resendWorkspaceInvitation, revokeWorkspaceInvitation, acceptWorkspaceInvitation } from "@/lib/firestore/workspaceInvitations";
import { removeWorkspaceMembership } from "@/lib/firestore/workspaceMemberships";

const WS_ID = "ws-seatlimit-1";
const OWNER_UID = "owner-1";
const ADMIN_UID = "admin-1";
const INVITEE_EMAIL = "invitee@example.com";
const INVITEE_UID = "invitee-1";

function seedWorkspace() {
  stores.workspaces.set(WS_ID, { data: { schemaVersion: 1, id: WS_ID, type: "team", name: "Seat Limit Test Workspace", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: ts(1000), updatedAt: ts(1000) } });
}
function seedMembership(uid: string, role: string, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(WS_ID, uid);
  stores.workspaceMemberships.set(id, { data: { schemaVersion: 1, id, workspaceId: WS_ID, uid, role, status: "active", createdAt: ts(1000), updatedAt: ts(1000), invitedByUserId: null, removedAt: null, removedByUserId: null, ...overrides } });
  return id;
}
function seedFillerMembers(count: number) {
  for (let i = 0; i < count; i++) seedMembership(`filler-${i}`, "member");
}
let guardCounter = 0;
function seedGuardCurrentInvitation(email: string, status: "pending" | "accepted" | "revoked", expiresAtSeconds: number, deliveryVersion = 1) {
  guardCounter += 1;
  const invitationId = `inv-${guardCounter}`;
  const guardKey = computeWorkspaceInvitationKey(WS_ID, email);
  stores.workspaceInvitationKeys.set(guardKey, { data: { workspaceId: WS_ID, normalizedEmail: email, currentInvitationId: invitationId, updatedAt: ts(1000) } });
  const rawToken = `token-${guardCounter}`;
  stores.workspaceInvitations.set(invitationId, {
    data: {
      schemaVersion: 1,
      id: invitationId,
      workspaceId: WS_ID,
      normalizedEmail: email,
      role: "member",
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
      deliveryVersion,
      lastDeliveryAttemptAt: null,
      lastDeliveryStatus: null,
      lastDeliveryVersion: null,
      providerMessageId: null,
    },
  });
  return { invitationId, rawToken };
}
function admissionDoc() {
  return stores.teamWorkspaceSeatAdmission.get(WS_ID)?.data as { reservedCount: number; revision: number } | undefined;
}

beforeEach(() => {
  resetStores();
  autoIdCounter = 0;
  guardCounter = 0;
  authUsers = {};
  seedWorkspace();
  seedMembership(OWNER_UID, "owner");
  seedMembership(ADMIN_UID, "admin");
});

describe("Section O — invitation creation is gated by the permanent limit", () => {
  it("real occupancy 4 (admin + 3 fillers, Owner excluded), new invite -> created, reserves to 5", async () => {
    seedFillerMembers(3);
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
    expect(admissionDoc()).toMatchObject({ reservedCount: 5 });
  });

  it("real occupancy 5 (admin + 4 fillers, Owner excluded), new invite -> seat_limit_reached, no invitation/guard/email dispatch", async () => {
    seedFillerMembers(4);
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result).toEqual({ status: "seat_limit_reached" });
    expect(stores.workspaceInvitations.size).toBe(0);
    expect(stores.workspaceInvitationKeys.size).toBe(0);
  });
});

describe("Section R — normal acceptance is delta 0, must succeed even at 5/5", () => {
  it("4 active + 1 valid pending = 5 occupied; accepting the valid pending invitation succeeds (delta 0, never re-consults the seat gate)", async () => {
    seedFillerMembers(2); // owner + admin + 2 fillers = 4 active
    const { invitationId, rawToken } = seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 9_999_999_999); // 4 + 1 pending = 5 occupied
    authUsers[INVITEE_UID] = { email: INVITEE_EMAIL, emailVerified: true };
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId, rawToken });
    expect(result.status).toBe("accepted");
    expect(result.status === "accepted" && result.alreadyMember).toBe(false);
    // Delta 0: never even created the admission doc, since neither create nor reactivate ever call the reserve gate.
    expect(stores.teamWorkspaceSeatAdmission.has(WS_ID)).toBe(false);
  });
});

describe("Section S — already-member acceptance edge releases exactly one seat", () => {
  it("caller already an active member AND holds a redundant valid pending invitation -> release exactly once", async () => {
    seedFillerMembers(2); // admin + 2 fillers = 3 non-owner active
    seedMembership(INVITEE_UID, "member"); // + the future acceptor = 4 non-owner active total
    const { invitationId, rawToken } = seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 9_999_999_999); // 4 + 1 pending = 5 (double-counts the same person)
    authUsers[INVITEE_UID] = { email: INVITEE_EMAIL, emailVerified: true };
    const result = await acceptWorkspaceInvitation({ uid: INVITEE_UID, invitationId, rawToken });
    expect(result.status).toBe("accepted");
    expect(result.status === "accepted" && result.alreadyMember).toBe(true);
    // Bootstrapped from live state (5), released once -> 4.
    expect(admissionDoc()).toMatchObject({ reservedCount: 4 });
  });
});

describe("Section T/U — resend: valid pending is delta 0, expired reactivation must pass the same gate as create", () => {
  it("resend of a CURRENTLY VALID pending invitation at real occupancy 5/5 succeeds — delta 0, never calls the reserve gate", async () => {
    seedFillerMembers(4); // admin + 4 fillers = 5 non-owner active — already at the limit
    const { invitationId } = seedGuardCurrentInvitation("live@example.com", "pending", 9_999_999_999); // still valid
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId, expectedDeliveryVersion: 1 });
    expect(result.status).toBe("resent");
    expect(stores.teamWorkspaceSeatAdmission.has(WS_ID)).toBe(false); // never touched
  });

  it("resend of a CURRENTLY EXPIRED pending invitation (reactivation) at real occupancy 5/5 (excluding the expired one) is DENIED — no loophole around the limit", async () => {
    seedFillerMembers(4); // admin + 4 fillers = 5 non-owner active real members
    const { invitationId } = seedGuardCurrentInvitation("expired@example.com", "pending", 1); // expired
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId, expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "seat_limit_reached" });
    // The invitation's expiry/token/deliveryVersion are untouched — the resend never committed.
    expect(stores.workspaceInvitations.get(invitationId)!.data.deliveryVersion).toBe(1);
    expect(stores.workspaceInvitations.get(invitationId)!.data.expiresAt).toEqual(ts(1));
  });

  it("resend of a CURRENTLY EXPIRED pending invitation (reactivation) at real occupancy 4 succeeds and reserves the 5th seat", async () => {
    seedFillerMembers(3); // admin + 3 fillers = 4 non-owner active real members
    const { invitationId } = seedGuardCurrentInvitation("expired@example.com", "pending", 1); // expired
    const result = await resendWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId, expectedDeliveryVersion: 1 });
    expect(result.status).toBe("resent");
    expect(admissionDoc()).toMatchObject({ reservedCount: 5 });
  });
});

describe("Section V — revoke releases a seat only if the invitation was currently valid", () => {
  it("revoking a CURRENTLY VALID pending invitation releases exactly one seat", async () => {
    seedFillerMembers(3); // admin + 3 fillers = 4 non-owner active
    const { invitationId } = seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 9_999_999_999); // occupancy 5
    const result = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId, expectedDeliveryVersion: 1 });
    expect(result.status).toBe("revoked");
    expect(admissionDoc()).toMatchObject({ reservedCount: 4 }); // bootstrapped from live 5, released to 4
  });

  it("revoking an ALREADY-EXPIRED pending invitation does NOT release a seat — it was already contributing zero, decrementing would undercount true occupancy", async () => {
    seedFillerMembers(2); // 4 active
    const { invitationId } = seedGuardCurrentInvitation(INVITEE_EMAIL, "pending", 1); // expired — contributes 0
    const result = await revokeWorkspaceInvitation({ uid: OWNER_UID, workspaceId: WS_ID, invitationId, expectedDeliveryVersion: 1 });
    expect(result.status).toBe("revoked");
    // No admission doc was ever created — no release call was made for an already-zero-contributing reservation.
    expect(stores.teamWorkspaceSeatAdmission.has(WS_ID)).toBe(false);
  });
});

describe("Section W — member removal always releases exactly one seat", () => {
  it("removing an active non-owner member frees exactly one seat", async () => {
    seedFillerMembers(4); // admin + 4 fillers = 5 non-owner active, at the limit
    const result = await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: "filler-0" });
    expect(result.status).toBe("removed");
    expect(admissionDoc()).toMatchObject({ reservedCount: 4 }); // bootstrapped from live 5, released to 4
  });

  it("after removal frees a seat, a new invitation can be created", async () => {
    seedFillerMembers(4); // admin + 4 fillers = 5 non-owner active, at the limit
    await removeWorkspaceMembership({ uid: OWNER_UID, workspaceId: WS_ID, targetUid: "filler-0" });
    const result = await createWorkspaceInvitation({ uid: ADMIN_UID, workspaceId: WS_ID, email: INVITEE_EMAIL, role: "member" });
    expect(result.status).toBe("created");
  });
});
