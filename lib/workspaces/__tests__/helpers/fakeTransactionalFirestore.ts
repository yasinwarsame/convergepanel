/**
 * A small in-memory Firestore for CONCURRENCY tests (Order B, Stage B1). Unlike the per-spec fakes elsewhere, this one
 * models the parts of Firestore that decide whether two writers can interleave badly:
 *
 *   - Every document has a version; every committed write bumps it.
 *   - Transactions record the version of every document they read. At commit, if the attempt has writes and ANY read
 *     document changed (or a document read as missing now exists), the attempt is discarded and the callback is RE-RUN.
 *     That is serializable-equivalent to the Admin SDK's server-side locking (where the competing write waits instead):
 *     either way the committed writes are based on the current state. Read-only attempts commit as-is.
 *   - Reads must precede writes inside a transaction (Firestore rejects a read after a write).
 *   - `tx.create` / `ref.create` fail with ALREADY_EXISTS if the document exists at commit (not retried).
 *   - `update` fails with NOT_FOUND on a missing document; dotted field paths update nested maps.
 *   - `set(..., { merge: true })` deep-merges plain maps (arrays and class instances such as Timestamp are replaced).
 *   - Writes inside one transaction commit atomically: all or nothing.
 *
 * Hooks let a test pause a transaction between its reads and its commit and run other writers in that gap:
 *   `hooks.afterTxReads(attempt)` runs after the callback returns (all reads done, writes buffered) and before commit.
 *   `hooks.failCommit(attempt)` may throw to simulate a commit failure (nothing is applied).
 */

type Data = Record<string, unknown>;
type Stored = { data: Data; version: number };

const MAX_ATTEMPTS = 5;

function isPlainObject(v: unknown): v is Data {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  return v;
}
function deepMerge(base: Data, patch: Data): Data {
  const out: Data = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Data, v) : clone(v);
  return out;
}
function applyUpdate(base: Data, patch: Data): Data {
  const out = clone(base);
  for (const [path, v] of Object.entries(patch)) {
    const parts = path.split(".");
    let cur: Data = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
      cur = cur[parts[i]] as Data;
    }
    cur[parts[parts.length - 1]] = clone(v);
  }
  return out;
}

export class FirestoreError extends Error {
  constructor(
    public code: "ALREADY_EXISTS" | "NOT_FOUND" | "ABORTED" | "INVALID_ARGUMENT" | "UNAVAILABLE",
    message: string
  ) {
    super(`${code}: ${message}`);
  }
}

let autoId = 0;

export class FakeDocRef {
  constructor(
    private db: FakeTransactionalFirestore,
    public path: string
  ) {}
  get id() {
    return this.path.split("/").pop()!;
  }
  collection(name: string) {
    return new FakeCollectionRef(this.db, `${this.path}/${name}`);
  }
  get parent() {
    const parts = this.path.split("/");
    return new FakeCollectionRef(this.db, parts.slice(0, -1).join("/"));
  }
  async get() {
    return this.db.snapshot(this.path);
  }
  async set(data: Data, opts?: { merge?: boolean }) {
    this.db.applyWrites([{ kind: opts?.merge ? "merge" : "set", path: this.path, data }]);
  }
  async update(data: Data) {
    this.db.applyWrites([{ kind: "update", path: this.path, data }]);
  }
  async create(data: Data) {
    this.db.applyWrites([{ kind: "create", path: this.path, data }]);
  }
  async delete() {
    this.db.applyWrites([{ kind: "delete", path: this.path, data: {} }]);
  }
}

export class FakeCollectionRef {
  constructor(
    private db: FakeTransactionalFirestore,
    public path: string
  ) {}
  doc(id?: string) {
    return new FakeDocRef(this.db, `${this.path}/${id ?? `auto${++autoId}`}`);
  }
}

type Write = { kind: "set" | "merge" | "update" | "create" | "delete"; path: string; data: Data };

export class FakeTransaction {
  reads = new Map<string, number>(); // path -> version read (-1 = missing)
  writes: Write[] = [];
  constructor(private db: FakeTransactionalFirestore) {}
  async get(ref: FakeDocRef) {
    if (this.writes.length > 0) throw new FirestoreError("INVALID_ARGUMENT", "Firestore transactions require all reads to be executed before all writes.");
    const s = this.db.docs.get(ref.path);
    this.reads.set(ref.path, s ? s.version : -1);
    return this.db.snapshot(ref.path);
  }
  set(ref: FakeDocRef, data: Data, opts?: { merge?: boolean }) {
    this.writes.push({ kind: opts?.merge ? "merge" : "set", path: ref.path, data: clone(data) });
    return this;
  }
  update(ref: FakeDocRef, data: Data) {
    this.writes.push({ kind: "update", path: ref.path, data: clone(data) });
    return this;
  }
  create(ref: FakeDocRef, data: Data) {
    this.writes.push({ kind: "create", path: ref.path, data: clone(data) });
    return this;
  }
  delete(ref: FakeDocRef) {
    this.writes.push({ kind: "delete", path: ref.path, data: {} });
    return this;
  }
}

export class FakeTransactionalFirestore {
  docs = new Map<string, Stored>();
  private clock = 0;
  stats = { commits: 0, retries: 0, aborted: 0 };
  hooks: { afterTxReads?: (attempt: number) => Promise<void> | void; failCommit?: (attempt: number) => void } = {};

  collection(name: string) {
    return new FakeCollectionRef(this, name);
  }
  doc(path: string) {
    return new FakeDocRef(this, path);
  }
  seed(path: string, data: Data) {
    this.docs.set(path, { data: clone(data), version: ++this.clock });
  }
  read(path: string): Data | undefined {
    const s = this.docs.get(path);
    return s ? clone(s.data) : undefined;
  }
  paths(prefix: string): string[] {
    return Array.from(this.docs.keys()).filter((p) => p.startsWith(prefix));
  }
  snapshot(path: string) {
    const s = this.docs.get(path);
    const data = s ? clone(s.data) : undefined;
    return {
      exists: s !== undefined,
      id: path.split("/").pop()!,
      ref: new FakeDocRef(this, path),
      data: () => (data ? clone(data) : undefined),
      get: (f: string) => (data ? data[f] : undefined),
      updateTime: { toMillis: () => s?.version ?? 0, seconds: s?.version ?? 0, nanoseconds: 0 },
    };
  }
  /** Applies a batch atomically: validates every write first, then applies all. */
  applyWrites(writes: Write[]) {
    const staged = new Map<string, Stored | undefined>();
    const current = (p: string) => (staged.has(p) ? staged.get(p) : this.docs.get(p));
    for (const w of writes) {
      const cur = current(w.path);
      if (w.kind === "create" && cur) throw new FirestoreError("ALREADY_EXISTS", w.path);
      if (w.kind === "update" && !cur) throw new FirestoreError("NOT_FOUND", w.path);
      const next =
        w.kind === "delete"
          ? undefined
          : w.kind === "set" || w.kind === "create"
            ? clone(w.data)
            : w.kind === "merge"
              ? deepMerge(cur?.data ?? {}, w.data)
              : applyUpdate(cur!.data, w.data);
      staged.set(w.path, next === undefined ? undefined : { data: next, version: 0 });
    }
    for (const [p, s] of staged) {
      if (s === undefined) this.docs.delete(p);
      else this.docs.set(p, { data: s.data, version: ++this.clock });
    }
  }
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const tx = new FakeTransaction(this);
      const result = await fn(tx);
      await this.hooks.afterTxReads?.(attempt);
      // A transaction that wrote nothing commits as-is (production: a read-only transaction has nothing to conflict on,
      // and its result reflects the state it read). Only attempts with writes are validated and retried.
      const conflict = tx.writes.length > 0 && Array.from(tx.reads.entries()).some(([p, v]) => (this.docs.get(p)?.version ?? -1) !== v);
      if (conflict) {
        this.stats.retries++;
        continue;
      }
      this.hooks.failCommit?.(attempt);
      this.applyWrites(tx.writes);
      this.stats.commits++;
      return result;
    }
    this.stats.aborted++;
    throw new FirestoreError("ABORTED", "too much contention");
  }
  async getAll(...refs: FakeDocRef[]) {
    return refs.map((r) => this.snapshot(r.path));
  }
}
