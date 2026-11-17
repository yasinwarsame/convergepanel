/**
 * In-memory FirestoreLike with the transaction rules that matter for the store's correctness:
 * - all reads must happen before any write (Firestore throws otherwise);
 * - `create` fails when the document exists (at commit time, against committed state + this tx's writes);
 * - writes are staged and applied atomically at commit; a throwing callback commits nothing;
 * - `update` fails when the document does not exist.
 * `failOn` lets a test force a commit failure for a given path prefix (atomicity proof).
 */
import type { DocRefLike, DocSnapshotLike, FirestoreLike, TransactionLike } from "@/lib/apiPlatform/firestorePort";

type Data = Record<string, unknown>;

export class FakeFirestore implements FirestoreLike {
  readonly docs = new Map<string, Data>();
  failOn: string | null = null;
  reads = 0;

  doc(path: string): DocRefLike {
    if (typeof path !== "string" || path.split("/").length % 2 !== 0) throw new Error(`bad doc path ${path}`);
    return {
      path,
      get: async () => {
        this.reads++;
        return this.snap(path);
      },
    };
  }

  private snap(path: string): DocSnapshotLike {
    const d = this.docs.get(path);
    return { exists: d !== undefined, data: () => (d === undefined ? undefined : structuredClone(d)) };
  }

  async runTransaction<T>(fn: (tx: TransactionLike) => Promise<T>): Promise<T> {
    const writes: { kind: "create" | "update"; path: string; data: Data }[] = [];
    let wrote = false;
    const tx: TransactionLike = {
      get: async (ref) => {
        if (wrote) throw new Error("Firestore transactions require all reads to be executed before all writes.");
        this.reads++;
        return this.snap(ref.path);
      },
      create: (ref, data) => {
        wrote = true;
        writes.push({ kind: "create", path: ref.path, data: structuredClone(data) });
        return tx;
      },
      update: (ref, data) => {
        wrote = true;
        writes.push({ kind: "update", path: ref.path, data: structuredClone(data) });
        return tx;
      },
    };
    const result = await fn(tx);
    const next = new Map(this.docs);
    for (const w of writes) {
      if (this.failOn && w.path.startsWith(this.failOn)) throw new Error(`injected commit failure on ${w.path}`);
      if (w.kind === "create") {
        if (next.has(w.path)) throw new Error(`ALREADY_EXISTS: ${w.path}`);
        next.set(w.path, w.data);
      } else {
        const cur = next.get(w.path);
        if (!cur) throw new Error(`NOT_FOUND: ${w.path}`);
        next.set(w.path, { ...cur, ...w.data });
      }
    }
    this.docs.clear();
    for (const [k, v] of next) this.docs.set(k, v);
    return result;
  }

  get(path: string): Data | undefined {
    return this.docs.get(path);
  }

  byPrefix(prefix: string): [string, Data][] {
    return [...this.docs.entries()].filter(([k]) => k.startsWith(prefix));
  }
}
