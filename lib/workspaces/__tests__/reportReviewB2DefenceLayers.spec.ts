/**
 * Order B, Stage B2 — defence layers redundant under TODAY's role table, pinned for future roles (mutation survivors
 * M6 and X2): deciding requires research.read in addition to reviews.submit; reading the context requires reviews.read
 * in addition to research.read.
 */
import { Timestamp } from "firebase-admin/firestore";
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({ REPORT_REVIEW_ENABLED: true }));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const strip = { cap: null as string | null, role: "reviewer" };
jest.mock("@/lib/workspaces/capabilities", () => {
  const actual = jest.requireActual("@/lib/workspaces/capabilities");
  const filter = (role: string, caps: readonly string[]) => (strip.cap && role === strip.role ? caps.filter((c) => c !== strip.cap) : caps);
  return {
    ...actual,
    roleHasCapability: (role: string, cap: string) => (strip.cap && role === strip.role && cap === strip.cap ? false : actual.roleHasCapability(role, cap)),
    capabilitiesForRole: (role: string) => filter(role, actual.capabilitiesForRole(role)),
  };
});

import { submitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { getReportReviewContext } from "@/lib/workspaces/reportReviewContext";
import { computeMembershipId } from "@/lib/workspaces/membershipId";

const W = "wsD2";
const NOW = Timestamp.fromDate(new Date("2026-11-02T10:00:00Z"));
function member(uid: string, role: string) {
  const id = computeMembershipId(W, uid);
  db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: W, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
}

beforeEach(async () => {
  db.docs.clear();
  strip.cap = null;
  db.seed(`workspaces/${W}`, { schemaVersion: 1, id: W, type: "team", name: "T", ownerUserId: "o", createdByUserId: "o", createdAt: NOW, updatedAt: NOW });
  member("o", "owner");
  member("sub", "member");
  member("rev", "reviewer");
  db.seed("runs/r1", { userId: "creator", workspaceId: W, projectId: null, status: "complete", createdAt: NOW, legacyAdaptiveOutput: { version: 1, schemaId: "generic" } });
  const s = await submitReportReview({ uid: "sub", workspaceId: W, runId: "r1", purpose: { code: "other" } });
  if (!s.ok) throw new Error("submit");
  db.seed("runs/r1/humanReviewAssignment/current", { schemaVersion: 1, teamId: null, runId: "r1", assignedReviewerUserId: "rev", assignedAt: "x", assignedByUserId: "o", updatedAt: "x", updatedByUserId: "o", revision: 1, workspaceId: W, projectId: null, dueAt: null });
});

const rec = () => db.read("runs/r1")!.reportReview as { cycle: number; updatedAt: string; humanReview: { status: string } };

it("M6: a reviewer role holding reviews.submit but not research.read cannot decide", async () => {
  strip.cap = "research.read";
  const r = await decideReportReview({ uid: "rev", workspaceId: W, runId: "r1", decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: rec().updatedAt });
  expect(r).toEqual({ ok: false, reason: "insufficient_capability" });
  expect(rec().humanReview.status).toBe("unreviewed");
  strip.cap = null;
  expect((await decideReportReview({ uid: "rev", workspaceId: W, runId: "r1", decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: rec().updatedAt })).ok).toBe(true); // control
});

it("X2: a role holding research.read but not reviews.read cannot read the report-review context", async () => {
  strip.cap = "reviews.read";
  expect(await getReportReviewContext({ uid: "rev", workspaceId: W, runId: "r1" })).toEqual({ status: "not_found" });
  strip.cap = null;
  expect((await getReportReviewContext({ uid: "rev", workspaceId: W, runId: "r1" })).status).toBe("ok"); // control
});
