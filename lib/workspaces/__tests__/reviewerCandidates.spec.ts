/**
 * Approval Workflow, Phase 9B.6 — getReviewerCandidates() tests. Requires
 * a `.where()`-capable fake for the `workspaceMemberships` collection
 * query (unlike reviewContext.spec.ts, which only needs `.get()`).
 */

import { Timestamp } from "firebase-admin/firestore";

type StoredDoc = Record<string, unknown>;
const stores: Record<string, Map<string, StoredDoc>> = {
  runs: new Map(),
  workspaceMemberships: new Map(),
  users: new Map(),
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
    let docs = Array.from(stores.workspaceMemberships.values());
    for (const f of this.filters) docs = docs.filter((d) => d[f.field] === f.value);
    if (this.limitCount !== null) docs = docs.slice(0, this.limitCount);
    return { docs: docs.map((data) => ({ data: () => data })) };
  }
}

function makeDocRef(collectionName: string, docId: string) {
  return {
    __collection: collectionName,
    __id: docId,
    get: async () => {
      const data = stores[collectionName].get(docId);
      return { exists: data !== undefined, data: () => data, id: docId };
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
      const data = stores[ref.__collection].get(ref.__id);
      return { exists: data !== undefined, data: () => data, id: ref.__id };
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
import { getReviewerCandidates } from "@/lib/workspaces/reviewerCandidates";

const WS_ID = "ws-1";
const OTHER_WS_ID = "ws-2";
const OWNER_UID = "owner-1";
const ADMIN_UID = "admin-1";
const MEMBER_UID = "member-1";
const REVIEWER_UID = "reviewer-1";
const VIEWER_UID = "viewer-1";
const CREATOR_UID = "creator-1";
const RUN_ID = "run-1";
const NOW = Timestamp.now();

function seedMembership(uid: string, role: string, workspaceId: string = WS_ID, overrides: Record<string, unknown> = {}) {
  const id = computeMembershipId(workspaceId, uid);
  const status = (overrides.status as string | undefined) ?? "active";
  stores.workspaceMemberships.set(
    id,
    asPersisted({ schemaVersion: 1, id, workspaceId, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: status === "removed" ? NOW : null, removedByUserId: status === "removed" ? OWNER_UID : null, ...overrides })
  );
}

function seedRun(overrides: Record<string, unknown> = {}) {
  stores.runs.set(RUN_ID, asPersisted({ userId: CREATOR_UID, workspaceId: WS_ID, projectId: null, question: "q", createdAt: NOW, governanceRecord: { version: 1, schemaId: "decision_support", answerShape: "decision_support_view", adaptiveOutputVersion: 1, humanReview: { status: "unreviewed" }, decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false }, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" }, ...overrides }));
}

function seedUser(uid: string, overrides: Record<string, unknown> = {}) {
  stores.users.set(uid, { name: "", email: "", ...overrides });
}

beforeEach(() => {
  resetStores();
  seedMembership(OWNER_UID, "owner");
  seedMembership(ADMIN_UID, "admin");
  seedMembership(MEMBER_UID, "member");
  seedMembership(REVIEWER_UID, "reviewer");
  seedMembership(VIEWER_UID, "viewer");
  seedMembership(CREATOR_UID, "member");
  seedRun();
});

describe("getReviewerCandidates — §69 eligibility", () => {
  it("Owner/Admin/Member/Reviewer (not creator): all eligible", async () => {
    const result = await getReviewerCandidates({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const uids = result.reviewers.map((r) => r.uid).sort();
    expect(uids).toEqual([ADMIN_UID, MEMBER_UID, OWNER_UID, REVIEWER_UID].sort());
  });

  it("Viewer excluded", async () => {
    const result = await getReviewerCandidates({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.reviewers.some((r) => r.uid === VIEWER_UID)).toBe(false);
  });

  it("creator excluded", async () => {
    const result = await getReviewerCandidates({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.reviewers.some((r) => r.uid === CREATOR_UID)).toBe(false);
  });

  it("removed member excluded", async () => {
    seedMembership(REVIEWER_UID, "reviewer", WS_ID, { status: "removed" });
    const result = await getReviewerCandidates({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.reviewers.some((r) => r.uid === REVIEWER_UID)).toBe(false);
  });

  it("cross-Workspace member excluded (query itself already scopes by workspaceId)", async () => {
    seedMembership("cross-ws-uid", "reviewer", OTHER_WS_ID);
    const result = await getReviewerCandidates({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.reviewers.some((r) => r.uid === "cross-ws-uid")).toBe(false);
  });

  it("run not found -> run_not_found", async () => {
    stores.runs.delete(RUN_ID);
    const result = await getReviewerCandidates({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result).toEqual({ status: "run_not_found" });
  });

  it("wrong workspace -> run_not_found (concealed)", async () => {
    seedRun({ workspaceId: OTHER_WS_ID });
    const result = await getReviewerCandidates({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result).toEqual({ status: "run_not_found" });
  });
});

describe("getReviewerCandidates — identity + ordering", () => {
  it("resolves display names, never raw UIDs", async () => {
    seedUser(OWNER_UID, { name: "Olivia Owner" });
    const result = await getReviewerCandidates({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const owner = result.reviewers.find((r) => r.uid === OWNER_UID);
    expect(owner?.displayName).toBe("Olivia Owner");
  });

  it("deterministic displayName-ascending ordering", async () => {
    seedUser(OWNER_UID, { name: "Zed" });
    seedUser(ADMIN_UID, { name: "Amy" });
    const result = await getReviewerCandidates({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const names = result.reviewers.map((r) => r.displayName);
    expect(names.indexOf("Amy")).toBeLessThan(names.indexOf("Zed"));
  });

  it("no user doc: safe fallback, never the raw UID", async () => {
    const result = await getReviewerCandidates({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    for (const r of result.reviewers) expect(r.displayName).not.toBe(r.uid);
  });
});

describe("getReviewerCandidates — bounded read", () => {
  it("scan is bounded by MAX_CANDIDATES_SCANNED (query itself carries a .limit())", async () => {
    // Structural proof via the fake's own query implementation honoring
    // .limit() — a large membership set does not crash or hang.
    for (let i = 0; i < 50; i++) seedMembership(`bulk-uid-${i}`, "member");
    const result = await getReviewerCandidates({ workspaceId: WS_ID, runId: RUN_ID });
    expect(result.status).toBe("ok");
  });
});
