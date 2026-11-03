/**
 * Owner Order A / S1 — REAL Firestore: the research-deletion workflow on the real firebase-admin SDK (listCollections,
 * nested recursion, runId queries for redaction) and a decision racing the deletion mark. Skipped unless
 * FIRESTORE_EMULATOR_HOST is set:  FIRESTORE_EMULATOR_HOST=127.0.0.1:8187 GCLOUD_PROJECT=demo-del npx jest --runTestsByPath <file>
 */
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-del";

jest.mock("@/lib/firebase/admin", () => {
  const { initializeApp, getApps } = jest.requireActual("firebase-admin/app");
  const { getFirestore } = jest.requireActual("firebase-admin/firestore");
  const app = getApps().find((a: { name: string }) => a.name === "del-emulator") ?? initializeApp({ projectId: "demo-del" }, "del-emulator");
  const mockDb = getFirestore(app);
  return {
    get adminDb() {
      return mockDb;
    },
  };
});
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({ REPORT_REVIEW_ENABLED: true }));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { submitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { putWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { deleteResearchRun, findResearchDeletionOrphans } from "@/lib/firestore/researchDeletion";
import { seedDb, W, OWNER, REVIEWER, SUBMITTER, CREATOR } from "./helpers/reviewQueueScenario";

const maybe = EMULATOR ? describe : describe.skip;
const db = adminDb!;

async function clear() {
  await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
}
async function seedReviewedRun(id: string) {
  await db.collection("runs").doc(id).set({ userId: CREATOR, workspaceId: W, projectId: null, question: "SECRET-Q", status: "complete", createdAt: Timestamp.fromMillis(Date.UTC(2026, 10, 2)), legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: { queryType: "generic" }, generatedAt: "x", results: [], alignedClaims: [] } });
  const sub = await submitReportReview({ uid: SUBMITTER, workspaceId: W, runId: id, purpose: { code: "other" } });
  if (!sub.ok) throw new Error(`submit ${sub.reason}`);
  await putWorkspaceReviewAssignment({ uid: OWNER, workspaceId: W, runId: id, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null });
  await db.collection("runs").doc(id).collection("exports").doc("e1").collection("parts").doc("p").set({ text: "SECRET-A" });
  await db.collection("admin_audit_logs").add({ runId: id, question: "SECRET-Q" });
  return sub.record;
}

maybe("REAL Firestore: research deletion", () => {
  beforeEach(async () => {
    await clear();
    await seedDb(db as never, []);
  }, 60_000);

  it("deletes the whole nested subtree, redacts kept audit rows, and verifies (real listCollections + queries)", async () => {
    await seedReviewedRun("rd1");
    expect((await db.collection("runs").doc("rd1").listCollections()).map((c) => c.id).sort()).toEqual(expect.arrayContaining(["exports", "reportReviewEvents", "reportReviewSnapshots"]));
    expect(await deleteResearchRun({ runId: "rd1", actorUid: "sys", reason: "admin_delete" })).toMatchObject({ status: "deleted" });
    expect((await db.collection("runs").doc("rd1").get()).exists).toBe(false);
    expect(await db.collection("runs").doc("rd1").listCollections()).toEqual([]);
    const wme = await db.collection("workspaceMembershipEvents").where("runId", "==", "rd1").get();
    expect(wme.size).toBeGreaterThan(0);
    expect(wme.docs.every((d) => d.data().runQuestion === null && d.data().contentRedacted === true)).toBe(true);
    const aal = await db.collection("admin_audit_logs").where("runId", "==", "rd1").get();
    expect(aal.docs.every((d) => d.data().question === "[deleted research]")).toBe(true);
    expect(await findResearchDeletionOrphans()).toEqual({ orphanRunIds: [], unfinishedJobs: [] });
  }, 60_000);

  it("10 rounds: a decision racing the deletion either committed before the mark (and is then deleted) or is refused; nothing is ever left behind", async () => {
    for (let i = 0; i < 10; i++) {
      const id = `race${i}`;
      const rec = await seedReviewedRun(id);
      const [d, del] = await Promise.all([
        decideReportReview({ uid: REVIEWER, workspaceId: W, runId: id, decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: rec.updatedAt }),
        deleteResearchRun({ runId: id, actorUid: "sys", reason: "admin_delete" }),
      ]);
      if (!d.ok) expect(d.reason).toBe("run_not_found");
      // A deletion that raced a committed decision may need one retry (a document created during the sweep is caught by
      // verification and reported incomplete — never a false success).
      const final = del.status === "deleted" ? del : await deleteResearchRun({ runId: id, actorUid: "sys", reason: "admin_delete" });
      expect(final.status).toBe("deleted");
      expect((await db.collection("runs").doc(id).get()).exists).toBe(false);
      expect(await db.collection("runs").doc(id).listCollections()).toEqual([]);
    }
    expect((await findResearchDeletionOrphans()).orphanRunIds).toEqual([]);
  }, 180_000);
});
