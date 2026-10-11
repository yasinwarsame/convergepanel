/**
 * Test-only in-memory Firestore for Source Standing. Faithful to the parts the
 * production code relies on, and STRICTER where Firestore is strict:
 *   - documents are addressed by full slash paths (sub-collections included);
 *   - `tx.get()` after any buffered write throws (Firestore: reads before writes);
 *   - `tx.create()` of an existing document fails the commit (ALREADY_EXISTS);
 *   - optimistic concurrency: every document a transaction read is version-
 *     checked at commit; a change since the read aborts the attempt and the
 *     callback is re-run (up to `maxAttempts`), exactly like the Admin SDK;
 *   - queries support only what the module uses: one `orderBy` + `limit` over
 *     the DIRECT children of one collection path.
 * Every read is recorded (`reads`) so read bounds can be asserted, and
 * `beforeCommit` lets a test interleave a concurrent writer or force a retry.
 */
type Data = Record<string, unknown>;

export type ReadRecord =
  | { kind: "doc"; path: string; via: "tx" | "get" | "getAll" }
  | { kind: "query"; path: string; orderBy: string | null; dir: string; limit: number; where: ReadonlyArray<{ field: string; value: unknown }>; via: "tx" | "get" };

export class FakeDocRef {
  constructor(readonly db: FakeDb, readonly path: string) {}
  get id(): string {
    return this.path.split("/").pop() as string;
  }
  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this.db, `${this.path}/${name}`);
  }
  async get() {
    this.db.reads.push({ kind: "doc", path: this.path, via: "get" });
    if (this.db.failReads) throw new Error("simulated read failure");
    return this.db.snap(this.path);
  }
}

export class FakeQuery {
  constructor(
    readonly db: FakeDb,
    readonly path: string,
    readonly field: string | null,
    readonly dir: "asc" | "desc",
    readonly lim: number,
    readonly filters: ReadonlyArray<{ field: string; value: unknown }> = []
  ) {}
  limit(n: number): FakeQuery {
    return new FakeQuery(this.db, this.path, this.field, this.dir, n, this.filters);
  }
  where(field: string, op: string, value: unknown): FakeQuery {
    if (op !== "==") throw new Error(`fake supports only ==, got ${op}`);
    return new FakeQuery(this.db, this.path, this.field, this.dir, this.lim, [...this.filters, { field, value }]);
  }
  orderBy(field: string, dir: "asc" | "desc" = "asc"): FakeQuery {
    return new FakeQuery(this.db, this.path, field, dir, this.lim, this.filters);
  }
  run() {
    const prefix = `${this.path}/`;
    const has = (d: Data, f: string) => Object.prototype.hasOwnProperty.call(d, f);
    let rows = [...this.db.store.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map(([p, v]) => ({ p, v }))
      .filter(({ v }) => this.filters.every((f) => has(v.data, f.field) && v.data[f.field] === f.value));
    if (this.field !== null) {
      const field = this.field;
      rows = rows
        .filter(({ v }) => has(v.data, field))
        .sort((a, b) => {
          const x = a.v.data[field] as number;
          const y = b.v.data[field] as number;
          return this.dir === "desc" ? y - x : x - y;
        });
    }
    const docs = rows.slice(0, this.lim).map(({ p }) => this.db.snap(p));
    return { empty: docs.length === 0, size: docs.length, docs };
  }
}

export class FakeCollectionRef {
  constructor(readonly db: FakeDb, readonly path: string) {}
  doc(id?: string): FakeDocRef {
    return new FakeDocRef(this.db, `${this.path}/${id ?? `auto${++this.db.autoId}`}`);
  }
  orderBy(field: string, dir: "asc" | "desc" = "asc"): FakeQuery {
    return new FakeQuery(this.db, this.path, field, dir, Number.MAX_SAFE_INTEGER);
  }
  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.db, this.path, null, "asc", Number.MAX_SAFE_INTEGER).where(field, op, value);
  }
}

type Write = { op: "set" | "create" | "delete"; path: string; data?: Data };

export class FakeTx {
  readonly writes: Write[] = [];
  readonly readVersions = new Map<string, number>();
  constructor(readonly db: FakeDb) {}
  async get(target: FakeDocRef | FakeQuery) {
    if (this.writes.length > 0) throw new Error("Firestore transactions require all reads to be executed before all writes.");
    if (this.db.failReads) throw new Error("simulated read failure");
    if (target instanceof FakeQuery) {
      this.db.reads.push({ kind: "query", path: target.path, orderBy: target.field, dir: target.dir, limit: target.lim, where: target.filters, via: "tx" });
      const res = target.run();
      for (const d of res.docs) this.readVersions.set(`${target.path}/${d.id}`, this.db.version(`${target.path}/${d.id}`));
      // A query also conflicts with inserts into its collection (Firestore locks the range).
      this.readVersions.set(`${target.path}/*`, this.db.collectionVersion(target.path));
      return res;
    }
    this.db.reads.push({ kind: "doc", path: target.path, via: "tx" });
    this.readVersions.set(target.path, this.db.version(target.path));
    return this.db.snap(target.path);
  }
  set(ref: FakeDocRef, data: Data) {
    this.writes.push({ op: "set", path: ref.path, data });
    return this;
  }
  create(ref: FakeDocRef, data: Data) {
    this.writes.push({ op: "create", path: ref.path, data });
    return this;
  }
  delete(ref: FakeDocRef) {
    this.writes.push({ op: "delete", path: ref.path });
    return this;
  }
}

export class FakeDb {
  store = new Map<string, { data: Data; version: number }>();
  versions = new Map<string, number>();
  collectionVersions = new Map<string, number>();
  reads: ReadRecord[] = [];
  autoId = 0;
  attempts = 0;
  commits = 0;
  failReads = false;
  maxAttempts = 5;
  /** Runs after the callback and before the commit check, once per attempt. Return "abort" to force a retry. */
  beforeCommit: ((attempt: number) => void | "abort" | Promise<void | "abort">) | null = null;

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this, name);
  }
  doc(path: string): FakeDocRef {
    return new FakeDocRef(this, path);
  }
  version(path: string): number {
    return this.versions.get(path) ?? 0;
  }
  collectionVersion(path: string): number {
    return this.collectionVersions.get(path) ?? 0;
  }
  snap(path: string) {
    const entry = this.store.get(path);
    const id = path.split("/").pop() as string;
    // Deep-ish copy so production code can never mutate stored state through a snapshot.
    return entry ? { exists: true, id, data: () => structuredCloneData(entry.data) } : { exists: false, id, data: () => undefined };
  }
  /** Direct seed/raw write (bumps versions like a committed write). */
  put(path: string, data: Data | null) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (data === null) this.store.delete(path);
    else this.store.set(path, { data, version: this.version(path) + 1 });
    this.versions.set(path, this.version(path) + 1);
    this.collectionVersions.set(parent, this.collectionVersion(parent) + 1);
  }
  read(path: string): Data | undefined {
    return this.store.get(path)?.data;
  }
  children(collectionPath: string): Array<{ id: string; data: Data }> {
    const prefix = `${collectionPath}/`;
    return [...this.store.entries()].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).map(([p, v]) => ({ id: p.slice(prefix.length), data: v.data }));
  }
  async getAll(...refs: FakeDocRef[]) {
    if (this.failReads) throw new Error("simulated read failure");
    for (const r of refs) this.reads.push({ kind: "doc", path: r.path, via: "getAll" });
    return refs.map((r) => this.snap(r.path));
  }
  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.attempts += 1;
      const tx = new FakeTx(this);
      const result = await fn(tx);
      if (this.beforeCommit && (await this.beforeCommit(attempt)) === "abort") continue;
      let stale = false;
      for (const [key, v] of tx.readVersions) {
        const now = key.endsWith("/*") ? this.collectionVersion(key.slice(0, -2)) : this.version(key);
        if (now !== v) stale = true;
      }
      if (stale) continue;
      for (const w of tx.writes) if (w.op === "create" && this.store.has(w.path)) throw Object.assign(new Error(`ALREADY_EXISTS: ${w.path}`), { code: 6 });
      for (const w of tx.writes) this.put(w.path, w.op === "delete" ? null : (w.data as Data));
      this.commits += 1;
      return result;
    }
    throw Object.assign(new Error("ABORTED: too much contention"), { code: 10 });
  }
}

function structuredCloneData(d: Data): Data {
  const out: Data = {};
  for (const [k, v] of Object.entries(d)) out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof (v as { toDate?: unknown }).toDate !== "function" ? structuredCloneData(v as Data) : v;
  return out;
}
