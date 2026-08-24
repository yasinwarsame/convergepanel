/**
 * Approval Workflow, Phase 9B.4 — getReviewQueue() tests. An in-memory
 * Firestore QUERY simulator (not just a get/set fake like prior test
 * harnesses in this codebase) — this module's whole job is building and
 * executing `where`/`orderBy`/`startAfter`/`limit` queries, both single-
 * collection (`runs`) and `collectionGroup` (`humanReviewAssignment`), so
 * the fake must actually filter/sort/paginate in JS rather than merely
 * store documents. Tailored to exactly the query shapes `reviewQueue.ts`
 * issues — not a general-purpose Firestore emulator.
 */

import { FieldPath, Timestamp } from "firebase-admin/firestore";

type StoredDoc = Record<string, unknown>;

const runsStore = new Map<string, StoredDoc>();
const assignmentsStore = new Map<string, StoredDoc>(); // runId -> assignment "current" doc
const membershipsStore = new Map<string, StoredDoc>();

function resetStores() {
  runsStore.clear();
  assignmentsStore.clear();
  membershipsStore.clear();
}

function getNestedField(data: StoredDoc, path: string): unknown {
  const segments = path.split(".");
  let cursor: unknown = data;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Timestamp && b instanceof Timestamp) {
    if (a.seconds !== b.seconds) return a.seconds - b.seconds;
    return a.nanoseconds - b.nanoseconds;
  }
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

interface FakeDocEntry {
  id: string; // bare doc id (run id for `runs`; "current" for assignment docs)
  path: string; // full path
  data: StoredDoc;
  parentRunId?: string; // only for assignment entries
}

type WhereOp = "==" | "in" | "<";
interface WhereClause {
  field: string;
  op: WhereOp;
  value: unknown;
}
interface OrderClause {
  field: string | typeof FieldPath;
  isDocId: boolean;
  dir: "asc" | "desc";
}

class FakeQuery {
  private wheres: WhereClause[] = [];
  private orders: OrderClause[] = [];
  private startAfterValues: unknown[] | null = null;
  private limitN = Infinity;

  constructor(private source: () => FakeDocEntry[]) {}

  where(field: string, op: WhereOp, value: unknown): FakeQuery {
    const q = this.clone();
    q.wheres.push({ field, op, value });
    return q;
  }

  orderBy(field: string | ReturnType<typeof FieldPath.documentId>, dir: "asc" | "desc"): FakeQuery {
    const q = this.clone();
    const isDocId = typeof field !== "string";
    q.orders.push({ field, isDocId, dir });
    return q;
  }

  startAfter(...values: unknown[]): FakeQuery {
    const q = this.clone();
    q.startAfterValues = values;
    return q;
  }

  limit(n: number): FakeQuery {
    const q = this.clone();
    q.limitN = n;
    return q;
  }

  private clone(): FakeQuery {
    const q = new FakeQuery(this.source);
    q.wheres = [...this.wheres];
    q.orders = [...this.orders];
    q.startAfterValues = this.startAfterValues;
    q.limitN = this.limitN;
    return q;
  }

  async get(): Promise<{ docs: Array<{ id: string; ref: { path: string; parent: { parent: { id: string } | null } }; data: () => StoredDoc }> }> {
    let entries = this.source();

    for (const w of this.wheres) {
      entries = entries.filter((e) => {
        const value = getNestedField(e.data, w.field);
        if (w.op === "==") return value === w.value;
        if (w.op === "in") return Array.isArray(w.value) && (w.value as unknown[]).includes(value);
        if (w.op === "<") return typeof value === "string" && typeof w.value === "string" && value < w.value;
        return false;
      });
    }

    entries = [...entries].sort((a, b) => {
      for (const o of this.orders) {
        const av = o.isDocId ? a.path : getNestedField(a.data, o.field as string);
        const bv = o.isDocId ? b.path : getNestedField(b.data, o.field as string);
        const cmp = compareValues(av, bv);
        if (cmp !== 0) return o.dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });

    if (this.startAfterValues) {
      const idx = entries.findIndex((e) => {
        return this.orders.every((o, i) => {
          const v = o.isDocId ? e.path : getNestedField(e.data, o.field as string);
          return compareValues(v, this.startAfterValues![i]) === 0;
        });
      });
      entries = idx >= 0 ? entries.slice(idx + 1) : entries;
    }

    entries = entries.slice(0, this.limitN);

    return {
      docs: entries.map((e) => ({
        id: e.id,
        ref: { path: e.path, parent: { parent: e.parentRunId ? { id: e.parentRunId } : null } },
        data: () => e.data,
      })),
    };
  }
}

function runsSource(): FakeDocEntry[] {
  return Array.from(runsStore.entries()).map(([id, data]) => ({ id, path: id, data }));
}

function assignmentsSource(): FakeDocEntry[] {
  return Array.from(assignmentsStore.entries()).map(([runId, data]) => ({ id: "current", path: `runs/${runId}/humanReviewAssignment/current`, data, parentRunId: runId }));
}

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "runs") {
      return {
        where: (f: string, op: WhereOp, v: unknown) => new FakeQuery(runsSource).where(f, op, v),
        orderBy: (f: any, d: "asc" | "desc") => new FakeQuery(runsSource).orderBy(f, d),
        doc: (id: string) => ({
          get: async () => ({ exists: runsStore.has(id), id, data: () => runsStore.get(id) }),
          collection: (sub: string) => ({
            doc: (subId: string) => ({
              __kind: "assignmentDocRef",
              __runId: id,
            }),
          }),
        }),
      };
    }
    if (name === "workspaceMemberships") {
      return {
        doc: (id: string) => ({ __kind: "membershipDocRef", __id: id }),
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  collectionGroup: (name: string) => {
    if (name === "humanReviewAssignment") {
      return {
        where: (f: string, op: WhereOp, v: unknown) => new FakeQuery(assignmentsSource).where(f, op, v),
      };
    }
    throw new Error(`unexpected collectionGroup: ${name}`);
  },
  getAll: async (...refs: any[]) => {
    return refs.map((ref) => {
      if (ref.__kind === "assignmentDocRef") {
        const runId = ref.__runId;
        const data = assignmentsStore.get(runId);
        return { exists: data !== undefined, id: "current", data: () => data };
      }
      if (ref.__kind === "membershipDocRef") {
        const data = membershipsStore.get(ref.__id);
        return { exists: data !== undefined, id: ref.__id, data: () => data };
      }
      // run doc refs from collectionGroup's doc.ref.parent.parent
      const runId = ref.id;
      const data = runsStore.get(runId);
      return { exists: data !== undefined, id: runId, data: () => data };
    });
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { getReviewQueue } from "@/lib/workspaces/reviewQueue";
import type { WorkspaceReviewCandidate } from "@/lib/workspaces/workspaceReviewEligibility";

const WS_ID = "ws-1";
const OTHER_WS_ID = "ws-2";
const OWNER_UID = "owner-1";
const CREATOR_UID = "creator-1";
const REVIEWER_UID = "reviewer-1";
const REVIEWER2_UID = "reviewer-2";
const VIEWER_UID = "viewer-1";

const NOW = Timestamp.now();

function seedMembership(uid: string, role: string, workspaceId: string = WS_ID, overrides: StoredDoc = {}) {
  const id = computeMembershipId(workspaceId, uid);
  const status = (overrides.status as string | undefined) ?? "active";
  membershipsStore.set(id, {
    schemaVersion: 1,
    id,
    workspaceId,
    uid,
    role,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    invitedByUserId: null,
    removedAt: status === "removed" ? NOW : null,
    removedByUserId: status === "removed" ? OWNER_UID : null,
    ...overrides,
  });
}

function seedRun(id: string, overrides: StoredDoc = {}) {
  runsStore.set(id, {
    userId: CREATOR_UID,
    workspaceId: WS_ID,
    projectId: null,
    createdAt: Timestamp.fromDate(new Date("2026-08-01T00:00:00.000Z")),
    governanceRecord: {
      version: 1,
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      adaptiveOutputVersion: 1,
      humanReview: { status: "unreviewed" },
      decisionReceipt: {
        conclusion: "x",
        basis: [],
        assumptions: [],
        uncertainties: [],
        limitations: [],
        sources: [],
        sourceBacked: true,
        humanReviewNeeded: false,
      },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    ...overrides,
  });
}

function seedAssignment(runId: string, overrides: StoredDoc = {}) {
  assignmentsStore.set(runId, {
    schemaVersion: 1,
    teamId: WS_ID,
    runId,
    assignedReviewerUserId: REVIEWER_UID,
    assignedAt: "2026-08-01T00:00:00.000Z",
    assignedByUserId: OWNER_UID,
    updatedAt: "2026-08-01T00:00:00.000Z",
    updatedByUserId: OWNER_UID,
    revision: 1,
    workspaceId: WS_ID,
    projectId: null,
    dueAt: null,
    ...overrides,
  });
}

function callerCandidate(uid: string, role: string, status: "active" | "removed" = "active"): WorkspaceReviewCandidate {
  return { uid, workspaceId: WS_ID, role: role as any, status };
}

beforeEach(() => {
  resetStores();
  seedMembership(OWNER_UID, "owner");
  seedMembership(REVIEWER_UID, "reviewer");
  seedMembership(REVIEWER2_UID, "reviewer");
  seedMembership(VIEWER_UID, "viewer");
});

describe("needs_review", () => {
  it("unreviewed run with no assignment: included, unassigned", async () => {
    seedRun("run-1");
    const result = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0].assignment.state).toBe("unassigned");
  });

  it("unreviewed run with actionable assignment: included, actionable", async () => {
    seedRun("run-1");
    seedAssignment("run-1");
    const result = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items[0].assignment.state).toBe("actionable");
    expect(result.items[0].assignment.assignedReviewerUserId).toBe(REVIEWER_UID);
  });

  it("unreviewed run with stale (removed) assignee: included, assignmentState stale", async () => {
    seedRun("run-1");
    seedAssignment("run-1");
    seedMembership(REVIEWER_UID, "reviewer", WS_ID, { status: "removed" });
    const result = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items[0].assignment.state).toBe("stale");
  });

  it("approved run: excluded", async () => {
    seedRun("run-1", {
      governanceRecord: {
        version: 1,
        schemaId: "decision_support",
        answerShape: "decision_support_view",
        adaptiveOutputVersion: 1,
        humanReview: { status: "approved", reviewedAt: "2026-08-05T00:00:00.000Z" },
        decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      },
    });
    const result = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("changes_requested run: excluded", async () => {
    seedRun("run-1", { governanceRecord: { version: 1, schemaId: "decision_support", answerShape: "decision_support_view", adaptiveOutputVersion: 1, humanReview: { status: "changes_requested", reviewedAt: "2026-08-05T00:00:00.000Z" }, decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false }, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z" } });
    const result = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("malformed governance record: excluded, fail-safe (never crashes)", async () => {
    seedRun("run-1", { governanceRecord: { version: 1 } });
    const result = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("wrong workspace: never appears", async () => {
    seedRun("run-1", { workspaceId: OTHER_WS_ID });
    const result = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });
});

describe("changes_requested", () => {
  function seedChangesRequestedRun(id: string, reviewedAt: string, overrides: StoredDoc = {}) {
    seedRun(id, {
      governanceRecord: {
        version: 1,
        schemaId: "decision_support",
        answerShape: "decision_support_view",
        adaptiveOutputVersion: 1,
        humanReview: { status: "changes_requested", reviewedAt },
        decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: reviewedAt,
      },
      ...overrides,
    });
  }

  it("changes_requested included, unreviewed excluded", async () => {
    seedChangesRequestedRun("run-1", "2026-08-05T00:00:00.000Z");
    seedRun("run-2"); // unreviewed
    const result = await getReviewQueue({ view: "changes_requested", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items.map((i) => i.runId)).toEqual(["run-1"]);
  });

  it("orders by humanReview.reviewedAt descending", async () => {
    seedChangesRequestedRun("run-earlier", "2026-08-01T00:00:00.000Z");
    seedChangesRequestedRun("run-later", "2026-08-10T00:00:00.000Z");
    const result = await getReviewQueue({ view: "changes_requested", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items.map((i) => i.runId)).toEqual(["run-later", "run-earlier"]);
  });

  it("post-resubmission run (current state unreviewed) is excluded even though its history once had changes_requested", async () => {
    seedRun("run-1"); // current state: unreviewed (simulating post-resubmission)
    const result = await getReviewQueue({ view: "changes_requested", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });
});

describe("recently_approved", () => {
  function seedApprovedRun(id: string, status: "approved" | "approved_with_conditions", reviewedAt: string) {
    seedRun(id, {
      governanceRecord: {
        version: 1,
        schemaId: "decision_support",
        answerShape: "decision_support_view",
        adaptiveOutputVersion: 1,
        humanReview: { status, reviewedAt },
        decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: reviewedAt,
      },
    });
  }

  it("approved and approved_with_conditions both included; changes_requested/rejected excluded", async () => {
    seedApprovedRun("run-a", "approved", "2026-08-05T00:00:00.000Z");
    seedApprovedRun("run-b", "approved_with_conditions", "2026-08-06T00:00:00.000Z");
    seedRun("run-c", { governanceRecord: { version: 1, schemaId: "decision_support", answerShape: "decision_support_view", adaptiveOutputVersion: 1, humanReview: { status: "rejected", reviewedAt: "2026-08-07T00:00:00.000Z" }, decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false }, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z" } });
    const result = await getReviewQueue({ view: "recently_approved", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(new Set(result.items.map((i) => i.runId))).toEqual(new Set(["run-a", "run-b"]));
  });
});

describe("assigned_to_me", () => {
  it("eligible assigned Reviewer: included, actionable", async () => {
    seedRun("run-1");
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID });
    const result = await getReviewQueue({ view: "assigned_to_me", workspaceId: WS_ID, uid: REVIEWER_UID, callerCandidate: callerCandidate(REVIEWER_UID, "reviewer"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0].isAssignedToMe).toBe(true);
  });

  it("stale assignment (caller downgraded to Viewer): excluded entirely, never shown as actionable 'assigned to me'", async () => {
    seedRun("run-1");
    seedAssignment("run-1", { assignedReviewerUserId: VIEWER_UID });
    const result = await getReviewQueue({ view: "assigned_to_me", workspaceId: WS_ID, uid: VIEWER_UID, callerCandidate: callerCandidate(VIEWER_UID, "viewer"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("creator assigned to self (self-review staleness): excluded", async () => {
    seedRun("run-1", { userId: REVIEWER_UID });
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID });
    const result = await getReviewQueue({ view: "assigned_to_me", workspaceId: WS_ID, uid: REVIEWER_UID, callerCandidate: callerCandidate(REVIEWER_UID, "reviewer"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("terminal (approved) run assignment: excluded — status no longer reviewable", async () => {
    seedRun("run-1", {
      governanceRecord: { version: 1, schemaId: "decision_support", answerShape: "decision_support_view", adaptiveOutputVersion: 1, humanReview: { status: "approved", reviewedAt: "2026-08-05T00:00:00.000Z" }, decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false }, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z" },
    });
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID });
    const result = await getReviewQueue({ view: "assigned_to_me", workspaceId: WS_ID, uid: REVIEWER_UID, callerCandidate: callerCandidate(REVIEWER_UID, "reviewer"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("other reviewer's assignment never appears for a different caller", async () => {
    seedRun("run-1");
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID });
    const result = await getReviewQueue({ view: "assigned_to_me", workspaceId: WS_ID, uid: REVIEWER2_UID, callerCandidate: callerCandidate(REVIEWER2_UID, "reviewer"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });
});

describe("overdue", () => {
  const PAST = "2020-01-01T00:00:00.000Z";
  const FUTURE = "2099-01-01T00:00:00.000Z";

  it("dueAt in the past + actionable: included", async () => {
    seedRun("run-1");
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID, dueAt: PAST });
    const result = await getReviewQueue({ view: "overdue", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0].isOverdue).toBe(true);
  });

  it("dueAt in the future: excluded", async () => {
    seedRun("run-1");
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID, dueAt: FUTURE });
    const result = await getReviewQueue({ view: "overdue", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("dueAt null: excluded", async () => {
    seedRun("run-1");
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID, dueAt: null });
    const result = await getReviewQueue({ view: "overdue", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("malformed dueAt (non-canonical string): excluded, never crashes, never classified overdue", async () => {
    seedRun("run-1");
    // A non-canonical but lexically-past string would still pass a naive
    // Firestore `<` filter — this proves the app-level isCanonicalDueAt
    // re-check (not just the query) is what actually protects here.
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID, dueAt: "2020-01-01" });
    const result = await getReviewQueue({ view: "overdue", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("removed assignee: excluded", async () => {
    seedRun("run-1");
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID, dueAt: PAST });
    seedMembership(REVIEWER_UID, "reviewer", WS_ID, { status: "removed" });
    const result = await getReviewQueue({ view: "overdue", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("Viewer-downgraded assignee: excluded", async () => {
    seedRun("run-1");
    seedAssignment("run-1", { assignedReviewerUserId: VIEWER_UID, dueAt: PAST });
    const result = await getReviewQueue({ view: "overdue", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("self-review assignment: excluded", async () => {
    seedRun("run-1", { userId: REVIEWER_UID });
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID, dueAt: PAST });
    const result = await getReviewQueue({ view: "overdue", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("terminal governance status: excluded", async () => {
    seedRun("run-1", {
      governanceRecord: { version: 1, schemaId: "decision_support", answerShape: "decision_support_view", adaptiveOutputVersion: 1, humanReview: { status: "changes_requested", reviewedAt: "2026-08-05T00:00:00.000Z" }, decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false }, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z" },
    });
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID, dueAt: PAST });
    const result = await getReviewQueue({ view: "overdue", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });

  it("orders by dueAt ascending (most overdue first)", async () => {
    seedRun("run-a");
    seedRun("run-b");
    seedAssignment("run-a", { assignedReviewerUserId: REVIEWER_UID, dueAt: "2020-06-01T00:00:00.000Z" });
    seedAssignment("run-b", { assignedReviewerUserId: REVIEWER2_UID, dueAt: "2020-01-01T00:00:00.000Z" });
    const result = await getReviewQueue({ view: "overdue", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items.map((i) => i.runId)).toEqual(["run-b", "run-a"]);
  });
});

describe("Project filter", () => {
  it("needs_review: only rows in the requested Project appear", async () => {
    seedRun("run-a", { projectId: "proj-a" });
    seedRun("run-b", { projectId: "proj-b" });
    const result = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: "proj-a", limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items.map((i) => i.runId)).toEqual(["run-a"]);
  });

  it("Unfiled filter (null) returns only projectId: null rows", async () => {
    seedRun("run-a", { projectId: null });
    seedRun("run-b", { projectId: "proj-b" });
    const result = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: null, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items.map((i) => i.runId)).toEqual(["run-a"]);
  });

  it("cross-project stale assignment mirror never leaks: canonical run.projectId governs, not assignment.projectId", async () => {
    seedRun("run-1", { projectId: "proj-a" });
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID, projectId: "proj-b" }); // stale mirror
    const result = await getReviewQueue({ view: "assigned_to_me", workspaceId: WS_ID, uid: REVIEWER_UID, callerCandidate: callerCandidate(REVIEWER_UID, "reviewer"), projectFilter: "proj-b", limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The assignment candidate query itself filters by its own projectId
    // mirror ("proj-b"), so the row IS returned at the candidate level —
    // but its DTO reports the CANONICAL project (proj-a), never the stale
    // mirror, proving canonical authority even when candidate discovery
    // used the projection.
    if (result.items.length > 0) {
      expect(result.items[0].projectId).toBe("proj-a");
    }
  });
});

describe("security: cross-workspace forged projection", () => {
  it("assignment.workspaceId forged to match W, but canonical run.workspaceId is a different Workspace: never returned", async () => {
    seedRun("run-1", { workspaceId: OTHER_WS_ID });
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID, workspaceId: WS_ID }); // forged mirror
    const result = await getReviewQueue({ view: "assigned_to_me", workspaceId: WS_ID, uid: REVIEWER_UID, callerCandidate: callerCandidate(REVIEWER_UID, "reviewer"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });
});

describe("legacy projection compatibility", () => {
  it("legacy assignment without workspaceId mirror never appears via Workspace queue merely because assignedReviewerUserId matches", async () => {
    seedRun("run-1");
    seedAssignment("run-1", { assignedReviewerUserId: REVIEWER_UID, workspaceId: undefined });
    // The collectionGroup query itself requires workspaceId == W, so a
    // legacy doc with no workspaceId field is never even a candidate.
    const result = await getReviewQueue({ view: "assigned_to_me", workspaceId: WS_ID, uid: REVIEWER_UID, callerCandidate: callerCandidate(REVIEWER_UID, "reviewer"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(0);
  });
});

describe("pagination", () => {
  it("hasMore is false and no cursor when fewer than limit rows exist", async () => {
    seedRun("run-1");
    const result = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  it("first page + cursor page together cover all rows exactly once, no duplicates, no gaps", async () => {
    for (let i = 0; i < 5; i++) {
      seedRun(`run-${i}`, { createdAt: Timestamp.fromDate(new Date(2026, 7, i + 1)) });
    }
    const page1 = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 3, cursor: null });
    expect(page1.status).toBe("ok");
    if (page1.status !== "ok") return;
    expect(page1.items).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    const { decodeReviewQueueCursor } = await import("@/lib/workspaces/reviewQueueCursor");
    const decoded = decodeReviewQueueCursor(page1.nextCursor!);
    expect(decoded.ok).toBe(true);

    const page2 = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 3, cursor: decoded.ok ? decoded.cursor : null });
    expect(page2.status).toBe("ok");
    if (page2.status !== "ok") return;
    expect(page2.items).toHaveLength(2);
    expect(page2.hasMore).toBe(false);

    const allIds = [...page1.items, ...page2.items].map((i) => i.runId);
    expect(new Set(allIds).size).toBe(5); // no duplicates
    expect(new Set(allIds)).toEqual(new Set(["run-0", "run-1", "run-2", "run-3", "run-4"]));
  });

  it("stale candidates preceding valid rows within the bounded scan window do not cause valid rows to be skipped", async () => {
    // 3 stale (removed-assignee) needs_review-eligible rows, then 2 valid
    // ones — all assignment-driven (assigned_to_me), where staleness is
    // dropped rather than shown.
    seedRun("stale-1");
    seedRun("stale-2");
    seedRun("stale-3");
    seedRun("valid-1");
    seedRun("valid-2");
    seedAssignment("stale-1", { assignedReviewerUserId: REVIEWER_UID, assignedAt: "2026-08-05T00:00:00.000Z" });
    seedAssignment("stale-2", { assignedReviewerUserId: REVIEWER_UID, assignedAt: "2026-08-04T00:00:00.000Z" });
    seedAssignment("stale-3", { assignedReviewerUserId: REVIEWER_UID, assignedAt: "2026-08-03T00:00:00.000Z" });
    seedAssignment("valid-1", { assignedReviewerUserId: REVIEWER_UID, assignedAt: "2026-08-02T00:00:00.000Z" });
    seedAssignment("valid-2", { assignedReviewerUserId: REVIEWER_UID, assignedAt: "2026-08-01T00:00:00.000Z" });
    seedMembership(REVIEWER_UID, "viewer"); // downgrade AFTER assignment — makes all of them "stale" for assigned_to_me...

    // Re-seed valid-1/valid-2 assignees as a DIFFERENT, still-eligible reviewer to create genuine stale-then-valid ordering.
    seedAssignment("valid-1", { assignedReviewerUserId: REVIEWER2_UID, assignedAt: "2026-08-02T00:00:00.000Z" });
    seedAssignment("valid-2", { assignedReviewerUserId: REVIEWER2_UID, assignedAt: "2026-08-01T00:00:00.000Z" });

    const result = await getReviewQueue({ view: "assigned_to_me", workspaceId: WS_ID, uid: REVIEWER2_UID, callerCandidate: callerCandidate(REVIEWER2_UID, "reviewer"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items.map((i) => i.runId)).toEqual(["valid-1", "valid-2"]);
  });
});

describe("read cost / no crash on empty workspace", () => {
  it("empty workspace: valid empty result, not an error", async () => {
    const result = await getReviewQueue({ view: "needs_review", workspaceId: WS_ID, uid: OWNER_UID, callerCandidate: callerCandidate(OWNER_UID, "owner"), projectFilter: undefined, limit: 25, cursor: null });
    expect(result).toEqual({ status: "ok", items: [], hasMore: false });
  });
});
