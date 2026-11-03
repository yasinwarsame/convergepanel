/**
 * Owner decision 2026-11-03 (research deletion integrity): the AUTHORITATIVE deletion barrier.
 *
 * INVARIANT: once a deletion of run R has been requested, no application writer may create or modify R's research
 * content or anything derived from it. That covers the run document, any document in its subtree, export records,
 * governance and review records, Team projections, and audit rows carrying research text.
 *
 * THE TOMBSTONE is `runDeletionJobs/{runId}`, the deletion job record. `deleteResearchRun` writes it as its FIRST step,
 * before the run is marked, swept or deleted.
 * - It is never deleted and never expires.
 * - It is keyed by the run id, so it survives deletion of `runs/{R}` and also blocks any later reuse of the id.
 * - Its EXISTENCE is the barrier. Its state (in_progress / failed / complete) does not matter.
 * - Clients cannot read or write it (firestore.rules default deny). No server path deletes it.
 *
 * ENFORCEMENT: a writer calls `assertResearchWritable(tx, db, runId)` INSIDE the same Firestore transaction as its write,
 * before the write. That call reads the tombstone and the run document, and refuses when any of these hold:
 *   - the tombstone exists ("deleted");
 *   - the run document carries the deletion mark ("deleting");
 *   - the run document does not exist ("missing"). This also covers runs deleted before the tombstone existed, and no
 *     guarded writer creates a run.
 *
 * WHY IT IS RACE-FREE: Firestore transactions are serializable. Both reads are in the transaction's read set, so the
 * transaction commits only if neither document changed before commit. For any guarded writer W and deletion D of the
 * same run, exactly one of these holds:
 *   - W committed BEFORE D created the tombstone. W's documents then already exist when D sweeps the run's subtree and
 *     its run-keyed copies, all of which happens after the tombstone, so D deletes or redacts them.
 *   - W runs after the tombstone exists and refuses (`ResearchWriteRefusedError`), writing nothing.
 * A writer that started before deletion (for example, a long model call) and commits afterwards is the second case,
 * because the check runs in the commit transaction, not in a preliminary read. Retries and delayed work re-run the same
 * transaction and fail closed in the same way.
 */
import "server-only";

export const RESEARCH_DELETION_TOMBSTONE_COLLECTION = "runDeletionJobs";

export type ResearchWriteRefusal = "deleted" | "deleting" | "missing";

export class ResearchWriteRefusedError extends Error {
  readonly code = "research_write_refused" as const;
  constructor(
    readonly runId: string,
    readonly refusal: ResearchWriteRefusal
  ) {
    super(`research write refused (${refusal})`);
    this.name = "ResearchWriteRefusedError";
  }
}

export function isResearchWriteRefusedError(err: unknown): err is ResearchWriteRefusedError {
  return err instanceof ResearchWriteRefusedError || (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "research_write_refused");
}

type Tx = FirebaseFirestore.Transaction;
type Db = FirebaseFirestore.Firestore;

export function researchDeletionTombstoneRef(db: Db, runId: string): FirebaseFirestore.DocumentReference {
  return db.collection(RESEARCH_DELETION_TOMBSTONE_COLLECTION).doc(runId);
}

/**
 * Reads the tombstone and `runs/{runId}` inside `tx`. Throws `ResearchWriteRefusedError` unless the run exists, is not
 * marked for deletion and has no tombstone. Returns the run snapshot so callers need not read it again. Call it before
 * the transaction's writes, because Firestore requires all reads first.
 */
export async function assertResearchWritable(tx: Tx, db: Db, runId: string): Promise<FirebaseFirestore.DocumentSnapshot> {
  if (typeof runId !== "string" || runId.length === 0 || runId.includes("/")) throw new ResearchWriteRefusedError(String(runId), "missing");
  const [tombstone, run] = await Promise.all([tx.get(researchDeletionTombstoneRef(db, runId)), tx.get(db.collection("runs").doc(runId))]);
  if (tombstone.exists) throw new ResearchWriteRefusedError(runId, "deleted");
  if (!run.exists) throw new ResearchWriteRefusedError(runId, "missing");
  const deletion = (run.data() as Record<string, unknown> | undefined)?.deletion;
  if (deletion !== undefined && deletion !== null) throw new ResearchWriteRefusedError(runId, "deleting");
  return run;
}

/**
 * Runs `body` in a transaction that first calls `assertResearchWritable`. Use it for a writer that was a plain,
 * non-transactional write: the write moves into `body` unchanged (`tx.set` / `tx.update` / `tx.create` in place of
 * `ref.set` / `ref.update` / `col.add`).
 */
/**
 * For a transaction that ALREADY reads `runs/{runId}` itself and handles a missing run with its own result (the
 * review, panel, vote, assignment, decision, resubmission, assignee and project-association writers). It reads the
 * tombstone in `tx` and checks the run snapshot the caller read for the deletion mark. It returns true when the run must
 * be treated as gone, so the caller returns its existing not-found result, after its own authorization checks, with
 * concealment order unchanged. Call it in the transaction's read phase, before any write.
 */
export async function isResearchDeletedInTx(tx: Tx, db: Db, runId: string, runSnap: { exists: boolean; data(): unknown }): Promise<boolean> {
  if (runSnap.exists) {
    const deletion = (runSnap.data() as Record<string, unknown> | undefined)?.deletion;
    if (deletion !== undefined && deletion !== null) return true;
  }
  return (await tx.get(researchDeletionTombstoneRef(db, runId))).exists;
}

/** Guarded `ref.set(data, { merge: true })`. */
export async function guardedResearchSetMerge(db: Db, runId: string, ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData): Promise<void> {
  await runResearchWrite(db, runId, (tx) => {
    tx.set(ref, data, { merge: true });
  });
}

/** Guarded `collection.add(data)`: a fresh auto-id document, created in the guarded transaction. */
export async function guardedResearchAdd(db: Db, runId: string, collection: FirebaseFirestore.CollectionReference, data: FirebaseFirestore.DocumentData): Promise<FirebaseFirestore.DocumentReference> {
  const ref = collection.doc();
  await runResearchWrite(db, runId, (tx) => {
    tx.create(ref, data);
  });
  return ref;
}

/**
 * Guarded `ref.create(data)`. Returns "already_exists" where `create()` would have thrown ALREADY_EXISTS; the existence
 * read is inside the transaction, so this is as exclusive as `create()` itself.
 */
export async function guardedResearchCreate(db: Db, runId: string, ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData): Promise<"created" | "already_exists"> {
  return runResearchWrite(db, runId, async (tx) => {
    if ((await tx.get(ref)).exists) return "already_exists" as const;
    tx.create(ref, data);
    return "created" as const;
  });
}

export async function runResearchWrite<T>(db: Db, runId: string, body: (tx: Tx, run: FirebaseFirestore.DocumentSnapshot) => Promise<T> | T): Promise<T> {
  return db.runTransaction(async (tx) => {
    const run = await assertResearchWritable(tx, db, runId);
    return body(tx, run);
  });
}
