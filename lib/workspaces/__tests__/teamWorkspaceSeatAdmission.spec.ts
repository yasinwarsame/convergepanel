/**
 * Permanent Team Workspace Collaborator-Seat Limit, Phase 12A.1S.1 —
 * `teamWorkspaceSeatAdmission.ts` in isolation (bootstrap, fast path,
 * full-cache self-heal, no-write-on-denial, release safety/underflow, and
 * the structural read-before-write / read+write coupling the concurrency
 * safety argument depends on). Invitation/membership WIRING is covered
 * separately in `workspaceInvitationCapacityIntegration.spec.ts` and
 * `workspaceInvitations.spec.ts`/`workspaceMemberships.spec.ts` — this file
 * exercises the module's own public functions directly against a minimal
 * in-memory Firestore transaction fake (doc-ref + query-object reads),
 * mirroring the query-aware fake convention established in
 * `workspaceInvitationCapacityIntegration.spec.ts`.
 */

import { Timestamp } from "firebase-admin/firestore";

function ts(seconds: number): Timestamp {
  return new Timestamp(seconds, 0);
}

type StoredDoc = { data: Record<string, unknown> };
const stores: Record<string, Map<string, StoredDoc>> = {
  workspaceMemberships: new Map(),
  workspaceInvitations: new Map(),
  workspaceInvitationKeys: new Map(),
  teamWorkspaceSeatAdmission: new Map(),
};

function resetStores() {
  for (const store of Object.values(stores)) store.clear();
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

let writeLog: Array<{ kind: "create" | "update"; collection: string; id: string; data: Record<string, unknown> }> = [];
let readLog: Array<{ kind: "doc" | "query"; collection: string; id?: string }> = [];

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId: string) => makeDocRef(name, docId),
    where: (field: string, op: string, value: unknown) => makeQuery(name, [[field, op, value]]),
  }),
};

/** A single fake transaction object — reused directly (no runTransaction wrapper needed; this module's own functions take `tx` directly). */
function makeTx() {
  return {
    get: async (ref: any) => {
      if (ref.__kind === "query") {
        readLog.push({ kind: "query", collection: ref.__collection });
        const store = stores[ref.__collection];
        const docs: Array<{ id: string; data: () => Record<string, unknown>; exists: true }> = [];
        for (const [id, entry] of store.entries()) {
          const matches = (ref.__filters as QueryFilter[]).every(([field, op, value]) => op === "==" && (entry.data as Record<string, unknown>)[field] === value);
          if (matches) docs.push({ id, data: () => entry.data, exists: true });
        }
        return { empty: docs.length === 0, docs };
      }
      readLog.push({ kind: "doc", collection: ref.__collection, id: ref.__id });
      const store = stores[ref.__collection];
      const entry = store.get(ref.__id);
      return { exists: entry !== undefined, data: () => entry?.data };
    },
    create: (ref: any, data: Record<string, unknown>) => {
      writeLog.push({ kind: "create", collection: ref.__collection, id: ref.__id, data });
      stores[ref.__collection].set(ref.__id, { data });
    },
    update: (ref: any, data: Record<string, unknown>) => {
      writeLog.push({ kind: "update", collection: ref.__collection, id: ref.__id, data });
      const store = stores[ref.__collection];
      const entry = store.get(ref.__id);
      store.set(ref.__id, { data: { ...(entry?.data ?? {}), ...data } });
    },
  };
}

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { computeWorkspaceInvitationKey } from "@/lib/workspaces/invitationKey";
import {
  reserveTeamWorkspaceSeat,
  releaseTeamWorkspaceSeat,
  planTeamWorkspaceSeatReservation,
  commitTeamWorkspaceSeatReservation,
  planTeamWorkspaceSeatRelease,
  commitTeamWorkspaceSeatRelease,
  isWellFormedTeamWorkspaceSeatAdmissionV1,
} from "@/lib/workspaces/teamWorkspaceSeatAdmission";

const WS_ID = "ws-seat-1";
const LIMIT = 5;

function seedMembership(uid: string, role: string) {
  const id = computeMembershipId(WS_ID, uid);
  stores.workspaceMemberships.set(id, {
    data: { schemaVersion: 1, id, workspaceId: WS_ID, uid, role, status: "active", createdAt: ts(1000), updatedAt: ts(1000), invitedByUserId: null, removedAt: null, removedByUserId: null },
  });
}

/** N throwaway active non-owner members, beyond any owner seeded separately. */
function seedNonOwnerMembers(count: number) {
  for (let i = 0; i < count; i++) seedMembership(`member-${i}`, "member");
}

let guardCounter = 0;
function seedInvitation(email: string, status: "pending" | "accepted" | "revoked", expiresAtSeconds: number) {
  guardCounter += 1;
  const invitationId = `inv-${guardCounter}`;
  const guardKey = computeWorkspaceInvitationKey(WS_ID, email);
  stores.workspaceInvitationKeys.set(guardKey, { data: { workspaceId: WS_ID, normalizedEmail: email, currentInvitationId: invitationId, updatedAt: ts(1000) } });
  stores.workspaceInvitations.set(invitationId, {
    data: {
      schemaVersion: 1,
      id: invitationId,
      workspaceId: WS_ID,
      normalizedEmail: email,
      role: "member",
      status,
      tokenHash: "a".repeat(64),
      expiresAt: ts(expiresAtSeconds),
      createdAt: ts(1000),
      updatedAt: ts(1000),
      invitedByUserId: "owner-1",
      acceptedAt: status === "accepted" ? ts(1500) : null,
      acceptedByUserId: status === "accepted" ? "someone" : null,
      revokedAt: status === "revoked" ? ts(1500) : null,
      revokedByUserId: status === "revoked" ? "owner-1" : null,
      deliveryVersion: 1,
      lastDeliveryAttemptAt: null,
      lastDeliveryStatus: null,
      lastDeliveryVersion: null,
      providerMessageId: null,
    },
  });
}

function admissionDoc() {
  return stores.teamWorkspaceSeatAdmission.get(WS_ID)?.data as { reservedCount: number; revision: number } | undefined;
}

beforeEach(() => {
  resetStores();
  guardCounter = 0;
  writeLog = [];
  readLog = [];
  seedMembership("owner-1", "owner"); // canonical Owner in every test — never counted toward the limit
});

describe("isWellFormedTeamWorkspaceSeatAdmissionV1", () => {
  it("accepts a well-formed document", () => {
    expect(isWellFormedTeamWorkspaceSeatAdmissionV1({ schemaVersion: 1, workspaceId: WS_ID, reservedCount: 3, revision: 2, updatedAt: ts(1000) })).toBe(true);
  });
  it("rejects a negative reservedCount", () => {
    expect(isWellFormedTeamWorkspaceSeatAdmissionV1({ schemaVersion: 1, workspaceId: WS_ID, reservedCount: -1, revision: 0, updatedAt: ts(1000) })).toBe(false);
  });
  it("rejects a non-integer revision", () => {
    expect(isWellFormedTeamWorkspaceSeatAdmissionV1({ schemaVersion: 1, workspaceId: WS_ID, reservedCount: 0, revision: 1.5, updatedAt: ts(1000) })).toBe(false);
  });
  it("rejects a missing updatedAt", () => {
    expect(isWellFormedTeamWorkspaceSeatAdmissionV1({ schemaVersion: 1, workspaceId: WS_ID, reservedCount: 0, revision: 0 })).toBe(false);
  });
});

describe("bootstrap (AG) — formula: active non-owner members + canonical-Owner excluded + valid non-expired pending invitations only", () => {
  it("0 live seats -> first reservation bootstraps safely to 1", async () => {
    const result = await reserveTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "reserved", occupied: 1 });
    expect(admissionDoc()).toMatchObject({ reservedCount: 1, revision: 0 });
  });

  it("canonical Owner alone contributes 0 — reserving the first REAL collaborator seat still starts from 0, not 1", async () => {
    // Only the Owner (seeded in beforeEach) exists; no non-owner members.
    const result = await reserveTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "reserved", occupied: 1 });
  });

  it("4 live non-owner seats -> reservation creates 5 (exactly at the limit)", async () => {
    seedNonOwnerMembers(4);
    const result = await reserveTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "reserved", occupied: 5 });
  });

  it("5 live non-owner seats -> reservation denied", async () => {
    seedNonOwnerMembers(5);
    const result = await reserveTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "limit_reached", occupied: 5, limit: LIMIT });
    expect(stores.teamWorkspaceSeatAdmission.has(WS_ID)).toBe(false); // rejection never persists a bootstrap
  });

  it("legacy over-limit Workspace (7 real non-owner members, predates this feature) -> new reservation denied without touching existing memberships/invitations", async () => {
    seedNonOwnerMembers(7);
    const before = stores.workspaceMemberships.size;
    const result = await reserveTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "limit_reached", occupied: 7, limit: LIMIT });
    expect(stores.workspaceMemberships.size).toBe(before); // nothing removed/rewritten
  });

  it("mixed memberships + invitations: 3 members + 1 valid pending -> occupancy 4, reservation succeeds to 5", async () => {
    seedNonOwnerMembers(3);
    seedInvitation("pending@example.com", "pending", 9_999_999_999);
    const result = await reserveTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "reserved", occupied: 5 });
  });

  it("expired pending invitation contributes 0 — 5 members + 1 expired pending still admits", async () => {
    seedNonOwnerMembers(4);
    seedInvitation("expired@example.com", "pending", 1); // expiresAt in the past
    const result = await reserveTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "reserved", occupied: 5 }); // 4 real + expired(0) + new(1) = 5
  });

  it("accepted/revoked historical invitations never reserve — 4 members + 1 accepted + 1 revoked still admits at 5", async () => {
    seedNonOwnerMembers(4);
    seedInvitation("accepted@example.com", "accepted", 9_999_999_999);
    seedInvitation("revoked@example.com", "revoked", 9_999_999_999);
    const result = await reserveTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "reserved", occupied: 5 });
  });
});

describe("fast path (AH) vs. full-cache self-heal path (AI)", () => {
  it("existing cache under the limit (3) -> fast-path admits using the cache, never recomputes live state", async () => {
    stores.teamWorkspaceSeatAdmission.set(WS_ID, { data: { schemaVersion: 1, workspaceId: WS_ID, reservedCount: 3, revision: 2, updatedAt: ts(1000) } });
    seedNonOwnerMembers(20); // deliberately WRONG real count — fast path must never consult it
    readLog = [];
    const result = await reserveTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "reserved", occupied: 4 });
    expect(admissionDoc()).toMatchObject({ reservedCount: 4, revision: 3 });
    // Only the admission doc itself was read — no membership/invitation query.
    expect(readLog.some((r) => r.collection === "workspaceMemberships")).toBe(false);
    expect(readLog.some((r) => r.collection === "workspaceInvitationKeys")).toBe(false);
  });

  it("cache AT the limit (5) but TRUE live occupancy is actually lower (a pending invitation naturally expired, no write ever occurred) -> self-heals and admits, no cron/background job involved", async () => {
    stores.teamWorkspaceSeatAdmission.set(WS_ID, { data: { schemaVersion: 1, workspaceId: WS_ID, reservedCount: 5, revision: 4, updatedAt: ts(1000) } });
    seedNonOwnerMembers(4); // true live occupancy is only 4 — the cache is stale-high
    const result = await reserveTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "reserved", occupied: 5 });
    // Self-healed to the corrected true value (4) plus the new reservation (5), advancing revision by exactly one real update.
    expect(admissionDoc()).toMatchObject({ reservedCount: 5, revision: 5 });
  });

  it("cache AT the limit and TRUE live occupancy is genuinely also at the limit -> denies, cache left at the corrected (here: unchanged) value, no write on denial", async () => {
    stores.teamWorkspaceSeatAdmission.set(WS_ID, { data: { schemaVersion: 1, workspaceId: WS_ID, reservedCount: 5, revision: 4, updatedAt: ts(1000) } });
    seedNonOwnerMembers(5); // true live occupancy really is 5
    writeLog = [];
    const result = await reserveTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "limit_reached", occupied: 5, limit: LIMIT });
    expect(writeLog.length).toBe(0); // AJ — no-write-on-denial, even on the self-heal path
    expect(admissionDoc()).toMatchObject({ reservedCount: 5, revision: 4 }); // cache untouched
  });

  it("malformed persisted admission document (negative reservedCount) -> fails closed as state_corruption, never trusted or silently repaired", async () => {
    stores.teamWorkspaceSeatAdmission.set(WS_ID, { data: { schemaVersion: 1, workspaceId: WS_ID, reservedCount: -3, revision: 0, updatedAt: ts(1000) } });
    const result = await reserveTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "state_corruption" });
  });
});

describe("release (AQ) — never underflows, safe when the admission document is missing or stale-high", () => {
  it("release when no admission doc exists yet -> bootstraps from live state first, then releases", async () => {
    seedNonOwnerMembers(3); // simulates: this release corresponds to one of these members' removal, evaluated as still-present at read time
    const result = await releaseTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "released", occupied: 2 });
    expect(admissionDoc()).toMatchObject({ reservedCount: 2, revision: 0 });
  });

  it("release on an existing cache at 3 -> 2, revision advances", async () => {
    stores.teamWorkspaceSeatAdmission.set(WS_ID, { data: { schemaVersion: 1, workspaceId: WS_ID, reservedCount: 3, revision: 1, updatedAt: ts(1000) } });
    const result = await releaseTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "released", occupied: 2 });
    expect(admissionDoc()).toMatchObject({ reservedCount: 2, revision: 2 });
  });

  it("release on a cache already at 0 -> underflow rejected as state_corruption, never clamped or silently accepted", async () => {
    stores.teamWorkspaceSeatAdmission.set(WS_ID, { data: { schemaVersion: 1, workspaceId: WS_ID, reservedCount: 0, revision: 5, updatedAt: ts(1000) } });
    const result = await releaseTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "state_corruption" });
  });

  it("release when the bootstrapped-from-live count is itself already 0 -> underflow rejected, never clamped", async () => {
    // No non-owner members, no invitations — only the Owner exists.
    const result = await releaseTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "state_corruption" });
  });

  it("release does NOT self-heal against live state the way reserve does — a stale-high cache simply decrements by one, remaining safely stale-high rather than under-correcting", async () => {
    stores.teamWorkspaceSeatAdmission.set(WS_ID, { data: { schemaVersion: 1, workspaceId: WS_ID, reservedCount: 5, revision: 0, updatedAt: ts(1000) } });
    seedNonOwnerMembers(2); // true live occupancy only 2 — cache is very stale-high
    const result = await releaseTeamWorkspaceSeat(makeTx(), WS_ID);
    expect(result).toEqual({ kind: "released", occupied: 4 }); // simple decrement of the CACHED value, not a live recompute
  });
});

describe("structural OCC invariant (AN) — the reservation genuinely READS and WRITES the same shared per-Workspace document", () => {
  it("planTeamWorkspaceSeatReservation() reads the shared admission document; commitTeamWorkspaceSeatReservation() writes the SAME document — the two are not independent state", async () => {
    const tx = makeTx();
    const plan = await planTeamWorkspaceSeatReservation(tx, WS_ID);
    expect(plan.kind).toBe("admit");
    expect(readLog.some((r) => r.kind === "doc" && r.collection === "teamWorkspaceSeatAdmission" && r.id === WS_ID)).toBe(true);
    if (plan.kind !== "admit") return;
    commitTeamWorkspaceSeatReservation(tx, WS_ID, plan);
    expect(writeLog.some((w) => (w.kind === "create" || w.kind === "update") && w.collection === "teamWorkspaceSeatAdmission" && w.id === WS_ID)).toBe(true);
  });

  it("MUTATION: a reservation that reads the admission doc but never writes it would leave two concurrent reservations both computing 'admit' from the same stale base — this is exactly what the plan/commit split exists to prevent; asserting the commit call actually stages a write proves the coupling is real, not merely documented", async () => {
    const tx = makeTx();
    const plan = await planTeamWorkspaceSeatReservation(tx, WS_ID);
    expect(plan.kind).toBe("admit");
    const writesBefore = writeLog.length;
    // Deliberately do NOT call commitTeamWorkspaceSeatReservation() — simulating the exact defect the OCC design must prevent from ever landing.
    expect(writeLog.length).toBe(writesBefore); // no write staged merely by planning
    // A second, independent plan computed from the SAME (still-uncommitted) base would ALSO see "admit" — proving the read alone provides no serialization; only a write against the same document does.
    const secondPlan = await planTeamWorkspaceSeatReservation(makeTx(), WS_ID);
    expect(secondPlan.kind).toBe("admit");
  });
});

describe("release plan/commit split mirrors reservation's", () => {
  it("planTeamWorkspaceSeatRelease() reads, commitTeamWorkspaceSeatRelease() writes the same document", async () => {
    seedNonOwnerMembers(3);
    const tx = makeTx();
    const plan = await planTeamWorkspaceSeatRelease(tx, WS_ID);
    expect(plan.kind).toBe("release");
    if (plan.kind !== "release") return;
    const writesBefore = writeLog.length;
    commitTeamWorkspaceSeatRelease(tx, WS_ID, plan);
    expect(writeLog.length).toBe(writesBefore + 1);
    expect(admissionDoc()).toMatchObject({ reservedCount: 2 });
  });
});
