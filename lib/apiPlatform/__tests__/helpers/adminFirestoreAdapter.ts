/**
 * Adapts a real firebase-admin Firestore (emulator in tests) to the store's FirestoreLike port, without
 * lib/apiPlatform importing any Firebase module. Test-only until a management route exists (API-1b), when a
 * reviewed production adapter outside lib/apiPlatform will do the same.
 */
import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import type { DocRefLike, DocSnapshotLike, FirestoreLike, TransactionLike } from "@/lib/apiPlatform/firestorePort";

const refs = new WeakMap<DocRefLike, DocumentReference>();

export function adaptAdminFirestore(db: Firestore): FirestoreLike {
  const wrap = (ref: DocumentReference): DocRefLike => {
    const like: DocRefLike = {
      path: ref.path,
      get: async (): Promise<DocSnapshotLike> => {
        const s = await ref.get();
        return { exists: s.exists, data: () => s.data() };
      },
    };
    refs.set(like, ref);
    return like;
  };
  const real = (like: DocRefLike): DocumentReference => {
    const r = refs.get(like);
    if (!r) throw new Error("adaptAdminFirestore: foreign DocRefLike");
    return r;
  };
  return {
    doc: (p: string) => wrap(db.doc(p)),
    runTransaction: <T>(fn: (tx: TransactionLike) => Promise<T>) =>
      db.runTransaction(async (t) => {
        const tx: TransactionLike = {
          get: async (ref) => {
            const s = await t.get(real(ref));
            return { exists: s.exists, data: () => s.data() };
          },
          create: (ref, data) => (t.create(real(ref), data), tx),
          update: (ref, data) => (t.update(real(ref), data), tx),
        };
        return fn(tx);
      }),
  };
}
