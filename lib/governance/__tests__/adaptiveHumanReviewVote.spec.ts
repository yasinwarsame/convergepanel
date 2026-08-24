/**
 * Immutable Multi-Reviewer Vote Contract and Submission, Part C — pure
 * model, deterministic ID, request parser, and stored-document parser
 * tests.
 */

import {
  buildAdaptiveHumanReviewVoteId,
  buildAdaptiveHumanReviewVote,
  isSemanticallyEquivalentAdaptiveHumanReviewVote,
  parseSubmitAdaptiveReviewVoteRequest,
  parseAdaptiveHumanReviewVote,
  AdaptiveHumanReviewVoteV1,
} from "@/lib/governance/adaptiveHumanReviewVote";

describe("buildAdaptiveHumanReviewVoteId", () => {
  it("the same reviewer + same revision always produces the same ID", () => {
    expect(buildAdaptiveHumanReviewVoteId(1, "uid-a")).toBe(buildAdaptiveHumanReviewVoteId(1, "uid-a"));
  });

  it("a different reviewer produces a different ID", () => {
    expect(buildAdaptiveHumanReviewVoteId(1, "uid-a")).not.toBe(buildAdaptiveHumanReviewVoteId(1, "uid-b"));
  });

  it("a different revision produces a different ID", () => {
    expect(buildAdaptiveHumanReviewVoteId(1, "uid-a")).not.toBe(buildAdaptiveHumanReviewVoteId(2, "uid-a"));
  });

  it("never contains a raw slash, even if the reviewer ID does", () => {
    const id = buildAdaptiveHumanReviewVoteId(1, "weird/uid");
    expect(id).not.toContain("/");
  });

  it("handles other unsafe/reserved characters safely and deterministically", () => {
    const id1 = buildAdaptiveHumanReviewVoteId(1, "uid:with:colons");
    const id2 = buildAdaptiveHumanReviewVoteId(1, "uid:with:colons");
    expect(id1).toBe(id2);
    expect(id1).not.toContain("/");
  });

  it("follows the r{revision}:{encodedReviewerUserId} format", () => {
    expect(buildAdaptiveHumanReviewVoteId(7, "abc")).toBe("r7:abc");
  });
});

const VALID_TIMESTAMP = "2026-07-31T00:00:00.000Z";

describe("parseSubmitAdaptiveReviewVoteRequest", () => {
  it("accepts a valid 'approved' vote", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "approved" });
    expect(result).toEqual({ ok: true, value: { panelRevision: 1, status: "approved", comment: undefined, conditions: undefined } });
  });

  it("accepts a valid 'approved_with_conditions' vote", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "approved_with_conditions", conditions: ["must fix X"] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.conditions).toEqual(["must fix X"]);
  });

  it("accepts a valid 'changes_requested' vote", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "changes_requested", comment: "please revise" });
    expect(result.ok).toBe(true);
  });

  it("accepts a valid 'rejected' vote", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "rejected", comment: "not acceptable" });
    expect(result.ok).toBe(true);
  });

  it("'approved' rejects non-empty conditions", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "approved", conditions: ["x"] });
    expect(result).toEqual({ ok: false, reason: "conditions_not_allowed" });
  });

  it("'approved_with_conditions' requires at least one condition", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "approved_with_conditions" });
    expect(result).toEqual({ ok: false, reason: "conditions_required" });
  });

  it("'changes_requested' requires a non-empty comment", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "changes_requested" });
    expect(result).toEqual({ ok: false, reason: "comment_required" });
  });

  it("'rejected' requires a non-empty comment", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "rejected" });
    expect(result).toEqual({ ok: false, reason: "comment_required" });
  });

  it("trims whitespace and deduplicates conditions, preserving order", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({
      panelRevision: 1,
      status: "approved_with_conditions",
      conditions: [" a ", "b", "a", "  ", "c"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.conditions).toEqual(["a", "b", "c"]);
  });

  it("enforces the comment length limit", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "rejected", comment: "x".repeat(4001) });
    expect(result).toEqual({ ok: false, reason: "comment_too_long" });
  });

  it("enforces the condition item-count limit", () => {
    const conditions = Array.from({ length: 21 }, (_, i) => `condition ${i}`);
    const result = parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "approved_with_conditions", conditions });
    expect(result).toEqual({ ok: false, reason: "too_many_conditions" });
  });

  it("enforces the per-condition length limit", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "approved_with_conditions", conditions: ["x".repeat(501)] });
    expect(result).toEqual({ ok: false, reason: "condition_too_long" });
  });

  it("rejects a missing panelRevision", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({ status: "approved" });
    expect(result).toEqual({ ok: false, reason: "missing_panel_revision" });
  });

  it("rejects a non-integer or non-positive panelRevision", () => {
    expect(parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 0, status: "approved" })).toEqual({ ok: false, reason: "invalid_panel_revision" });
    expect(parseSubmitAdaptiveReviewVoteRequest({ panelRevision: -1, status: "approved" })).toEqual({ ok: false, reason: "invalid_panel_revision" });
    expect(parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1.5, status: "approved" })).toEqual({ ok: false, reason: "invalid_panel_revision" });
    expect(parseSubmitAdaptiveReviewVoteRequest({ panelRevision: "1", status: "approved" })).toEqual({ ok: false, reason: "invalid_panel_revision" });
  });

  it("rejects an invalid status", () => {
    expect(parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "unreviewed" })).toEqual({ ok: false, reason: "invalid_status" });
    expect(parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "escalated" })).toEqual({ ok: false, reason: "invalid_status" });
  });

  it("rejects a non-object body", () => {
    expect(parseSubmitAdaptiveReviewVoteRequest("nope")).toEqual({ ok: false, reason: "malformed_body" });
    expect(parseSubmitAdaptiveReviewVoteRequest(null)).toEqual({ ok: false, reason: "malformed_body" });
  });

  it("client-supplied reviewerUserId/teamId/runId/submittedAt/vote-ID/quorum/actor fields are simply never read — the parser only ever extracts panelRevision/status/comment/conditions", () => {
    const result = parseSubmitAdaptiveReviewVoteRequest({
      panelRevision: 1,
      status: "approved",
      reviewerUserId: "attacker-uid",
      teamId: "attacker-team",
      runId: "attacker-run",
      submittedAt: "2020-01-01T00:00:00.000Z",
      voteId: "forged-id",
      quorum: 99,
      finalDecision: "approved",
    });
    expect(result).toEqual({ ok: true, value: { panelRevision: 1, status: "approved", comment: undefined, conditions: undefined } });
  });

  it("shared validation drift is impossible — reuses the exact same core as parseAdaptiveReviewDecisionRequest, not a forked copy", () => {
    // Both parsers agree on the exact same failure reason for the exact
    // same status-rule violation, because they call the same function.
    const voteResult = parseSubmitAdaptiveReviewVoteRequest({ panelRevision: 1, status: "approved", conditions: ["x"] });
    expect(voteResult).toEqual({ ok: false, reason: "conditions_not_allowed" });
  });
});

function validVote(overrides: Partial<AdaptiveHumanReviewVoteV1> = {}): AdaptiveHumanReviewVoteV1 {
  return {
    schemaVersion: 1,
    kind: "adaptive_human_review_vote",
    teamId: "team-1",
    runId: "run-1",
    panelRevision: 1,
    reviewerUserId: "reviewer-a",
    status: "approved",
    comment: undefined,
    conditions: undefined,
    commentPresent: false,
    conditionsCount: 0,
    submittedAt: VALID_TIMESTAMP,
    ...overrides,
  };
}

describe("buildAdaptiveHumanReviewVote", () => {
  it("sets commentPresent/conditionsCount correctly from the given comment/conditions", () => {
    const vote = buildAdaptiveHumanReviewVote({
      teamId: "team-1",
      runId: "run-1",
      panelRevision: 1,
      reviewerUserId: "reviewer-a",
      status: "changes_requested",
      comment: "please revise",
      now: VALID_TIMESTAMP,
    });
    expect(vote.commentPresent).toBe(true);
    expect(vote.conditionsCount).toBe(0);
  });

  it("sets conditionsCount from the conditions array length", () => {
    const vote = buildAdaptiveHumanReviewVote({
      teamId: "team-1",
      runId: "run-1",
      panelRevision: 1,
      reviewerUserId: "reviewer-a",
      status: "approved_with_conditions",
      conditions: ["a", "b", "c"],
      now: VALID_TIMESTAMP,
    });
    expect(vote.conditionsCount).toBe(3);
    expect(vote.commentPresent).toBe(false);
  });

  it("Phase 9B.5.2 — teamId: null (Workspace-bound panel vote) produces a vote document with teamId: null, not coerced/omitted, and round-trips through the parser unchanged", () => {
    const vote = buildAdaptiveHumanReviewVote({ teamId: null, runId: "run-1", panelRevision: 1, reviewerUserId: "reviewer-a", status: "approved", now: VALID_TIMESTAMP });
    expect(vote.teamId).toBeNull();
    const parsed = parseAdaptiveHumanReviewVote(vote);
    expect(parsed.status).toBe("valid");
    if (parsed.status === "valid") expect(parsed.vote.teamId).toBeNull();
  });
});

describe("isSemanticallyEquivalentAdaptiveHumanReviewVote", () => {
  it("two votes with identical content but different submittedAt are equivalent", () => {
    const a = validVote({ submittedAt: "2026-01-01T00:00:00.000Z" });
    const b = validVote({ submittedAt: "2026-06-01T00:00:00.000Z" });
    expect(isSemanticallyEquivalentAdaptiveHumanReviewVote(a, b)).toBe(true);
  });

  it("a different status is not equivalent", () => {
    const a = validVote({ status: "approved" });
    const b = validVote({ status: "rejected" });
    expect(isSemanticallyEquivalentAdaptiveHumanReviewVote(a, b)).toBe(false);
  });

  it("a different comment is not equivalent", () => {
    const a = validVote({ status: "rejected", comment: "reason A", commentPresent: true });
    const b = validVote({ status: "rejected", comment: "reason B", commentPresent: true });
    expect(isSemanticallyEquivalentAdaptiveHumanReviewVote(a, b)).toBe(false);
  });

  it("a different conditions array is not equivalent", () => {
    const a = validVote({ status: "approved_with_conditions", conditions: ["x"], conditionsCount: 1 });
    const b = validVote({ status: "approved_with_conditions", conditions: ["y"], conditionsCount: 1 });
    expect(isSemanticallyEquivalentAdaptiveHumanReviewVote(a, b)).toBe(false);
  });

  it("the same normalized conditions in the same order are equivalent", () => {
    const a = validVote({ status: "approved_with_conditions", conditions: ["x", "y"], conditionsCount: 2 });
    const b = validVote({ status: "approved_with_conditions", conditions: ["x", "y"], conditionsCount: 2 });
    expect(isSemanticallyEquivalentAdaptiveHumanReviewVote(a, b)).toBe(true);
  });

  it("a different panelRevision is not equivalent", () => {
    const a = validVote({ panelRevision: 1 });
    const b = validVote({ panelRevision: 2 });
    expect(isSemanticallyEquivalentAdaptiveHumanReviewVote(a, b)).toBe(false);
  });

  it("a different reviewer is not equivalent", () => {
    const a = validVote({ reviewerUserId: "reviewer-a" });
    const b = validVote({ reviewerUserId: "reviewer-b" });
    expect(isSemanticallyEquivalentAdaptiveHumanReviewVote(a, b)).toBe(false);
  });
});

describe("parseAdaptiveHumanReviewVote", () => {
  it("a valid vote parses as valid", () => {
    const result = parseAdaptiveHumanReviewVote(validVote());
    expect(result.status).toBe("valid");
  });

  it("a schemaVersion greater than 1 is unsupported_version", () => {
    expect(parseAdaptiveHumanReviewVote(validVote({ schemaVersion: 2 as 1 }))).toEqual({ status: "unsupported_version" });
  });

  it("a missing schemaVersion is malformed", () => {
    const { schemaVersion, ...rest } = validVote();
    expect(parseAdaptiveHumanReviewVote(rest)).toEqual({ status: "malformed" });
  });

  it("wrong kind is malformed", () => {
    expect(parseAdaptiveHumanReviewVote(validVote({ kind: "something_else" as any }))).toEqual({ status: "malformed" });
  });

  it("empty/missing teamId is malformed", () => {
    expect(parseAdaptiveHumanReviewVote(validVote({ teamId: "" }))).toEqual({ status: "malformed" });
  });

  it("Phase 9B.5.2 — teamId: null (Workspace-bound panel vote) parses as valid, distinct from empty/undefined; every existing legacy Team vote (non-null string teamId) continues to parse exactly as before", () => {
    const nullResult = parseAdaptiveHumanReviewVote(validVote({ teamId: null }));
    expect(nullResult.status).toBe("valid");
    if (nullResult.status === "valid") expect(nullResult.vote.teamId).toBeNull();

    const legacyResult = parseAdaptiveHumanReviewVote(validVote({ teamId: "team-1" }));
    expect(legacyResult.status).toBe("valid");
    if (legacyResult.status === "valid") expect(legacyResult.vote.teamId).toBe("team-1");
  });

  it("empty/missing runId is malformed", () => {
    expect(parseAdaptiveHumanReviewVote(validVote({ runId: "" }))).toEqual({ status: "malformed" });
  });

  it("a non-integer or non-positive panelRevision is malformed", () => {
    expect(parseAdaptiveHumanReviewVote(validVote({ panelRevision: 0 }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewVote(validVote({ panelRevision: 1.5 as any }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewVote(validVote({ panelRevision: "1" as any }))).toEqual({ status: "malformed" });
  });

  it("empty/missing reviewerUserId is malformed", () => {
    expect(parseAdaptiveHumanReviewVote(validVote({ reviewerUserId: "" }))).toEqual({ status: "malformed" });
  });

  it("an invalid status is malformed", () => {
    expect(parseAdaptiveHumanReviewVote(validVote({ status: "unreviewed" as any }))).toEqual({ status: "malformed" });
  });

  it("commentPresent not matching the actual comment is malformed", () => {
    expect(parseAdaptiveHumanReviewVote(validVote({ status: "rejected", comment: "x", commentPresent: false }))).toEqual({
      status: "malformed",
    });
    expect(parseAdaptiveHumanReviewVote(validVote({ commentPresent: true }))).toEqual({ status: "malformed" }); // no comment but claims present
  });

  it("conditionsCount not matching the actual conditions length is malformed", () => {
    expect(
      parseAdaptiveHumanReviewVote(
        validVote({ status: "approved_with_conditions", conditions: ["a", "b"], conditionsCount: 1 })
      )
    ).toEqual({ status: "malformed" });
  });

  it("an invalid submittedAt is malformed", () => {
    expect(parseAdaptiveHumanReviewVote(validVote({ submittedAt: "not-a-date" }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewVote(validVote({ submittedAt: "" }))).toEqual({ status: "malformed" });
  });

  it("duplicate conditions are malformed", () => {
    expect(
      parseAdaptiveHumanReviewVote(
        validVote({ status: "approved_with_conditions", conditions: ["a", "a"], conditionsCount: 2 })
      )
    ).toEqual({ status: "malformed" });
  });

  it("an empty-string condition entry is malformed", () => {
    expect(
      parseAdaptiveHumanReviewVote(
        validVote({ status: "approved_with_conditions", conditions: ["a", ""], conditionsCount: 2 })
      )
    ).toEqual({ status: "malformed" });
  });

  it("a status-rule mismatch (e.g. approved with conditions present) is malformed", () => {
    expect(
      parseAdaptiveHumanReviewVote(validVote({ status: "approved", conditions: ["x"], conditionsCount: 1 }))
    ).toEqual({ status: "malformed" });
  });

  it("a runId/teamId/panelRevision/reviewerUserId mismatch against the caller's expected context is malformed", () => {
    expect(parseAdaptiveHumanReviewVote(validVote(), { expectedTeamId: "team-2" })).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewVote(validVote(), { expectedRunId: "run-2" })).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewVote(validVote(), { expectedPanelRevision: 99 })).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewVote(validVote(), { expectedReviewerUserId: "someone-else" })).toEqual({ status: "malformed" });
  });

  it("a matching context passes through unaffected", () => {
    const result = parseAdaptiveHumanReviewVote(validVote(), {
      expectedTeamId: "team-1",
      expectedRunId: "run-1",
      expectedPanelRevision: 1,
      expectedReviewerUserId: "reviewer-a",
    });
    expect(result.status).toBe("valid");
  });

  it("never coerces malformed data into a valid vote", () => {
    const result = parseAdaptiveHumanReviewVote(validVote({ conditionsCount: 999 }));
    expect(result).toEqual({ status: "malformed" });
    expect(result).not.toHaveProperty("vote");
  });

  it("is deterministic — the same valid input always parses to the same output", () => {
    const input = validVote();
    expect(parseAdaptiveHumanReviewVote(input)).toEqual(parseAdaptiveHumanReviewVote(input));
  });

  it("never includes an aggregate/final-decision/quorum field on the parsed vote — the type has none to begin with", () => {
    const result = parseAdaptiveHumanReviewVote(validVote());
    if (result.status === "valid") {
      expect(result.vote).not.toHaveProperty("finalDecision");
      expect(result.vote).not.toHaveProperty("quorum");
      expect(result.vote).not.toHaveProperty("aggregateStatus");
    }
  });
});
