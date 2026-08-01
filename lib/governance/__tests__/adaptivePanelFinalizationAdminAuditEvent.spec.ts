/**
 * Transactional Multi-Reviewer Finalization, Part E —
 * writeAdaptivePanelFinalizationAdminAuditEvent() tests.
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

import { writeAdaptivePanelFinalizationAdminAuditEvent } from "@/lib/governance/auditLog";

const BASE_ARGS = {
  actorUid: "owner-uid",
  teamId: "team-1",
  runId: "run-1",
  priorHumanReviewStatus: "unreviewed",
  finalStatus: "approved",
  panelRevision: 3,
  finalDecisionId: "panel_dec_abc123",
  aggregationPolicyVersion: 1,
  finalizedAt: "2020-06-01T00:00:00.000Z",
};

beforeEach(() => {
  auditDocs.clear();
  firestoreUnavailableFlag.value = false;
  consoleErrorSpy.mockClear();
});

describe("writeAdaptivePanelFinalizationAdminAuditEvent", () => {
  it("writes with a deterministic ID derived from finalDecisionId", async () => {
    const result = await writeAdaptivePanelFinalizationAdminAuditEvent(BASE_ARGS);
    expect(result).toEqual({ status: "recorded" });
    expect(auditDocs.get("admin_audit_logs/adaptive-review-panel-finalization:panel_dec_abc123")).toBeDefined();
  });

  it("stores only safe metadata", async () => {
    await writeAdaptivePanelFinalizationAdminAuditEvent(BASE_ARGS);
    const stored = auditDocs.get("admin_audit_logs/adaptive-review-panel-finalization:panel_dec_abc123")!;
    expect(stored.action).toBe("adaptive_review_panel_finalized");
    expect(stored.byUid).toBe("owner-uid");
    expect(stored.teamId).toBe("team-1");
    expect(stored.runId).toBe("run-1");
    expect(stored.prevStatus).toBe("unreviewed");
    expect(stored.nextStatus).toBe("approved");
    expect(stored.decisionId).toBe("panel_dec_abc123");
    expect(stored.panelRevision).toBe(3);
    expect(stored.aggregationPolicyVersion).toBe(1);
    expect(stored.source).toBe("multi_reviewer_panel");
  });

  it("never includes comments, conditions, vote text, reviewer emails, or a raw request", async () => {
    await writeAdaptivePanelFinalizationAdminAuditEvent(BASE_ARGS);
    const stored = auditDocs.get("admin_audit_logs/adaptive-review-panel-finalization:panel_dec_abc123")!;
    for (const forbidden of ["comment", "conditions", "voteText", "reviewerEmail", "rawRequest", "fullProfile"]) {
      expect(stored).not.toHaveProperty(forbidden);
    }
  });

  it("a retried write with the same finalDecisionId is idempotent — no duplicate document", async () => {
    const first = await writeAdaptivePanelFinalizationAdminAuditEvent(BASE_ARGS);
    expect(first).toEqual({ status: "recorded" });
    const second = await writeAdaptivePanelFinalizationAdminAuditEvent({ ...BASE_ARGS, finalStatus: "rejected" });
    expect(second).toEqual({ status: "already_exists" });
    expect(auditDocs.size).toBe(1);
  });

  it("a distinct finalDecisionId creates a distinct document", async () => {
    await writeAdaptivePanelFinalizationAdminAuditEvent(BASE_ARGS);
    const result = await writeAdaptivePanelFinalizationAdminAuditEvent({ ...BASE_ARGS, finalDecisionId: "panel_dec_different" });
    expect(result).toEqual({ status: "recorded" });
    expect(auditDocs.size).toBe(2);
  });

  it("returns failed safely when Firestore is unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await writeAdaptivePanelFinalizationAdminAuditEvent(BASE_ARGS);
    expect(result).toEqual({ status: "failed" });
  });

  it("returns failed on an unexpected error without exposing it", async () => {
    (mockAdminDb as any).collection = () => ({
      doc: () => ({ create: jest.fn().mockRejectedValue(new Error("SECRET INTERNAL DETAIL")) }),
    });
    const result = await writeAdaptivePanelFinalizationAdminAuditEvent(BASE_ARGS);
    expect(result).toEqual({ status: "failed" });
    expect(JSON.stringify(result)).not.toContain("SECRET INTERNAL DETAIL");
  });
});
