/**
 * Multi-Reviewer Owner Override, Part F —
 * overrideAdaptiveHumanReviewPanel() tests.
 */

const runDocs = new Map<string, Record<string, any>>();
const panelDocs = new Map<string, Record<string, any>>();
const voteDocs = new Map<string, Record<string, any>>();
const firestoreUnavailableFlag = { value: false };

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (runId: string) => ({
      id: runId,
      get: jest.fn().mockImplementation(async () => ({ exists: runDocs.has(runId), data: () => runDocs.get(runId) })),
      collection: (subName: string) => ({
        doc: (docId: string) => ({
          get: jest.fn().mockImplementation(async () => {
            const store = subName === "humanReviewPanel" ? panelDocs : voteDocs;
            const key = `${runId}/${subName}/${docId}`;
            return { exists: store.has(key), data: () => store.get(key) };
          }),
        }),
      }),
    }),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    const txn = {
      get: async (ref: any) => {
        if (ref.__isPanelRef) {
          const key = `${ref.__runId}/humanReviewPanel/current`;
          return { exists: panelDocs.has(key), data: () => panelDocs.get(key) };
        }
        if (ref.__isVoteRef) {
          const key = `${ref.__runId}/humanReviewVotes/${ref.__voteId}`;
          return { exists: voteDocs.has(key), data: () => voteDocs.get(key) };
        }
        return { exists: runDocs.has(ref.id), data: () => runDocs.get(ref.id) };
      },
      update: (ref: any, fields: Record<string, unknown>) => {
        const doc = runDocs.get(ref.id);
        if (!doc) throw new Error("not found");
        for (const [path, value] of Object.entries(fields)) {
          const segments = path.split(".");
          let cursor = doc;
          for (let i = 0; i < segments.length - 1; i++) {
            if (typeof cursor[segments[i]] !== "object" || cursor[segments[i]] === null) cursor[segments[i]] = {};
            cursor = cursor[segments[i]];
          }
          cursor[segments[segments.length - 1]] = value;
        }
      },
      set: (ref: any, value: Record<string, unknown>) => {
        if (ref.__isPanelRef) {
          panelDocs.set(`${ref.__runId}/humanReviewPanel/current`, value);
        }
      },
    };
    return fn(txn);
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

const mockLoggerInfo = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: (...args: unknown[]) => mockLoggerInfo(...args), error: jest.fn(), debug: jest.fn() },
}));

// Tag refs so the transaction fake can distinguish run/panel/vote refs —
// same technique as adaptivePanelFinalization.spec.ts.
const originalCollection = mockAdminDb.collection;
mockAdminDb.collection = (name: string) => {
  const base = originalCollection(name);
  return {
    doc: (runId: string) => {
      const runRef = base.doc(runId);
      return {
        ...runRef,
        id: runId,
        collection: (subName: string) => {
          const subCollection = runRef.collection(subName);
          return {
            doc: (docId: string) => {
              const docRef = subCollection.doc(docId);
              return {
                ...docRef,
                id: docId,
                __isPanelRef: subName === "humanReviewPanel" && docId === "current",
                __isVoteRef: subName === "humanReviewVotes",
                __voteId: docId,
                __runId: runId,
              };
            },
          };
        },
      };
    },
  };
};

import {
  overrideAdaptiveHumanReviewPanel,
  finalizeAdaptiveHumanReviewPanel,
  submitAdaptiveHumanReviewVote,
  submitAdaptiveHumanReviewPanel,
} from "@/lib/firestore/runs";
import { buildAdaptiveHumanReviewVoteId } from "@/lib/governance/adaptiveHumanReviewVote";

const RUN_ID = "run-1";
const TEAM_ID = "team-1";
const R1 = "reviewer-1";
const R2 = "reviewer-2";
const R3 = "reviewer-3";
const OWNER = "owner-uid";

function governanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
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
    updatedAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function storedPanel(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "adaptive_review_panel",
    teamId: TEAM_ID,
    runId: RUN_ID,
    mode: "majority_quorum",
    reviewerUserIds: [R1, R2, R3],
    requiredReviewerCount: 3,
    quorum: 2,
    status: "open",
    revision: 1,
    createdAt: "2020-01-01T00:00:00.000Z",
    createdByUserId: "admin-uid",
    updatedAt: "2020-01-01T00:00:00.000Z",
    updatedByUserId: "admin-uid",
    ...overrides,
  };
}

function storedVote(reviewerUserId: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "adaptive_human_review_vote",
    teamId: TEAM_ID,
    runId: RUN_ID,
    panelRevision: 1,
    reviewerUserId,
    status,
    commentPresent: status === "changes_requested" || status === "rejected",
    comment: status === "changes_requested" || status === "rejected" ? "reason" : undefined,
    conditionsCount: 0,
    submittedAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function seedOpenPanel() {
  runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
  panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel());
}

function seedDeadlockedPanel() {
  runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
  panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ reviewerUserIds: [R1, R2], requiredReviewerCount: 2, quorum: 2 }));
  voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`, storedVote(R1, "approved"));
  voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R2)}`, storedVote(R2, "rejected"));
}

function baseArgs(overrides: Partial<Parameters<typeof overrideAdaptiveHumanReviewPanel>[0]> = {}) {
  return {
    runId: RUN_ID,
    teamId: TEAM_ID,
    actorUserId: OWNER,
    expectedPanelRevision: 1,
    expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
    status: "approved" as const,
    justification: "The panel has deadlocked and a decision is required before the deadline.",
    now: "2020-06-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  runDocs.clear();
  panelDocs.clear();
  voteDocs.clear();
  firestoreUnavailableFlag.value = false;
  mockLoggerInfo.mockClear();
});

describe("overrideAdaptiveHumanReviewPanel — happy path", () => {
  it("overrides an open (waiting, no votes at all) panel successfully", async () => {
    seedOpenPanel();
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.submissionStatus).toBe("overridden");
      expect(result.humanReview.status).toBe("approved");
      expect(result.humanReview.decidedVia).toBe("multi_reviewer_owner_override");
      expect(result.humanReview.panelRevision).toBe(1);
      expect(result.humanReview.overrideJustification).toBe(baseArgs().justification);
      expect(result.panel.status).toBe("finalized");
      expect(result.panel.finalizedVia).toBe("owner_override");
      expect(result.panel.overrideJustificationPresent).toBe(true);
      expect(result.panel.overrideByUserId).toBe(OWNER);
      expect(result.panel.revision).toBe(2);
    }
  });

  it("overrides a DEADLOCKED panel without ever reading or aggregating votes as a precondition", async () => {
    seedDeadlockedPanel();
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs({ status: "approved" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.submissionStatus).toBe("overridden");
      expect(result.humanReview.status).toBe("approved"); // owner's chosen status, NOT an aggregation outcome
    }
  });

  it("writes the canonical governanceRecord.humanReview and updatedAt", async () => {
    seedOpenPanel();
    await overrideAdaptiveHumanReviewPanel(baseArgs());
    const run = runDocs.get(RUN_ID)!;
    expect(run.governanceRecord.humanReview.status).toBe("approved");
    expect(run.governanceRecord.updatedAt).toBe("2020-06-01T00:00:00.000Z");
  });

  it("writes ONLY governanceRecord.humanReview/.updatedAt — decisionReceipt untouched", async () => {
    seedOpenPanel();
    const before = JSON.parse(JSON.stringify(runDocs.get(RUN_ID)!.governanceRecord.decisionReceipt));
    await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(runDocs.get(RUN_ID)!.governanceRecord.decisionReceipt).toEqual(before);
  });

  it("votes remain completely untouched by an override", async () => {
    seedDeadlockedPanel();
    const before = JSON.parse(JSON.stringify(voteDocs.get(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`)));
    await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(voteDocs.get(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`)).toEqual(before);
  });

  it("reviewerUserIds/mode/quorum/requiredReviewerCount are preserved on the finalized panel", async () => {
    seedOpenPanel();
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.panel.reviewerUserIds).toEqual([R1, R2, R3]);
      expect(result.panel.mode).toBe("majority_quorum");
      expect(result.panel.quorum).toBe(2);
    }
  });

  it("approved_with_conditions override stores the owner's own conditions verbatim, not any vote's", async () => {
    seedOpenPanel();
    const result = await overrideAdaptiveHumanReviewPanel(
      baseArgs({ status: "approved_with_conditions", conditions: ["owner-specified condition"] })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.humanReview.status).toBe("approved_with_conditions");
      expect(result.humanReview.conditions).toEqual(["owner-specified condition"]);
    }
  });

  it("rejected override gets the fixed override system comment, never the raw justification text as 'comment'", async () => {
    seedOpenPanel();
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs({ status: "rejected", justification: "confidential reasoning" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.humanReview.comment).toBe("Finalized by owner override.");
      expect(result.humanReview.comment).not.toContain("confidential reasoning");
    }
  });

  it("the panel document itself never contains the raw justification text — only the boolean presence flag", async () => {
    seedOpenPanel();
    await overrideAdaptiveHumanReviewPanel(baseArgs({ justification: "very specific confidential owner reasoning" }));
    const panel = panelDocs.get(`${RUN_ID}/humanReviewPanel/current`)!;
    expect(JSON.stringify(panel)).not.toContain("very specific confidential owner reasoning");
    expect(panel.overrideJustificationPresent).toBe(true);
  });

  it("the decision ID uses the distinct override prefix", async () => {
    seedOpenPanel();
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.panel.finalDecisionId).toMatch(/^panel_override_dec_[0-9a-f]{32}$/);
    }
  });
});

describe("overrideAdaptiveHumanReviewPanel — stale/terminal/cancelled rejected", () => {
  it("a stale expectedPanelRevision is rejected", async () => {
    seedOpenPanel();
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs({ expectedPanelRevision: 99 }));
    expect(result).toEqual({ ok: false, reason: "panel_stale" });
  });

  it("a stale expectedGovernanceUpdatedAt is rejected", async () => {
    seedOpenPanel();
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs({ expectedGovernanceUpdatedAt: "2019-01-01T00:00:00.000Z" }));
    expect(result).toEqual({ ok: false, reason: "governance_stale" });
  });

  it("a cancelled panel is rejected", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ status: "cancelled" }));
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(result).toEqual({ ok: false, reason: "panel_cancelled" });
  });

  it("a terminal governanceRecord (already decided outside the panel) is rejected as not_pending", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "approved" } }) });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel());
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(result).toEqual({ ok: false, reason: "not_pending" });
  });

  it("a malformed panel is rejected and never overwritten", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ quorum: 999 }));
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(result).toEqual({ ok: false, reason: "panel_malformed" });
  });

  it("no panel at all is rejected", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(result).toEqual({ ok: false, reason: "panel_absent" });
  });

  it("no run at all is rejected", async () => {
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(result).toEqual({ ok: false, reason: "run_missing" });
  });
});

describe("overrideAdaptiveHumanReviewPanel — idempotency (§F7)", () => {
  it("an exact retry (identical status/justification/conditions) is an idempotent already_overridden success", async () => {
    seedOpenPanel();
    const first = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(first.ok).toBe(true);
    const second = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.submissionStatus).toBe("already_overridden");
      expect(second.panel.finalDecisionId).toBe((first as any).panel.finalDecisionId);
    }
  });

  it("an idempotent retry never rewrites finalizedAt even with a later 'now'", async () => {
    seedOpenPanel();
    const first = await overrideAdaptiveHumanReviewPanel(baseArgs({ now: "2020-06-01T00:00:00.000Z" }));
    expect(first.ok).toBe(true);
    const second = await overrideAdaptiveHumanReviewPanel(baseArgs({ now: "2020-12-01T00:00:00.000Z" }));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.panel.finalizedAt).toBe("2020-06-01T00:00:00.000Z");
  });

  it("a CHANGED retry (different justification) against an already-overridden panel is a conflict, never an overwrite", async () => {
    seedOpenPanel();
    const first = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(first.ok).toBe(true);
    const changed = await overrideAdaptiveHumanReviewPanel(baseArgs({ justification: "a completely different justification" }));
    expect(changed).toEqual({ ok: false, reason: "panel_already_finalized" });
    // Canonical state is unchanged from the first override.
    expect(runDocs.get(RUN_ID)!.governanceRecord.humanReview.overrideJustification).toBe(baseArgs().justification);
  });

  it("a CHANGED retry (different status) against an already-overridden panel is a conflict", async () => {
    seedOpenPanel();
    const first = await overrideAdaptiveHumanReviewPanel(baseArgs({ status: "approved" }));
    expect(first.ok).toBe(true);
    const changed = await overrideAdaptiveHumanReviewPanel(baseArgs({ status: "rejected" }));
    expect(changed).toEqual({ ok: false, reason: "panel_already_finalized" });
  });

  it("overriding a panel already finalized via AGGREGATION is rejected as panel_already_finalized, never overwritten", async () => {
    seedOpenPanel();
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`, storedVote(R1, "approved"));
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R2)}`, storedVote(R2, "approved"));
    const finalizeResult = await finalizeAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: OWNER,
      expectedPanelRevision: 1,
      expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
      now: "2020-06-01T00:00:00.000Z",
    });
    expect(finalizeResult.ok).toBe(true);
    const overrideAttempt = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(overrideAttempt).toEqual({ ok: false, reason: "panel_already_finalized" });
    expect(runDocs.get(RUN_ID)!.governanceRecord.humanReview.decidedVia).toBe("multi_reviewer_panel"); // untouched
  });

  it("an inconsistent already-overridden state (humanReview doesn't match panel) fails closed", async () => {
    const decisionId = "panel_override_dec_00000000000000000000000000000000";
    runDocs.set(RUN_ID, {
      governanceRecord: governanceRecord({
        humanReview: { status: "rejected", decidedVia: "multi_reviewer_owner_override", panelRevision: 1, overrideJustification: "x" },
      }),
    });
    panelDocs.set(
      `${RUN_ID}/humanReviewPanel/current`,
      storedPanel({
        status: "finalized",
        revision: 2,
        updatedAt: "2020-06-01T00:00:00.000Z",
        finalizedAt: "2020-06-01T00:00:00.000Z",
        finalizedByUserId: OWNER,
        finalStatus: "approved", // MISMATCH — humanReview says "rejected"
        finalDecisionId: decisionId,
        finalizedVia: "owner_override",
        overrideJustificationPresent: true,
        overrideByUserId: OWNER,
        aggregationPolicyVersion: 1,
      })
    );
    // Craft args whose computed decision ID matches the stored one exactly,
    // to reach the consistency check rather than the "changed retry" branch.
    const { buildAdaptivePanelOverrideDecisionId } = require("@/lib/governance/adaptivePanelOverride");
    const matchingJustification = "matching-justification";
    const computedId = buildAdaptivePanelOverrideDecisionId({
      teamId: TEAM_ID,
      runId: RUN_ID,
      panelRevision: 1,
      status: "approved",
      justification: matchingJustification,
    });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, {
      ...panelDocs.get(`${RUN_ID}/humanReviewPanel/current`),
      finalDecisionId: computedId,
    });
    const result = await overrideAdaptiveHumanReviewPanel(
      baseArgs({ status: "approved", justification: matchingJustification, expectedPanelRevision: 1 })
    );
    expect(result).toEqual({ ok: false, reason: "inconsistent_finalization_state" });
  });
});

describe("overrideAdaptiveHumanReviewPanel — concurrency and races", () => {
  it("two overrides in immediate succession with the same request: the first performs the write, the second is idempotent", async () => {
    seedOpenPanel();
    const first = await overrideAdaptiveHumanReviewPanel(baseArgs());
    const second = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(first.ok && (first as any).submissionStatus).toBe("overridden");
    expect(second.ok && (second as any).submissionStatus).toBe("already_overridden");
  });

  it("a finalize attempt after an override already committed fails closed as panel_already_finalized, never reinterpreting the override as its own aggregation output", async () => {
    seedDeadlockedPanel();
    const overrideResult = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(overrideResult.ok).toBe(true);
    const finalizeResult = await finalizeAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: OWNER,
      expectedPanelRevision: 1, // the (correct) pre-override revision — proves this isn't just a stale-revision rejection
      expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
      now: "2020-06-01T00:00:00.000Z",
    });
    expect(finalizeResult).toEqual({ ok: false, reason: "panel_already_finalized" });
    // The panel remains overridden — never reopened or reassigned to aggregation.
    expect(panelDocs.get(`${RUN_ID}/humanReviewPanel/current`)!.finalizedVia).toBe("owner_override");
  });

  it("a finalize attempt with a genuinely stale expectedPanelRevision against an override-finalized panel is panel_stale, checked before the finalizedVia branch", async () => {
    seedDeadlockedPanel();
    const overrideResult = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(overrideResult.ok).toBe(true);
    const finalizeResult = await finalizeAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: OWNER,
      expectedPanelRevision: 0, // genuinely stale — predates even the original open panel
      expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
      now: "2020-06-01T00:00:00.000Z",
    });
    expect(finalizeResult).toEqual({ ok: false, reason: "panel_stale" });
  });

  it("a vote submitted after an override already committed fails closed as not_pending", async () => {
    seedOpenPanel();
    const overrideResult = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(overrideResult.ok).toBe(true);
    const voteResult = await submitAdaptiveHumanReviewVote({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserId: R1,
      panelRevision: 1, // stale view predating the override
      status: "approved",
    });
    expect(voteResult).toEqual({ ok: false, reason: "not_pending" });
  });

  it("a panel reconfiguration attempted after an override already committed fails closed as not_pending, never reopening", async () => {
    seedOpenPanel();
    const overrideResult = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(overrideResult.ok).toBe(true);
    const reconfigureResult = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: [R1, R2],
      actorUserId: "admin-uid",
      expectedRevision: 1,
    });
    expect(reconfigureResult).toEqual({ ok: false, reason: "not_pending" });
    expect(panelDocs.get(`${RUN_ID}/humanReviewPanel/current`)!.status).toBe("finalized");
    expect(panelDocs.get(`${RUN_ID}/humanReviewPanel/current`)!.finalizedVia).toBe("owner_override");
  });
});

describe("overrideAdaptiveHumanReviewPanel — firestore unavailable", () => {
  it("returns firestore_unavailable without throwing", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await overrideAdaptiveHumanReviewPanel(baseArgs());
    expect(result).toEqual({ ok: false, reason: "firestore_unavailable" });
  });
});

describe("overrideAdaptiveHumanReviewPanel — telemetry (Step 5.8/5.9)", () => {
  it("logs override_completed with safe metadata only, never the justification text", async () => {
    seedOpenPanel();
    await overrideAdaptiveHumanReviewPanel(baseArgs({ justification: "highly specific confidential reasoning" }));
    const call = mockLoggerInfo.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("override_completed"));
    expect(call).toBeDefined();
    const [, metadata] = call!;
    expect(metadata).toMatchObject({ operation: "override_completed", runId: RUN_ID, teamId: TEAM_ID });
    expect(JSON.stringify(metadata)).not.toContain("confidential reasoning");
  });

  it("logs override_stale on a stale expectedGovernanceUpdatedAt, never a success event", async () => {
    seedOpenPanel();
    mockLoggerInfo.mockClear();
    await overrideAdaptiveHumanReviewPanel(baseArgs({ expectedGovernanceUpdatedAt: "2019-01-01T00:00:00.000Z" }));
    const staleCall = mockLoggerInfo.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("override_stale"));
    expect(staleCall).toBeDefined();
    const completedCall = mockLoggerInfo.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("override_completed"));
    expect(completedCall).toBeUndefined();
  });
});
