/**
 * Multi-Reviewer Owner Override, Part F (§F9) —
 * repairAdaptivePanelOverrideArtifacts() tests.
 */

const runDocs = new Map<string, Record<string, any>>();
const panelDocs = new Map<string, Record<string, any>>();
const historyDocs = new Map<string, Record<string, any>>();
const panelHistoryDocs = new Map<string, Record<string, any>>();
const auditDocs = new Map<string, Record<string, any>>();
const teamRunDocs = new Map<string, Record<string, any>>();
const firestoreUnavailableFlag = { value: false };

function alreadyExistsError() {
  const err: any = new Error("6 ALREADY_EXISTS");
  err.code = 6;
  return err;
}
function notFoundError() {
  const err: any = new Error("5 NOT_FOUND: No document to update");
  err.code = 5;
  return err;
}

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "admin_audit_logs") {
      return {
        doc: (docId: string) => ({
          create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
            const key = `${name}/${docId}`;
            if (auditDocs.has(key)) throw alreadyExistsError();
            auditDocs.set(key, value);
          }),
        }),
      };
    }
    if (name === "teamRuns") {
      return {
        doc: (docId: string) => ({
          update: jest.fn().mockImplementation(async (fields: Record<string, unknown>) => {
            if (!teamRunDocs.has(docId)) throw notFoundError();
            teamRunDocs.set(docId, { ...teamRunDocs.get(docId), ...fields });
          }),
        }),
      };
    }
    // "runs"
    return {
      doc: (runId: string) => ({
        id: runId,
        get: jest.fn().mockImplementation(async () => ({ exists: runDocs.has(runId), data: () => runDocs.get(runId) })),
        collection: (subName: string) => ({
          doc: (docId: string) => {
            const store = subName === "humanReviewPanel" ? panelDocs : subName === "humanReviewHistory" ? historyDocs : panelHistoryDocs;
            const key = `${runId}/${subName}/${docId}`;
            return {
              get: jest.fn().mockImplementation(async () => ({ exists: store.has(key), data: () => store.get(key) })),
              create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
                if (store.has(key)) throw alreadyExistsError();
                store.set(key, value);
              }),
            };
          },
        }),
      }),
    };
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { repairAdaptivePanelOverrideArtifacts } from "@/lib/governance/adaptivePanelOverrideRepair";

const RUN_ID = "run-1";
const TEAM_ID = "team-1";
const R1 = "reviewer-1";
const R2 = "reviewer-2";
const OWNER = "owner-uid";

function governanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: {
      status: "approved",
      reviewerId: OWNER,
      reviewedAt: "2020-06-01T00:00:00.000Z",
      decidedVia: "multi_reviewer_owner_override",
      panelRevision: 1,
      overrideJustification: "Deadline pressure required an override.",
    },
    decisionReceipt: {
      conclusion: "x",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: [],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: false,
    },
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function overriddenPanel(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "adaptive_review_panel",
    teamId: TEAM_ID,
    runId: RUN_ID,
    mode: "majority_quorum",
    reviewerUserIds: [R1, R2],
    requiredReviewerCount: 2,
    quorum: 2,
    status: "finalized",
    revision: 2,
    createdAt: "2020-01-01T00:00:00.000Z",
    createdByUserId: "admin-uid",
    updatedAt: "2020-06-01T00:00:00.000Z",
    updatedByUserId: OWNER,
    finalizedAt: "2020-06-01T00:00:00.000Z",
    finalizedByUserId: OWNER,
    finalStatus: "approved",
    finalDecisionId: "panel_override_dec_abc123",
    aggregationPolicyVersion: 1,
    finalizedVia: "owner_override",
    overrideJustificationPresent: true,
    overrideByUserId: OWNER,
    ...overrides,
  };
}

function seedConsistentOverriddenState() {
  runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
  panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, overriddenPanel());
  teamRunDocs.set(`${TEAM_ID}:${RUN_ID}`, { humanReviewStatus: "unreviewed" });
}

beforeEach(() => {
  runDocs.clear();
  panelDocs.clear();
  historyDocs.clear();
  panelHistoryDocs.clear();
  auditDocs.clear();
  teamRunDocs.clear();
  firestoreUnavailableFlag.value = false;
});

describe("repairAdaptivePanelOverrideArtifacts — repairs missing artifacts", () => {
  it("creates all missing artifacts for a consistent overridden panel", async () => {
    seedConsistentOverriddenState();
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result.status).toBe("repaired");
    if (result.status === "repaired" || result.status === "already_complete") {
      expect(result.historyStatus).toBe("recorded");
      expect(result.panelHistoryStatus).toBe("recorded");
      expect(result.eventStatus).toBe("recorded");
      expect(result.auditStatus).toBe("recorded");
      expect(result.projectionSyncStatus).toBe("synced");
    }
  });

  it("a second repair run is idempotent — already_complete, no duplicates", async () => {
    seedConsistentOverriddenState();
    await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result.status).toBe("already_complete");
    if (result.status === "already_complete") {
      expect(result.historyStatus).toBe("already_exists");
      expect(result.panelHistoryStatus).toBe("already_exists");
      expect(result.eventStatus).toBe("already_exists");
      expect(result.auditStatus).toBe("already_exists");
    }
  });

  it("creates only the missing artifact when some already exist", async () => {
    seedConsistentOverriddenState();
    auditDocs.set(`admin_audit_logs/adaptive-review-panel-override:panel_override_dec_abc123`, { action: "adaptive_review_panel_owner_overridden" });
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result.status).toBe("repaired");
    if (result.status === "repaired") {
      expect(result.auditStatus).toBe("already_exists");
      expect(result.historyStatus).toBe("recorded");
    }
  });

  it("never modifies the panel or changes canonical humanReview", async () => {
    seedConsistentOverriddenState();
    const panelBefore = JSON.parse(JSON.stringify(panelDocs.get(`${RUN_ID}/humanReviewPanel/current`)));
    const humanReviewBefore = JSON.parse(JSON.stringify(runDocs.get(RUN_ID)!.governanceRecord.humanReview));
    await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(panelDocs.get(`${RUN_ID}/humanReviewPanel/current`)).toEqual(panelBefore);
    expect(runDocs.get(RUN_ID)!.governanceRecord.humanReview).toEqual(humanReviewBefore);
  });

  it("the created panel-history entry never contains the raw justification text", async () => {
    seedConsistentOverriddenState();
    await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    const entry = panelHistoryDocs.get(`${RUN_ID}/humanReviewPanelHistory/2:panel_owner_overridden`);
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain("Deadline pressure required an override.");
    expect(entry!.overrideJustificationPresent).toBe(true);
  });
});

describe("repairAdaptivePanelOverrideArtifacts — no-op cases", () => {
  it("no panel at all → no_panel, no repair attempted", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "unreviewed" } }) });
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "no_panel" });
  });

  it("an OPEN panel → panel_not_finalized, no repair attempted", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "unreviewed" } }) });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, {
      ...overriddenPanel(),
      status: "open",
      finalizedAt: undefined,
      finalizedByUserId: undefined,
      finalStatus: undefined,
      finalDecisionId: undefined,
      aggregationPolicyVersion: undefined,
      finalizedVia: undefined,
      overrideJustificationPresent: undefined,
      overrideByUserId: undefined,
    });
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "panel_not_finalized" });
  });

  it("a panel finalized via AGGREGATION (not override) → panel_not_overridden, this repair service never touches it", async () => {
    runDocs.set(
      RUN_ID,
      { governanceRecord: governanceRecord({ humanReview: { status: "approved", decidedVia: "multi_reviewer_panel", panelRevision: 1, aggregationPolicyVersion: 1, supportingReviewerCount: 2 } }) }
    );
    panelDocs.set(
      `${RUN_ID}/humanReviewPanel/current`,
      overriddenPanel({ finalizedVia: "aggregation", overrideJustificationPresent: undefined, overrideByUserId: undefined })
    );
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "panel_not_overridden" });
  });

  it("a legacy Part-E finalized panel with no finalizedVia at all → panel_not_overridden", async () => {
    runDocs.set(
      RUN_ID,
      { governanceRecord: governanceRecord({ humanReview: { status: "approved", decidedVia: "multi_reviewer_panel", panelRevision: 1, aggregationPolicyVersion: 1, supportingReviewerCount: 2 } }) }
    );
    panelDocs.set(
      `${RUN_ID}/humanReviewPanel/current`,
      overriddenPanel({ finalizedVia: undefined, overrideJustificationPresent: undefined, overrideByUserId: undefined })
    );
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "panel_not_overridden" });
  });
});

describe("repairAdaptivePanelOverrideArtifacts — fail-closed on inconsistency", () => {
  it("humanReview still reviewable despite a finalized panel → inconsistent, never guesses", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "unreviewed" } }) });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, overriddenPanel());
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result.status).toBe("inconsistent");
  });

  it("humanReview decidedVia not multi_reviewer_owner_override → inconsistent", async () => {
    runDocs.set(RUN_ID, {
      governanceRecord: governanceRecord({ humanReview: { status: "approved", decidedVia: "multi_reviewer_panel", panelRevision: 1, aggregationPolicyVersion: 1, supportingReviewerCount: 2 } }),
    });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, overriddenPanel());
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result.status).toBe("inconsistent");
  });

  it("humanReview status doesn't match panel.finalStatus → inconsistent", async () => {
    runDocs.set(RUN_ID, {
      governanceRecord: governanceRecord({ humanReview: { status: "rejected", decidedVia: "multi_reviewer_owner_override", panelRevision: 1, overrideJustification: "x" } }),
    });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, overriddenPanel({ finalStatus: "approved" }));
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result.status).toBe("inconsistent");
  });

  it("humanReview.panelRevision doesn't match the panel's pre-override revision → inconsistent", async () => {
    runDocs.set(RUN_ID, {
      governanceRecord: governanceRecord({ humanReview: { status: "approved", decidedVia: "multi_reviewer_owner_override", panelRevision: 99, overrideJustification: "x" } }),
    });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, overriddenPanel());
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result.status).toBe("inconsistent");
  });

  it("humanReview missing overrideJustification entirely → inconsistent", async () => {
    runDocs.set(RUN_ID, {
      governanceRecord: governanceRecord({ humanReview: { status: "approved", decidedVia: "multi_reviewer_owner_override", panelRevision: 1 } }),
    });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, overriddenPanel());
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result.status).toBe("inconsistent");
  });

  it("panel missing overrideByUserId despite finalizedVia owner_override is rejected at the PARSER level (panel_malformed), before this service's own consistency check ever runs", async () => {
    seedConsistentOverriddenState();
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, overriddenPanel({ overrideByUserId: undefined }));
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "panel_malformed" });
  });

  it("malformed governanceRecord → fails closed", async () => {
    runDocs.set(RUN_ID, { governanceRecord: { version: 1, garbage: true } });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, overriddenPanel());
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "governance_record_malformed" });
  });

  it("malformed panel → fails closed", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, overriddenPanel({ quorum: 999 }));
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "panel_malformed" });
  });

  it("run missing → fails closed", async () => {
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "run_missing" });
  });

  it("firestore unavailable → safe result, no throw", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await repairAdaptivePanelOverrideArtifacts(RUN_ID, TEAM_ID);
    expect(result).toEqual({ status: "firestore_unavailable" });
  });
});
