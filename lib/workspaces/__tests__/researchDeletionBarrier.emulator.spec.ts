/**
 * Owner decision 2026-11-03 (research deletion integrity): the deletion barrier on the REAL Firestore emulator, using
 * the real firebase-admin transaction semantics. Covers:
 *   - writers racing a deletion;
 *   - delayed writers that hold their transaction open across the deletion;
 *   - post-deletion retries;
 *   - tombstone persistence and id reuse;
 *   - a run in another workspace being unaffected.
 * Skipped unless FIRESTORE_EMULATOR_HOST is set:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8187 GCLOUD_PROJECT=demo-bar npx jest --runTestsByPath <file>
 */
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-bar";

jest.mock("@/lib/firebase/admin", () => {
  const { initializeApp, getApps } = jest.requireActual("firebase-admin/app");
  const { getFirestore } = jest.requireActual("firebase-admin/firestore");
  const app = getApps().find((a: { name: string }) => a.name === "bar-emulator") ?? initializeApp({ projectId: "demo-bar" }, "bar-emulator");
  const mockDb = getFirestore(app);
  return {
    get adminDb() {
      return mockDb;
    },
  };
});
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: async () => ({ planId: "pro" }) }));
jest.mock("@/lib/governance/governancePolicyStore", () => ({ loadGovernancePolicy: async () => ({ policyVersion: 7 }) }));
jest.mock("@/lib/governance/evaluateGovernance", () => ({
  evaluateGovernance: () => ({ status: "needs_review", reasons: ["r"], meta: { scoreFamily: "f", scoreThresholdsInEffect: {} } }),
}));

import { adminDb } from "@/lib/firebase/admin";
import { persistAdaptiveOutput, writeAdaptiveGovernanceEvent, createAdaptiveHumanReviewHistory, createAdaptiveHumanReviewAssignmentHistory } from "@/lib/firestore/runs";
import { createAdaptiveExportRecord, markAdaptiveExportReady } from "@/lib/firestore/adaptiveExports";
import { evaluateAndStoreGovernance } from "@/lib/governance/evaluateAndStore";
import { createAdaptiveTeamRunProjection } from "@/lib/firestore/teamRuns";
import { deleteResearchRun, findResearchDeletionOrphans } from "@/lib/firestore/researchDeletion";
import { RESEARCH_DELETION_TOMBSTONE_COLLECTION, runResearchWrite, isResearchWriteRefusedError } from "@/lib/firestore/researchDeletionBarrier";

const maybe = EMULATOR ? describe : describe.skip;
const db = adminDb!;
const SECRET = "SECRET research text";

async function clear() {
  await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
}
async function seedRun(id: string, workspaceId = "wsA") {
  await db.collection("runs").doc(id).set({ userId: "u1", userEmail: "u1@x.test", workspaceId, question: SECRET, status: "complete" });
}
/** Everything that still carries this run's content: run doc, subtree, run-keyed rows. */
async function leftovers(id: string): Promise<string[]> {
  const out: string[] = [];
  const run = db.collection("runs").doc(id);
  if ((await run.get()).exists) out.push("run");
  for (const c of await run.listCollections()) out.push(`sub:${c.id}`);
  for (const col of ["teamRuns", "workspaceMembershipEvents"]) if (!(await db.collection(col).where("runId", "==", id).get()).empty) out.push(col);
  const aal = await db.collection("admin_audit_logs").where("runId", "==", id).get();
  if (aal.docs.some((d) => d.data().contentRedacted !== true)) out.push("admin_audit_logs(unredacted)");
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function deleteUntilDone(id: string) {
  for (let i = 0; i < 3; i++) {
    const r = await deleteResearchRun({ runId: id, actorUid: "sys", reason: "admin_delete" });
    if (r.status === "deleted") return r;
  }
  throw new Error(`deletion of ${id} did not complete`);
}

type Racer = { name: string; run: (id: string) => Promise<unknown> };
const RACERS: Racer[] = [
  { name: "persistAdaptiveOutput", run: (id) => persistAdaptiveOutput(id, { version: 1, results: [SECRET] } as never) },
  { name: "writeAdaptiveGovernanceEvent", run: (id) => writeAdaptiveGovernanceEvent(id, { status: "needs_review", reasons: [SECRET], policyVersion: 1 } as never, "t") },
  { name: "createAdaptiveHumanReviewHistory", run: (id) => createAdaptiveHumanReviewHistory(id, { decisionId: "d1", comment: SECRET } as never) },
  // A stale reviewer-assignment operation: its post-commit history write lands while (or after) the run is deleted.
  { name: "createAdaptiveHumanReviewAssignmentHistory (stale assignment)", run: (id) => createAdaptiveHumanReviewAssignmentHistory(id, { eventId: "a1", newReviewerUserId: "u2" } as never) },
  { name: "createAdaptiveExportRecord (Order 6 exception)", run: (id) => createAdaptiveExportRecord({ runId: id, exportId: "exp-1", record: { exportMetadata: { exportId: "exp-1" }, artifactStatus: "generating", reportSnapshot: { body: SECRET } } as never }) },
  { name: "evaluateAndStoreGovernance", run: (id) => evaluateAndStoreGovernance({ runId: id, collection: "runs", input: { question: SECRET, consensusScore: 40, runType: "research" } as never, ownerUid: "u1" }) },
  { name: "createAdaptiveTeamRunProjection", run: (id) => createAdaptiveTeamRunProjection({ teamId: "team1", runId: id, conclusion: SECRET } as never) },
];

maybe("REAL Firestore: research deletion barrier", () => {
  beforeEach(async () => {
    await clear();
  }, 60_000);

  for (const racer of RACERS) {
    it(`${racer.name} racing a deletion (8 rounds): content is either deleted or never written; nothing resurrects`, async () => {
      for (let i = 0; i < 8; i++) {
        const id = `race-${i}`;
        await seedRun(id);
        // Stagger the writer slightly across rounds so both orders occur.
        const [, del] = await Promise.all([sleep(i % 4).then(() => racer.run(id)), sleep((i + 2) % 4).then(() => deleteResearchRun({ runId: id, actorUid: "sys", reason: "admin_delete" }))]);
        if (del.status !== "deleted") await deleteUntilDone(id);
        expect(await leftovers(id)).toEqual([]);
        // A late retry of the same writer after completion is refused.
        await racer.run(id);
        expect(await leftovers(id)).toEqual([]);
      }
      expect((await findResearchDeletionOrphans()).orphanRunIds).toEqual([]);
    }, 180_000);
  }

  it("a delayed writer that read before the deletion and commits after it never resurrects content", async () => {
    for (let i = 0; i < 5; i++) {
      const id = `delay-${i}`;
      await seedRun(id);
      let attempts = 0;
      const writer = runResearchWrite(db, id, async (tx, run) => {
        attempts++;
        await sleep(300); // the deletion starts while this transaction holds its reads
        tx.create(run.ref.collection("exports").doc(`late-${attempts}`), { reportSnapshot: { body: SECRET } });
      }).then(
        () => "committed",
        (e) => (isResearchWriteRefusedError(e) ? "refused" : `error:${(e as Error).message}`)
      );
      await sleep(50);
      const del = deleteResearchRun({ runId: id, actorUid: "sys", reason: "admin_delete" });
      const [w, d] = await Promise.all([writer, del]);
      expect(["committed", "refused"]).toContain(w); // committed only if it serialized before the tombstone
      if (d.status !== "deleted") await deleteUntilDone(id);
      expect(await leftovers(id)).toEqual([]);
    }
  }, 180_000);

  it("delayed export completion after deletion: ready is refused and no stub is created", async () => {
    await seedRun("exp-run");
    expect(await createAdaptiveExportRecord({ runId: "exp-run", exportId: "exp-1", record: { exportMetadata: { exportId: "exp-1" }, artifactStatus: "generating", reportSnapshot: { body: SECRET } } as never })).toEqual({ ok: true, reportVersion: 1 });
    await deleteUntilDone("exp-run");
    expect(await markAdaptiveExportReady("exp-run", "exp-1", "hash")).toEqual({ ok: false, reason: "write_failed" });
    expect(await leftovers("exp-run")).toEqual([]);
  }, 60_000);

  it("the tombstone persists after the run document is gone, survives duplicate deletion requests, and blocks id reuse", async () => {
    await seedRun("tomb");
    await deleteUntilDone("tomb");
    expect(await deleteResearchRun({ runId: "tomb", actorUid: "sys", reason: "admin_delete" })).toMatchObject({ status: "deleted" }); // duplicate request
    const t = await db.collection(RESEARCH_DELETION_TOMBSTONE_COLLECTION).doc("tomb").get();
    expect(t.exists).toBe(true);
    expect(t.data()).toEqual(expect.objectContaining({ state: "complete" }));
    await seedRun("tomb"); // something recreates a run under the deleted id
    expect(await persistAdaptiveOutput("tomb", { version: 1 } as never)).toEqual({ saved: false, reason: "write_failed" });
    expect((await db.collection("runs").doc("tomb").get()).data()!.adaptiveOutput).toBeUndefined();
  }, 60_000);

  it("interrupted deletion (crash right after the tombstone) already blocks every writer; recovery completes the deletion", async () => {
    await seedRun("crash");
    // What a deletion that died after its first step leaves behind: the tombstone (job in_progress), no mark yet.
    await db.collection(RESEARCH_DELETION_TOMBSTONE_COLLECTION).doc("crash").set({ runId: "crash", state: "in_progress", step: "job" });
    for (const r of RACERS) await r.run("crash");
    const run = (await db.collection("runs").doc("crash").get()).data()!;
    expect(Object.keys(run).sort()).toEqual(["question", "status", "userEmail", "userId", "workspaceId"]); // nothing added
    expect((await db.collection("runs").doc("crash").listCollections()).map((c) => c.id)).toEqual([]);
    expect(await deleteResearchRun({ runId: "crash", actorUid: "sys", reason: "admin_delete" })).toMatchObject({ status: "deleted" }); // recovery
    expect(await leftovers("crash")).toEqual([]);
  }, 60_000);

  it("missing run document (no tombstone, e.g. deleted before tombstones existed): writers create nothing", async () => {
    for (const r of RACERS) await r.run("never-existed");
    expect(await leftovers("never-existed")).toEqual([]);
  }, 60_000);

  it("deleting a run in one workspace leaves a run in another workspace fully writable", async () => {
    await seedRun("runA", "wsA");
    await seedRun("runB", "wsB");
    await deleteUntilDone("runA");
    expect(await persistAdaptiveOutput("runB", { version: 1 } as never)).toEqual({ saved: true });
    expect(await createAdaptiveExportRecord({ runId: "runB", exportId: "exp-1", record: { exportMetadata: { exportId: "exp-1" }, artifactStatus: "generating", reportSnapshot: {} } as never })).toEqual({ ok: true, reportVersion: 1 });
    expect(await evaluateAndStoreGovernance({ runId: "runB", collection: "runs", input: { question: "q", consensusScore: 40, runType: "research" } as never, ownerUid: "u1" })).toEqual({ governanceStatus: "needs_review" });
    expect((await db.collection("runs").doc("runB").get()).data()).toEqual(expect.objectContaining({ adaptiveOutput: { version: 1 }, adaptiveExportCounter: 1, governanceStatus: "needs_review" }));
    expect(await leftovers("runA")).toEqual([]);
  }, 60_000);
});
