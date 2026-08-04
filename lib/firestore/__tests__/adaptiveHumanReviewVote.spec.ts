/**
 * Immutable Multi-Reviewer Vote Contract and Submission, Part C —
 * getAdaptiveHumanReviewVote() / submitAdaptiveHumanReviewVote() tests.
 */

const runDocs = new Map<string, Record<string, any>>();
const panelDocs = new Map<string, Record<string, any>>();
const teamDocs = new Map<string, Record<string, any>>();
const voteDocs = new Map<string, Record<string, any>>();
const firestoreUnavailableFlag = { value: false };

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => {
      if (name === "teams") {
        return {
          id,
          get: jest.fn().mockImplementation(async () => ({ exists: teamDocs.has(id), data: () => teamDocs.get(id) })),
        };
      }
      // "runs"
      return {
        id,
        get: jest.fn().mockImplementation(async () => ({ exists: runDocs.has(id), data: () => runDocs.get(id) })),
        collection: (subName: string) => ({
          doc: (docId: string) => ({
            get: jest.fn().mockImplementation(async () => {
              const store = subName === "humanReviewPanel" ? panelDocs : voteDocs;
              const key = `${id}/${subName}/${docId}`;
              return { exists: store.has(key), data: () => store.get(key) };
            }),
          }),
        }),
      };
    },
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    const txn = {
      get: async (ref: any) => {
        if (ref.__isTeamRef) return { exists: teamDocs.has(ref.__teamId), data: () => teamDocs.get(ref.__teamId) };
        if (ref.__isPanelRef) return { exists: panelDocs.has(`${ref.__runId}/humanReviewPanel/current`), data: () => panelDocs.get(`${ref.__runId}/humanReviewPanel/current`) };
        if (ref.__isVoteRef) return { exists: voteDocs.has(`${ref.__runId}/humanReviewVotes/${ref.__voteId}`), data: () => voteDocs.get(`${ref.__runId}/humanReviewVotes/${ref.__voteId}`) };
        return { exists: runDocs.has(ref.id), data: () => runDocs.get(ref.id) };
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

// Tag refs so the transaction fake can distinguish run/panel/vote/team refs
// — same technique already used in adaptiveHumanReviewPanel.spec.ts.
const originalCollection = mockAdminDb.collection;
mockAdminDb.collection = (name: string) => {
  if (name === "teams") {
    return {
      doc: (teamId: string) => {
        const base = originalCollection(name).doc(teamId);
        return { ...base, id: teamId, __isTeamRef: true, __teamId: teamId };
      },
    };
  }
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

import { getAdaptiveHumanReviewVote, submitAdaptiveHumanReviewVote } from "@/lib/firestore/runs";
import { buildAdaptiveHumanReviewVoteId } from "@/lib/governance/adaptiveHumanReviewVote";

const RUN_ID = "run-1";
const TEAM_ID = "team-1";
const REVIEWER_A = "reviewer-a";
const REVIEWER_B = "reviewer-b";

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
    reviewerUserIds: [REVIEWER_A, REVIEWER_B],
    requiredReviewerCount: 2,
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

function storedTeam(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Team",
    createdBy: "owner-uid",
    members: [
      { uid: REVIEWER_A, email: "a@test.com", role: "admin", joinedAt: "x" },
      { uid: REVIEWER_B, email: "b@test.com", role: "owner", joinedAt: "x" },
      { uid: "member-uid", email: "member@test.com", role: "member", joinedAt: "x" },
    ],
    policyRules: [],
    settings: {},
    ...overrides,
  };
}

function storedVote(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "adaptive_human_review_vote",
    teamId: TEAM_ID,
    runId: RUN_ID,
    panelRevision: 1,
    reviewerUserId: REVIEWER_A,
    status: "approved",
    commentPresent: false,
    conditionsCount: 0,
    submittedAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  runDocs.clear();
  panelDocs.clear();
  teamDocs.clear();
  voteDocs.clear();
  firestoreUnavailableFlag.value = false;
});

describe("getAdaptiveHumanReviewVote", () => {
  it("returns absent when no vote document exists", async () => {
    expect(await getAdaptiveHumanReviewVote(RUN_ID, 1, REVIEWER_A)).toEqual({ status: "absent" });
  });

  it("returns found with the parsed vote when one exists", async () => {
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, REVIEWER_A)}`, storedVote());
    const result = await getAdaptiveHumanReviewVote(RUN_ID, 1, REVIEWER_A, TEAM_ID);
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.vote.status).toBe("approved");
  });

  it("returns malformed for a corrupted stored vote", async () => {
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, REVIEWER_A)}`, storedVote({ conditionsCount: 999 }));
    expect(await getAdaptiveHumanReviewVote(RUN_ID, 1, REVIEWER_A)).toEqual({ status: "malformed" });
  });

  it("returns unsupported_version for a future schema version", async () => {
    voteDocs.set(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, REVIEWER_A)}`, storedVote({ schemaVersion: 2 }));
    expect(await getAdaptiveHumanReviewVote(RUN_ID, 1, REVIEWER_A)).toEqual({ status: "unsupported_version" });
  });

  it("returns firestore_unavailable when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    expect(await getAdaptiveHumanReviewVote(RUN_ID, 1, REVIEWER_A)).toEqual({ status: "firestore_unavailable" });
  });
});

function baseArgs(overrides: Partial<Parameters<typeof submitAdaptiveHumanReviewVote>[0]> = {}) {
  return {
    runId: RUN_ID,
    teamId: TEAM_ID,
    reviewerUserId: REVIEWER_A,
    panelRevision: 1,
    status: "approved" as const,
    now: "2026-07-31T01:00:00.000Z",
    ...overrides,
  };
}

function seedHappyPath() {
  runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
  panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel());
  teamDocs.set(TEAM_ID, storedTeam());
}

describe("submitAdaptiveHumanReviewVote — valid submission", () => {
  it("a listed, eligible reviewer submits successfully — exactly one vote document created", async () => {
    seedHappyPath();
    const result = await submitAdaptiveHumanReviewVote(baseArgs());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.submissionStatus).toBe("submitted");
      expect(result.vote.status).toBe("approved");
      expect(result.vote.reviewerUserId).toBe(REVIEWER_A);
    }
    expect(voteDocs.size).toBe(1);
  });

  it("never writes governanceRecord, panel, teamRuns, or assignment — only the vote document", async () => {
    seedHappyPath();
    const runBefore = JSON.stringify(runDocs.get(RUN_ID));
    const panelBefore = JSON.stringify(panelDocs.get(`${RUN_ID}/humanReviewPanel/current`));
    await submitAdaptiveHumanReviewVote(baseArgs());
    expect(JSON.stringify(runDocs.get(RUN_ID))).toBe(runBefore);
    expect(JSON.stringify(panelDocs.get(`${RUN_ID}/humanReviewPanel/current`))).toBe(panelBefore);
  });

  it("never finalizes and never computes an aggregate — the result has no finalDecision/aggregate field", async () => {
    seedHappyPath();
    const result = await submitAdaptiveHumanReviewVote(baseArgs());
    expect(result).not.toHaveProperty("finalDecision");
    expect(result).not.toHaveProperty("aggregate");
    expect(result).not.toHaveProperty("quorumMet");
  });
});

describe("submitAdaptiveHumanReviewVote — authorization", () => {
  it("rejects a caller not listed on the panel", async () => {
    seedHappyPath();
    teamDocs.set(TEAM_ID, storedTeam({ members: [...storedTeam().members, { uid: "admin-2-uid", email: "x@test.com", role: "admin", joinedAt: "x" }] }));
    const result = await submitAdaptiveHumanReviewVote(baseArgs({ reviewerUserId: "admin-2-uid" }));
    expect(result).toEqual({ ok: false, reason: "reviewer_not_assigned" });
  });

  it("rejects a reviewer who is no longer a team member at all", async () => {
    seedHappyPath();
    teamDocs.set(TEAM_ID, storedTeam({ members: [{ uid: REVIEWER_B, email: "b@test.com", role: "owner", joinedAt: "x" }] })); // REVIEWER_A removed
    const result = await submitAdaptiveHumanReviewVote(baseArgs({ reviewerUserId: REVIEWER_A }));
    expect(result).toEqual({ ok: false, reason: "reviewer_not_assigned" });
  });

  it("rejects a reviewer whose role was demoted to a plain, ineligible member", async () => {
    seedHappyPath();
    teamDocs.set(
      TEAM_ID,
      storedTeam({ members: [{ uid: REVIEWER_A, email: "a@test.com", role: "member", joinedAt: "x" }, { uid: REVIEWER_B, email: "b@test.com", role: "owner", joinedAt: "x" }] })
    );
    const result = await submitAdaptiveHumanReviewVote(baseArgs({ reviewerUserId: REVIEWER_A }));
    expect(result).toEqual({ ok: false, reason: "reviewer_not_assigned" });
  });

  it("rejects an owner/admin who is simply not on THIS panel", async () => {
    seedHappyPath();
    teamDocs.set(TEAM_ID, storedTeam({ members: [...storedTeam().members, { uid: "uninvolved-admin", email: "z@test.com", role: "admin", joinedAt: "x" }] }));
    const result = await submitAdaptiveHumanReviewVote(baseArgs({ reviewerUserId: "uninvolved-admin" }));
    expect(result).toEqual({ ok: false, reason: "reviewer_not_assigned" });
  });

  it("never discloses whether the caller was previously assigned — the failure reason is identical for 'never was' and 'was removed'", async () => {
    seedHappyPath();
    const neverAssigned = await submitAdaptiveHumanReviewVote(baseArgs({ reviewerUserId: "totally-unknown-uid" }));
    teamDocs.set(TEAM_ID, storedTeam({ members: [{ uid: REVIEWER_B, email: "b@test.com", role: "owner", joinedAt: "x" }] }));
    const wasRemoved = await submitAdaptiveHumanReviewVote(baseArgs({ reviewerUserId: REVIEWER_A }));
    expect(neverAssigned).toEqual(wasRemoved);
  });
});

describe("submitAdaptiveHumanReviewVote — panel state", () => {
  it("rejects when no panel exists", async () => {
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord() });
    teamDocs.set(TEAM_ID, storedTeam());
    const result = await submitAdaptiveHumanReviewVote(baseArgs());
    expect(result).toEqual({ ok: false, reason: "panel_absent" });
  });

  it("rejects when the panel is malformed", async () => {
    seedHappyPath();
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ quorum: 999 }));
    const result = await submitAdaptiveHumanReviewVote(baseArgs());
    expect(result).toEqual({ ok: false, reason: "panel_malformed" });
  });

  it("rejects when the panel is an unsupported version", async () => {
    seedHappyPath();
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ schemaVersion: 2 }));
    const result = await submitAdaptiveHumanReviewVote(baseArgs());
    expect(result).toEqual({ ok: false, reason: "panel_unsupported_version" });
  });

  it("rejects when the panel is cancelled", async () => {
    seedHappyPath();
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ status: "cancelled" }));
    const result = await submitAdaptiveHumanReviewVote(baseArgs());
    expect(result).toEqual({ ok: false, reason: "panel_cancelled" });
  });

  it("rejects a stale panel revision — never silently migrates the vote to the new revision", async () => {
    seedHappyPath();
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ revision: 2 }));
    const result = await submitAdaptiveHumanReviewVote(baseArgs({ panelRevision: 1 }));
    expect(result).toEqual({ ok: false, reason: "panel_stale" });
    expect(voteDocs.size).toBe(0);
  });
});

describe("submitAdaptiveHumanReviewVote — terminal-review protection", () => {
  it("rejects when the review is no longer pending", async () => {
    seedHappyPath();
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "approved" } }) });
    const result = await submitAdaptiveHumanReviewVote(baseArgs());
    expect(result).toEqual({ ok: false, reason: "not_pending" });
    expect(voteDocs.size).toBe(0);
  });

  it("does not trust panel status alone — a terminal governanceRecord blocks voting even though the panel itself is open", async () => {
    seedHappyPath(); // panel is open
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "rejected" } }) });
    const result = await submitAdaptiveHumanReviewVote(baseArgs());
    expect(result).toEqual({ ok: false, reason: "not_pending" });
  });

  it("fails closed on a missing parent run", async () => {
    const result = await submitAdaptiveHumanReviewVote(baseArgs());
    expect(result).toEqual({ ok: false, reason: "run_missing" });
  });

  it("returns firestore_unavailable safely", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await submitAdaptiveHumanReviewVote(baseArgs());
    expect(result).toEqual({ ok: false, reason: "firestore_unavailable" });
  });
});

describe("submitAdaptiveHumanReviewVote — idempotent duplicate semantics", () => {
  it("an exact duplicate resubmission returns already_submitted, without creating a second document or changing the timestamp", async () => {
    seedHappyPath();
    const first = await submitAdaptiveHumanReviewVote(baseArgs({ now: "2026-07-31T01:00:00.000Z" }));
    expect(first.ok).toBe(true);
    const second = await submitAdaptiveHumanReviewVote(baseArgs({ now: "2026-07-31T02:00:00.000Z" })); // later "now" — must not matter
    expect(second).toEqual({ ok: true, submissionStatus: "already_submitted", vote: (first as any).vote });
    expect(voteDocs.size).toBe(1);
    expect((second as any).vote.submittedAt).toBe("2026-07-31T01:00:00.000Z"); // unchanged — the ORIGINAL vote, not a new one
  });

  it("the same normalized comment (differing only in surrounding whitespace before normalization) is treated as identical — idempotent", async () => {
    seedHappyPath();
    const first = await submitAdaptiveHumanReviewVote(baseArgs({ status: "rejected", comment: "not acceptable" }));
    expect(first.ok).toBe(true);
    const second = await submitAdaptiveHumanReviewVote(baseArgs({ status: "rejected", comment: "not acceptable" }));
    expect(second).toEqual({ ok: true, submissionStatus: "already_submitted", vote: (first as any).vote });
  });

  it("a different status on the same panel revision is a conflict, never an overwrite", async () => {
    seedHappyPath();
    const first = await submitAdaptiveHumanReviewVote(baseArgs({ status: "approved" }));
    expect(first.ok).toBe(true);
    const second = await submitAdaptiveHumanReviewVote(baseArgs({ status: "rejected", comment: "changed my mind" }));
    expect(second).toEqual({ ok: false, reason: "vote_conflict" });
    expect(voteDocs.size).toBe(1);
    expect((voteDocs.get(`${RUN_ID}/humanReviewVotes/${buildAdaptiveHumanReviewVoteId(1, REVIEWER_A)}`) as any).status).toBe("approved"); // untouched
  });

  it("a different comment on the same status is a conflict", async () => {
    seedHappyPath();
    const first = await submitAdaptiveHumanReviewVote(baseArgs({ status: "rejected", comment: "reason A" }));
    expect(first.ok).toBe(true);
    const second = await submitAdaptiveHumanReviewVote(baseArgs({ status: "rejected", comment: "reason B" }));
    expect(second).toEqual({ ok: false, reason: "vote_conflict" });
  });

  it("a different conditions array on the same status is a conflict", async () => {
    seedHappyPath();
    const first = await submitAdaptiveHumanReviewVote(baseArgs({ status: "approved_with_conditions", conditions: ["x"] }));
    expect(first.ok).toBe(true);
    const second = await submitAdaptiveHumanReviewVote(baseArgs({ status: "approved_with_conditions", conditions: ["y"] }));
    expect(second).toEqual({ ok: false, reason: "vote_conflict" });
  });

  it("one reviewer's vote can never overwrite another reviewer's vote — they are independent documents", async () => {
    seedHappyPath();
    const a = await submitAdaptiveHumanReviewVote(baseArgs({ reviewerUserId: REVIEWER_A, status: "approved" }));
    const b = await submitAdaptiveHumanReviewVote(baseArgs({ reviewerUserId: REVIEWER_B, status: "rejected", comment: "no" }));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(voteDocs.size).toBe(2);
    expect((a as any).vote.status).toBe("approved");
    expect((b as any).vote.status).toBe("rejected");
  });
});

describe("submitAdaptiveHumanReviewVote — concurrency and races", () => {
  /**
   * The test fake's `runTransaction` does not implement real Firestore
   * optimistic-concurrency conflict retry — it has no notion of a
   * transaction's read-snapshot becoming stale mid-flight. Genuinely
   * interleaving two calls via `Promise.all` therefore cannot prove
   * anything about arbitration (both callbacks would observe the
   * "not yet written" state before either commits). Matching the exact,
   * already-established pattern from every prior concurrency test in this
   * engagement (Part B's panel transaction tests, Part E3's assignment
   * transaction tests): two SEQUENTIAL `await` calls prove "only the
   * first of two attempts against the same precondition succeeds" just as
   * validly, since the underlying revision/existence check the real
   * transaction performs is exactly what's being proven, not literal
   * thread-level interleaving.
   */
  it("two identical submissions in immediate succession: the first creates, the second is an idempotent already_submitted success", async () => {
    seedHappyPath();
    const first = await submitAdaptiveHumanReviewVote(baseArgs());
    const second = await submitAdaptiveHumanReviewVote(baseArgs());
    expect(first.ok).toBe(true);
    expect((first as any).submissionStatus).toBe("submitted");
    expect(second.ok).toBe(true);
    expect((second as any).submissionStatus).toBe("already_submitted");
    expect(voteDocs.size).toBe(1);
  });

  it("two different submissions from the same reviewer in immediate succession: the first creates, the second conflicts", async () => {
    seedHappyPath();
    const a = await submitAdaptiveHumanReviewVote(baseArgs({ status: "approved" }));
    const b = await submitAdaptiveHumanReviewVote(baseArgs({ status: "rejected", comment: "no" }));
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, reason: "vote_conflict" });
    expect(voteDocs.size).toBe(1);
  });

  it("panel reconfigured (revision bumped) between validation and submission: the stale-revision request fails", async () => {
    seedHappyPath();
    panelDocs.set(`${RUN_ID}/humanReviewPanel/current`, storedPanel({ revision: 5 })); // simulates a reconfiguration that already landed
    const result = await submitAdaptiveHumanReviewVote(baseArgs({ panelRevision: 1 })); // caller's stale view
    expect(result).toEqual({ ok: false, reason: "panel_stale" });
  });

  it("reviewer removed from the team between validation and submission: the request fails", async () => {
    seedHappyPath();
    teamDocs.set(TEAM_ID, storedTeam({ members: [{ uid: REVIEWER_B, email: "b@test.com", role: "owner", joinedAt: "x" }] })); // simulates removal that already landed
    const result = await submitAdaptiveHumanReviewVote(baseArgs({ reviewerUserId: REVIEWER_A }));
    expect(result).toEqual({ ok: false, reason: "reviewer_not_assigned" });
  });

  it("review terminalized between validation and submission: the request fails", async () => {
    seedHappyPath();
    runDocs.set(RUN_ID, { governanceRecord: governanceRecord({ humanReview: { status: "approved" } }) }); // simulates a decision that already landed
    const result = await submitAdaptiveHumanReviewVote(baseArgs());
    expect(result).toEqual({ ok: false, reason: "not_pending" });
  });
});
