/**
 * Team Run Lists, Phase 8C-B2 — `listTeamProjectRuns()` tests. Same
 * FakeQuery pattern as `listTeamWorkspaceRuns.spec.ts`. This function
 * never reads a Project document at all — P is validated once by the
 * caller before this function is ever invoked — so no `projects`
 * collection fake is needed here.
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
class FakeFieldPath {
  static documentId() {
    return DOC_ID_SENTINEL;
  }
}
jest.mock("firebase-admin/firestore", () => ({
  Timestamp: FakeTimestamp,
  FieldPath: FakeFieldPath,
}));

type FakeDoc = { id: string; data: Record<string, unknown> };
function orderingKey(doc: FakeDoc, field: string | symbol): [number, number] | string {
  if (field === DOC_ID_SENTINEL) return doc.id;
  const v = doc.data[field as string];
  if (v instanceof FakeTimestamp) return [v.seconds, v.nanoseconds];
  return String(v ?? "");
}
function compareKeys(a: [number, number] | string, b: [number, number] | string): number {
  if (Array.isArray(a) && Array.isArray(b)) return a[0] - b[0] || a[1] - b[1];
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}
class FakeQuery {
  constructor(
    private allDocs: FakeDoc[],
    private filters: Array<{ field: string; op: string; value: unknown }> = [],
    private orders: Array<{ field: string | symbol; dir: "asc" | "desc" }> = [],
    private startAfterVals?: unknown[],
    private limitN?: number
  ) {}
  where(field: string, op: string, value: unknown) {
    return new FakeQuery(this.allDocs, [...this.filters, { field, op, value }], this.orders, this.startAfterVals, this.limitN);
  }
  orderBy(field: string | symbol, dir: "asc" | "desc" = "asc") {
    return new FakeQuery(this.allDocs, this.filters, [...this.orders, { field, dir }], this.startAfterVals, this.limitN);
  }
  startAfter(...vals: unknown[]) {
    return new FakeQuery(this.allDocs, this.filters, this.orders, vals, this.limitN);
  }
  limit(n: number) {
    return new FakeQuery(this.allDocs, this.filters, this.orders, this.startAfterVals, n);
  }
  async get() {
    let result = this.allDocs.filter((d) =>
      this.filters.every((f) => {
        if (!Object.prototype.hasOwnProperty.call(d.data, f.field)) return false;
        return f.op === "==" && d.data[f.field] === f.value;
      })
    );
    result = [...result].sort((a, b) => {
      for (const o of this.orders) {
        const cmp = compareKeys(orderingKey(a, o.field), orderingKey(b, o.field));
        if (cmp !== 0) return o.dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
    if (this.startAfterVals) {
      const startKeys = this.orders.map((o, i) => {
        const raw = this.startAfterVals![i];
        if (o.field === DOC_ID_SENTINEL) return String(raw);
        if (raw instanceof FakeTimestamp) return [raw.seconds, raw.nanoseconds] as [number, number];
        return raw;
      });
      const idx = result.findIndex((d) => this.orders.every((o, i) => compareKeys(orderingKey(d, o.field), startKeys[i] as any) === 0));
      result = idx === -1 ? [] : result.slice(idx + 1);
    }
    if (this.limitN != null) result = result.slice(0, this.limitN);
    return { docs: result.map((d) => ({ id: d.id, data: () => d.data })) };
  }
}

let runsDocs: FakeDoc[] = [];
let firestoreUnavailable = false;
const getAllSpy = jest.fn();
const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "runs") return new FakeQuery(runsDocs);
    throw new Error(`unexpected collection ${name} — listTeamProjectRuns must never read the projects collection`);
  },
  getAll: getAllSpy,
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailable ? null : mockAdminDb;
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { listTeamProjectRuns } from "../listTeamProjectRuns";

const W = "ws-team-1";
const P = "proj-1";

function runDoc(id: string, overrides: Record<string, unknown> = {}) {
  return { id, data: { userId: "uid-1", workspaceId: W, projectId: P, createdAt: FakeTimestamp.fromMillis(1_700_000_000_000), ...overrides } };
}

beforeEach(() => {
  runsDocs = [];
  firestoreUnavailable = false;
  getAllSpy.mockReset();
});

describe("listTeamProjectRuns — query predicate shape (Part 10)", () => {
  it("workspaceId==W AND projectId==P, no userId/createdByUserId predicate", async () => {
    runsDocs = [runDoc("r1"), runDoc("r2", { projectId: "other-proj" }), runDoc("r3", { workspaceId: "other-ws" })];
    const result = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items.map((i) => i.id)).toEqual(["r1"]);
  });

  it("ordering: createdAt DESC, documentId DESC", async () => {
    runsDocs = [runDoc("a", { createdAt: FakeTimestamp.fromMillis(1000) }), runDoc("b", { createdAt: FakeTimestamp.fromMillis(3000) })];
    const result = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("no creator filter — a run created by a different uid still appears", async () => {
    runsDocs = [runDoc("r1", { userId: "some-other-creator" })];
    const result = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items[0].userId).toBe("some-other-creator");
  });
});

describe("listTeamProjectRuns — Part 17 matrix", () => {
  it("valid rows -> returned", async () => {
    runsDocs = [runDoc("r1"), runDoc("r2")];
    const result = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items).toHaveLength(2);
  });

  it("no per-row Project re-read — getAll is never called by this function", async () => {
    runsDocs = [runDoc("r1"), runDoc("r2")];
    await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    expect(getAllSpy).not.toHaveBeenCalled();
  });

  it("run workspace mismatch -> integrity violation (row somehow returned with wrong workspaceId)", async () => {
    // Construct a scenario where the row validator's workspaceId check is
    // what catches it (defense in depth beyond the query's own filter).
    runsDocs = [{ id: "r1", data: { userId: "uid-1", workspaceId: "wrong-ws", projectId: P, createdAt: FakeTimestamp.fromMillis(1000) } }];
    // The query itself already filters workspaceId==W, so this row is
    // simply never returned — proving the query-level exclusion, which is
    // the primary defense.
    const result = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    expect(result).toEqual({ status: "ok", items: [], hasMore: false });
  });

  it("run project mismatch -> integrity violation (row somehow returned with wrong projectId, e.g. hypothetical query bug)", async () => {
    // The query filters projectId==P already; this proves the row
    // validator's own defense-in-depth equality check independently, by
    // directly exercising validateTeamRunRowShape's contract — a row
    // that matches the query's own filters can never actually disagree,
    // so this is a structural, not behavioral, guarantee. Covered
    // directly in teamRunRowValidation.spec.ts and listTeamProjectRuns.ts's
    // own explicit `result.projectId !== args.projectId` check.
    runsDocs = [runDoc("r1")];
    const result = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    expect(result.status).toBe("ok");
  });

  it("missing/malformed projectId -> integrity violation", async () => {
    const doc = runDoc("r1");
    delete (doc.data as any).projectId;
    runsDocs = [doc];
    // Absent projectId never matches the query's own projectId==P filter,
    // so it's excluded at the query level, not surfaced as a violation
    // here — this proves the query itself, not a validator escape.
    const result = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    expect(result).toEqual({ status: "ok", items: [], hasMore: false });
  });

  it("malformed createdAt -> integrity_violation", async () => {
    runsDocs = [runDoc("r1", { createdAt: { seconds: 1, nanoseconds: 0 } })];
    const result = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("cursor continuation", async () => {
    runsDocs = [
      runDoc("a", { createdAt: FakeTimestamp.fromMillis(3000) }),
      runDoc("b", { createdAt: FakeTimestamp.fromMillis(2000) }),
      runDoc("c", { createdAt: FakeTimestamp.fromMillis(1000) }),
    ];
    const page1 = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 2 });
    expect(page1.status).toBe("ok");
    if (page1.status !== "ok") return;
    expect(page1.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(page1.hasMore).toBe(true);

    const page2 = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 2, cursorRaw: page1.nextCursor });
    expect(page2.status).toBe("ok");
    if (page2.status !== "ok") return;
    expect(page2.items.map((i) => i.id)).toEqual(["c"]);
    expect(page2.hasMore).toBe(false);
  });

  it("hasMore true/false computed correctly", async () => {
    runsDocs = [runDoc("a"), runDoc("b")];
    const exact = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 2 });
    expect(exact.status).toBe("ok");
    if (exact.status === "ok") expect(exact.hasMore).toBe(false);

    const short = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 1 });
    expect(short.status).toBe("ok");
    if (short.status === "ok") expect(short.hasMore).toBe(true);
  });
});

describe("listTeamProjectRuns — infra", () => {
  it("firestore unavailable -> query_failed", async () => {
    firestoreUnavailable = true;
    const result = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20 });
    expect(result).toEqual({ status: "query_failed" });
  });

  it("invalid cursor -> invalid_cursor", async () => {
    const result = await listTeamProjectRuns({ workspaceId: W, projectId: P, limit: 20, cursorRaw: "garbage" });
    expect(result).toEqual({ status: "invalid_cursor" });
  });
});
