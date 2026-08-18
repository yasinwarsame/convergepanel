/**
 * Project Read Foundation, Phase 7A — listRunsByProjectScopeRaw() tests.
 * Firestore is faked in-memory with a real filter/sort/startAfter/limit
 * engine (not a fixed-docs stub), mirroring
 * app/api/user/workspace/runs/__tests__/route.spec.ts's established
 * FakeQuery pattern, so the cursor-pagination matrix is exercised against
 * realistic query semantics, not just this function's own bookkeeping.
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
    // Firestore `==` never matches a document where the filtered field is
    // genuinely absent — including against `null`. `hasOwnProperty` here
    // (not a plain `field in data` check, which would also be true for an
    // absent-but-inherited-from-prototype key — irrelevant for plain
    // object literals but matches the real semantic intent precisely)
    // mirrors that: an absent `projectId` field can never satisfy
    // `where("projectId","==",null)`.
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
const mockAdminDb: any = {
  collection: (name: string) => {
    if (name !== "runs") throw new Error(`unexpected collection ${name}`);
    return new FakeQuery(runsDocs);
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailable ? null : mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { listRunsByProjectScopeRaw } from "@/lib/projects/listRunsByProjectScopeRaw";

const UID = "owner-1";
const WS_ID = "personal-owner-1";
const P1 = "proj-1";

function runDoc(id: string, overrides: Record<string, unknown> = {}) {
  return { id, data: { userId: UID, workspaceId: WS_ID, projectId: P1, createdAt: FakeTimestamp.fromMillis(1_700_000_000_000), ...overrides } };
}

beforeEach(() => {
  jest.clearAllMocks();
  runsDocs = [];
  firestoreUnavailable = false;
});

describe("firestore unavailable", () => {
  it("returns firestore_unavailable", async () => {
    firestoreUnavailable = true;
    const result = await listRunsByProjectScopeRaw({ userId: UID, workspaceId: WS_ID, projectId: P1, limit: 20 });
    expect(result).toEqual({ status: "firestore_unavailable" });
  });
});

describe("scope filtering", () => {
  it("project scope: only returns runs with the exact matching projectId, userId, workspaceId", async () => {
    runsDocs = [
      runDoc("run-1", { projectId: P1 }),
      runDoc("run-2", { projectId: "proj-2" }),
      runDoc("run-3", { userId: "someone-else" }),
      runDoc("run-4", { workspaceId: "personal-someone-else" }),
    ];
    const result = await listRunsByProjectScopeRaw({ userId: UID, workspaceId: WS_ID, projectId: P1, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items.map((i) => i.id)).toEqual(["run-1"]);
  });

  it("unfiled scope: projectId==null never matches a run where projectId is absent", async () => {
    const withNull = runDoc("run-null", { projectId: null });
    const withAbsent = runDoc("run-absent");
    delete (withAbsent.data as any).projectId;
    runsDocs = [withNull, withAbsent];
    const result = await listRunsByProjectScopeRaw({ userId: UID, workspaceId: WS_ID, projectId: null, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items.map((i) => i.id)).toEqual(["run-null"]);
  });
});

describe("pagination", () => {
  it("peek-one-extra-doc: hasMore true when more rows exist beyond limit", async () => {
    runsDocs = [
      runDoc("run-1", { createdAt: FakeTimestamp.fromMillis(3000) }),
      runDoc("run-2", { createdAt: FakeTimestamp.fromMillis(2000) }),
      runDoc("run-3", { createdAt: FakeTimestamp.fromMillis(1000) }),
    ];
    const result = await listRunsByProjectScopeRaw({ userId: UID, workspaceId: WS_ID, projectId: P1, limit: 2 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    }
  });

  it("hasMore false when exactly at the boundary", async () => {
    runsDocs = [runDoc("run-1", { createdAt: FakeTimestamp.fromMillis(2000) }), runDoc("run-2", { createdAt: FakeTimestamp.fromMillis(1000) })];
    const result = await listRunsByProjectScopeRaw({ userId: UID, workspaceId: WS_ID, projectId: P1, limit: 2 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.hasMore).toBe(false);
  });

  it("startAfter resumes correctly, no duplicate/skipped rows across pages", async () => {
    runsDocs = [
      runDoc("run-1", { createdAt: FakeTimestamp.fromMillis(3000) }),
      runDoc("run-2", { createdAt: FakeTimestamp.fromMillis(2000) }),
      runDoc("run-3", { createdAt: FakeTimestamp.fromMillis(1000) }),
    ];
    const page1 = await listRunsByProjectScopeRaw({ userId: UID, workspaceId: WS_ID, projectId: P1, limit: 1 });
    expect(page1.status).toBe("ok");
    if (page1.status !== "ok") return;
    expect(page1.items.map((i) => i.id)).toEqual(["run-1"]);

    const page2 = await listRunsByProjectScopeRaw({
      userId: UID,
      workspaceId: WS_ID,
      projectId: P1,
      limit: 1,
      startAfter: { createdAtSeconds: 3, createdAtNanoseconds: 0, lastDocId: "run-1" },
    });
    expect(page2.status).toBe("ok");
    if (page2.status !== "ok") return;
    expect(page2.items.map((i) => i.id)).toEqual(["run-2"]);
  });

  it("PRECISION REGRESSION: same-second, different-nanosecond documents are correctly distinguished by startAfter", async () => {
    runsDocs = [
      runDoc("run-a", { createdAt: new FakeTimestamp(1000, 500_000_000) }),
      runDoc("run-b", { createdAt: new FakeTimestamp(1000, 100_000_000) }),
    ];
    const page1 = await listRunsByProjectScopeRaw({ userId: UID, workspaceId: WS_ID, projectId: P1, limit: 1 });
    expect(page1.status).toBe("ok");
    if (page1.status !== "ok") return;
    expect(page1.items.map((i) => i.id)).toEqual(["run-a"]);

    const page2 = await listRunsByProjectScopeRaw({
      userId: UID,
      workspaceId: WS_ID,
      projectId: P1,
      limit: 1,
      startAfter: { createdAtSeconds: 1000, createdAtNanoseconds: 500_000_000, lastDocId: "run-a" },
    });
    expect(page2.status).toBe("ok");
    if (page2.status !== "ok") return;
    expect(page2.items.map((i) => i.id)).toEqual(["run-b"]);
  });
});

describe("empty result", () => {
  it("returns ok with an empty array, not an error", async () => {
    runsDocs = [];
    const result = await listRunsByProjectScopeRaw({ userId: UID, workspaceId: WS_ID, projectId: P1, limit: 20 });
    expect(result).toEqual({ status: "ok", items: [], hasMore: false });
  });
});
