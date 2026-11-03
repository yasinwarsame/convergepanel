/**
 * Research deletion integrity (2026-11-03, review M-1): installs the deletion-tombstone collection
 * (`runDeletionJobs/{runId}`) on a spec's own hand-written Firestore double.
 *
 * Every review, panel, vote, assignment, decision, resubmission, assignee and project-association transaction now also
 * reads `runDeletionJobs/{runId}` (`isResearchDeletedInTx`). Many older specs have doubles that route reads by id alone
 * or by a fixed set of collections. In those, that read either throws (unknown collection), giving
 * `transaction_failed`, or returns the RUN document, so the tombstone looks present. This helper gives the double what
 * real Firestore has: a `runDeletionJobs` collection that is empty unless the spec seeds it.
 *   - `db.collection("runDeletionJobs").doc(id)` returns a reference the double's own routing never sees.
 *   - The transaction's `get` serves that reference from the tombstone map. Every other read goes to the spec's own
 *     transaction unchanged, so its conflict, retry and ordering model is untouched.
 *   - A spec can seed a tombstone (`tombstones.set(runId, {...})`) to prove refusal. The barrier is NOT mocked away:
 *     production code reads this collection exactly as it reads Firestore.
 *   - Only reads are supported. No production writer under these specs writes a tombstone, so a write to one throws.
 *
 * Install it once, after the spec's own patches to `collection` / `runTransaction`. `runTransaction` stays a jest mock
 * function, so `mockClear()` and call assertions keep working.
 */
import { RESEARCH_DELETION_TOMBSTONE_COLLECTION } from "@/lib/firestore/researchDeletionBarrier";

type AnyDb = { collection: (...a: any[]) => any; runTransaction: (...a: any[]) => any };

export function installDeletionTombstoneCollection(db: AnyDb): Map<string, Record<string, unknown>> {
  const tombstones = new Map<string, Record<string, unknown>>();
  const snapshot = (id: string) => {
    const data = tombstones.get(id);
    return { exists: data !== undefined, id, data: () => (data === undefined ? undefined : { ...data }) };
  };
  const tombstoneRef = (id: string) => ({
    __deletionTombstoneOf: id,
    id,
    get: async () => snapshot(id),
    set: () => {
      throw new Error("a deletion tombstone is never written by the code under this spec");
    },
  });
  const isTombstoneRef = (ref: unknown): ref is { __deletionTombstoneOf: string } =>
    typeof ref === "object" && ref !== null && typeof (ref as { __deletionTombstoneOf?: unknown }).__deletionTombstoneOf === "string";

  const originalCollection = db.collection;
  db.collection = (name: string, ...rest: unknown[]) =>
    name === RESEARCH_DELETION_TOMBSTONE_COLLECTION ? { doc: (id: string) => tombstoneRef(id) } : originalCollection.call(db, name, ...rest);

  const originalRunTransaction = db.runTransaction;
  db.runTransaction = jest.fn((fn: (txn: any) => unknown, ...rest: unknown[]) =>
    originalRunTransaction.call(
      db,
      (txn: any) =>
        fn(
          new Proxy(txn, {
            get(target, prop) {
              if (prop === "get") {
                return (ref: unknown, ...a: unknown[]) => (isTombstoneRef(ref) ? Promise.resolve(snapshot(ref.__deletionTombstoneOf)) : target.get(ref, ...a));
              }
              const v = Reflect.get(target, prop);
              return typeof v === "function" ? v.bind(target) : v;
            },
          })
        ),
      ...rest
    )
  );
  return tombstones;
}
