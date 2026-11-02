/**
 * Order B, Stage B2 — REAL Firestore semantics (owner requirement): the combined-queue scenarios and transaction
 * contention, run against the Firestore emulator through the real firebase-admin SDK. Skipped unless
 * FIRESTORE_EMULATOR_HOST is set (CI runs the same scenarios on the fake in reportReviewQueue.spec.ts).
 *
 *   java -jar ~/.cache/firebase/emulators/cloud-firestore-emulator-v1.19.8.jar --host=127.0.0.1 --port=8187 &
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8187 GCLOUD_PROJECT=demo-b2 npx jest --runTestsByPath <this file>
 *
 * The emulator does not enforce composite indexes (they are declared in firestore.indexes.json); it does enforce query
 * legality, cursor semantics, ordering and transaction contention.
 */
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-b2";

jest.mock("@/lib/firebase/admin", () => {
  const { initializeApp, getApps } = jest.requireActual("firebase-admin/app");
  const { getFirestore } = jest.requireActual("firebase-admin/firestore");
  const app = getApps().find((a: { name: string }) => a.name === "b2-emulator") ?? initializeApp({ projectId: "demo-b2" }, "b2-emulator");
  const mockDb = getFirestore(app);
  return {
    get adminDb() {
      return mockDb;
    },
  };
});
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({ REPORT_REVIEW_ENABLED: true }));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined, APPROVAL_WORKFLOW_ENABLED: true }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockIdentity = { uid: "" };
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: async () => ({ status: "authenticated", uid: mockIdentity.uid, source: "session_cookie" }) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/workspaces/approvalWorkflowRollout", () => ({ resolveApprovalWorkflowAdmission: () => ({ admitted: true }) }));

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { GET } from "@/app/api/workspaces/[workspaceId]/review-queue/route";
import { submitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { putWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { buildSeed, seedDb, expectedStatusView, expectedAssignedToMe, pageAll, type QueueFn, type SeedRun, W, OWNER, REVIEWER, SUBMITTER, CREATOR } from "./helpers/reviewQueueScenario";
import { Timestamp } from "firebase-admin/firestore";

const maybe = EMULATOR ? describe : describe.skip;

async function clear() {
  await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
}
const db = adminDb!;
const queue: QueueFn = async ({ view, uid, limit, cursor }) => {
  mockIdentity.uid = uid;
  const qs = new URLSearchParams({ view, limit: String(limit) });
  if (cursor) qs.set("cursor", cursor);
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${W}/review-queue?${qs}`), { params: { workspaceId: W } });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
};

maybe("REAL Firestore: combined queue completeness and order", () => {
  let seed: SeedRun[];
  beforeAll(async () => {
    await clear();
    seed = buildSeed();
    await seedDb(db as never, seed);
  }, 60_000);

  it.each(["needs_review", "changes_requested", "recently_approved"].flatMap((v) => [1, 2, 3, 5, 25].map((l) => [v, l] as const)))("%s, limit %i: every eligible item exactly once, in order", async (view, limit) => {
    const { ids } = await pageAll(queue, view, OWNER, "owner", limit);
    expect(ids).toEqual(expectedStatusView(seed, view as never));
  }, 60_000);

  it.each([1, 2, 25])("Assigned to me, limit %i", async (limit) => {
    const { ids } = await pageAll(queue, "assigned_to_me", REVIEWER, "reviewer", limit);
    expect([...ids].sort()).toEqual(expectedAssignedToMe(seed, REVIEWER));
    const sub = await pageAll(queue, "assigned_to_me", SUBMITTER, "member", 2);
    expect(sub.ids.filter((id) => id.startsWith("rr-"))).toEqual([]);
  }, 60_000);
});

maybe("REAL Firestore: transaction contention", () => {
  beforeEach(async () => {
    await clear();
    await seedDb(db as never, []);
    await db.collection("runs").doc("rr-c").set({ userId: CREATOR, workspaceId: W, projectId: null, question: "c", status: "complete", createdAt: Timestamp.fromMillis(Date.UTC(2026, 10, 2)), legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: {}, generatedAt: "x", results: [], alignedClaims: [] } });
  }, 60_000);

  it("simultaneous submissions: exactly one record, exactly one event", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => submitReportReview({ uid: SUBMITTER, workspaceId: W, runId: "rr-c", purpose: { code: "internal_review" } })));
    expect(rs.filter((r) => r.ok && r.created)).toHaveLength(1);
    expect(rs.filter((r) => r.ok && !r.created)).toHaveLength(4);
    expect((await db.collection("runs").doc("rr-c").collection("reportReviewEvents").get()).size).toBe(1);
  }, 60_000);

  it("simultaneous decisions by the assignee: exactly one decision and one decided event", async () => {
    const sub = await submitReportReview({ uid: SUBMITTER, workspaceId: W, runId: "rr-c", purpose: { code: "internal_review" } });
    if (!sub.ok) throw new Error("submit");
    expect((await putWorkspaceReviewAssignment({ uid: OWNER, workspaceId: W, runId: "rr-c", assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null })).ok).toBe(true);
    const statuses = ["approved", "rejected", "changes_requested", "approved", "rejected"];
    const rs = await Promise.all(statuses.map((status) => decideReportReview({ uid: REVIEWER, workspaceId: W, runId: "rr-c", decision: { status }, expectedCycle: 1, expectedUpdatedAt: sub.record.updatedAt })));
    const committed = rs.filter((r) => r.ok && !r.replayed);
    expect(committed).toHaveLength(1);
    const events = (await db.collection("runs").doc("rr-c").collection("reportReviewEvents").get()).docs.map((d) => d.data()).filter((e) => e.type === "report_review_decided");
    expect(events).toHaveLength(1);
    const final = (await db.collection("runs").doc("rr-c").get()).data()!.reportReview;
    expect(final.humanReview.status).toBe((committed[0] as { record: { humanReview: { status: string } } }).record.humanReview.status);
  }, 60_000);
});
