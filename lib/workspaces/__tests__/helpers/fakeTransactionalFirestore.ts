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
/** Set while an `afterTxReads` hook body runs; see `runTransaction`. */
const insideAfterTxReadsHook = new (require("async_hooks") as typeof import("async_hooks")).AsyncLocalStorage<true>();

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

// ---------------------------------------------------------------------------------------------------------------------
// Queries (B2): where (==, in, <) on dotted paths, orderBy (incl. documentId), startAfter(values), limit, collectionGroup.
// Ordering matches Firestore for the value kinds used here: Timestamp by (seconds, nanos); strings and document keys by
// UTF-8 bytes; documentId on a collection query = the bare id, on a collection-group query = the full path.
// ---------------------------------------------------------------------------------------------------------------------
const DOC_ID = "__name__";
type Source = { kind: "collection"; path: string } | { kind: "group"; id: string };
type Where = { field: string; op: "==" | "in" | "<" | "<=" | ">="; value: unknown };
type Order = { field: string; dir: "asc" | "desc" };

function nested(data: Data, path: string): unknown {
  let cur: unknown = data;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Data)[seg];
  }
  return cur;
}
function isTimestampLike(v: unknown): v is { seconds: number; nanoseconds: number } {
  return typeof v === "object" && v !== null && typeof (v as { seconds?: unknown }).seconds === "number" && typeof (v as { nanoseconds?: unknown }).nanoseconds === "number";
}
function cmpValue(a: unknown, b: unknown): number {
  if (isTimestampLike(a) && isTimestampLike(b)) return a.seconds - b.seconds || a.nanoseconds - b.nanoseconds;
  if (typeof a === "string" && typeof b === "string") return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  if (typeof a === "number" && typeof b === "number") return a - b;
  return 0;
}
function fieldName(f: unknown): string {
  if (typeof f === "string") return f;
  const str = String(f);
  return str === "__name__" || str.includes("__name__") ? DOC_ID : str;
}

export class FakeQueryBase {
  constructor(
    protected db: FakeTransactionalFirestore,
    protected source: Source,
    protected wheres: Where[],
    protected orders: Order[],
    protected after: unknown[] | null,
    protected max: number
  ) {}
  protected next(p: Partial<{ wheres: Where[]; orders: Order[]; after: unknown[] | null; max: number }>): FakeQueryBase {
    return new FakeQueryBase(this.db, this.source, p.wheres ?? this.wheres, p.orders ?? this.orders, p.after !== undefined ? p.after : this.after, p.max ?? this.max);
  }
  where(field: unknown, op: "==" | "in" | "<" | "<=" | ">=", value: unknown) {
    return this.next({ wheres: [...this.wheres, { field: fieldName(field), op, value }] });
  }
  orderBy(field: unknown, dir: "asc" | "desc" = "asc") {
    return this.next({ orders: [...this.orders, { field: fieldName(field), dir }] });
  }
  startAfter(...values: unknown[]) {
    return this.next({ after: values });
  }
  limit(n: number) {
    return this.next({ max: n });
  }
  select() {
    return this;
  }
  private members(): string[] {
    const all = Array.from(this.db.docs.keys());
    if (this.source.kind === "collection") {
      const prefix = `${this.source.path}/`;
      return all.filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
    }
    const id = this.source.id;
    return all.filter((p) => {
      const parts = p.split("/");
      return parts.length >= 2 && parts[parts.length - 2] === id;
    });
  }
  async get() {
    const keyOf = (path: string) => (this.source.kind === "group" ? path : path.split("/").pop()!);
    const val = (path: string, data: Data, field: string) => (field === DOC_ID ? keyOf(path) : nested(data, field));
    let rows = this.members()
      .map((path) => ({ path, data: this.db.docs.get(path)!.data }))
      .filter(({ path, data }) =>
        this.wheres.every((w) => {
          const v = val(path, data, w.field);
          if (w.op === "==") return v === w.value || (isTimestampLike(v) && isTimestampLike(w.value) && cmpValue(v, w.value) === 0);
          if (w.op === "in") return Array.isArray(w.value) && w.value.includes(v);
          if (v === undefined || typeof v !== typeof w.value) return false;
          const c = cmpValue(v, w.value);
          return w.op === "<" ? c < 0 : w.op === "<=" ? c <= 0 : c >= 0;
        })
      );
    // Firestore only returns documents that HAVE every orderBy field.
    rows = rows.filter(({ path, data }) => this.orders.every((o) => val(path, data, o.field) !== undefined));
    const cmpRow = (a: { path: string; data: Data }, b: { path: string; data: Data }) => {
      for (const o of this.orders) {
        const c = cmpValue(val(a.path, a.data, o.field), val(b.path, b.data, o.field)) * (o.dir === "desc" ? -1 : 1);
        if (c !== 0) return c;
      }
      return 0;
    };
    rows.sort(cmpRow);
    if (this.after) {
      const after = this.after;
      rows = rows.filter((r) => {
        for (let i = 0; i < this.orders.length; i++) {
          const c = cmpValue(val(r.path, r.data, this.orders[i].field), after[i]) * (this.orders[i].dir === "desc" ? -1 : 1);
          if (c !== 0) return c > 0;
        }
        return false;
      });
    }
    rows = rows.slice(0, this.max);
    return { docs: rows.map((r) => this.db.snapshot(r.path)), empty: rows.length === 0, size: rows.length };
  }
}

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
  /** Subcollections that contain at least one document at any depth (as Firestore's listCollections reports them). */
  async listCollections() {
    const prefix = `${this.path}/`;
    const names = new Set<string>();
    for (const p of this.db.docs.keys()) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split("/")[0]);
    return Array.from(names).sort().map((n) => new FakeCollectionRef(this.db, `${this.path}/${n}`));
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

export class FakeCollectionRef extends FakeQueryBase {
  constructor(
    db: FakeTransactionalFirestore,
    public path: string
  ) {
    super(db, { kind: "collection", path }, [], [], null, Infinity);
  }
  doc(id?: string) {
    return new FakeDocRef(this.db, `${this.path}/${id ?? `auto${++autoId}`}`);
  }
  async add(data: Data) {
    const ref = this.doc();
    await ref.create(data);
    return ref;
  }
  /** Every document id under this collection, INCLUDING "missing" ancestors that only have subcollections (Firestore semantics). */
  async listDocuments() {
    const prefix = `${this.path}/`;
    const ids = new Set<string>();
    for (const p of this.db.docs.keys()) if (p.startsWith(prefix)) ids.add(p.slice(prefix.length).split("/")[0]);
    return Array.from(ids).sort().map((id) => new FakeDocRef(this.db, `${this.path}/${id}`));
  }
  get id() {
    return this.path.split("/").pop()!;
  }
  /** The document this collection belongs to (null for a root collection). */
  get parent(): FakeDocRef | null {
    const parts = this.path.split("/");
    return parts.length < 2 ? null : new FakeDocRef(this.db, parts.slice(0, -1).join("/"));
  }
}

type Write = { kind: "set" | "merge" | "update" | "create" | "delete"; path: string; data: Data };

export class FakeTransaction {
  reads = new Map<string, number>(); // path -> version read (-1 = missing)
  writes: Write[] = [];
  constructor(private db: FakeTransactionalFirestore) {}
  async get(ref: FakeDocRef): Promise<ReturnType<FakeTransactionalFirestore["snapshot"]>>;
  async get(ref: FakeQueryBase): Promise<Awaited<ReturnType<FakeQueryBase["get"]>>>;
  async get(ref: FakeDocRef | FakeQueryBase): Promise<unknown> {
    if (this.writes.length > 0) throw new FirestoreError("INVALID_ARGUMENT", "Firestore transactions require all reads to be executed before all writes.");
    if (ref instanceof FakeQueryBase) {
      // A query read in a transaction: every returned document joins the read set (phantoms are not tracked).
      const snap = await ref.get();
      for (const d of snap.docs) this.reads.set(d.ref.path, this.db.docs.get(d.ref.path)?.version ?? -1);
      return snap;
    }
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
  hooks: { afterTxReads?: (attempt: number) => Promise<void> | void; failCommit?: (attempt: number) => void; failWrite?: (w: { kind: string; path: string }) => void } = {};

  collection(name: string) {
    return new FakeCollectionRef(this, name);
  }
  collectionGroup(id: string) {
    return new FakeQueryBase(this, { kind: "group", id }, [], [], null, Infinity);
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
  /**
   * Every write that was APPLIED (committed), in order: its kind, path, data, and whether it came from a transaction
   * commit (`via: "tx"`) or a direct document call (`via: "direct"`). Lets specs assert the exact write shape a
   * production writer issues, the way method spies did, against a store that models transactions.
   */
  writeLog: { kind: Write["kind"]; path: string; data: Data; via: "tx" | "direct" }[] = [];
  applyWrites(writes: Write[], via: "tx" | "direct" = "direct") {
    const staged = new Map<string, Stored | undefined>();
    const current = (p: string) => (staged.has(p) ? staged.get(p) : this.docs.get(p));
    for (const w of writes) {
      this.hooks.failWrite?.({ kind: w.kind, path: w.path }); // partial-storage-failure injection (S1 deletion tests)
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
    for (const w of writes) this.writeLog.push({ kind: w.kind, path: w.path, data: clone(w.data), via });
  }
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const tx = new FakeTransaction(this);
      const result = await fn(tx);
      // The hook stands for OTHER writers acting between this transaction's reads and its commit. Writes the hook makes
      // are those other writers' own operations. When they run transactions of their own (for example, every
      // deletion-barrier-guarded writer), they are not intercepted again, which would make the hook re-enter itself
      // without bound. The guard is scoped to the hook's own async context (AsyncLocalStorage): a transaction running
      // concurrently from elsewhere is still intercepted.
      if (this.hooks.afterTxReads && !insideAfterTxReadsHook.getStore()) {
        const hook = this.hooks.afterTxReads;
        await insideAfterTxReadsHook.run(true, () => hook(attempt));
      }
      // A transaction that wrote nothing commits as-is (production: a read-only transaction has nothing to conflict on,
      // and its result reflects the state it read). Only attempts with writes are validated and retried.
      const conflict = tx.writes.length > 0 && Array.from(tx.reads.entries()).some(([p, v]) => (this.docs.get(p)?.version ?? -1) !== v);
      if (conflict) {
        this.stats.retries++;
        continue;
      }
      this.hooks.failCommit?.(attempt);
      this.applyWrites(tx.writes, "tx");
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
