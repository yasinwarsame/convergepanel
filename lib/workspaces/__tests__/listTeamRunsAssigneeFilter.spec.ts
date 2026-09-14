/**
 * Project/Research Assignment — `?assignee=me` on both run list builders
 * and `assigneeUid` on the Team Project raw query: the predicate is an
 * exact equality / array-contains on the stored field, applied ONLY when
 * the (route-substituted) uid is given, and the page's assignees are
 * enriched through ONE batched presentation resolve. D4: a stale assignee
 * still renders by name on the row (the route-level exclusion is proven
 * in `assigneeFilterResolution.spec.ts` and the route specs).
 */

class FakeTimestamp {
  constructor(
    public seconds: number,
    public nanoseconds: number = 0
  ) {}
  static fromMillis(ms: number) {
    return new FakeTimestamp(Math.floor(ms / 1000), (ms % 1000) * 1_000_000);
  }
}
const DOC_ID_SENTINEL = Symbol("documentId");
jest.mock("firebase-admin/firestore", () => ({ Timestamp: FakeTimestamp, FieldPath: { documentId: () => DOC_ID_SENTINEL } }));

type FakeDoc = { id: string; data: Record<string, unknown> };
let runsDocs: FakeDoc[] = [];
let projectDocs: FakeDoc[] = [];
const whereLog: { collection: string; field: string; op: string; value: unknown }[] = [];
class FakeQuery {
  constructor(
    private collection: string,
    private docs: FakeDoc[],
    private filters: Array<{ field: string; op: string; value: unknown }> = []
  ) {}
  doc(id: string) {
    return { __collection: this.collection, __id: id };
  }
  where(field: string, op: string, value: unknown) {
    whereLog.push({ collection: this.collection, field, op, value });
    return new FakeQuery(this.collection, this.docs, [...this.filters, { field, op, value }]);
  }
  orderBy() {
    return this;
  }
  startAfter() {
    return this;
  }
  limit() {
    return this;
  }
  async get() {
    const docs = this.docs.filter((d) =>
      this.filters.every((f) => (f.op === "array-contains" ? Array.isArray(d.data[f.field]) && (d.data[f.field] as unknown[]).includes(f.value) : d.data[f.field] === f.value))
    );
    return { docs: docs.map((d) => ({ id: d.id, data: () => d.data, updateTime: new FakeTimestamp(1) })) };
  }
}
const mockAdminDb: any = {
  collection: (name: string) => new FakeQuery(name, name === "runs" ? runsDocs : projectDocs),
  getAll: (...refs: { __collection: string; __id: string }[]) =>
    Promise.resolve(
      refs.map((r) => {
        const found = (r.__collection === "projects" ? projectDocs : runsDocs).find((d) => d.id === r.__id);
        return { id: r.__id, exists: found !== undefined, data: () => found?.data };
      })
    ),
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockedPresent = jest.fn();
jest.mock("../assigneePresentation", () => ({ resolveAssigneePresentations: (...a: unknown[]) => mockedPresent(...a) }));

import { listTeamProjectRuns } from "../listTeamProjectRuns";
import { listTeamWorkspaceRuns } from "../listTeamWorkspaceRuns";
import { listActiveProjectsRaw } from "@/lib/firestore/projects";

const W = "ws-team-1";
const P = "proj-1";
function runDoc(id: string, overrides: Record<string, unknown> = {}): FakeDoc {
  return { id, data: { userId: "uid-1", workspaceId: W, projectId: P, createdAt: FakeTimestamp.fromMillis(1_700_000_000_000), ...overrides } };
}
function projectDoc(id: string): FakeDoc {
  return { id, data: { schemaVersion: 1, id, workspaceId: W, name: "P", status: "active", createdByUserId: "uid-1", createdAt: FakeTimestamp.fromMillis(1), updatedAt: FakeTimestamp.fromMillis(1) } };
}

beforeEach(() => {
  runsDocs = [];
  projectDocs = [];
  whereLog.length = 0;
  mockedPresent.mockReset();
  mockedPresent.mockImplementation(async (_ws: string, kind: string, uids: string[]) => new Map(uids.map((u) => [u, { uid: u, displayName: `Name(${u})`, state: u === "stale-uid" ? "stale" : "active" }])));
});

describe("listTeamProjectRuns", () => {
  it("no filter ⇒ no assigneeUid predicate; rows carry `assignee` from ONE batched resolve (null when unassigned)", async () => {
    runsDocs = [runDoc("r1", { assigneeUid: "m1" }), runDoc("r2"), runDoc("r3", { assigneeUid: "m1" })];
    const r = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    expect(whereLog.some((w) => w.field === "assigneeUid")).toBe(false);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items.map((i) => i.assignee?.uid ?? null)).toEqual(["m1", null, "m1"]);
    expect(mockedPresent).toHaveBeenCalledTimes(1);
    expect(mockedPresent).toHaveBeenCalledWith(W, "run", ["m1"]);
  });
  it("assigneeUid ⇒ exact equality predicate on the stored field; only matching rows return", async () => {
    runsDocs = [runDoc("mine", { assigneeUid: "me" }), runDoc("theirs", { assigneeUid: "other" }), runDoc("none")];
    const r = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20, assigneeUid: "me" });
    expect(whereLog).toContainEqual({ collection: "runs", field: "assigneeUid", op: "==", value: "me" });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items.map((i) => i.id)).toEqual(["mine"]);
  });
  it("D4 — a stale assignee is still RENDERED BY NAME on the row with state stale", async () => {
    runsDocs = [runDoc("r1", { assigneeUid: "stale-uid" })];
    const r = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items[0].assignee).toEqual({ uid: "stale-uid", displayName: "Name(stale-uid)", state: "stale" });
  });
  it("a malformed stored assigneeUid never fails the page (row emitted with assignee: null)", async () => {
    runsDocs = [runDoc("r1", { assigneeUid: 42 })];
    const r = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items[0].assignee).toBeNull();
  });
});

describe("listTeamWorkspaceRuns", () => {
  it("all scope + assigneeUid ⇒ equality predicate; unfiled scope keeps projectId==null AND adds the predicate", async () => {
    runsDocs = [runDoc("a", { assigneeUid: "me" }), runDoc("b", { projectId: null, assigneeUid: "me" }), runDoc("c", { projectId: null })];
    projectDocs = [projectDoc(P)];
    let r = await listTeamWorkspaceRuns({ workspaceId: W, scope: "all", limit: 20, assigneeUid: "me" });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items.map((i) => i.id).sort()).toEqual(["a", "b"]);
    whereLog.length = 0;
    r = await listTeamWorkspaceRuns({ workspaceId: W, scope: "unfiled", limit: 20, assigneeUid: "me" });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items.map((i) => i.id)).toEqual(["b"]);
    expect(whereLog.map((w) => w.field)).toEqual(["workspaceId", "projectId", "assigneeUid"]);
  });
  it("no filter ⇒ no predicate, assignee enriched", async () => {
    runsDocs = [runDoc("a", { projectId: null, assigneeUid: "m1" })];
    const r = await listTeamWorkspaceRuns({ workspaceId: W, scope: "unfiled", limit: 20 });
    expect(whereLog.some((w) => w.field === "assigneeUid")).toBe(false);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items[0].assignee?.displayName).toBe("Name(m1)");
  });
});

describe("listActiveProjectsRaw — Project assignee predicate", () => {
  it("assigneeUid ⇒ array-contains on assigneeUids, after the workspace/status predicates; absent ⇒ no predicate", async () => {
    projectDocs = [
      { id: "p1", data: { workspaceId: W, status: "active", assigneeUids: ["me", "other"], createdAt: FakeTimestamp.fromMillis(1) } },
      { id: "p2", data: { workspaceId: W, status: "active", assigneeUids: ["other"], createdAt: FakeTimestamp.fromMillis(1) } },
      { id: "p3", data: { workspaceId: W, status: "active", createdAt: FakeTimestamp.fromMillis(1) } },
    ];
    const r = await listActiveProjectsRaw({ workspaceId: W, limit: 20, status: "active", assigneeUid: "me" });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.items.map((i) => i.id)).toEqual(["p1"]);
    expect(whereLog.map((w) => [w.field, w.op])).toEqual([
      ["workspaceId", "=="],
      ["status", "=="],
      ["assigneeUids", "array-contains"],
    ]);
    whereLog.length = 0;
    const all = await listActiveProjectsRaw({ workspaceId: W, limit: 20, status: "active" });
    if (all.status === "ok") expect(all.items).toHaveLength(3);
    expect(whereLog.some((w) => w.field === "assigneeUids")).toBe(false);
  });
});
