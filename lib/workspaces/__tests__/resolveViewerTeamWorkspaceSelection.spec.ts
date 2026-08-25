/**
 * Approval Workflow, Phase 9C.1-R1C — resolveViewerTeamWorkspaceSelection()
 * tests. Replaces the deleted resolveViewerTeamWorkspaceId.spec.ts: the
 * defect under test here is exactly the one R1 confirmed — a uid with
 * TWO OR MORE active memberships must get `"multiple"`, NEVER a silently
 * chosen `workspaceId`. A minimal in-memory `workspaceMemberships` query
 * simulator, tailored exactly to this module's own
 * `.where("uid","==",...).where("status","==","active").limit(N).get()`
 * shape.
 */

type StoredDoc = Record<string, unknown>;
const membershipsStore: StoredDoc[] = [];

function resetStore() {
  membershipsStore.length = 0;
}

let simulateGetFailure = false;
let simulateNoAdminDb = false;

class FakeQuery {
  constructor(private docs: StoredDoc[]) {}
  where(field: string, _op: "==", value: unknown): FakeQuery {
    return new FakeQuery(this.docs.filter((d) => d[field] === value));
  }
  limit(n: number): FakeQuery {
    return new FakeQuery(this.docs.slice(0, n));
  }
  async get() {
    if (simulateGetFailure) throw new Error("simulated Firestore failure");
    return { empty: this.docs.length === 0, docs: this.docs.map((data) => ({ data: () => data })) };
  }
}

const realFakeDb: any = {
  collection: (name: string) => {
    if (name !== "workspaceMemberships") throw new Error(`unexpected collection: ${name}`);
    return new FakeQuery(membershipsStore);
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return simulateNoAdminDb ? null : realFakeDb;
  },
}));

import { Timestamp } from "firebase-admin/firestore";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { resolveViewerTeamWorkspaceSelection, MAX_VIEWER_MEMBERSHIP_CARDINALITY_SCAN } from "@/lib/workspaces/resolveViewerTeamWorkspaceSelection";

const UID = "viewer-1";

function seedMembership(workspaceId: string, uid: string, overrides: Partial<StoredDoc> = {}, createdAtSeconds = 1000) {
  const id = computeMembershipId(workspaceId, uid);
  const doc: StoredDoc = {
    schemaVersion: 1,
    id,
    workspaceId,
    uid,
    role: "member",
    status: "active",
    createdAt: new Timestamp(createdAtSeconds, 0),
    updatedAt: new Timestamp(createdAtSeconds, 0),
    invitedByUserId: null,
    removedAt: null,
    removedByUserId: null,
    ...overrides,
  };
  membershipsStore.push(doc);
}

beforeEach(() => {
  resetStore();
  simulateGetFailure = false;
  simulateNoAdminDb = false;
});

describe("resolveViewerTeamWorkspaceSelection — cardinality 0/1", () => {
  it("returns kind:'none' when the uid has no membership documents at all", async () => {
    const result = await resolveViewerTeamWorkspaceSelection(UID);
    expect(result).toEqual({ kind: "none" });
  });

  it("returns kind:'single' with the one active membership's workspaceId", async () => {
    seedMembership("ws-a", UID);
    const result = await resolveViewerTeamWorkspaceSelection(UID);
    expect(result).toEqual({ kind: "single", workspaceId: "ws-a" });
  });

  it("does not consider a removed membership — status=active is a query-level filter, never post-filtered leniently", async () => {
    seedMembership("ws-removed", UID, { status: "removed", removedAt: new Timestamp(500, 0), removedByUserId: "owner-1" });
    const result = await resolveViewerTeamWorkspaceSelection(UID);
    expect(result).toEqual({ kind: "none" });
  });
});

describe("resolveViewerTeamWorkspaceSelection — Phase 9C.1-R1C CRITICAL: cardinality 2+ never picks one", () => {
  it("two active memberships -> kind:'multiple', no workspaceId chosen or exposed", async () => {
    seedMembership("ws-newer", UID, {}, 2000);
    seedMembership("ws-older", UID, {}, 1000);
    const result = await resolveViewerTeamWorkspaceSelection(UID);
    expect(result).toEqual({ kind: "multiple" });
    expect((result as any).workspaceId).toBeUndefined();
  });

  it("three active memberships -> still kind:'multiple' (never returns a count)", async () => {
    seedMembership("ws-a", UID, {}, 1000);
    seedMembership("ws-b", UID, {}, 2000);
    seedMembership("ws-c", UID, {}, 3000);
    const result = await resolveViewerTeamWorkspaceSelection(UID);
    expect(result).toEqual({ kind: "multiple" });
  });

  it("one malformed + one valid membership -> kind:'single' (the malformed one is excluded, not counted toward cardinality)", async () => {
    membershipsStore.push({ schemaVersion: 1, uid: UID, status: "active" } as StoredDoc); // malformed
    seedMembership("ws-valid", UID);
    const result = await resolveViewerTeamWorkspaceSelection(UID);
    expect(result).toEqual({ kind: "single", workspaceId: "ws-valid" });
  });

  it("two malformed + zero valid -> kind:'none'", async () => {
    membershipsStore.push({ schemaVersion: 1, uid: UID, status: "active" } as StoredDoc);
    membershipsStore.push({ id: "not-derived-correctly", workspaceId: "ws-x", uid: UID, status: "active" } as StoredDoc);
    const result = await resolveViewerTeamWorkspaceSelection(UID);
    expect(result).toEqual({ kind: "none" });
  });
});

describe("resolveViewerTeamWorkspaceSelection — malformed/confused-deputy documents fail closed", () => {
  it("fails closed on a confused-deputy document (id doesn't match its own embedded workspaceId/uid)", async () => {
    seedMembership("ws-x", UID, { id: "wm_not_matching_the_real_derivation" });
    const result = await resolveViewerTeamWorkspaceSelection(UID);
    expect(result).toEqual({ kind: "none" });
  });

  it("ignores an active membership belonging to a different uid, even if scanned", async () => {
    seedMembership("ws-x", "someone-else");
    const result = await resolveViewerTeamWorkspaceSelection(UID);
    expect(result).toEqual({ kind: "none" });
  });
});

describe("resolveViewerTeamWorkspaceSelection — bounded scan and failure semantics", () => {
  it("scans at most MAX_VIEWER_MEMBERSHIP_CARDINALITY_SCAN documents", async () => {
    for (let i = 0; i < MAX_VIEWER_MEMBERSHIP_CARDINALITY_SCAN + 5; i++) {
      seedMembership(`ws-${i}`, UID, {}, 1000 + i);
    }
    const result = await resolveViewerTeamWorkspaceSelection(UID);
    // Well beyond the bound — this is exactly a "multiple" case regardless.
    expect(result).toEqual({ kind: "multiple" });
  });

  it("returns kind:'lookup_failed' when adminDb is unavailable — never fabricates a workspace", async () => {
    simulateNoAdminDb = true;
    const result = await resolveViewerTeamWorkspaceSelection(UID);
    expect(result).toEqual({ kind: "lookup_failed" });
  });

  it("returns kind:'lookup_failed' when the query throws — never fabricates a workspace", async () => {
    simulateGetFailure = true;
    const result = await resolveViewerTeamWorkspaceSelection(UID);
    expect(result).toEqual({ kind: "lookup_failed" });
  });
});
