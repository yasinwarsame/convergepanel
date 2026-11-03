/**
 * Map-shaped views over `FakeTransactionalFirestore` (research deletion integrity, 2026-11-03).
 *
 * Several older specs modelled Firestore as separate `Map`s keyed by a spec-specific string (`runId`,
 * `${runId}/${sub}/${docId}`, `admin_audit_logs/${id}`, …) behind hand-written `create()` / `update()` stubs. Those stubs
 * had no transactions, so they cannot run writers that are now guarded by the deletion barrier. A view keeps the
 * spec's `Map` API and keys unchanged while the documents live in the transactional fake. That fake models versions,
 * conflicts and retries, read-before-write, `create()` exclusivity and `update()` NOT_FOUND. Every existing assertion
 * therefore reads exactly what the production writer committed.
 */
import type { FakeTransactionalFirestore } from "./fakeTransactionalFirestore";

type Data = Record<string, any>;

export interface StoreView {
  get(key: string): Data | undefined;
  set(key: string, value: Data): StoreView;
  has(key: string): boolean;
  delete(key: string): boolean;
  readonly size: number;
  keys(): IterableIterator<string>;
  values(): IterableIterator<Data>;
  entries(): IterableIterator<[string, Data]>;
  clear(): void;
}

/**
 * @param toPath   spec key → Firestore document path
 * @param fromPath Firestore document path → spec key, or null if the path is not part of this view
 */
export function storeView(db: FakeTransactionalFirestore, toPath: (key: string) => string, fromPath: (path: string) => string | null): StoreView {
  const own = () =>
    Array.from(db.docs.keys())
      .map((p) => [p, fromPath(p)] as const)
      .filter((e): e is readonly [string, string] => e[1] !== null);
  const view: StoreView = {
    get: (key) => db.read(toPath(key)),
    set: (key, value) => {
      db.seed(toPath(key), value);
      return view;
    },
    has: (key) => db.docs.has(toPath(key)),
    delete: (key) => db.docs.delete(toPath(key)),
    get size() {
      return own().length;
    },
    keys: () => own().map(([, k]) => k)[Symbol.iterator](),
    values: () => own().map(([p]) => db.read(p)!)[Symbol.iterator](),
    entries: () => own().map(([p, k]) => [k, db.read(p)!] as [string, Data])[Symbol.iterator](),
    clear: () => {
      for (const [p] of own()) db.docs.delete(p);
    },
  };
  return view;
}

/** `runs/{key}` (top-level run documents only). */
export const runDocView = (db: FakeTransactionalFirestore) =>
  storeView(db, (k) => `runs/${k}`, (p) => (/^runs\/[^/]+$/.test(p) ? p.slice(5) : null));

/** `runs/{runId}/{sub}/{docId}` keyed `${runId}/${sub}/${docId}`, for the given subcollections (or all except `exclude`). */
export const runSubView = (db: FakeTransactionalFirestore, subs: { include?: string[]; exclude?: string[] }) =>
  storeView(
    db,
    (k) => `runs/${k}`,
    (p) => {
      const m = /^runs\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(p);
      if (!m) return null;
      if (subs.include && !subs.include.includes(m[2])) return null;
      if (subs.exclude && subs.exclude.includes(m[2])) return null;
      return `${m[1]}/${m[2]}/${m[3]}`;
    }
  );

/** A top-level collection keyed either by the bare document id or by `${collection}/${id}`. */
export const topLevelView = (db: FakeTransactionalFirestore, collection: string, keyIncludesCollection: boolean) =>
  storeView(
    db,
    (k) => (keyIncludesCollection ? k : `${collection}/${k}`),
    (p) => {
      const m = new RegExp(`^${collection}/([^/]+)$`).exec(p);
      if (!m) return null;
      return keyIncludesCollection ? p : m[1];
    }
  );
