/**
 * Owner Order A / S1 (2026-11-03) — the durable, idempotent RESEARCH DELETION workflow used by every supported path that
 * deletes research: DELETE /api/admin/runs/{runId} (collection "runs") and POST /api/admin/purge-runs.
 *
 * Why it exists: before S1, deleting a run removed only `runs/{R}` and left every subcollection behind (review
 * assignments and panels, governance events, export records with frozen report snapshots, and the report-review cycles,
 * events and reviewed-content snapshots). A reviewed-content snapshot must never become an undeletable second copy of
 * customer research, so deletion now covers the run's whole subtree and the research text copied outside it.
 *
 * DELETION CONTRACT (one run):
 *   1. Job record `runDeletionJobs/{runId}` (state, attempts, step, timestamps): written first, so an interrupted deletion
 *      is visible and resumable. Re-running is always safe: every step is idempotent.
 *   2. Mark `runs/{R}.deletion` in a transaction. From then on every report-review mutation and read refuses the run
 *      (`run_not_found`), so a concurrent submission/decision/assignment either committed BEFORE the mark (and its
 *      documents are deleted below) or is refused. The marker is excluded from the content fingerprint.
 *   3. Delete the run's ENTIRE subtree, recursively, discovered with listCollections() (never a hard-coded list that could
 *      miss a collection): report-review snapshots, cycles and events; export records; review assignment, history and
 *      panels; governance events; anything else.
 *   4. Out-of-tree copies keyed by runId:
 *        - `workspaceMembershipEvents` (Workspace Audit Log): KEPT as audit metadata (who, what, when, cycle, status), with
 *          the research text (`runQuestion`) redacted to null and `contentRedacted: true`;
 *        - `admin_audit_logs`: KEPT, with `question` redacted and `contentRedacted: true`;
 *        - `teamRuns` projections (legacy Team listing; they carry the receipt conclusion): DELETED (a derived index).
 *   5. Delete `runs/{R}`.
 *   6. VERIFY: the run document is gone, the subtree is empty, and no copy above still carries research text. Only then is
 *      the job marked `complete` and success reported. Any failure leaves the job `failed` (with the step) and the caller
 *      reports the deletion as INCOMPLETE — never as done.
 * Not covered (outside the application's control; see docs/workspaces/report-review-content-integrity.md §6): Firestore
 * managed backups / point-in-time recovery, which expire by their own retention; logs, which never contain research text.
 */
import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";

import { RESEARCH_DELETION_TOMBSTONE_COLLECTION } from "@/lib/firestore/researchDeletionBarrier";

/**
 * The job record doubles as the PERMANENT deletion tombstone (researchDeletionBarrier.ts): it is written first and never
 * deleted, and every research writer refuses a run that has one.
 */
export const RUN_DELETION_JOBS_COLLECTION = RESEARCH_DELETION_TOMBSTONE_COLLECTION;
export const REDACTED_ADMIN_AUDIT_QUESTION = "[deleted research]";
const PAGE = 300;

export type ResearchDeletionStep = "job" | "mark" | "subtree" | "workspace_audit" | "admin_audit" | "team_projection" | "run" | "verify";

/**
 * A deletion that needs (re-)running by runId even though the run document is already gone: an unfinished job, OR a
 * completed job whose verification no longer holds (content recreated afterwards by a writer outside report review).
 */
export async function getUnfinishedResearchDeletion(runId: string): Promise<boolean> {
  const db = adminDb;
  if (!db) return false;
  const job = await db.collection(RUN_DELETION_JOBS_COLLECTION).doc(runId).get();
  if (!job.exists) return false;
  if ((job.data() as Record<string, unknown>).state !== "complete") return true;
  return (await verifyDeleted(db, db.collection("runs").doc(runId), runId)) !== null;
}

/** Unfinished deletion jobs (bounded), for purge to resume. */
export async function listUnfinishedResearchDeletions(limit = 100): Promise<string[]> {
  const db = adminDb;
  if (!db) return [];
  const snap = await db.collection(RUN_DELETION_JOBS_COLLECTION).where("state", "in", ["in_progress", "failed"]).limit(limit).get();
  return snap.docs.map((d) => d.id).sort();
}
export type ResearchDeletionResult =
  | { status: "deleted"; runId: string; attempts: number }
  | { status: "incomplete"; runId: string; step: ResearchDeletionStep; error: string }
  | { status: "unavailable"; runId: string };

type Db = NonNullable<typeof adminDb>;
type DocRef = FirebaseFirestore.DocumentReference;

/**
 * Deletes every document under `ref` (all subcollections, recursively). Uses listDocuments(), which — unlike a query —
 * also returns "missing" documents: ancestors that hold no data but have subcollections of their own, whose content a
 * query would never reach. Bounded by the subtree's size; idempotent.
 */
async function deleteSubtree(ref: DocRef): Promise<void> {
  for (const col of await ref.listCollections()) {
    const docs = await col.listDocuments();
    for (let i = 0; i < docs.length; i += PAGE) {
      for (const d of docs.slice(i, i + PAGE)) {
        await deleteSubtree(d);
        await d.delete();
      }
    }
  }
}

async function subtreeIsEmpty(ref: DocRef): Promise<boolean> {
  return (await ref.listCollections()).length === 0;
}

async function redactWorkspaceAudit(db: Db, runId: string): Promise<number> {
  const snap = await db.collection("workspaceMembershipEvents").where("runId", "==", runId).get();
  let n = 0;
  for (const d of snap.docs) {
    const row = d.data() as Record<string, unknown>;
    if (row.runQuestion === null && row.contentRedacted === true) continue;
    await d.ref.update({ runQuestion: null, contentRedacted: true });
    n++;
  }
  return n;
}

/**
 * Free-text fields an admin audit row may carry about the research (review S1-M-2): the question, a reviewer's or an
 * administrator's comment, governance reasons, justification text and notes. All are redacted; the row's metadata (action,
 * actor, time, statuses, counts) is kept as evidence.
 */
export const ADMIN_AUDIT_FREE_TEXT_FIELDS = ["question", "comment", "reasons", "justification", "overrideJustification", "note", "notes"] as const;
const isRedacted = (row: Record<string, unknown>) => row.contentRedacted === true && ADMIN_AUDIT_FREE_TEXT_FIELDS.every((f) => row[f] === undefined || row[f] === REDACTED_ADMIN_AUDIT_QUESTION);

async function redactAdminAudit(db: Db, runId: string): Promise<number> {
  const snap = await db.collection("admin_audit_logs").where("runId", "==", runId).get();
  let n = 0;
  for (const d of snap.docs) {
    const row = d.data() as Record<string, unknown>;
    if (isRedacted(row)) continue;
    const patch: Record<string, unknown> = { contentRedacted: true };
    for (const f of ADMIN_AUDIT_FREE_TEXT_FIELDS) if (row[f] !== undefined) patch[f] = REDACTED_ADMIN_AUDIT_QUESTION;
    await d.ref.update(patch);
    n++;
  }
  return n;
}

/** Team snapshot locks naming this run (review S1-m-2): metadata only, but a stale lock blocks re-adding the source. */
async function deleteSnapshotLocks(db: Db, runId: string): Promise<number> {
  const snap = await db.collection("runSnapshotLocks").where("snapshotRunId", "==", runId).get();
  for (const d of snap.docs) await d.ref.delete();
  return snap.size;
}

async function deleteTeamProjections(db: Db, runId: string): Promise<number> {
  const snap = await db.collection("teamRuns").where("runId", "==", runId).get();
  for (const d of snap.docs) await d.ref.delete();
  return snap.size;
}

/** Nothing derived from the run still carries research text. `runDocMayExist` for the pre-check before the run is deleted. */
async function verifyDeleted(db: Db, runRef: DocRef, runId: string, runDocMayExist = false): Promise<string | null> {
  if (!runDocMayExist && (await runRef.get()).exists) return "run document still exists";
  if (!(await subtreeIsEmpty(runRef))) return "run subtree not empty";
  const wme = await db.collection("workspaceMembershipEvents").where("runId", "==", runId).get();
  if (wme.docs.some((d) => (d.data() as Record<string, unknown>).runQuestion != null)) return "workspace audit row still carries research text";
  const aal = await db.collection("admin_audit_logs").where("runId", "==", runId).get();
  if (aal.docs.some((d) => !isRedacted(d.data() as Record<string, unknown>))) return "admin audit row not redacted";
  if (!(await db.collection("teamRuns").where("runId", "==", runId).get()).empty) return "team projection still exists";
  if (!(await db.collection("runSnapshotLocks").where("snapshotRunId", "==", runId).get()).empty) return "snapshot lock still exists";
  return null;
}

export async function deleteResearchRun(args: { runId: string; actorUid: string; reason: "admin_delete" | "admin_purge"; now?: () => string }): Promise<ResearchDeletionResult> {
  const db = adminDb;
  if (!db) return { status: "unavailable", runId: args.runId };
  const now = args.now ?? (() => new Date().toISOString());
  const runRef = db.collection("runs").doc(args.runId);
  const jobRef = db.collection(RUN_DELETION_JOBS_COLLECTION).doc(args.runId);
  let step: ResearchDeletionStep = "job";
  try {
    const prior = await jobRef.get();
    const attempts = (typeof prior.data()?.attempts === "number" ? (prior.data()!.attempts as number) : 0) + 1;
    await jobRef.set({ runId: args.runId, state: "in_progress", step, reason: args.reason, requestedByUserId: args.actorUid, updatedAt: now(), attempts, ...(prior.exists ? {} : { startedAt: now() }) }, { merge: true });

    step = "mark";
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(runRef);
      if (!snap.exists) return; // already deleted (a retry), or never existed: continue cleaning up anything left behind
      const data = snap.data() as Record<string, unknown>;
      if (data.deletion === undefined || data.deletion === null) tx.update(runRef, { deletion: { state: "pending", requestedAt: now(), requestedByUserId: args.actorUid } });
    });

    step = "subtree";
    await jobRef.set({ step, updatedAt: now() }, { merge: true });
    await deleteSubtree(runRef);

    step = "workspace_audit";
    await redactWorkspaceAudit(db, args.runId);
    step = "admin_audit";
    await redactAdminAudit(db, args.runId);
    step = "team_projection";
    await deleteTeamProjections(db, args.runId);
    await deleteSnapshotLocks(db, args.runId);

    // Review S1-M-1: everything except the run document is verified BEFORE the run document goes, so a failure here
    // leaves the run (still marked) for an ordinary retry through any deletion path.
    step = "verify";
    const pre = await verifyDeleted(db, runRef, args.runId, true);
    if (pre) throw new Error(pre);

    step = "run";
    await runRef.delete();
    // Sweep again after the run document is gone, then verify the final state. If this last check fails the job stays
    // `failed` and the run can be resumed by runId (DELETE /api/admin/runs/{id} and purge both resume unfinished jobs).
    await deleteSubtree(runRef);
    await redactWorkspaceAudit(db, args.runId);
    await redactAdminAudit(db, args.runId);

    step = "verify";
    const problem = await verifyDeleted(db, runRef, args.runId);
    if (problem) throw new Error(problem);

    await jobRef.set({ state: "complete", step: "verify", completedAt: now(), updatedAt: now() }, { merge: true });
    return { status: "deleted", runId: args.runId, attempts };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("[firestore/researchDeletion] research deletion INCOMPLETE — retry the deletion; nothing is reported as deleted", { runId: args.runId, step, error });
    try {
      await jobRef.set({ state: "failed", step, lastError: error.slice(0, 300), updatedAt: now() }, { merge: true });
    } catch {
      // The job record could not be updated either; the caller still reports the deletion as incomplete.
    }
    return { status: "incomplete", runId: args.runId, step, error };
  }
}

/**
 * Orphan detection (operations): report-review and export documents whose run no longer exists, and deletion jobs that
 * never completed. Bounded. Either finding means a deletion must be re-run for that runId (deleteResearchRun is idempotent
 * and also cleans up after an already-deleted run document).
 */
export async function findResearchDeletionOrphans(limitPerSource = 200): Promise<{ orphanRunIds: string[]; unfinishedJobs: string[] }> {
  const db = adminDb;
  if (!db) return { orphanRunIds: [], unfinishedJobs: [] };
  const orphan = new Set<string>();
  for (const group of ["reportReviewSnapshots", "reportReviewCycles", "reportReviewEvents", "exports"]) {
    const snap = await db.collectionGroup(group).limit(limitPerSource).get();
    for (const d of snap.docs) {
      const run = d.ref.parent.parent;
      if (!run || run.parent.id !== "runs") continue;
      if (!(await run.get()).exists) orphan.add(run.id);
    }
  }
  const jobs = await db.collection(RUN_DELETION_JOBS_COLLECTION).where("state", "in", ["in_progress", "failed"]).limit(limitPerSource).get();
  // Review S1-B-1 (detection): content recreated AFTER a completed deletion by a writer outside report review — the run
  // document, its subtree, OR research text in an audit row / projection / lock — fails the same full verification the
  // deletion used. Newest completed jobs first (single-field order; no composite index), bounded.
  const done = await db.collection(RUN_DELETION_JOBS_COLLECTION).orderBy("completedAt", "desc").limit(limitPerSource).get();
  for (const j of done.docs) {
    if ((j.data() as Record<string, unknown>).state !== "complete") continue;
    if ((await verifyDeleted(db, db.collection("runs").doc(j.id), j.id)) !== null) orphan.add(j.id);
  }
  return { orphanRunIds: Array.from(orphan).sort(), unfinishedJobs: jobs.docs.map((d) => d.id).sort() };
}
