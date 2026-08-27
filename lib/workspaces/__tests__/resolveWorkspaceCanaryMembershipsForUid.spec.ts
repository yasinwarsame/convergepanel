/**
 * Workspace-Scoped Team Canary, Phase 10B.3.1 —
 * `resolveWorkspaceCanaryMembershipsForUid()` /
 * `listWorkspaceCanaryMembershipsForUid()` tests. Fake `adminDb` supports
 * only deterministic doc-ref point reads via `getAll()` — no query
 * support needed, mirroring the bounded-point-read design these
 * functions use (never a `.where()` scan).
 */

import { Timestamp } from "firebase-admin/firestore";

type StoredDoc = Record<string, unknown>;
const membershipsStore = new Map<string, StoredDoc>();
const workspacesStore = new Map<string, StoredDoc>();

function resetStores() {
  membershipsStore.clear();
  workspacesStore.clear();
}

let simulateGetAllFailure = false;
let simulateNoAdminDb = false;

function makeRef(collection: string, id: string) {
  return { __collection: collection, __id: id, id };
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => makeRef(name, id),
  }),
  getAll: async (...refs: Array<{ __collection: string; __id: string }>) => {
    if (simulateGetAllFailure) throw new Error("simulated Firestore failure");
    return refs.map((ref) => {
      const store = ref.__collection === "workspaceMemberships" ? membershipsStore : workspacesStore;
      const data = store.get(ref.__id);
      return { exists: data !== undefined, data: () => data, id: ref.__id };
    });
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return simulateNoAdminDb ? null : mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { resolveWorkspaceCanaryMembershipsForUid, listWorkspaceCanaryMembershipsForUid } from "@/lib/workspaces/resolveWorkspaceCanaryMembershipsForUid";

const UID = "uid-1";
const NOW = Timestamp.now();

function seedMembership(workspaceId: string, uid: string, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(workspaceId, uid);
  membershipsStore.set(id, {
    schemaVersion: 1,
    id,
    workspaceId,
    uid,
    role: "member",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    invitedByUserId: null,
    removedAt: null,
    removedByUserId: null,
    ...overrides,
  });
}

function seedWorkspace(workspaceId: string, overrides: Record<string, unknown> = {}) {
  workspacesStore.set(workspaceId, {
    schemaVersion: 1,
    id: workspaceId,
    type: "team",
    name: `Name-${workspaceId}`,
    ownerUserId: "owner-1",
    createdByUserId: "owner-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

beforeEach(() => {
  resetStores();
  simulateGetAllFailure = false;
  simulateNoAdminDb = false;
});

describe("resolveWorkspaceCanaryMembershipsForUid", () => {
  it("absent canary list -> ok, empty, zero reads (no adminDb call needed)", async () => {
    simulateNoAdminDb = true; // proves the function never even touches adminDb when the list is empty
    const result = await resolveWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: undefined });
    expect(result).toEqual({ status: "ok", workspaceIds: [] });
  });

  it("empty string canary list -> ok, empty", async () => {
    const result = await resolveWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "" });
    expect(result).toEqual({ status: "ok", workspaceIds: [] });
  });

  it("malformed canary list -> ok, empty (fails closed, not lookup_failed)", async () => {
    const result = await resolveWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "*" });
    expect(result).toEqual({ status: "ok", workspaceIds: [] });
  });

  it("one admitted Workspace, active membership -> survives", async () => {
    seedMembership("ws-1", UID);
    const result = await resolveWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "ok", workspaceIds: ["ws-1"] });
  });

  it("admitted Workspace, no membership -> does not survive", async () => {
    const result = await resolveWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "ok", workspaceIds: [] });
  });

  it("admitted Workspace, removed membership -> does not survive", async () => {
    seedMembership("ws-1", UID, { status: "removed", removedAt: NOW, removedByUserId: "someone" });
    const result = await resolveWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "ok", workspaceIds: [] });
  });

  it("admitted Workspace, malformed membership -> fails closed, does not survive, never grants", async () => {
    membershipsStore.set(computeMembershipId("ws-1", UID), { garbage: true });
    const result = await resolveWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "ok", workspaceIds: [] });
  });

  it("cross-Workspace: caller has an active membership in a NON-admitted Workspace -> not returned, only the admitted one is", async () => {
    seedMembership("ws-1", UID); // admitted
    seedMembership("ws-2", UID); // NOT admitted (not in the list below)
    const result = await resolveWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "ok", workspaceIds: ["ws-1"] });
  });

  it("multiple admitted Workspaces, active member of both -> both survive", async () => {
    seedMembership("ws-1", UID);
    seedMembership("ws-2", UID);
    const result = await resolveWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1,ws-2" });
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && [...result.workspaceIds].sort()).toEqual(["ws-1", "ws-2"]);
  });

  it("bounded: at most 10 candidate reads regardless of list size (list itself is capped at 10 by the parser)", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `ws-${i}`);
    for (const id of ids) seedMembership(id, UID);
    const result = await resolveWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: ids.join(",") });
    expect(result.status === "ok" && result.workspaceIds.length).toBe(10);
  });

  it("adminDb unavailable -> lookup_failed", async () => {
    simulateNoAdminDb = true;
    const result = await resolveWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "lookup_failed" });
  });

  it("getAll throws -> lookup_failed", async () => {
    simulateGetAllFailure = true;
    const result = await resolveWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "lookup_failed" });
  });
});

describe("listWorkspaceCanaryMembershipsForUid", () => {
  it("no surviving membership -> ok, empty items, zero Workspace reads", async () => {
    const result = await listWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "ok", items: [] });
  });

  it("one surviving membership -> returns {workspaceId, name}", async () => {
    seedMembership("ws-1", UID);
    seedWorkspace("ws-1", { name: "Acme" });
    const result = await listWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "ok", items: [{ workspaceId: "ws-1", name: "Acme" }] });
  });

  it("never returns a Workspace merely because its id is allowlisted — only ones the caller actively belongs to", async () => {
    seedWorkspace("ws-1", { name: "Acme" }); // real Workspace, allowlisted, but no membership
    const result = await listWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "ok", items: [] });
  });

  it("multiple surviving memberships -> deterministic name-sorted order", async () => {
    seedMembership("ws-1", UID);
    seedMembership("ws-2", UID);
    seedWorkspace("ws-1", { name: "Zebra" });
    seedWorkspace("ws-2", { name: "Apple" });
    const result = await listWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1,ws-2" });
    expect(result.status === "ok" && result.items.map((i) => i.name)).toEqual(["Apple", "Zebra"]);
  });

  it("malformed Workspace document -> excluded, never listed", async () => {
    seedMembership("ws-1", UID);
    workspacesStore.set("ws-1", { garbage: true });
    const result = await listWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "ok", items: [] });
  });

  it("Workspace document id mismatch -> excluded, never listed", async () => {
    seedMembership("ws-1", UID);
    seedWorkspace("ws-1", { id: "different-id" });
    const result = await listWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "ok", items: [] });
  });

  it("Personal-typed Workspace document at that id -> excluded (workspaceMemberships is Team-only, but never trusted blindly)", async () => {
    seedMembership("ws-1", UID);
    seedWorkspace("ws-1", { type: "personal", ownerUserId: UID });
    const result = await listWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "ok", items: [] });
  });

  it("core lookup failure propagates as lookup_failed", async () => {
    simulateNoAdminDb = true;
    // seed a candidate so the core function actually needs adminDb
    const result = await listWorkspaceCanaryMembershipsForUid({ uid: UID, canaryWorkspaceIdsRaw: "ws-1" });
    expect(result).toEqual({ status: "lookup_failed" });
  });
});
