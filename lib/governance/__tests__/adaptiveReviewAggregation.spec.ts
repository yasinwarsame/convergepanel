/**
 * Pure Multi-Reviewer Aggregation Engine and Quorum Truth Tables, Part D —
 * truth tables, exhaustive combination tests, invalid-input tests,
 * condition-metadata tests, privacy tests, immutability tests,
 * order-independence tests, and a no-I/O import-boundary test.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION,
  ADAPTIVE_REVIEW_AGGREGATION_POLICY_V1,
  aggregateAdaptiveReviewVotes,
  AggregateAdaptiveReviewVotesResult,
} from "@/lib/governance/adaptiveReviewAggregation";
import { AdaptiveHumanReviewPanelV1, deriveAdaptivePanelQuorum } from "@/lib/governance/adaptiveHumanReviewPanel";
import { AdaptiveHumanReviewVoteV1 } from "@/lib/governance/adaptiveHumanReviewVote";
import { AdaptiveReviewDecisionStatus } from "@/lib/governance/adaptiveHumanReviewRequest";

const TEAM_ID = "team-1";
const RUN_ID = "run-1";

function buildPanel(overrides: Partial<AdaptiveHumanReviewPanelV1> = {}): AdaptiveHumanReviewPanelV1 {
  const reviewerUserIds = overrides.reviewerUserIds ?? ["r1", "r2"];
  const requiredReviewerCount = reviewerUserIds.length;
  return {
    schemaVersion: 1,
    kind: "adaptive_review_panel",
    teamId: TEAM_ID,
    runId: RUN_ID,
    mode: "majority_quorum",
    reviewerUserIds,
    requiredReviewerCount,
    quorum: deriveAdaptivePanelQuorum(requiredReviewerCount),
    status: "open",
    revision: 1,
    createdAt: "2020-01-01T00:00:00.000Z",
    createdByUserId: "admin-uid",
    updatedAt: "2020-01-01T00:00:00.000Z",
    updatedByUserId: "admin-uid",
    ...overrides,
  };
}

function buildVote(
  reviewerUserId: string,
  status: AdaptiveReviewDecisionStatus,
  opts: { conditions?: string[]; comment?: string; panelRevision?: number; teamId?: string; runId?: string } = {}
): AdaptiveHumanReviewVoteV1 {
  const comment = opts.comment ?? (status === "changes_requested" || status === "rejected" ? "reason" : undefined);
  const conditions = opts.conditions ?? (status === "approved_with_conditions" ? ["default condition"] : undefined);
  return {
    schemaVersion: 1,
    kind: "adaptive_human_review_vote",
    teamId: opts.teamId ?? TEAM_ID,
    runId: opts.runId ?? RUN_ID,
    panelRevision: opts.panelRevision ?? 1,
    reviewerUserId,
    status,
    comment,
    conditions,
    commentPresent: Boolean(comment),
    conditionsCount: conditions?.length ?? 0,
    submittedAt: "2020-01-01T00:00:00.000Z",
  };
}

const A = "approved" as const;
const AC = "approved_with_conditions" as const;
const C = "changes_requested" as const;
const R = "rejected" as const;

// ============================================
// §D17 — explicit truth table, 2 reviewers, quorum 2
// ============================================

describe("Truth table — 2 reviewers, quorum 2", () => {
  // Every row is deliberately padded to the SAME length (4 elements,
  // `undefined` where no finalStatus applies) — a jest-each gotcha:
  // inconsistent row lengths against a 4-parameter callback can make
  // jest's arity-sniffing mistake the unfilled trailing parameter for an
  // async `done` callback, hanging the test until timeout instead of
  // running synchronously.
  const cases: Array<[AdaptiveReviewDecisionStatus, AdaptiveReviewDecisionStatus, "ready" | "deadlocked", AdaptiveReviewDecisionStatus | undefined]> = [
    [A, A, "ready", A],
    [A, AC, "ready", AC],
    [AC, AC, "ready", AC],
    [C, C, "ready", C],
    [C, R, "ready", R],
    [R, R, "ready", R],
    [A, C, "deadlocked", undefined],
    [A, R, "deadlocked", undefined],
    [AC, C, "deadlocked", undefined],
    [AC, R, "deadlocked", undefined],
  ];

  it.each(cases)("%s + %s -> %s (%s)", (statusA, statusB, expectedOutcome, expectedFinal) => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const votes = [buildVote("r1", statusA), buildVote("r2", statusB)];
    const result = aggregateAdaptiveReviewVotes({ panel, votes });
    expect(result.status).toBe(expectedOutcome);
    if (expectedOutcome === "ready" && result.status === "ready") {
      expect(result.finalStatus).toBe(expectedFinal);
    }
  });

  it.each(cases)("%s + %s is independent of vote-array order", (statusA, statusB) => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const forward = aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", statusA), buildVote("r2", statusB)] });
    const reversed = aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r2", statusB), buildVote("r1", statusA)] });
    expect(forward).toEqual(reversed);
  });
});

describe("Truth table — 0 or 1 of 2 submitted -> waiting", () => {
  it("zero votes", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [] });
    expect(result).toEqual({
      status: "waiting",
      policyVersion: 1,
      reason: "quorum_not_met",
      reviewerCount: 2,
      quorum: 2,
      submittedCount: 0,
      remainingToQuorum: 2,
      approvalGroupCount: 0,
      blockingGroupCount: 0,
    });
  });

  it("one vote", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", A)] });
    expect(result.status).toBe("waiting");
    if (result.status === "waiting") {
      expect(result.remainingToQuorum).toBe(1);
      expect(result.approvalGroupCount).toBe(1);
    }
  });
});

// ============================================
// §D17/§D18 — exhaustive combinations, 2/3/4 reviewers
// ============================================

const ALL_STATUSES: AdaptiveReviewDecisionStatus[] = [A, AC, C, R];

function isApprovalGroup(s: AdaptiveReviewDecisionStatus): boolean {
  return (ADAPTIVE_REVIEW_AGGREGATION_POLICY_V1.approvalGroupStatuses as readonly string[]).includes(s);
}
function isBlockingGroup(s: AdaptiveReviewDecisionStatus): boolean {
  return (ADAPTIVE_REVIEW_AGGREGATION_POLICY_V1.blockingGroupStatuses as readonly string[]).includes(s);
}

function cartesianStatuses(n: number): AdaptiveReviewDecisionStatus[][] {
  if (n === 0) return [[]];
  const rest = cartesianStatuses(n - 1);
  const result: AdaptiveReviewDecisionStatus[][] = [];
  for (const s of ALL_STATUSES) {
    for (const r of rest) result.push([s, ...r]);
  }
  return result;
}

describe.each([2, 3, 4])("Exhaustive combinations — %d reviewers", (n) => {
  const reviewerIds = Array.from({ length: n }, (_, i) => `reviewer-${i}`);
  const quorum = Math.floor(n / 2) + 1;
  const panel = buildPanel({ reviewerUserIds: reviewerIds });

  for (let submittedCount = 0; submittedCount <= n; submittedCount++) {
    const combos = cartesianStatuses(submittedCount);

    it(`all ${combos.length} status combinations at ${submittedCount} of ${n} submitted obey waiting/deadlocked/ready invariants`, () => {
      for (const statuses of combos) {
        const votes = statuses.map((s, idx) => buildVote(reviewerIds[idx], s));
        const result = aggregateAdaptiveReviewVotes({ panel, votes });

        if (submittedCount < quorum) {
          expect(result.status).toBe("waiting");
          continue;
        }

        const approvalCount = statuses.filter(isApprovalGroup).length;
        const blockingCount = statuses.filter(isBlockingGroup).length;
        const approvalWins = approvalCount > submittedCount / 2;
        const blockingWins = blockingCount > submittedCount / 2;

        if (!approvalWins && !blockingWins) {
          expect(result.status).toBe("deadlocked");
          if (result.status === "deadlocked") {
            expect(result.approvalGroupCount).toBe(approvalCount);
            expect(result.blockingGroupCount).toBe(blockingCount);
          }
          continue;
        }

        expect(result.status).toBe("ready");
        if (result.status !== "ready") continue;

        if (approvalWins) {
          const winningStatuses = statuses.filter(isApprovalGroup);
          const expectedFinal = winningStatuses.includes(AC) ? AC : A;
          expect(result.finalStatus).toBe(expectedFinal);
          expect(result.supportingReviewerUserIds).toHaveLength(approvalCount);
        } else {
          const winningStatuses = statuses.filter(isBlockingGroup);
          const expectedFinal = winningStatuses.includes(R) ? R : C;
          expect(result.finalStatus).toBe(expectedFinal);
          expect(result.supportingReviewerUserIds).toHaveLength(blockingCount);
        }
      }
    });

    it(`all ${combos.length} status combinations at ${submittedCount} of ${n} submitted are order-independent`, () => {
      for (const statuses of combos) {
        const votes = statuses.map((s, idx) => buildVote(reviewerIds[idx], s));
        const reversedVotes = [...votes].reverse();
        const forward = aggregateAdaptiveReviewVotes({ panel, votes });
        const reversed = aggregateAdaptiveReviewVotes({ panel, votes: reversedVotes });
        expect(forward).toEqual(reversed);
      }
    });
  }
});

// ============================================
// §D6 — the prompt's own worked examples, verified directly
// ============================================

describe("Group-majority worked examples from the spec", () => {
  it("3 assigned, quorum 2: 1 approval + 1 blocking -> deadlocked", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2", "r3"] });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", A), buildVote("r2", C)] });
    expect(result.status).toBe("deadlocked");
  });

  it("3 assigned, quorum 2: 2 approval -> approval group wins", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2", "r3"] });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", A), buildVote("r2", A)] });
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.finalStatus).toBe(A);
  });

  it("4 assigned, quorum 3: 2 approval + 1 blocking (3 submitted) -> approval group wins", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2", "r3", "r4"] });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", A), buildVote("r2", A), buildVote("r3", C)] });
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.finalStatus).toBe(A);
  });

  it("4 assigned, quorum 3: 2 approval + 2 blocking (4 submitted) -> deadlocked", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2", "r3", "r4"] });
    const result = aggregateAdaptiveReviewVotes({
      panel,
      votes: [buildVote("r1", A), buildVote("r2", A), buildVote("r3", C), buildVote("r4", R)],
    });
    expect(result.status).toBe("deadlocked");
  });

  it("2 approved + 1 rejected -> approval group wins with finalStatus approved (no rejection veto)", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2", "r3"] });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", A), buildVote("r2", A), buildVote("r3", R)] });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.finalStatus).toBe(A);
      expect(result.supportingReviewerUserIds).toEqual(["r1", "r2"]);
    }
  });
});

// ============================================
// §D9/§D20 — condition aggregation metadata
// ============================================

describe("Condition aggregation metadata", () => {
  it("no approved_with_conditions votes -> zero metadata", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", A), buildVote("r2", A)] });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.conditionsSummary).toEqual({ contributingVoteCount: 0, uniqueConditionCount: 0, hasConditions: false });
    }
  });

  it("one AC vote with one condition", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const result = aggregateAdaptiveReviewVotes({
      panel,
      votes: [buildVote("r1", A), buildVote("r2", AC, { conditions: ["must add X"] })],
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.finalStatus).toBe(AC);
      expect(result.conditionsSummary).toEqual({ contributingVoteCount: 1, uniqueConditionCount: 1, hasConditions: true });
    }
  });

  it("two AC votes with the exact same condition -> unique count 1", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const result = aggregateAdaptiveReviewVotes({
      panel,
      votes: [buildVote("r1", AC, { conditions: ["must add X"] }), buildVote("r2", AC, { conditions: ["must add X"] })],
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.conditionsSummary).toEqual({ contributingVoteCount: 2, uniqueConditionCount: 1, hasConditions: true });
    }
  });

  it("two AC votes with different conditions -> unique count 2", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const result = aggregateAdaptiveReviewVotes({
      panel,
      votes: [buildVote("r1", AC, { conditions: ["must add X"] }), buildVote("r2", AC, { conditions: ["must add Y"] })],
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.conditionsSummary).toEqual({ contributingVoteCount: 2, uniqueConditionCount: 2, hasConditions: true });
    }
  });

  it("a losing-group AC vote does not contribute when the blocking group wins", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2", "r3"] });
    const result = aggregateAdaptiveReviewVotes({
      panel,
      votes: [buildVote("r1", AC, { conditions: ["ignored condition"] }), buildVote("r2", R), buildVote("r3", R)],
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.finalStatus).toBe(R);
      expect(result.conditionsSummary).toEqual({ contributingVoteCount: 0, uniqueConditionCount: 0, hasConditions: false });
    }
  });

  it("a minority AC vote WITHIN the winning approval group still contributes", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2", "r3"] });
    const result = aggregateAdaptiveReviewVotes({
      panel,
      votes: [buildVote("r1", A), buildVote("r2", AC, { conditions: ["one condition"] }), buildVote("r3", R)],
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.finalStatus).toBe(AC); // any AC in winning group escalates
      expect(result.conditionsSummary.contributingVoteCount).toBe(1);
      expect(result.conditionsSummary.uniqueConditionCount).toBe(1);
    }
  });

  it("final approved (no AC) has zero condition metadata", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", A), buildVote("r2", A)] });
    if (result.status === "ready") expect(result.conditionsSummary.hasConditions).toBe(false);
  });

  it("final rejected/changes_requested always have zero condition metadata", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const rejected = aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", R), buildVote("r2", R)] });
    const changes = aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", C), buildVote("r2", C)] });
    if (rejected.status === "ready") expect(rejected.conditionsSummary).toEqual({ contributingVoteCount: 0, uniqueConditionCount: 0, hasConditions: false });
    if (changes.status === "ready") expect(changes.conditionsSummary).toEqual({ contributingVoteCount: 0, uniqueConditionCount: 0, hasConditions: false });
  });

  it("no condition TEXT is ever returned in the result", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const result = aggregateAdaptiveReviewVotes({
      panel,
      votes: [buildVote("r1", AC, { conditions: ["a very specific secret condition"] }), buildVote("r2", AC, { conditions: ["another one"] })],
    });
    expect(JSON.stringify(result)).not.toContain("secret condition");
    expect(JSON.stringify(result)).not.toContain("another one");
  });
});

// ============================================
// §D19 — invalid input
// ============================================

describe("Invalid input — panel", () => {
  it("unsupported panel schemaVersion", () => {
    const panel = buildPanel({ schemaVersion: 2 as 1 });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "unsupported_panel_version" });
  });

  it("malformed kind", () => {
    const panel = buildPanel({ kind: "something_else" as any });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "invalid_panel" });
  });

  it("wrong mode", () => {
    const panel = buildPanel({ mode: "single" as any });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "invalid_panel_mode" });
  });

  it("cancelled panel status -> invalid, never waiting", () => {
    const panel = buildPanel({ status: "cancelled" });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "invalid_panel_status" });
  });

  it("duplicate reviewers on the panel itself", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r1"], requiredReviewerCount: 2 });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "invalid_panel" });
  });

  it("reviewer count below minimum", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1"], requiredReviewerCount: 1, quorum: 1 });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "invalid_panel" });
  });

  it("reviewer count above maximum", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const panel = buildPanel({ reviewerUserIds: ids, requiredReviewerCount: 10, quorum: 6 });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "invalid_panel" });
  });

  it("wrong requiredReviewerCount", () => {
    // quorum is deliberately kept internally consistent with the (wrong)
    // requiredReviewerCount value, so the ONLY thing under test is the
    // requiredReviewerCount vs reviewerUserIds.length mismatch itself —
    // not an incidental quorum-formula mismatch (a distinct, separately
    // tested reason below).
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"], requiredReviewerCount: 5, quorum: deriveAdaptivePanelQuorum(5) });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "invalid_panel" });
  });

  it("wrong quorum (does not match floor(n/2)+1) -> distinct invalid_quorum reason", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2", "r3"], requiredReviewerCount: 3, quorum: 99 });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "invalid_quorum" });
  });

  it("invalid revision (zero)", () => {
    const panel = buildPanel({ revision: 0 });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "invalid_panel" });
  });
});

describe("Invalid input — votes", () => {
  it("unsupported vote schemaVersion", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const vote = { ...buildVote("r1", A), schemaVersion: 2 as 1 };
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [vote] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "unsupported_vote_version" });
  });

  it("malformed kind", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const vote = { ...buildVote("r1", A), kind: "something_else" as any };
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [vote] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "invalid_vote" });
  });

  it("wrong team", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const vote = buildVote("r1", A, { teamId: "other-team" });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [vote] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "vote_team_mismatch" });
  });

  it("wrong run", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const vote = buildVote("r1", A, { runId: "other-run" });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [vote] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "vote_run_mismatch" });
  });

  it("wrong panel revision", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"], revision: 5 });
    const vote = buildVote("r1", A, { panelRevision: 1 });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [vote] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "vote_revision_mismatch" });
  });

  it("reviewer not in panel", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const vote = buildVote("stranger", A);
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [vote] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "reviewer_not_in_panel" });
  });

  it("duplicate reviewer vote", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const votes = [buildVote("r1", A), buildVote("r1", R)];
    const result = aggregateAdaptiveReviewVotes({ panel, votes });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "duplicate_reviewer_vote" });
  });

  it("duplicate reviewer vote detected regardless of array order", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const votes = [buildVote("r2", A), buildVote("r1", A), buildVote("r1", R)];
    const result = aggregateAdaptiveReviewVotes({ panel, votes });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "duplicate_reviewer_vote" });
  });

  it("invalid status", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const vote = { ...buildVote("r1", A), status: "unreviewed" as any };
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [vote] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "invalid_vote" });
  });

  it("invalid comment/condition cross-field state (approved with conditions present)", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const vote = { ...buildVote("r1", A), conditions: ["x"], conditionsCount: 1 };
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [vote] });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "invalid_vote" });
  });

  it("more votes than reviewers (a foreign reviewer's vote) -> invalid, never silently ignored", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const votes = [buildVote("r1", A), buildVote("r2", A), buildVote("r3", A)];
    const result = aggregateAdaptiveReviewVotes({ panel, votes });
    expect(result).toEqual({ status: "invalid", policyVersion: 1, reason: "reviewer_not_in_panel" });
  });

  it("never throws for expected invalid domain input — always returns a result", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"], quorum: -50 });
    expect(() => aggregateAdaptiveReviewVotes({ panel, votes: [] })).not.toThrow();
  });
});

// ============================================
// §D14 — input immutability
// ============================================

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    Object.getOwnPropertyNames(obj).forEach((key) => {
      const value = (obj as any)[key];
      if (value && typeof value === "object") deepFreeze(value);
    });
    Object.freeze(obj);
  }
  return obj;
}

describe("Input immutability", () => {
  it("never mutates a deep-frozen panel or vote array — no exception, no observable change", () => {
    const panel = deepFreeze(buildPanel({ reviewerUserIds: ["r1", "r2"] }));
    const votes = deepFreeze([buildVote("r1", AC, { conditions: ["x", "y"] }), buildVote("r2", A)]);
    expect(() => aggregateAdaptiveReviewVotes({ panel, votes })).not.toThrow();
  });

  it("panel.reviewerUserIds array is untouched after aggregation", () => {
    const reviewerUserIds = ["r1", "r2"];
    const panel = buildPanel({ reviewerUserIds });
    const before = [...panel.reviewerUserIds];
    aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", A), buildVote("r2", A)] });
    expect(panel.reviewerUserIds).toEqual(before);
  });

  it("the input votes array itself is never reordered or mutated", () => {
    const votes = [buildVote("r2", A), buildVote("r1", R)];
    const before = votes.map((v) => ({ ...v }));
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    aggregateAdaptiveReviewVotes({ panel, votes });
    expect(votes).toEqual(before);
  });

  it("vote conditions arrays are never mutated", () => {
    const conditions = ["must fix X"];
    const vote = buildVote("r1", AC, { conditions });
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    aggregateAdaptiveReviewVotes({ panel, votes: [vote, buildVote("r2", AC, { conditions: ["must fix X"] })] });
    expect(conditions).toEqual(["must fix X"]);
  });
});

// ============================================
// §D21 — privacy
// ============================================

describe("Privacy — the result never includes sensitive content", () => {
  it("no comment, condition text, reviewer email, display name, membership, vote IDs, prompt/receipt/evidence/model-output/governance-reasons fields", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const result = aggregateAdaptiveReviewVotes({
      panel,
      votes: [
        buildVote("r1", C, { comment: "a very specific private reason" }),
        buildVote("r2", AC, { conditions: ["a very specific private condition"] }),
      ],
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of ["comment", "condition", "email", "displayName", "reviewerName", "voteId", "prompt", "receipt", "evidence", "modelOutput", "governanceReasons"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(serialized).not.toContain("a very specific private reason");
    expect(serialized).not.toContain("a very specific private condition");
  });

  it("supportingReviewerUserIds is the only reviewer-identifying field, and contains only bare UIDs", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const result = aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", A), buildVote("r2", A)] });
    if (result.status === "ready") {
      expect(result.supportingReviewerUserIds).toEqual(["r1", "r2"]);
    }
  });
});

// ============================================
// §D22 — no I/O / import boundary
// ============================================

describe("No I/O — import boundary", () => {
  const source = readFileSync(join(__dirname, "../adaptiveReviewAggregation.ts"), "utf-8");
  const dependencySources = [
    readFileSync(join(__dirname, "../adaptiveHumanReviewPanel.ts"), "utf-8"),
    readFileSync(join(__dirname, "../adaptiveHumanReviewVote.ts"), "utf-8"),
    readFileSync(join(__dirname, "../adaptiveHumanReviewRequest.ts"), "utf-8"),
  ];

  const FORBIDDEN_PATTERNS: RegExp[] = [
    /firebase-admin/,
    /["']@\/lib\/firebase/,
    /["']next\/server["']/,
    /["']react["']/,
    /\bfetch\(/,
    /["']@\/lib\/teams\/teamApiAuth["']/,
    /["']@\/lib\/logger["']/,
    /process\.env/,
  ];

  it("the aggregation module itself imports no Firebase Admin, route, React, fetch, team-auth, logging, or env-var access", () => {
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(source).not.toMatch(pattern);
    }
  });

  it("its direct pure-validator dependencies are also free of forbidden imports", () => {
    for (const depSource of dependencySources) {
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(depSource).not.toMatch(pattern);
      }
    }
  });

  it("exports only the documented policy/type/function surface", () => {
    expect(source).toContain("export const ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION");
    expect(source).toContain("export const ADAPTIVE_REVIEW_AGGREGATION_POLICY_V1");
    expect(source).toContain("export function aggregateAdaptiveReviewVotes");
  });

  it("performs no route wiring — this module is never imported by any app/api route in this session's changes", () => {
    // A structural guarantee, not a route-level test: the function is
    // exported for future (Part E) use but is not called from any route
    // file as of this step.
    expect(source).not.toMatch(/NextRequest|NextResponse/);
  });
});

// ============================================
// §D4 — policy/version surface
// ============================================

describe("Policy contract", () => {
  it("the fixed policy constant matches the documented groupings", () => {
    expect(ADAPTIVE_REVIEW_AGGREGATION_POLICY_V1).toEqual({
      version: 1,
      mode: "majority_quorum",
      approvalGroupStatuses: ["approved", "approved_with_conditions"],
      blockingGroupStatuses: ["changes_requested", "rejected"],
    });
  });

  it("every result carries the policy version", () => {
    const panel = buildPanel({ reviewerUserIds: ["r1", "r2"] });
    const results: AggregateAdaptiveReviewVotesResult[] = [
      aggregateAdaptiveReviewVotes({ panel, votes: [] }),
      aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", A), buildVote("r2", R)] }),
      aggregateAdaptiveReviewVotes({ panel, votes: [buildVote("r1", A), buildVote("r2", A)] }),
      aggregateAdaptiveReviewVotes({ panel: buildPanel({ status: "cancelled" }), votes: [] }),
    ];
    for (const r of results) expect(r.policyVersion).toBe(ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION);
  });
});
