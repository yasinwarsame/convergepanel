/**
 * Owner Order A — REAL Firestore: a content write racing a decision can never let a decision commit on content other
 * than the content submitted. Skipped unless FIRESTORE_EMULATOR_HOST is set.
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8187 GCLOUD_PROJECT=demo-rra npx jest --runTestsByPath <this file>
 *
 * Each round races decideReportReview against a TRANSACTIONAL content write that also records whether, at the moment it
 * committed, the cycle was already decided. Real transactions serialize the two, so exactly one order happened:
 *   - content first  → the decision must have been refused (content_changed);
 *   - decision first → the content write saw a decided cycle.
 * Invariant checked every round: decision committed ⇒ the content write serialized after it.
 */
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-rra";

jest.mock("@/lib/firebase/admin", () => {
  const { initializeApp, getApps } = jest.requireActual("firebase-admin/app");
  const { getFirestore } = jest.requireActual("firebase-admin/firestore");
  const app = getApps().find((a: { name: string }) => a.name === "rra-emulator") ?? initializeApp({ projectId: "demo-rra" }, "rra-emulator");
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
import { seedDb, W, OWNER, REVIEWER, SUBMITTER, CREATOR } from "./helpers/reviewQueueScenario";

const maybe = EMULATOR ? describe : describe.skip;
const db = adminDb!;

async function clear() {
  await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
}

maybe("REAL Firestore: content changes cannot race a decision", () => {
  beforeAll(async () => {
    await clear();
    await seedDb(db as never, []);
  }, 60_000);

  it("20 rounds: a decision only ever commits when the content write serialized after it", async () => {
    let decidedFirst = 0;
    let contentFirst = 0;
    for (let i = 0; i < 20; i++) {
      const runId = `rra-${i}`;
      const ref = db.collection("runs").doc(runId);
      await ref.set({ userId: CREATOR, workspaceId: W, projectId: null, question: `Q${i}`, status: "complete", createdAt: Timestamp.fromMillis(Date.UTC(2026, 10, 2)), legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: { queryType: "generic" }, generatedAt: "x", results: [], alignedClaims: [] } });
      const sub = await submitReportReview({ uid: SUBMITTER, workspaceId: W, runId, purpose: { code: "internal_review" } });
      if (!sub.ok) throw new Error(`submit ${sub.reason}`);
      expect((await putWorkspaceReviewAssignment({ uid: OWNER, workspaceId: W, runId, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null })).ok).toBe(true);

      const contentWrite = db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const status = (snap.data()!.reportReview as { humanReview: { status: string } }).humanReview.status;
        tx.update(ref, { synthesizedStructuredReport: { summary: `regenerated ${i}` }, schemaVersion: 1 });
        return { sawDecided: status !== "unreviewed" && status !== "pending" };
      });
      const decision = decideReportReview({ uid: REVIEWER, workspaceId: W, runId, decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: sub.record.updatedAt });
      const [cw, d] = await Promise.all([contentWrite, decision]);

      if (d.ok) {
        expect(cw.sawDecided).toBe(true); // the decision committed on the submitted content; the change came after
        decidedFirst++;
      } else {
        expect(d).toEqual({ ok: false, reason: "content_changed" });
        expect(cw.sawDecided).toBe(false);
        const after = (await ref.get()).data()!.reportReview;
        expect(after.humanReview.status).toBe("unreviewed");
        expect(after.contentFingerprint).toEqual(sub.record.contentFingerprint); // never silently replaced
        contentFirst++;
      }
    }
    expect(decidedFirst + contentFirst).toBe(20);
  }, 120_000);
});
