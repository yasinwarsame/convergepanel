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

export const RUN_DELETION_JOBS_COLLECTION = "runDeletionJobs";
export const REDACTED_ADMIN_AUDIT_QUESTION = "[deleted research]";
const PAGE = 300;

export type ResearchDeletionStep = "job" | "mark" | "subtree" | "workspace_audit" | "admin_audit" | "team_projection" | "run" | "verify";
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

async function redactAdminAudit(db: Db, runId: string): Promise<number> {
  const snap = await db.collection("admin_audit_logs").where("runId", "==", runId).get();
  let n = 0;
  for (const d of snap.docs) {
    const row = d.data() as Record<string, unknown>;
    if (row.contentRedacted === true && (row.question === undefined || row.question === REDACTED_ADMIN_AUDIT_QUESTION)) continue;
    await d.ref.update({ ...(row.question !== undefined ? { question: REDACTED_ADMIN_AUDIT_QUESTION } : {}), contentRedacted: true });
    n++;
  }
  return n;
}

async function deleteTeamProjections(db: Db, runId: string): Promise<number> {
  const snap = await db.collection("teamRuns").where("runId", "==", runId).get();
  for (const d of snap.docs) await d.ref.delete();
  return snap.size;
}

/** Nothing derived from the run still carries research text. */
async function verifyDeleted(db: Db, runRef: DocRef, runId: string): Promise<string | null> {
  if ((await runRef.get()).exists) return "run document still exists";
  if (!(await subtreeIsEmpty(runRef))) return "run subtree not empty";
  const wme = await db.collection("workspaceMembershipEvents").where("runId", "==", runId).get();
  if (wme.docs.some((d) => (d.data() as Record<string, unknown>).runQuestion != null)) return "workspace audit row still carries research text";
  const aal = await db.collection("admin_audit_logs").where("runId", "==", runId).get();
  if (aal.docs.some((d) => (d.data() as Record<string, unknown>).contentRedacted !== true)) return "admin audit row not redacted";
  if (!(await db.collection("teamRuns").where("runId", "==", runId).get()).empty) return "team projection still exists";
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

    step = "run";
    await runRef.delete();
    // A write that committed before the mark but after the subtree pass cannot exist (the mark serialises them), but the
    // subtree is swept once more after the run document is gone, so the verification below is about the final state.
    await deleteSubtree(runRef);

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
  return { orphanRunIds: Array.from(orphan).sort(), unfinishedJobs: jobs.docs.map((d) => d.id).sort() };
}
