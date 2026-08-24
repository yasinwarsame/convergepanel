/**
 * Approval Workflow, Phase 9C.1 — resolveViewerTeamWorkspaceId() tests.
 * A minimal in-memory `workspaceMemberships` query simulator, tailored
 * exactly to this module's own `.where("uid","==",...).where("status","==","active").limit(N).get()`
 * shape — not a general-purpose Firestore emulator.
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
import { resolveViewerTeamWorkspaceId, MAX_VIEWER_MEMBERSHIPS_SCANNED } from "@/lib/workspaces/resolveViewerTeamWorkspaceId";

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

describe("resolveViewerTeamWorkspaceId", () => {
  it("returns not_found when the uid has no membership documents at all", async () => {
    const result = await resolveViewerTeamWorkspaceId(UID);
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns found with the single active membership's workspaceId", async () => {
    seedMembership("ws-a", UID);
    const result = await resolveViewerTeamWorkspaceId(UID);
    expect(result).toEqual({ status: "found", workspaceId: "ws-a" });
  });

  it("does not consider a removed membership — status=active is a query-level filter, never post-filtered leniently", async () => {
    seedMembership("ws-removed", UID, { status: "removed", removedAt: new Timestamp(500, 0), removedByUserId: "owner-1" });
    const result = await resolveViewerTeamWorkspaceId(UID);
    expect(result).toEqual({ status: "not_found" });
  });

  it("picks the earliest-created active membership deterministically when multiple exist", async () => {
    seedMembership("ws-newer", UID, {}, 2000);
    seedMembership("ws-older", UID, {}, 1000);
    const result = await resolveViewerTeamWorkspaceId(UID);
    expect(result).toEqual({ status: "found", workspaceId: "ws-older" });
  });

  it("breaks a createdAt tie by workspaceId, deterministically", async () => {
    seedMembership("ws-b", UID, {}, 1000);
    seedMembership("ws-a", UID, {}, 1000);
    const result = await resolveViewerTeamWorkspaceId(UID);
    expect(result).toEqual({ status: "found", workspaceId: "ws-a" });
  });

  it("fails closed to not_found on a malformed membership document (missing required fields)", async () => {
    membershipsStore.push({ schemaVersion: 1, uid: UID, status: "active" } as StoredDoc);
    const result = await resolveViewerTeamWorkspaceId(UID);
    expect(result).toEqual({ status: "not_found" });
  });

  it("fails closed to not_found on a confused-deputy document (id doesn't match its own embedded workspaceId/uid)", async () => {
    seedMembership("ws-x", UID, { id: "wm_not_matching_the_real_derivation" });
    const result = await resolveViewerTeamWorkspaceId(UID);
    expect(result).toEqual({ status: "not_found" });
  });

  it("ignores an active membership belonging to a different uid, even if scanned", async () => {
    seedMembership("ws-a", "someone-else");
    const result = await resolveViewerTeamWorkspaceId(UID);
    expect(result).toEqual({ status: "not_found" });
  });

  it("caps the scan at MAX_VIEWER_MEMBERSHIPS_SCANNED (bounded, not unbounded)", () => {
    expect(MAX_VIEWER_MEMBERSHIPS_SCANNED).toBe(10);
  });

  it("returns lookup_failed (never found/not_found) when adminDb is unavailable", async () => {
    simulateNoAdminDb = true;
    const result = await resolveViewerTeamWorkspaceId(UID);
    expect(result).toEqual({ status: "lookup_failed" });
  });

  it("returns lookup_failed (never found/not_found) when the Firestore query itself throws", async () => {
    seedMembership("ws-a", UID);
    simulateGetFailure = true;
    const result = await resolveViewerTeamWorkspaceId(UID);
    expect(result).toEqual({ status: "lookup_failed" });
  });
});
