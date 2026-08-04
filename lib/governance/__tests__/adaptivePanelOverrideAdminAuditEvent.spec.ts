/**
 * Multi-Reviewer Owner Override, Part F —
 * writeAdaptivePanelOverrideAdminAuditEvent() tests.
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

import { writeAdaptivePanelOverrideAdminAuditEvent } from "@/lib/governance/auditLog";

const BASE_ARGS = {
  actorUid: "owner-uid",
  teamId: "team-1",
  runId: "run-1",
  priorHumanReviewStatus: "unreviewed",
  finalStatus: "approved",
  panelRevision: 3,
  finalDecisionId: "panel_override_dec_abc123",
  conditionsCount: 0,
  finalizedAt: "2020-06-01T00:00:00.000Z",
};

beforeEach(() => {
  auditDocs.clear();
  firestoreUnavailableFlag.value = false;
  consoleErrorSpy.mockClear();
});

describe("writeAdaptivePanelOverrideAdminAuditEvent", () => {
  it("writes with a deterministic ID derived from finalDecisionId, distinct from the finalization audit ID prefix", async () => {
    const result = await writeAdaptivePanelOverrideAdminAuditEvent(BASE_ARGS);
    expect(result).toEqual({ status: "recorded" });
    expect(auditDocs.get("admin_audit_logs/adaptive-review-panel-override:panel_override_dec_abc123")).toBeDefined();
  });

  it("stores only safe metadata, including justificationPresent/conditionsCount but never the raw justification", async () => {
    await writeAdaptivePanelOverrideAdminAuditEvent({ ...BASE_ARGS, conditionsCount: 2 });
    const stored = auditDocs.get("admin_audit_logs/adaptive-review-panel-override:panel_override_dec_abc123")!;
    expect(stored.action).toBe("adaptive_review_panel_owner_overridden");
    expect(stored.byUid).toBe("owner-uid");
    expect(stored.teamId).toBe("team-1");
    expect(stored.runId).toBe("run-1");
    expect(stored.prevStatus).toBe("unreviewed");
    expect(stored.nextStatus).toBe("approved");
    expect(stored.decisionId).toBe("panel_override_dec_abc123");
    expect(stored.panelRevision).toBe(3);
    expect(stored.justificationPresent).toBe(true);
    expect(stored.conditionsCount).toBe(2);
    expect(stored.source).toBe("multi_reviewer_owner_override");
  });

  it("never includes the raw justification text, comments, conditions text, vote text, or reviewer emails", async () => {
    await writeAdaptivePanelOverrideAdminAuditEvent(BASE_ARGS);
    const stored = auditDocs.get("admin_audit_logs/adaptive-review-panel-override:panel_override_dec_abc123")!;
    for (const forbidden of ["justification", "comment", "conditionsText", "voteText", "reviewerEmail", "rawRequest"]) {
      expect(stored).not.toHaveProperty(forbidden);
    }
  });

  it("a retried write with the same finalDecisionId is idempotent — no duplicate document", async () => {
    const first = await writeAdaptivePanelOverrideAdminAuditEvent(BASE_ARGS);
    expect(first).toEqual({ status: "recorded" });
    const second = await writeAdaptivePanelOverrideAdminAuditEvent({ ...BASE_ARGS, finalStatus: "rejected" });
    expect(second).toEqual({ status: "already_exists" });
    expect(auditDocs.size).toBe(1);
  });

  it("a distinct finalDecisionId creates a distinct document", async () => {
    await writeAdaptivePanelOverrideAdminAuditEvent(BASE_ARGS);
    const result = await writeAdaptivePanelOverrideAdminAuditEvent({ ...BASE_ARGS, finalDecisionId: "panel_override_dec_different" });
    expect(result).toEqual({ status: "recorded" });
    expect(auditDocs.size).toBe(2);
  });

  it("an aggregation-finalization audit document and an override audit document for the same decision-ID-suffix never collide (distinct prefixes)", async () => {
    await writeAdaptivePanelOverrideAdminAuditEvent({ ...BASE_ARGS, finalDecisionId: "panel_dec_shared_suffix" });
    // Simulate the aggregation writer's own doc-id shape for the same suffix.
    const aggregationKey = "admin_audit_logs/adaptive-review-panel-finalization:panel_dec_shared_suffix";
    expect(auditDocs.has(aggregationKey)).toBe(false);
    expect(auditDocs.has("admin_audit_logs/adaptive-review-panel-override:panel_dec_shared_suffix")).toBe(true);
  });

  it("returns failed safely when Firestore is unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await writeAdaptivePanelOverrideAdminAuditEvent(BASE_ARGS);
    expect(result).toEqual({ status: "failed" });
  });

  it("returns failed on an unexpected error without exposing it", async () => {
    (mockAdminDb as any).collection = () => ({
      doc: () => ({ create: jest.fn().mockRejectedValue(new Error("SECRET INTERNAL DETAIL")) }),
    });
    const result = await writeAdaptivePanelOverrideAdminAuditEvent(BASE_ARGS);
    expect(result).toEqual({ status: "failed" });
    expect(JSON.stringify(result)).not.toContain("SECRET INTERNAL DETAIL");
  });
});
