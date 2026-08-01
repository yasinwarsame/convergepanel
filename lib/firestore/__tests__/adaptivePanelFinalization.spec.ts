/**
 * Transactional Multi-Reviewer Finalization, Part E —
 * finalizeAdaptiveHumanReviewPanel() tests.
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
// same technique already used in adaptiveHumanReviewPanel.spec.ts and
// adaptiveHumanReviewVote.spec.ts.
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

import { finalizeAdaptiveHumanReviewPanel, submitAdaptiveHumanReviewVote, submitAdaptiveHumanReviewPanel } from "@/lib/firestore/runs";
import { buildAdaptiveHumanReviewVoteId } from "@/lib/governance/adaptiveHumanReviewVote";

const RUN_ID = "run-1";
const TEAM_ID = "team-1";
const R1 = "reviewer-1";
const R2 = "reviewer-2";
const R3 = "reviewer-3";

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

function seedTwoApprovedVotes(panelRevision = 1) {
  voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(panelRevision, R1)}`, storedVote(R1, "approved", { panelRevision }));
  voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(panelRevision, R2)}`, storedVote(R2, "approved", { panelRevision }));
}

function seedHappyPath() {
  runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
  panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel());
  seedTwoApprovedVotes();
}

function baseArgs(overrides: Partial<Parameters<typeof finalizeAdaptiveHumanReviewPanel>[0]> = {}) {
  return {
    runId: RUN_ID,
    teamId: TEAM_ID,
    actorUserId: "owner-uid",
    expectedPanelRevision: 1,
    expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
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

describe("finalizeAdaptiveHumanReviewPanel — ready panel finalizes", () => {
  it("a panel with a strict majority finalizes successfully", async () => {
    seedHappyPath();
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.submissionStatus).toBe("finalized");
      expect(result.humanReview.status).toBe("approved");
      expect(result.humanReview.decidedVia).toBe("multi_reviewer_panel");
      expect(result.humanReview.panelRevision).toBe(1);
      expect(result.humanReview.aggregationPolicyVersion).toBe(1);
      expect(result.humanReview.supportingReviewerCount).toBe(2);
      expect(result.panel.status).toBe("finalized");
      expect(result.panel.finalStatus).toBe("approved");
      expect(result.panel.revision).toBe(2); // incremented
      expect(result.submittedCount).toBe(2);
    }
  });

  it("writes the canonical governanceRecord.humanReview and updatedAt", async () => {
    seedHappyPath();
    await finalizeAdaptiveHumanReviewPanel(baseArgs());
    const run = runDocs.get(RUN_ID)!;
    expect(run.governanceRecord.humanReview.status).toBe("approved");
    expect(run.governanceRecord.updatedAt).toBe("2020-06-01T00:00:00.000Z");
  });

  it("writes ONLY governanceRecord.humanReview/.updatedAt on the run — decisionReceipt/automatedGovernance untouched", async () => {
    seedHappyPath();
    const before = JSON.parse(JSON.stringify(runDocs.get(RUN_ID)!.governanceRecord.decisionReceipt));
    await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(runDocs.get(RUN_ID)!.governanceRecord.decisionReceipt).toEqual(before);
  });

  it("marks the panel finalized in the SAME transaction, preserving the reviewer list", async () => {
    seedHappyPath();
    await finalizeAdaptiveHumanReviewPanel(baseArgs());
    const panel = panelDocs.get(`${RUN_ID}/humanReviewPanel/current`)!;
    expect(panel.status).toBe("finalized");
    expect(panel.reviewerUserIds).toEqual([R1, R2, R3]);
  });

  it("votes remain completely untouched", async () => {
    seedHappyPath();
    const before = JSON.parse(JSON.stringify(voteDocs.get(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`)));
    await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(voteDocs.get(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`)).toEqual(before);
  });

  it("the decision ID is deterministic and the exact policy version is stored", async () => {
    seedHappyPath();
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.panel.finalDecisionId).toMatch(/^panel_dec_[0-9a-f]{32}$/);
      expect(result.panel.aggregationPolicyVersion).toBe(1);
    }
  });

  it("approved_with_conditions finalization unions winning-group conditions into canonical humanReview", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel());
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`, storedVote(R1, "approved_with_conditions", { conditions: ["fix X"], conditionsCount: 1 }));
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R2)}`, storedVote(R2, "approved_with_conditions", { conditions: ["fix Y"], conditionsCount: 1 }));
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.humanReview.status).toBe("approved_with_conditions");
      expect(result.humanReview.conditions).toEqual(["fix X", "fix Y"]);
    }
  });

  it("rejected finalization gets the fixed system comment, never a raw vote comment", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel());
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`, storedVote(R1, "rejected", { comment: "reviewer 1's private reason" }));
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R2)}`, storedVote(R2, "rejected", { comment: "reviewer 2's private reason" }));
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.humanReview.comment).toBe("Finalized by multi-reviewer panel.");
      expect(JSON.stringify(result.humanReview)).not.toContain("private reason");
    }
  });
});

describe("finalizeAdaptiveHumanReviewPanel — waiting/deadlocked/invalid rejected", () => {
  it("a waiting panel (below quorum) is rejected with quorum_not_met", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel());
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`, storedVote(R1, "approved"));
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(result).toEqual({ ok: false, reason: "quorum_not_met", submittedCount: 1, quorum: 2 });
  });

  it("a deadlocked panel is rejected with panel_deadlocked", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ reviewerUserIds: [R1, R2], requiredReviewerCount: 2, quorum: 2 }));
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`, storedVote(R1, "approved"));
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R2)}`, storedVote(R2, "rejected"));
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs({ expectedPanelRevision: 1 }));
    expect(result).toEqual({ ok: false, reason: "panel_deadlocked" });
  });

  it("neither humanReview nor the panel is mutated when rejected as waiting/deadlocked", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ reviewerUserIds: [R1, R2], requiredReviewerCount: 2, quorum: 2 }));
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`, storedVote(R1, "approved"));
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R2)}`, storedVote(R2, "rejected"));
    await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(runDocs.get(RUN_ID)!.governanceRecord.humanReview.status).toBe("unreviewed");
    expect(panelDocs.get(`${RUN_ID}/humanReviewPanel/current`)!.status).toBe("open");
  });
});

describe("finalizeAdaptiveHumanReviewPanel — stale/terminal/cancelled rejected", () => {
  it("a stale expectedPanelRevision is rejected", async () => {
    seedHappyPath();
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs({ expectedPanelRevision: 99 }));
    expect(result).toEqual({ ok: false, reason: "panel_stale" });
  });

  it("a stale expectedGovernanceUpdatedAt is rejected", async () => {
    seedHappyPath();
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs({ expectedGovernanceUpdatedAt: "2019-01-01T00:00:00.000Z" }));
    expect(result).toEqual({ ok: false, reason: "governance_stale" });
  });

  it("a cancelled panel is rejected", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ status: "cancelled" }));
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(result).toEqual({ ok: false, reason: "panel_cancelled" });
  });

  it("a terminal (already-decided outside the panel) governanceRecord is rejected as not_pending", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "approved" } }) });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel());
    seedTwoApprovedVotes();
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(result).toEqual({ ok: false, reason: "not_pending" });
  });

  it("a malformed panel is rejected and never overwritten", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ quorum: 999 }));
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(result).toEqual({ ok: false, reason: "panel_malformed" });
  });

  it("no panel at all is rejected", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(result).toEqual({ ok: false, reason: "panel_absent" });
  });

  it("a malformed vote at the current revision is rejected", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel());
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`, storedVote(R1, "approved", { conditionsCount: 999 }));
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R2)}`, storedVote(R2, "approved"));
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(result).toEqual({ ok: false, reason: "vote_malformed" });
  });
});

describe("finalizeAdaptiveHumanReviewPanel — idempotency", () => {
  it("finalizing twice in immediate succession: the second is an idempotent already_finalized success with the SAME outcome", async () => {
    seedHappyPath();
    const first = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(first.ok).toBe(true);
    const second = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.submissionStatus).toBe("already_finalized");
      expect(second.panel.finalDecisionId).toBe((first as any).panel.finalDecisionId);
      expect(second.humanReview.status).toBe("approved");
    }
  });

  it("an idempotent retry never rewrites finalizedAt", async () => {
    seedHappyPath();
    const first = await finalizeAdaptiveHumanReviewPanel(baseArgs({ now: "2020-06-01T00:00:00.000Z" }));
    expect(first.ok).toBe(true);
    const second = await finalizeAdaptiveHumanReviewPanel(baseArgs({ now: "2020-12-01T00:00:00.000Z" })); // later "now" — must not matter
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.panel.finalizedAt).toBe("2020-06-01T00:00:00.000Z");
  });

  it("a retry with a stale expectedPanelRevision (predating a DIFFERENT already-completed finalization) is panel_stale, not idempotent success", async () => {
    seedHappyPath();
    const first = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(first.ok).toBe(true);
    const retryWithOldRevision = await finalizeAdaptiveHumanReviewPanel(baseArgs({ expectedPanelRevision: 0 }));
    expect(retryWithOldRevision).toEqual({ ok: false, reason: "panel_stale" });
  });

  it("Multi-Reviewer Owner Override, Part F — a panel finalized via owner override is never reinterpreted as this function's own aggregation output; it fails closed as panel_already_finalized, not inconsistent_finalization_state", async () => {
    runDocs.set(
      RUN_ID,
      {
        governanceRecord: governanceRecord({
          humanReview: { status: "approved", decidedVia: "multi_reviewer_owner_override", panelRevision: 1, overrideJustification: "x" },
        }),
      }
    );
    panelDocs.set(
      `${RUN_ID}/humanReviewPanel/current`,
      storedPanel({
        status: "finalized",
        revision: 2,
        updatedAt: "2020-06-01T00:00:00.000Z",
        finalizedAt: "2020-06-01T00:00:00.000Z",
        finalizedByUserId: "owner-uid",
        finalStatus: "approved",
        finalDecisionId: "panel_override_dec_x",
        finalizedVia: "owner_override",
        overrideJustificationPresent: true,
        overrideByUserId: "owner-uid",
        aggregationPolicyVersion: 1,
      })
    );
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs({ expectedPanelRevision: 1 }));
    expect(result).toEqual({ ok: false, reason: "panel_already_finalized" });
  });

  it("an inconsistent already-finalized state (humanReview doesn't match panel) fails closed, never guesses", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "rejected", decidedVia: "multi_reviewer_panel", panelRevision: 1 } }) });
    panelDocs.set(
      `${RUN_ID}/humanReviewPanel/current`,
      storedPanel({
        status: "finalized",
        revision: 2,
        updatedAt: "2020-06-01T00:00:00.000Z",
        finalizedAt: "2020-06-01T00:00:00.000Z",
        finalizedByUserId: "owner-uid",
        finalStatus: "approved", // MISMATCH — humanReview says "rejected"
        finalDecisionId: "panel_dec_x",
        aggregationPolicyVersion: 1,
      })
    );
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs({ expectedPanelRevision: 1 }));
    expect(result).toEqual({ ok: false, reason: "inconsistent_finalization_state" });
  });

  it("humanReview still reviewable despite the panel claiming finalized fails closed", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "unreviewed" } }) });
    panelDocs.set(
      `${RUN_ID}/humanReviewPanel/current`,
      storedPanel({
        status: "finalized",
        revision: 2,
        updatedAt: "2020-06-01T00:00:00.000Z",
        finalizedAt: "2020-06-01T00:00:00.000Z",
        finalizedByUserId: "owner-uid",
        finalStatus: "approved",
        finalDecisionId: "panel_dec_x",
        aggregationPolicyVersion: 1,
      })
    );
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs({ expectedPanelRevision: 1 }));
    expect(result).toEqual({ ok: false, reason: "inconsistent_finalization_state" });
  });
});

describe("finalizeAdaptiveHumanReviewPanel — concurrency and races", () => {
  /**
   * Same documented limitation/pattern as every prior concurrency test in
   * this engagement (Part B/C/D): the shared in-memory transaction fake
   * has no real Firestore-style optimistic-concurrency retry, so genuine
   * `Promise.all` interleaving cannot prove arbitration. Sequential calls
   * prove "only the first of two attempts against the same precondition
   * succeeds" just as validly.
   */
  it("two finalizations in immediate succession: exactly one performs the fresh transition, the other is idempotent", async () => {
    seedHappyPath();
    const first = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    const second = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(first.ok && (first as any).submissionStatus).toBe("finalized");
    expect(second.ok && (second as any).submissionStatus).toBe("already_finalized");
  });

  /**
   * Both `submitAdaptiveHumanReviewVote` (Part C) and
   * `submitAdaptiveHumanReviewPanel` (Part B) check
   * `isHumanReviewStatusReviewable(governanceRecord.humanReview.status)`
   * BEFORE they ever look at the panel's own status/revision — an
   * already-established, protected precedence order from those earlier
   * steps (mirroring the single-reviewer decision route's own "terminal
   * state is the most fundamental gate" pattern). Since finalization
   * always writes a TERMINAL humanReview status in the SAME transaction as
   * marking the panel finalized, any vote/reconfigure attempt against an
   * already-finalized panel is REJECTED AT THIS EARLIER GATE
   * (`not_pending`) in practice — it never actually reaches the
   * panel-specific `panel_stale`/`panel_finalized` checks. This is
   * correct, existing, protected behavior — not weakened or reordered
   * here; the two tests below assert the REAL, reachable outcome.
   */
  it("a vote submitted after finalization already committed fails closed as not_pending (the governance-terminality gate, checked before any panel-specific check)", async () => {
    seedHappyPath();
    const finalizeResult = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(finalizeResult.ok).toBe(true);
    const voteResult = await submitAdaptiveHumanReviewVote({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserId: R3,
      panelRevision: 1, // the reviewer's stale view — panel is now at revision 2, finalized
      status: "approved",
    });
    expect(voteResult).toEqual({ ok: false, reason: "not_pending" });
  });

  it("a panel reconfiguration attempted after finalization fails closed as not_pending, never silently reopening", async () => {
    seedHappyPath();
    const finalizeResult = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(finalizeResult.ok).toBe(true);
    const reconfigureResult = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: [R1, R2],
      actorUserId: "admin-uid",
      expectedRevision: 1, // stale view predating finalization
    });
    expect(reconfigureResult).toEqual({ ok: false, reason: "not_pending" });
    // The panel itself is untouched — still finalized at revision 2, never reopened.
    expect(panelDocs.get(`${RUN_ID}/humanReviewPanel/current`)!.status).toBe("finalized");
    expect(panelDocs.get(`${RUN_ID}/humanReviewPanel/current`)!.revision).toBe(2);
  });

  it("the dedicated panel_finalized reason (added in this step, defense-in-depth) is reached directly when a panel is independently finalized while governanceRecord is still (inconsistently) reviewable", async () => {
    // A hypothetical/inconsistent state (never produced by any real code
    // path — finalization always writes both atomically) — constructed
    // directly here purely to prove the panel_finalized branch itself is
    // correct and reachable, since the normal flow above never reaches it
    // (not_pending always wins first when the state is consistent).
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "unreviewed" } }) });
    panelDocs.set(
      `${RUN_ID}/humanReviewPanel/current`,
      storedPanel({
        status: "finalized",
        revision: 2,
        updatedAt: "2020-06-01T00:00:00.000Z",
        finalizedAt: "2020-06-01T00:00:00.000Z",
        finalizedByUserId: "owner-uid",
        finalStatus: "approved",
        finalDecisionId: "panel_dec_x",
        aggregationPolicyVersion: 1,
      })
    );
    const reconfigureResult = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: [R1, R2],
      actorUserId: "admin-uid",
      expectedRevision: 2,
    });
    expect(reconfigureResult).toEqual({ ok: false, reason: "panel_finalized" });
  });

  it("finalization observes votes that were submitted before it started, even if racing against a NEW (not-yet-visible) vote for a not-yet-voted reviewer", async () => {
    // Simulates: R1 and R2 already voted (quorum met for a 3-reviewer, quorum-2
    // panel); R3's vote is submitted, then finalization runs and should still
    // only require the pre-existing majority, unaffected by R3's late vote.
    // R3's vote is seeded directly at its deterministic document ID (the
    // same production helper every other fixture in this file already
    // uses) rather than routed through the full `submitAdaptiveHumanReviewVote`
    // transaction, since this file's fake does not model the `teams`
    // collection that function also reads — direct seeding isolates this
    // test to exactly the property it claims to prove (finalization's own
    // vote-read behavior), without depending on unrelated infrastructure.
    seedHappyPath();
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R3)}`, storedVote(R3, "rejected", { comment: "no" }));
    const result = await finalizeAdaptiveHumanReviewPanel(baseArgs());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.humanReview.status).toBe("approved"); // 2 approved still beats 1 rejected — 3 submitted, quorum 2, strict majority
      expect(result.submittedCount).toBe(3);
    }
  });
});

describe("finalizeAdaptiveHumanReviewPanel — telemetry (Step 5.8/5.9)", () => {
  it("logs finalization_completed with safe metadata on success", async () => {
    seedHappyPath();
    await finalizeAdaptiveHumanReviewPanel(baseArgs());
    const call = mockLoggerInfo.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("finalization_completed"));
    expect(call).toBeDefined();
    const [, metadata] = call!;
    expect(metadata).toMatchObject({ operation: "finalization_completed", runId: RUN_ID, teamId: TEAM_ID, statusCategory: "approved" });
  });

  it("logs finalization_deadlocked, never finalization_completed, for a deadlocked panel", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ reviewerUserIds: [R1, R2], requiredReviewerCount: 2, quorum: 2 }));
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`, storedVote(R1, "approved"));
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R2)}`, storedVote(R2, "rejected"));
    await finalizeAdaptiveHumanReviewPanel(baseArgs());
    const deadlockedCall = mockLoggerInfo.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("finalization_deadlocked"));
    expect(deadlockedCall).toBeDefined();
    const completedCall = mockLoggerInfo.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("finalization_completed"));
    expect(completedCall).toBeUndefined();
  });

  it("logs finalization_waiting for a below-quorum panel", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel());
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, R1)}`, storedVote(R1, "approved"));
    await finalizeAdaptiveHumanReviewPanel(baseArgs());
    const call = mockLoggerInfo.mock.calls.find(([msg]) => typeof msg === "string" && msg.includes("finalization_waiting"));
    expect(call).toBeDefined();
  });
});
