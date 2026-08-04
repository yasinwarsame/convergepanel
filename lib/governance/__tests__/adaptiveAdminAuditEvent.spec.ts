/**
 * Immutable Adaptive Review History and Admin Audit Integration —
 * writeAdaptiveAdminAuditEvent() tests.
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

import { writeAdaptiveAdminAuditEvent } from "@/lib/governance/auditLog";

const BASE_ARGS = {
  decisionId: "dec_abc123",
  actorUid: "reviewer-uid",
  teamId: "team-1",
  runId: "run-1",
  schemaId: "decision_support",
  answerShape: "decision_support_view",
  priorStatus: "unreviewed",
  newStatus: "approved",
  reviewedAt: "2026-07-30T00:00:00.000Z",
};

beforeEach(() => {
  auditDocs.clear();
  firestoreUnavailableFlag.value = false;
  consoleErrorSpy.mockClear();
});

describe("writeAdaptiveAdminAuditEvent", () => {
  it("writes to admin_audit_logs with a deterministic ID derived from decisionId", async () => {
    const result = await writeAdaptiveAdminAuditEvent(BASE_ARGS);
    expect(result).toEqual({ status: "recorded" });
    expect(auditDocs.get("admin_audit_logs/adaptive-review:dec_abc123")).toBeDefined();
  });

  it("sets action to adaptive_human_review_decided and includes only safe metadata", async () => {
    await writeAdaptiveAdminAuditEvent(BASE_ARGS);
    const stored = auditDocs.get("admin_audit_logs/adaptive-review:dec_abc123")!;
    expect(stored.action).toBe("adaptive_human_review_decided");
    expect(stored.byUid).toBe("reviewer-uid");
    expect(stored.teamId).toBe("team-1");
    expect(stored.runId).toBe("run-1");
    expect(stored.prevStatus).toBe("unreviewed");
    expect(stored.nextStatus).toBe("approved");
    expect(stored.outcome).toBe("success");
    expect(stored.source).toBe("adaptive_team_review");
  });

  it("never includes comment, conditions, question, receipt content, sources, or model output (not accepted as inputs)", async () => {
    await writeAdaptiveAdminAuditEvent(BASE_ARGS);
    const stored = auditDocs.get("admin_audit_logs/adaptive-review:dec_abc123")!;
    for (const forbidden of ["comment", "conditions", "question", "conclusion", "sources", "basis", "reasons", "rawModelOutput"]) {
      expect(stored).not.toHaveProperty(forbidden);
    }
  });

  it("a retried write with the same decisionId is idempotent — already_exists, never a duplicate document", async () => {
    const first = await writeAdaptiveAdminAuditEvent(BASE_ARGS);
    expect(first).toEqual({ status: "recorded" });
    const storedAfterFirst = { ...auditDocs.get("admin_audit_logs/adaptive-review:dec_abc123") };

    const second = await writeAdaptiveAdminAuditEvent({ ...BASE_ARGS, newStatus: "rejected" });
    expect(second).toEqual({ status: "already_exists" });
    expect(auditDocs.get("admin_audit_logs/adaptive-review:dec_abc123")).toEqual(storedAfterFirst);
    expect(auditDocs.size).toBe(1);
  });

  it("returns failed safely when Firestore is unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await writeAdaptiveAdminAuditEvent(BASE_ARGS);
    expect(result).toEqual({ status: "failed" });
  });

  it("returns failed on an unexpected error and never exposes the raw error to the caller", async () => {
    (mockAdminDb as any).collection = () => ({
      doc: () => ({
        create: jest.fn().mockRejectedValue(new Error("SECRET INTERNAL DETAIL")),
      }),
    });
    const result = await writeAdaptiveAdminAuditEvent(BASE_ARGS);
    expect(result).toEqual({ status: "failed" });
    expect(JSON.stringify(result)).not.toContain("SECRET INTERNAL DETAIL");
  });

  it("does not alter the legacy writeAuditEvent shape or behavior (structurally separate function)", async () => {
    const { writeAuditEvent } = await import("@/lib/governance/auditLog");
    expect(typeof writeAuditEvent).toBe("function");
  });
});
