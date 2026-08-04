/**
 * Multi-Reviewer Owner Override, Part F (§F23) — end-to-end contract
 * tests chaining the REAL production Firestore-layer functions together
 * (never mocked at the function level) through complete lifecycle flows:
 *
 * 1. Normal aggregation flow: create panel → vote → ready → finalize →
 *    canonical terminal → finalized panel → no further votes/finalize/
 *    override/reconfigure possible.
 * 2. Deadlock override flow: create panel → deadlocking votes →
 *    deadlocked → owner override → canonical terminal → finalized via
 *    override → votes unchanged → no further mutation possible.
 * 3. Single-review coexistence: no panel ever created → the panel getter
 *    reports "absent" and nothing in this module touches or requires a
 *    panel to exist.
 */

const runDocs = new Map<string, Record<string, any>>();
const panelDocs = new Map<string, Record<string, any>>();
const voteDocs = new Map<string, Record<string, any>>();
const teamDocs = new Map<string, Record<string, any>>();
const firestoreUnavailableFlag = { value: false };

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "teams") {
      return {
        doc: (teamId: string) => ({
          id: teamId,
          get: jest.fn().mockImplementation(async () => ({ exists: teamDocs.has(teamId), data: () => teamDocs.get(teamId) })),
        }),
      };
    }
    return {
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
    };
  },
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
        if (ref.__isTeamRef) {
          return { exists: teamDocs.has(ref.__teamId), data: () => teamDocs.get(ref.__teamId) };
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
        } else if (ref.__isVoteRef) {
          voteDocs.set(`${ref.__runId}/humanReviewVotes/${ref.__voteId}`, value);
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

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const originalCollection = mockAdminDb.collection;
mockAdminDb.collection = (name: string) => {
  const base = originalCollection(name);
  if (name === "teams") {
    return {
      doc: (teamId: string) => {
        const ref = base.doc(teamId);
        return { ...ref, id: teamId, __isTeamRef: true, __teamId: teamId };
      },
    };
  }
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
  submitAdaptiveHumanReviewPanel,
  submitAdaptiveHumanReviewVote,
  finalizeAdaptiveHumanReviewPanel,
  overrideAdaptiveHumanReviewPanel,
  getAdaptiveHumanReviewPanel,
} from "@/lib/firestore/runs";

const RUN_ID = "run-1";
const TEAM_ID = "team-1";
const OWNER = "owner-uid";
const R1 = "reviewer-1";
const R2 = "reviewer-2";
const R3 = "reviewer-3";

function team() {
  return {
    id: TEAM_ID,
    name: "Test Team",
    createdBy: OWNER,
    members: [
      { uid: OWNER, email: "owner@test.com", role: "owner", joinedAt: "x" },
      { uid: R1, email: "r1@test.com", role: "admin", joinedAt: "x" },
      { uid: R2, email: "r2@test.com", role: "admin", joinedAt: "x" },
      { uid: R3, email: "r3@test.com", role: "admin", joinedAt: "x" },
    ],
    policyRules: [],
    settings: {},
  };
}

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

beforeEach(() => {
  runDocs.clear();
  panelDocs.clear();
  voteDocs.clear();
  teamDocs.clear();
  firestoreUnavailableFlag.value = false;
  teamDocs.set(TEAM_ID, team());
});

describe("End-to-end — normal aggregation flow", () => {
  it("create → vote → ready → finalize → canonical terminal → finalized panel → no further action possible", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });

    // 1. Create the panel.
    const created = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: [R1, R2, R3],
      actorUserId: OWNER,
      expectedRevision: 0,
      now: "2020-01-01T01:00:00.000Z",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.panel.status).toBe("open");
    expect(created.panel.revision).toBe(1);

    // 2. Two of three reviewers vote approved — strict majority reached.
    const vote1 = await submitAdaptiveHumanReviewVote({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserId: R1,
      panelRevision: 1,
      status: "approved",
      now: "2020-01-01T02:00:00.000Z",
    });
    expect(vote1.ok).toBe(true);
    const vote2 = await submitAdaptiveHumanReviewVote({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserId: R2,
      panelRevision: 1,
      status: "approved",
      now: "2020-01-01T02:30:00.000Z",
    });
    expect(vote2.ok).toBe(true);

    // 3. Finalize — the panel is now "ready" (2/3, quorum 2).
    const finalized = await finalizeAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: OWNER,
      expectedPanelRevision: 1,
      expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
      now: "2020-01-01T03:00:00.000Z",
    });
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    expect(finalized.submissionStatus).toBe("finalized");
    expect(finalized.humanReview.status).toBe("approved");
    expect(finalized.humanReview.decidedVia).toBe("multi_reviewer_panel");
    expect(finalized.panel.status).toBe("finalized");
    expect(finalized.panel.finalizedVia).toBe("aggregation");

    // 4. Canonical terminal: governanceRecord.humanReview is now terminal.
    expect(runDocs.get(RUN_ID)!.governanceRecord.humanReview.status).toBe("approved");

    // 5. The panel is finalized — reading it back confirms terminal state.
    const readBack = await getAdaptiveHumanReviewPanel(RUN_ID, TEAM_ID);
    expect(readBack.status).toBe("found");
    if (readBack.status === "found") expect(readBack.panel.status).toBe("finalized");

    // 6. No further vote is accepted.
    const lateVote = await submitAdaptiveHumanReviewVote({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserId: R3,
      panelRevision: 1,
      status: "approved",
    });
    expect(lateVote.ok).toBe(false);

    // 7. No further finalize (idempotent retry aside) with a stale view is accepted as fresh.
    const reFinalize = await finalizeAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: OWNER,
      expectedPanelRevision: 1,
      expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(reFinalize.ok).toBe(true);
    if (reFinalize.ok) expect(reFinalize.submissionStatus).toBe("already_finalized");

    // 8. No override is accepted against an already aggregation-finalized panel.
    const overrideAttempt = await overrideAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: OWNER,
      expectedPanelRevision: 1,
      expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
      status: "approved",
      justification: "Trying to override an already-decided panel.",
    });
    expect(overrideAttempt).toEqual({ ok: false, reason: "panel_already_finalized" });
  });
});

describe("End-to-end — deadlock override flow", () => {
  it("create → deadlocking votes → deadlocked → owner override → canonical terminal → finalized via override → votes unchanged → artifacts recorded", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });

    // 1. Create a 2-reviewer panel (quorum 2 — both must vote).
    const created = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: [R1, R2],
      actorUserId: OWNER,
      expectedRevision: 0,
      now: "2020-01-01T01:00:00.000Z",
    });
    expect(created.ok).toBe(true);

    // 2. A split vote — deadlock.
    const vote1 = await submitAdaptiveHumanReviewVote({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserId: R1,
      panelRevision: 1,
      status: "approved",
      now: "2020-01-01T02:00:00.000Z",
    });
    expect(vote1.ok).toBe(true);
    const vote2 = await submitAdaptiveHumanReviewVote({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserId: R2,
      panelRevision: 1,
      status: "rejected",
      comment: "Disagree with the conclusion.",
      now: "2020-01-01T02:30:00.000Z",
    });
    expect(vote2.ok).toBe(true);

    // 3. Confirm the panel is genuinely deadlocked (finalize is rejected as such).
    const finalizeAttempt = await finalizeAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: OWNER,
      expectedPanelRevision: 1,
      expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(finalizeAttempt).toEqual({ ok: false, reason: "panel_deadlocked" });

    // 4. Owner override — breaks the deadlock.
    const votesBefore = new Map(voteDocs);
    const overridden = await overrideAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: OWNER,
      expectedPanelRevision: 1,
      expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
      status: "approved",
      justification: "The deadline has passed and a decision is required despite the deadlock.",
      now: "2020-01-01T04:00:00.000Z",
    });
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) return;
    expect(overridden.submissionStatus).toBe("overridden");
    expect(overridden.humanReview.status).toBe("approved");
    expect(overridden.humanReview.decidedVia).toBe("multi_reviewer_owner_override");
    expect(overridden.humanReview.overrideJustification).toContain("deadline has passed");
    expect(overridden.panel.status).toBe("finalized");
    expect(overridden.panel.finalizedVia).toBe("owner_override");
    expect(overridden.panel.overrideByUserId).toBe(OWNER);

    // 5. Canonical terminal.
    expect(runDocs.get(RUN_ID)!.governanceRecord.humanReview.status).toBe("approved");
    expect(runDocs.get(RUN_ID)!.governanceRecord.humanReview.decidedVia).toBe("multi_reviewer_owner_override");

    // 6. Votes are byte-for-byte unchanged by the override.
    for (const [key, value] of votesBefore) {
      expect(voteDocs.get(key)).toEqual(value);
    }
    expect(voteDocs.size).toBe(votesBefore.size);

    // 7. No further vote, finalize, or reconfiguration is accepted.
    const lateVote = await submitAdaptiveHumanReviewVote({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserId: R1,
      panelRevision: 1,
      status: "rejected",
      comment: "changed my mind",
    });
    expect(lateVote.ok).toBe(false);

    const lateFinalize = await finalizeAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: OWNER,
      expectedPanelRevision: 1,
      expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(lateFinalize).toEqual({ ok: false, reason: "panel_already_finalized" });

    const lateReconfigure = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: [R1, R3],
      actorUserId: OWNER,
      expectedRevision: 1,
    });
    expect(lateReconfigure).toEqual({ ok: false, reason: "not_pending" });
  });
});

describe("End-to-end — single-reviewer coexistence (no panel ever created)", () => {
  it("a run with no panel reports panel absent, and creating one later is still possible while pending", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });

    const initialRead = await getAdaptiveHumanReviewPanel(RUN_ID, TEAM_ID);
    expect(initialRead).toEqual({ status: "absent" });

    // Nothing about the presence/absence of a panel affects the governance
    // record until a panel actually exists and is finalized/overridden —
    // the single-reviewer decision route (untouched by Part F, not
    // exercised here) remains the ONLY path to a terminal decision for
    // this run for as long as no panel exists.
    expect(runDocs.get(RUN_ID)!.governanceRecord.humanReview.status).toBe("unreviewed");

    // A panel can still be created later, on demand, while the review is pending.
    const created = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: [R1, R2],
      actorUserId: OWNER,
      expectedRevision: 0,
    });
    expect(created.ok).toBe(true);
  });
});
