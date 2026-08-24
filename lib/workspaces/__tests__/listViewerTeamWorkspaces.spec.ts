/**
 * Approval Workflow, Phase 9C.1-R1C — listViewerTeamWorkspaces() tests.
 * Proves the bounded, PAGINATED discovery/selection list: every active
 * Team Workspace membership is reachable through pagination (no
 * `.limit(N)`-with-no-`orderBy` truncation defect), ordering is by
 * document id (index-free — see the module's own doc comment for why),
 * and the response never exposes anything beyond `workspaceId`/`name`.
 */

type StoredDoc = Record<string, unknown>;
const membershipsStore: StoredDoc[] = [];
const workspacesStore = new Map<string, StoredDoc>();

function resetStores() {
  membershipsStore.length = 0;
  workspacesStore.clear();
}

let simulateQueryFailure = false;
let simulateGetAllFailure = false;
let simulateNoAdminDb = false;

class FakeMembershipQuery {
  constructor(
    private docs: StoredDoc[],
    private afterId: string | null = null,
    private lim: number | null = null
  ) {}
  where(field: string, _op: "==", value: unknown): FakeMembershipQuery {
    return new FakeMembershipQuery(
      this.docs.filter((d) => d[field] === value),
      this.afterId,
      this.lim
    );
  }
  orderBy(_fieldPath: unknown): FakeMembershipQuery {
    const sorted = [...this.docs].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return new FakeMembershipQuery(sorted, this.afterId, this.lim);
  }
  startAfter(cursorId: string): FakeMembershipQuery {
    return new FakeMembershipQuery(this.docs, cursorId, this.lim);
  }
  limit(n: number): FakeMembershipQuery {
    return new FakeMembershipQuery(this.docs, this.afterId, n);
  }
  async get() {
    if (simulateQueryFailure) throw new Error("simulated Firestore failure");
    let docs = this.docs;
    if (this.afterId) {
      const idx = docs.findIndex((d) => d.id === this.afterId);
      docs = idx >= 0 ? docs.slice(idx + 1) : docs;
    }
    if (this.lim !== null) docs = docs.slice(0, this.lim);
    return { docs: docs.map((data) => ({ id: data.id as string, data: () => data })) };
  }
}

function makeWorkspaceRef(id: string) {
  return { __collection: "workspaces", __id: id };
}

const realFakeDb: any = {
  collection: (name: string) => {
    if (name === "workspaceMemberships") return new FakeMembershipQuery(membershipsStore);
    if (name === "workspaces") return { doc: (id: string) => makeWorkspaceRef(id) };
    throw new Error(`unexpected collection: ${name}`);
  },
  getAll: async (...refs: { __collection: string; __id: string }[]) => {
    if (simulateGetAllFailure) throw new Error("simulated getAll failure");
    return refs.map((ref) => {
      const data = workspacesStore.get(ref.__id);
      return { exists: data !== undefined, data: () => data, id: ref.__id };
    });
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return simulateNoAdminDb ? null : realFakeDb;
  },
}));

import { Timestamp } from "firebase-admin/firestore";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { listViewerTeamWorkspaces, VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE } from "@/lib/workspaces/listViewerTeamWorkspaces";

const UID = "viewer-1";

function seedMembership(workspaceId: string, uid: string, overrides: Partial<StoredDoc> = {}) {
  const id = computeMembershipId(workspaceId, uid);
  membershipsStore.push({
    schemaVersion: 1,
    id,
    workspaceId,
    uid,
    role: "member",
    status: "active",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    invitedByUserId: null,
    removedAt: null,
    removedByUserId: null,
    ...overrides,
  });
}

function seedWorkspace(workspaceId: string, name: string, overrides: Partial<StoredDoc> = {}) {
  workspacesStore.set(workspaceId, {
    schemaVersion: 1,
    id: workspaceId,
    type: "team",
    name,
    ownerUserId: "owner-1",
    createdByUserId: "owner-1",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...overrides,
  });
}

beforeEach(() => {
  resetStores();
  simulateQueryFailure = false;
  simulateGetAllFailure = false;
  simulateNoAdminDb = false;
});

describe("listViewerTeamWorkspaces — basic listing", () => {
  it("returns an empty page for a uid with no memberships", async () => {
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result).toEqual({ status: "ok", items: [], hasMore: false, nextCursor: null });
  });

  it("returns one item for one active membership with a resolvable Team Workspace", async () => {
    seedMembership("ws-a", UID);
    seedWorkspace("ws-a", "Acme Research");
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result).toEqual({ status: "ok", items: [{ workspaceId: "ws-a", name: "Acme Research" }], hasMore: false, nextCursor: null });
  });

  it("excludes a removed membership", async () => {
    seedMembership("ws-removed", UID, { status: "removed", removedAt: Timestamp.now(), removedByUserId: "owner-1" });
    seedWorkspace("ws-removed", "Removed Co");
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result).toEqual({ status: "ok", items: [], hasMore: false, nextCursor: null });
  });

  it("excludes a membership belonging to a different uid", async () => {
    seedMembership("ws-a", "someone-else");
    seedWorkspace("ws-a", "Acme");
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result.status).toBe("ok");
    expect((result as any).items).toEqual([]);
  });
});

describe("listViewerTeamWorkspaces — Phase 9C.1-R1C: every Workspace reachable through pagination", () => {
  it("hasMore=true and a nextCursor when a full page is returned; the next page reaches the remaining Workspace(s) — no fixed-limit truncation", async () => {
    seedMembership("ws-a", UID);
    seedWorkspace("ws-a", "Alpha");
    seedMembership("ws-b", UID);
    seedWorkspace("ws-b", "Beta");
    seedMembership("ws-c", UID);
    seedWorkspace("ws-c", "Gamma");

    const page1 = await listViewerTeamWorkspaces({ uid: UID, limit: 2 });
    expect(page1.status).toBe("ok");
    if (page1.status !== "ok") return;
    expect(page1.items.length).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listViewerTeamWorkspaces({ uid: UID, limit: 2, cursor: page1.nextCursor });
    expect(page2.status).toBe("ok");
    if (page2.status !== "ok") return;
    expect(page2.items.length).toBe(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();

    const allWorkspaceIds = new Set([...page1.items, ...page2.items].map((i) => i.workspaceId));
    expect(allWorkspaceIds).toEqual(new Set(["ws-a", "ws-b", "ws-c"]));
  });

  it("beyond the historical single-page .limit(10) bound: a uid with 15 active memberships can still reach every one via pagination", async () => {
    for (let i = 0; i < 15; i++) {
      seedMembership(`ws-${i}`, UID);
      seedWorkspace(`ws-${i}`, `Workspace ${i}`);
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = await listViewerTeamWorkspaces({ uid: UID, limit: 4, cursor });
      expect(page.status).toBe("ok");
      if (page.status !== "ok") break;
      for (const item of page.items) seen.add(item.workspaceId);
      cursor = page.nextCursor;
      guard++;
    } while (cursor && guard < 20);
    expect(seen.size).toBe(15);
  });

  it("clamps limit to the max page size", async () => {
    for (let i = 0; i < 3; i++) {
      seedMembership(`ws-${i}`, UID);
      seedWorkspace(`ws-${i}`, `WS ${i}`);
    }
    const result = await listViewerTeamWorkspaces({ uid: UID, limit: 99999 });
    expect(result.status).toBe("ok");
  });

  it("defaults to VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE when no limit is given", async () => {
    seedMembership("ws-a", UID);
    seedWorkspace("ws-a", "Alpha");
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result.status).toBe("ok");
    expect(VIEWER_WORKSPACE_LIST_DEFAULT_PAGE_SIZE).toBeGreaterThan(0);
  });
});

describe("listViewerTeamWorkspaces — malformed/mismatched data fails safe", () => {
  it("excludes a confused-deputy membership document (id doesn't match embedded workspaceId/uid)", async () => {
    seedMembership("ws-x", UID, { id: "wm_not_matching_the_real_derivation" });
    seedWorkspace("ws-x", "X Co");
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items).toEqual([]);
  });

  it("excludes a membership whose Workspace document doesn't exist (dangling reference)", async () => {
    seedMembership("ws-missing", UID);
    // no seedWorkspace() call — the workspace doc doesn't exist
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items).toEqual([]);
  });

  it("excludes a membership whose Workspace document is malformed", async () => {
    seedMembership("ws-malformed", UID);
    workspacesStore.set("ws-malformed", { schemaVersion: 1 } as StoredDoc); // missing required fields
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items).toEqual([]);
  });

  it("excludes a Personal-typed Workspace document defensively, even though workspaceMemberships should never reference one", async () => {
    seedMembership("ws-personal", UID);
    seedWorkspace("ws-personal", "Should Not Appear", { type: "personal", createdByUserId: undefined });
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items).toEqual([]);
  });

  it("a Workspace document whose own id disagrees with the membership's workspaceId is excluded", async () => {
    seedMembership("ws-y", UID);
    workspacesStore.set("ws-y", {
      schemaVersion: 1,
      id: "ws-different",
      type: "team",
      name: "Mismatched",
      ownerUserId: "owner-1",
      createdByUserId: "owner-1",
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items).toEqual([]);
  });
});

describe("listViewerTeamWorkspaces — presentation and privacy", () => {
  it("sorts each page's items by Workspace name", async () => {
    seedMembership("ws-z", UID);
    seedWorkspace("ws-z", "Zeta");
    seedMembership("ws-a", UID);
    seedWorkspace("ws-a", "Alpha");
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items.map((i) => i.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("response items expose only workspaceId and name — no role, capabilities, owner uid, or member data", async () => {
    seedMembership("ws-a", UID, { role: "owner" });
    seedWorkspace("ws-a", "Acme");
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      for (const item of result.items) {
        expect(Object.keys(item).sort()).toEqual(["name", "workspaceId"]);
      }
    }
  });

  it("batches Workspace document reads via getAll — never one get() per membership", async () => {
    const getAllSpy = jest.spyOn(realFakeDb, "getAll");
    seedMembership("ws-a", UID);
    seedWorkspace("ws-a", "A");
    seedMembership("ws-b", UID);
    seedWorkspace("ws-b", "B");
    await listViewerTeamWorkspaces({ uid: UID });
    expect(getAllSpy).toHaveBeenCalledTimes(1);
    getAllSpy.mockRestore();
  });
});

describe("listViewerTeamWorkspaces — failure semantics", () => {
  it("returns lookup_failed when adminDb is unavailable", async () => {
    simulateNoAdminDb = true;
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result).toEqual({ status: "lookup_failed" });
  });

  it("returns lookup_failed when the membership query throws", async () => {
    simulateQueryFailure = true;
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result).toEqual({ status: "lookup_failed" });
  });

  it("returns lookup_failed when the batched Workspace getAll() throws", async () => {
    seedMembership("ws-a", UID);
    seedWorkspace("ws-a", "A");
    simulateGetAllFailure = true;
    const result = await listViewerTeamWorkspaces({ uid: UID });
    expect(result).toEqual({ status: "lookup_failed" });
  });
});
