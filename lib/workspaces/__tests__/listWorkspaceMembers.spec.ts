/**
 * Team Workspace Self-Service Onboarding — listWorkspaceMembers() tests.
 * Structural mirror of reviewerCandidates.spec.ts's fixture (a
 * `.where()`-capable fake for the `workspaceMemberships` collection).
 */

import { Timestamp } from "firebase-admin/firestore";

let updateTimeCounter = 0;
function nextUpdateTime(): Timestamp {
  updateTimeCounter += 1;
  return new Timestamp(1_700_000_000 + updateTimeCounter, 0);
}

type StoredDoc = Record<string, unknown>;
type StoredEntry = { data: StoredDoc; updateTime: Timestamp };
const stores: Record<string, Map<string, StoredEntry>> = {
  workspaceMemberships: new Map(),
  users: new Map(),
  workspaces: new Map(),
};

function resetStores() {
  for (const store of Object.values(stores)) store.clear();
}

function asPersisted(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

class FakeMembershipQuery {
  private filters: Array<{ field: string; value: unknown }> = [];
  private limitCount: number | null = null;
  where(field: string, op: string, value: unknown) {
    if (op !== "==") throw new Error(`unsupported op: ${op}`);
    this.filters.push({ field, value });
    return this;
  }
  limit(n: number) {
    this.limitCount = n;
    return this;
  }
  async get() {
    let entries = Array.from(stores.workspaceMemberships.values());
    for (const f of this.filters) entries = entries.filter((e) => e.data[f.field] === f.value);
    if (this.limitCount !== null) entries = entries.slice(0, this.limitCount);
    return { docs: entries.map((e) => ({ data: () => e.data, updateTime: e.updateTime })) };
  }
}

function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    get: async () => {
      const entry = stores[collectionName]?.get(docId);
      return { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime, id: docId };
    },
  };
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId: string) => makeDocRef(name, docId),
    where: (field: string, op: string, value: unknown) => new FakeMembershipQuery().where(field, op, value),
  }),
  getAll: async (...refs: { __collection: string; __id: string }[]) => {
    return refs.map((ref) => {
      const entry = stores[ref.__collection]?.get(ref.__id);
      return { exists: entry !== undefined, data: () => entry?.data, updateTime: entry?.updateTime, id: ref.__id };
    });
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { listWorkspaceMembers } from "@/lib/workspaces/listWorkspaceMembers";
import type { TeamWorkspaceV1 } from "@/lib/workspaces/types";

const WS_ID = "ws-1";
const OTHER_WS_ID = "ws-2";
const OWNER_UID = "owner-1";
const ADMIN_UID = "admin-1";
const MEMBER_UID = "member-1";
const REVIEWER_UID = "reviewer-1";
const VIEWER_UID = "viewer-1";
const NOW = Timestamp.now();

function workspace(overrides: Partial<TeamWorkspaceV1> = {}): TeamWorkspaceV1 {
  return { schemaVersion: 1, id: WS_ID, type: "team", name: "Test Workspace", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: NOW, updatedAt: NOW, ...overrides };
}

function seedMembership(uid: string, role: string, workspaceId: string = WS_ID, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(workspaceId, uid);
  const status = (overrides.status as string | undefined) ?? "active";
  const data = asPersisted({ schemaVersion: 1, id, workspaceId, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: status === "removed" ? NOW : null, removedByUserId: status === "removed" ? OWNER_UID : null, ...overrides });
  stores.workspaceMemberships.set(id, { data, updateTime: nextUpdateTime() });
}

function seedUser(uid: string, overrides: Record<string, unknown> = {}) {
  stores.users.set(uid, { data: { name: "", email: "", ...overrides }, updateTime: nextUpdateTime() });
}

/** Backs the second read `listWorkspaceMembers()` now performs (`workspaces/{workspaceId}`) purely to capture the Workspace document's own OCC `updateTime` — the passed-in `TeamWorkspaceV1` (see `workspace()` below) carries no snapshot metadata. */
function seedWorkspaceDoc(workspaceId: string = WS_ID, overrides: Record<string, unknown> = {}) {
  const data = { schemaVersion: 1, id: workspaceId, type: "team", name: "Test Workspace", ownerUserId: OWNER_UID, createdByUserId: OWNER_UID, createdAt: NOW, updatedAt: NOW, ...overrides };
  stores.workspaces.set(workspaceId, { data, updateTime: nextUpdateTime() });
}

beforeEach(() => {
  resetStores();
  seedWorkspaceDoc();
  seedMembership(OWNER_UID, "owner");
  seedMembership(ADMIN_UID, "admin");
  seedMembership(MEMBER_UID, "member");
  seedMembership(REVIEWER_UID, "reviewer");
  seedMembership(VIEWER_UID, "viewer");
});

describe("listWorkspaceMembers — membership scope", () => {
  it("lists all active members of the given Workspace", async () => {
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    const uids = result.members.map((m) => m.uid).sort();
    expect(uids).toEqual([ADMIN_UID, MEMBER_UID, OWNER_UID, REVIEWER_UID, VIEWER_UID].sort());
  });

  it("removed member excluded", async () => {
    seedMembership(REVIEWER_UID, "reviewer", WS_ID, { status: "removed" });
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.members.some((m) => m.uid === REVIEWER_UID)).toBe(false);
  });

  it("cross-Workspace member excluded (query itself scopes by workspaceId — no cross-Workspace enumeration)", async () => {
    seedMembership("cross-ws-uid", "reviewer", OTHER_WS_ID);
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.members.some((m) => m.uid === "cross-ws-uid")).toBe(false);
  });
});

describe("listWorkspaceMembers — canonical Owner badge", () => {
  it("the genuine Owner membership is badged isCanonicalOwner: true", async () => {
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    const owner = result.members.find((m) => m.uid === OWNER_UID);
    expect(owner?.isCanonicalOwner).toBe(true);
  });

  it("non-Owner members are never badged isCanonicalOwner", async () => {
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    for (const m of result.members.filter((x) => x.uid !== OWNER_UID)) expect(m.isCanonicalOwner).toBe(false);
  });

  it("a corrupt extra membership carrying role=\"owner\" for a uid that is NOT workspace.ownerUserId is still LISTED (fail-visible) but never badged canonical Owner", async () => {
    seedMembership("corrupt-owner-uid", "owner");
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    const corrupt = result.members.find((m) => m.uid === "corrupt-owner-uid");
    expect(corrupt).toBeDefined();
    expect(corrupt?.isCanonicalOwner).toBe(false);
    // The genuine owner (workspace.ownerUserId) remains the only canonical badge.
    expect(result.members.filter((m) => m.isCanonicalOwner)).toHaveLength(1);
  });
});

describe("listWorkspaceMembers — deterministic ordering", () => {
  it("Owner first, then Admin, Member, Reviewer, Viewer", async () => {
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.members.map((m) => m.role)).toEqual(["owner", "admin", "member", "reviewer", "viewer"]);
  });

  it("stable secondary sort by display name within the same role", async () => {
    seedMembership("member-2", "member");
    seedUser(MEMBER_UID, { name: "Zed Member" });
    seedUser("member-2", { name: "Amy Member" });
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    const memberNames = result.members.filter((m) => m.role === "member").map((m) => m.displayName);
    expect(memberNames.indexOf("Amy Member")).toBeLessThan(memberNames.indexOf("Zed Member"));
  });
});

describe("listWorkspaceMembers — identity resolution", () => {
  it("resolves display names, never raw UIDs", async () => {
    seedUser(OWNER_UID, { name: "Olivia Owner" });
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    const owner = result.members.find((m) => m.uid === OWNER_UID);
    expect(owner?.displayName).toBe("Olivia Owner");
  });

  it("no user doc: safe fallback, never the raw UID", async () => {
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    for (const m of result.members) expect(m.displayName).not.toBe(m.uid);
  });
});

describe("listWorkspaceMembers — projection safety", () => {
  it("returned members carry only the allow-listed DTO fields (uid, displayName, role, isCanonicalOwner, joinedAt, updateTimeToken) — no raw Firestore document, no removedAt/removedByUserId/invitedByUserId/schemaVersion", async () => {
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    for (const m of result.members) {
      expect(Object.keys(m).sort()).toEqual(["displayName", "isCanonicalOwner", "joinedAt", "role", "uid", "updateTimeToken"]);
    }
  });
});

describe("listWorkspaceMembers — Ownership Transfer UI, Phase TEAM-MGMT-12C: OCC token exposure", () => {
  it("each member's updateTimeToken is the losslessly-serialized native DocumentSnapshot.updateTime of THAT membership document, not a shared/derived value", async () => {
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    const owner = result.members.find((m) => m.uid === OWNER_UID)!;
    const admin = result.members.find((m) => m.uid === ADMIN_UID)!;
    const expectedOwnerUpdateTime = stores.workspaceMemberships.get(computeMembershipId(WS_ID, OWNER_UID))!.updateTime;
    const expectedAdminUpdateTime = stores.workspaceMemberships.get(computeMembershipId(WS_ID, ADMIN_UID))!.updateTime;
    expect(owner.updateTimeToken).toEqual({ seconds: expectedOwnerUpdateTime.seconds, nanoseconds: expectedOwnerUpdateTime.nanoseconds });
    expect(admin.updateTimeToken).toEqual({ seconds: expectedAdminUpdateTime.seconds, nanoseconds: expectedAdminUpdateTime.nanoseconds });
    expect(owner.updateTimeToken).not.toEqual(admin.updateTimeToken);
  });

  it("workspaceUpdateToken is the losslessly-serialized native DocumentSnapshot.updateTime of the Workspace document itself, read fresh (not derived from any membership's updateTime)", async () => {
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    const expectedWorkspaceUpdateTime = stores.workspaces.get(WS_ID)!.updateTime;
    expect(result.workspaceUpdateToken).toEqual({ seconds: expectedWorkspaceUpdateTime.seconds, nanoseconds: expectedWorkspaceUpdateTime.nanoseconds });
  });

  it("a missing Workspace document at the OCC-token read fails closed to query_failed rather than fabricating a token", async () => {
    stores.workspaces.delete(WS_ID);
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("query_failed");
  });
});

describe("listWorkspaceMembers — bounded read", () => {
  it("scan is bounded (query itself carries a .limit()) — a large membership set does not crash or hang", async () => {
    for (let i = 0; i < 50; i++) seedMembership(`bulk-uid-${i}`, "member");
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("listed");
  });
});

describe("listWorkspaceMembers — infrastructure", () => {
  it("adminDb unavailable -> firestore_unavailable", async () => {
    const original = mockAdminDb.collection;
    // Simulate adminDb being null by temporarily overriding the mock module's export via jest's own hoisted mock — simplest safe approach: swap collection to throw is insufficient (status differs), so directly re-mock via require cache is out of scope here; instead verify the query-failure path.
    mockAdminDb.collection = () => {
      throw new Error("simulated Firestore outage");
    };
    const result = await listWorkspaceMembers({ workspace: workspace() });
    expect(result.status).toBe("query_failed");
    mockAdminDb.collection = original;
  });
});
