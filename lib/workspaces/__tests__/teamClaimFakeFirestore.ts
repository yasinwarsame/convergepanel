/**
 * TEAM-VERIFICATION-PARITY-R3 — in-memory Firestore fake shared by the Team
 * Claim read-contract suites (not a spec file). A real filter / multi-field
 * sort / startAfter / limit engine (the `listTeamWorkspaceRuns.spec.ts`
 * pattern), plus `doc().get()`, `getAll()`, and a recorder for every query,
 * read and ATTEMPTED WRITE so suites can prove scope and zero side effects.
 */

export class FakeTimestamp {
  constructor(
    public seconds: number,
    public nanoseconds: number = 0
  ) {}
  static fromMillis(ms: number) {
    return new FakeTimestamp(Math.floor(ms / 1000), (ms % 1000) * 1_000_000);
  }
  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1_000_000);
  }
}
export const DOC_ID_SENTINEL = Symbol("documentId");
export class FakeFieldPath {
  static documentId() {
    return DOC_ID_SENTINEL;
  }
}
export const fakeFirestoreModule = { Timestamp: FakeTimestamp, FieldPath: FakeFieldPath, FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" } };

export type FakeDoc = { id: string; data: Record<string, unknown> };
export type RecordedQuery = { collection: string; filters: Array<{ field: string; op: string; value: unknown }>; orders: Array<{ field: string; dir: string }>; startAfter?: unknown[]; limit?: number };

export type FakeState = {
  collections: Record<string, FakeDoc[]>;
  queries: RecordedQuery[];
  docGets: string[];
  getAllCalls: string[][];
  writeAttempts: string[];
  unavailable: boolean;
  throwOnQuery: boolean;
  throwOnDocGetCollections: Set<string>;
};

export function createFakeState(): FakeState {
  return { collections: {}, queries: [], docGets: [], getAllCalls: [], writeAttempts: [], unavailable: false, throwOnQuery: false, throwOnDocGetCollections: new Set() };
}

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

function writeRecorder(state: FakeState, label: string) {
  return (..._args: unknown[]) => {
    state.writeAttempts.push(label);
    throw new Error(`write attempted: ${label}`);
  };
}

class FakeQuery {
  constructor(
    private state: FakeState,
    private name: string,
    private filters: RecordedQuery["filters"] = [],
    private orders: Array<{ field: string | symbol; dir: "asc" | "desc" }> = [],
    private startAfterVals?: unknown[],
    private limitN?: number
  ) {}
  where(field: string, op: string, value: unknown) {
    return new FakeQuery(this.state, this.name, [...this.filters, { field, op, value }], this.orders, this.startAfterVals, this.limitN);
  }
  orderBy(field: string | symbol, dir: "asc" | "desc" = "asc") {
    return new FakeQuery(this.state, this.name, this.filters, [...this.orders, { field, dir }], this.startAfterVals, this.limitN);
  }
  startAfter(...vals: unknown[]) {
    return new FakeQuery(this.state, this.name, this.filters, this.orders, vals, this.limitN);
  }
  limit(n: number) {
    return new FakeQuery(this.state, this.name, this.filters, this.orders, this.startAfterVals, n);
  }
  async get() {
    this.state.queries.push({
      collection: this.name,
      filters: this.filters,
      orders: this.orders.map((o) => ({ field: o.field === DOC_ID_SENTINEL ? "__name__" : String(o.field), dir: o.dir })),
      ...(this.startAfterVals ? { startAfter: this.startAfterVals } : {}),
      ...(this.limitN != null ? { limit: this.limitN } : {}),
    });
    if (this.state.throwOnQuery) throw new Error("query failed");
    let result = (this.state.collections[this.name] ?? []).filter((d) =>
      this.filters.every((f) => Object.prototype.hasOwnProperty.call(d.data, f.field) && f.op === "==" && d.data[f.field] === f.value)
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
      // Real Firestore semantics: startAfter compares ORDERING VALUES, so the
      // cursor's own document need not be present in this query's scope.
      result = result.filter((d) => {
        for (let i = 0; i < this.orders.length; i += 1) {
          const cmp = compareKeys(orderingKey(d, this.orders[i].field), startKeys[i] as never);
          if (cmp !== 0) return this.orders[i].dir === "desc" ? cmp < 0 : cmp > 0;
        }
        return false;
      });
    }
    if (this.limitN != null) result = result.slice(0, this.limitN);
    return { docs: result.map((d) => ({ id: d.id, exists: true, data: () => d.data })), size: result.length };
  }
}

export function makeFakeDb(state: FakeState) {
  const docRef = (name: string, id: string) => ({
    __path: `${name}/${id}`,
    id,
    get: async () => {
      state.docGets.push(`${name}/${id}`);
      if (state.throwOnDocGetCollections.has(name)) throw new Error(`read failed: ${name}`);
      const found = (state.collections[name] ?? []).find((d) => d.id === id);
      return { id, exists: !!found, data: () => found?.data, updateTime: undefined };
    },
    set: writeRecorder(state, `${name}.set`),
    update: writeRecorder(state, `${name}.update`),
    delete: writeRecorder(state, `${name}.delete`),
    create: writeRecorder(state, `${name}.create`),
    collection: (sub: string) => ({ add: writeRecorder(state, `${name}/${id}/${sub}.add`) }),
  });
  return {
    collection: (name: string) => {
      const q = new FakeQuery(state, name);
      return Object.assign(q, { doc: (id: string) => docRef(name, id), add: writeRecorder(state, `${name}.add`) });
    },
    getAll: async (...refs: Array<{ __path: string }>) => {
      state.getAllCalls.push(refs.map((r) => r.__path));
      return refs.map((r) => {
        const [name, id] = r.__path.split("/");
        if (state.throwOnDocGetCollections.has(name)) throw new Error(`read failed: ${name}`);
        const found = (state.collections[name] ?? []).find((d) => d.id === id);
        return { id, exists: !!found, data: () => found?.data };
      });
    },
    batch: writeRecorder(state, "batch"),
    runTransaction: writeRecorder(state, "runTransaction"),
  };
}

export const TEAM_W = "ws-team-1";

export function teamClaimDoc(id: string, overrides: Record<string, unknown> = {}, ms = 1_700_000_000_000): FakeDoc {
  return {
    id,
    data: {
      userId: "creator-a",
      type: "claim_verification",
      claim: `Claim ${id}`,
      verdict: "confirmed",
      consensusScore: 80,
      confidenceLabel: "High",
      evidenceQuality: "strong",
      supportRatio: 0.8,
      modelResults: [{ modelId: "chatgpt", status: "ok", verdict: "accurate", confidence: "high", summary: "ok", correctParts: ["a"], incorrectParts: [], unverifiableParts: [] }],
      auditBundle: { version: "1", kind: "claim_verification", claimCharCount: 5, modelCount: 1, verdict: "confirmed", consensusScore: 80, confidenceLabel: "High", evidenceQuality: "strong", perModel: [], generatedAt: "2026-09-01T00:00:00.000Z" },
      selectedModels: ["chatgpt"],
      timestamp: FakeTimestamp.fromMillis(ms),
      workspaceId: TEAM_W,
      projectId: null,
      ...overrides,
    },
  };
}

export function projectDoc(id: string, overrides: Record<string, unknown> = {}): FakeDoc {
  return {
    id,
    data: { schemaVersion: 1, id, workspaceId: TEAM_W, name: `Project ${id}`, status: "active", createdByUserId: "owner", createdAt: FakeTimestamp.fromMillis(1_600_000_000_000), updatedAt: FakeTimestamp.fromMillis(1_600_000_000_000), ...overrides },
  };
}
