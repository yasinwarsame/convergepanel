/**
 * Part E3 — writeAdaptiveAssignmentAdminAuditEvent() tests.
 */

const auditDocs = new Map<string, Record<string, any>>();
const firestoreUnavailableFlag = { value: false };

function alreadyExistsError() {
  const err: any = new Error("6 ALREADY_EXISTS");
  err.code = 6;
  return err;
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (docId: string) => ({
      create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
        const key = `${name}/${docId}`;
        if (auditDocs.has(key)) throw alreadyExistsError();
        auditDocs.set(key, value);
      }),
    }),
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

import { writeAdaptiveAssignmentAdminAuditEvent } from "@/lib/governance/auditLog";

const BASE_ARGS = {
  action: "adaptive_human_review_reviewer_assigned" as const,
  actorUid: "admin-uid",
  teamId: "team-1",
  runId: "run-1",
  previousReviewerUserId: null,
  newReviewerUserId: "reviewer-uid",
  assignmentRevision: 1,
  at: "2026-07-30T00:00:00.000Z",
};

beforeEach(() => {
  auditDocs.clear();
  firestoreUnavailableFlag.value = false;
  consoleErrorSpy.mockClear();
});

describe("writeAdaptiveAssignmentAdminAuditEvent", () => {
  it("writes with a deterministic ID derived from runId + revision", async () => {
    const result = await writeAdaptiveAssignmentAdminAuditEvent(BASE_ARGS);
    expect(result).toEqual({ status: "recorded" });
    expect(auditDocs.get("admin_audit_logs/adaptive-review-assignment:run-1:1")).toBeDefined();
  });

  it("stores only safe metadata", async () => {
    await writeAdaptiveAssignmentAdminAuditEvent(BASE_ARGS);
    const stored = auditDocs.get("admin_audit_logs/adaptive-review-assignment:run-1:1")!;
    expect(stored.action).toBe("adaptive_human_review_reviewer_assigned");
    expect(stored.byUid).toBe("admin-uid");
    expect(stored.teamId).toBe("team-1");
    expect(stored.runId).toBe("run-1");
    expect(stored.previousReviewerUserId).toBeNull();
    expect(stored.newReviewerUserId).toBe("reviewer-uid");
    expect(stored.assignmentRevision).toBe(1);
  });

  it("never includes reviewer email, display name, comments, or decision content", async () => {
    await writeAdaptiveAssignmentAdminAuditEvent(BASE_ARGS);
    const stored = auditDocs.get("admin_audit_logs/adaptive-review-assignment:run-1:1")!;
    for (const forbidden of ["reviewerEmail", "reviewerName", "comment", "conditions", "decisionReceipt", "fullProfile"]) {
      expect(stored).not.toHaveProperty(forbidden);
    }
  });

  it("distinct actions (reassigned/unassigned) are stored correctly", async () => {
    await writeAdaptiveAssignmentAdminAuditEvent({ ...BASE_ARGS, action: "adaptive_human_review_reviewer_reassigned", assignmentRevision: 2, previousReviewerUserId: "reviewer-uid", newReviewerUserId: "reviewer-2" });
    await writeAdaptiveAssignmentAdminAuditEvent({ ...BASE_ARGS, action: "adaptive_human_review_reviewer_unassigned", assignmentRevision: 3, previousReviewerUserId: "reviewer-2", newReviewerUserId: null });
    expect(auditDocs.get("admin_audit_logs/adaptive-review-assignment:run-1:2")!.action).toBe("adaptive_human_review_reviewer_reassigned");
    expect(auditDocs.get("admin_audit_logs/adaptive-review-assignment:run-1:3")!.action).toBe("adaptive_human_review_reviewer_unassigned");
  });

  it("a retried write with the same revision is idempotent — no duplicate document", async () => {
    const first = await writeAdaptiveAssignmentAdminAuditEvent(BASE_ARGS);
    expect(first).toEqual({ status: "recorded" });
    const second = await writeAdaptiveAssignmentAdminAuditEvent({ ...BASE_ARGS, newReviewerUserId: "different-uid" });
    expect(second).toEqual({ status: "already_exists" });
    expect(auditDocs.size).toBe(1);
  });

  it("returns failed safely when Firestore is unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await writeAdaptiveAssignmentAdminAuditEvent(BASE_ARGS);
    expect(result).toEqual({ status: "failed" });
  });

  it("returns failed on an unexpected error without exposing it", async () => {
    (mockAdminDb as any).collection = () => ({
      doc: () => ({ create: jest.fn().mockRejectedValue(new Error("SECRET DETAIL")) }),
    });
    const result = await writeAdaptiveAssignmentAdminAuditEvent(BASE_ARGS);
    expect(result).toEqual({ status: "failed" });
    expect(JSON.stringify(result)).not.toContain("SECRET DETAIL");
  });
});
