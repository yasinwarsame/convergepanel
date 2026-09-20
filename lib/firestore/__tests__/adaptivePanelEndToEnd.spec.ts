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
// Phase 1 Cross-Authority Guard — the assignment document needs a real store
// here. Without one `txn.set(assignmentRef, …)` was silently dropped, so the
// "nothing was written" assertion below could not observe an assignment write
// and passed even with the guard relocated after it.
const assignmentDocs = new Map<string, Record<string, any>>();
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
              const store =
                subName === "humanReviewPanel" ? panelDocs : subName === "humanReviewAssignment" ? assignmentDocs : voteDocs;
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
        if (ref.__isAssignmentRef) {
          const key = `${ref.__runId}/humanReviewAssignment/current`;
          return { exists: assignmentDocs.has(key), data: () => assignmentDocs.get(key) };
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
        } else if (ref.__isAssignmentRef) {
          assignmentDocs.set(`${ref.__runId}/humanReviewAssignment/current`, value);
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
                __isAssignmentRef: subName === "humanReviewAssignment" && docId === "current",
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
  cancelAdaptiveHumanReviewPanel,
  submitAdaptiveHumanReviewAssignment,
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
  assignmentDocs.clear();
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

/**
 * PHASE 1 REVIEW STACK CROSS-AUTHORITY GUARD — Workspace authority is
 * EXCLUSIVE over a Workspace-bound run's human-review state.
 *
 * THE STRUCTURAL HOLE THIS CLOSES. Two mutation stacks write the same
 * documents. The legacy stack (`/api/teams/adaptive-runs/{runId}/…`)
 * authorizes through the legacy `teams` document — membership plus
 * `isTeamAdmin()` — and a `teamRuns` projection. The canonical Workspace
 * stack authorizes through Team Workspace membership plus `reviews.manage`
 * and `research.read`. A single run can hold BOTH bindings, because
 * `lib/runPanelExecution.ts` writes a legacy `teamRuns` projection whenever
 * the run OWNER belongs to a legacy team with adaptive review enabled.
 * Nothing stopped a legacy team admin, holding no Workspace capability at
 * all, from finalizing, overriding, cancelling, re-assigning or voting on a
 * panel the Workspace stack governs.
 *
 * WHAT THE FIXTURE DOES. It builds a REAL open panel through the real
 * services on a legacy run, then changes ONE thing — it binds the run to a
 * Workspace — and re-runs every legacy mutation. Nothing else differs, so a
 * denial can only be attributable to the binding. Each case also asserts
 * ZERO mutation: panel, votes and the run document must be byte-identical
 * afterwards, because a guard that denies only after writing is not a guard.
 */
describe("legacy review mutations cannot touch a Workspace-bound run", () => {
  const OWNER_UID = "owner-uid";

  /** Every mutable store, captured so "nothing changed" is checkable. */
  function snapshot() {
    return JSON.stringify({
      runs: [...runDocs.entries()].sort(),
      panels: [...panelDocs.entries()].sort(),
      votes: [...voteDocs.entries()].sort(),
      assignments: [...assignmentDocs.entries()].sort(),
    });
  }

  /** An open panel on a genuinely legacy run — the shared starting state. */
  async function openPanelOnLegacyRun() {
    runDocs.set(RUN_ID, { userId: OWNER_UID, governanceRecord: governanceRecord() });
    const created = await submitAdaptiveHumanReviewPanel({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserIds: [R1, R2, R3],
      actorUserId: OWNER,
      expectedRevision: 0,
      now: "2020-01-01T01:00:00.000Z",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("fixture could not open a panel");

    // Cast every vote, so the panel is genuinely finalizable. Without this the
    // finalize/override probes short-circuit at `quorum_not_met` BEFORE their
    // write, and the zero-side-effect assertion never exercises their ordering.
    for (const reviewer of [R1, R2, R3]) {
      const voted = await submitAdaptiveHumanReviewVote({
        runId: RUN_ID,
        teamId: TEAM_ID,
        reviewerUserId: reviewer,
        panelRevision: created.panel.revision,
        status: "approved",
      });
      expect(voted.ok).toBe(true);
    }
    return created.panel.revision;
  }

  /** Every legacy TEAM mutation over the shared review state. */
  function legacyMutations(revision: number) {
    return [
      ["panel create/reconfigure", () => submitAdaptiveHumanReviewPanel({ runId: RUN_ID, teamId: TEAM_ID, reviewerUserIds: [R1, R2], actorUserId: OWNER, expectedRevision: revision })],
      ["panel cancel", () => cancelAdaptiveHumanReviewPanel({ runId: RUN_ID, teamId: TEAM_ID, actorUserId: OWNER, expectedRevision: revision })],
      ["vote", () => submitAdaptiveHumanReviewVote({ runId: RUN_ID, teamId: TEAM_ID, reviewerUserId: R1, panelRevision: revision, status: "approved" })],
      ["finalize", () => finalizeAdaptiveHumanReviewPanel({ runId: RUN_ID, teamId: TEAM_ID, actorUserId: OWNER, expectedPanelRevision: revision, expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z" })],
      ["override", () => overrideAdaptiveHumanReviewPanel({ runId: RUN_ID, teamId: TEAM_ID, actorUserId: OWNER, expectedPanelRevision: revision, expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z", status: "approved" })],
      ["assignment", () => submitAdaptiveHumanReviewAssignment({ runId: RUN_ID, teamId: TEAM_ID, newReviewerUserId: R2, actorUserId: OWNER, expectedRevision: 0 })],
    ] as const;
  }

  const BINDINGS: [label: string, workspaceId: unknown][] = [
    ["a Team Workspace", "ws-team-1"],
    ["its owner's Personal Workspace", `personal-${OWNER_UID}`],
    ["a malformed binding", 12345],
  ];

  it.each(BINDINGS)("refuses every legacy mutation when the run is bound to %s", async (_label, workspaceId) => {
    const revision = await openPanelOnLegacyRun();
    // The ONLY change: the canonical run record gains a Workspace binding.
    runDocs.set(RUN_ID, { ...runDocs.get(RUN_ID), workspaceId });
    const before = snapshot();

    for (const [name, run] of legacyMutations(revision)) {
      const result = await run();
      // Denied, and indistinguishable from a run that does not exist.
      expect(`${name} => ${JSON.stringify(result)}`).toBe(`${name} => ${JSON.stringify({ ok: false, reason: "run_missing" })}`);
      // And nothing was written on the way to that denial.
      expect(`${name} => ${snapshot()}`).toBe(`${name} => ${before}`);
    }
  });

  it("still allows every legacy mutation on a genuinely legacy run", async () => {
    // The drain control. Without this, a guard that refused everything
    // would satisfy every assertion above.
    const revision = await openPanelOnLegacyRun();
    expect(runDocs.get(RUN_ID)).not.toHaveProperty("workspaceId");

    // Three different legacy mutations, in an order the panel lifecycle
    // actually permits: vote on the open panel, then drain it by cancelling.
    const voted = await submitAdaptiveHumanReviewVote({ runId: RUN_ID, teamId: TEAM_ID, reviewerUserId: R1, panelRevision: revision, status: "approved" });
    expect(voted.ok).toBe(true);

    const assigned = await submitAdaptiveHumanReviewAssignment({ runId: RUN_ID, teamId: TEAM_ID, newReviewerUserId: R2, actorUserId: OWNER, expectedRevision: 0 });
    expect(assigned.ok).toBe(true);

    const cancelled = await cancelAdaptiveHumanReviewPanel({ runId: RUN_ID, teamId: TEAM_ID, actorUserId: OWNER, expectedRevision: revision });
    expect(cancelled.ok).toBe(true);
  });

  it("does not disturb the PERSONAL assignment path on a Workspace-bound run", async () => {
    // `teamId: null` is `personalReviewerAssignment`'s propagation call. A
    // personal run legitimately carries its owner's Personal Workspace id,
    // so excluding it would have broken reviewer propagation outright.
    runDocs.set(RUN_ID, {
      userId: OWNER_UID,
      workspaceId: `personal-${OWNER_UID}`,
      governanceRecord: governanceRecord(),
    });
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: null,
      newReviewerUserId: R1,
      actorUserId: OWNER_UID,
      expectedRevision: 0,
    });
    expect(result.ok).toBe(true);
  });

  it("denies a legacy TEAM assignment on that same Workspace-bound run", async () => {
    // Same run, same state — only the authority differs.
    runDocs.set(RUN_ID, {
      userId: OWNER_UID,
      workspaceId: `personal-${OWNER_UID}`,
      governanceRecord: governanceRecord(),
    });
    const before = snapshot();
    const result = await submitAdaptiveHumanReviewAssignment({
      runId: RUN_ID,
      teamId: TEAM_ID,
      newReviewerUserId: R1,
      actorUserId: OWNER,
      expectedRevision: 0,
    });
    expect(result).toEqual({ ok: false, reason: "run_missing" });
    expect(snapshot()).toBe(before);
  });
});
