/**
 * Minimal Firestore port used by the API platform store. It is a structural subset of the Admin SDK
 * (`Firestore.doc`, `runTransaction`, `Transaction.get/create/update`), so production passes the real
 * Admin Firestore and tests pass a fake with the same transaction rules (all reads before writes;
 * `create` fails when the document exists).
 */
export interface DocSnapshotLike {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface DocRefLike {
  readonly path: string;
  get(): Promise<DocSnapshotLike>;
}

export interface TransactionLike {
  get(ref: DocRefLike): Promise<DocSnapshotLike>;
  create(ref: DocRefLike, data: Record<string, unknown>): TransactionLike;
  update(ref: DocRefLike, data: Record<string, unknown>): TransactionLike;
}

export interface FirestoreLike {
  doc(path: string): DocRefLike;
  runTransaction<T>(fn: (tx: TransactionLike) => Promise<T>): Promise<T>;
}
