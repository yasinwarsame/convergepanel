/**
 * Transactional Multi-Reviewer Finalization, Part E — pure model tests:
 * the deterministic final-decision identity, the canonical condition
 * union, the system-generated comment, the canonical humanReview
 * provenance builder, and the panel finalization history builder.
 */

import {
  buildAdaptivePanelFinalDecisionId,
  buildWorkspacePanelFinalDecisionId,
  buildFinalConditionsUnion,
  buildFinalSystemComment,
  buildFinalizedMultiReviewerHumanReview,
  buildAdaptivePanelFinalizationHistoryEntry,
} from "@/lib/governance/adaptivePanelFinalization";
import { AdaptiveHumanReviewVoteV1 } from "@/lib/governance/adaptiveHumanReviewVote";

describe("buildAdaptivePanelFinalDecisionId", () => {
  it("is deterministic — the same inputs always produce the same ID", () => {
    const a = buildAdaptivePanelFinalDecisionId("team-1", "run-1", 3, "approved", 1);
    const b = buildAdaptivePanelFinalDecisionId("team-1", "run-1", 3, "approved", 1);
    expect(a).toBe(b);
  });

  it("does NOT depend on a timestamp — no now/finalizedAt argument exists at all, so retries always match", () => {
    // Structural proof: the function signature itself has no time input.
    expect(buildAdaptivePanelFinalDecisionId.length).toBe(5);
  });

  it("a different panelRevision produces a different ID", () => {
    const a = buildAdaptivePanelFinalDecisionId("team-1", "run-1", 3, "approved", 1);
    const b = buildAdaptivePanelFinalDecisionId("team-1", "run-1", 4, "approved", 1);
    expect(a).not.toBe(b);
  });

  it("a different finalStatus produces a different ID", () => {
    const a = buildAdaptivePanelFinalDecisionId("team-1", "run-1", 3, "approved", 1);
    const b = buildAdaptivePanelFinalDecisionId("team-1", "run-1", 3, "rejected", 1);
    expect(a).not.toBe(b);
  });

  it("a different runId produces a different ID", () => {
    const a = buildAdaptivePanelFinalDecisionId("team-1", "run-1", 3, "approved", 1);
    const b = buildAdaptivePanelFinalDecisionId("team-1", "run-2", 3, "approved", 1);
    expect(a).not.toBe(b);
  });

  it("is a safe Firestore document ID (no slash, prefixed, hex digest)", () => {
    const id = buildAdaptivePanelFinalDecisionId("team-1", "run-1", 3, "approved", 1);
    expect(id).not.toContain("/");
    expect(id).toMatch(/^panel_dec_[0-9a-f]{32}$/);
  });

  it("throws on empty required components (programmer error, not domain input)", () => {
    expect(() => buildAdaptivePanelFinalDecisionId("", "run-1", 3, "approved", 1)).toThrow();
    expect(() => buildAdaptivePanelFinalDecisionId("team-1", "", 3, "approved", 1)).toThrow();
    expect(() => buildAdaptivePanelFinalDecisionId("team-1", "run-1", 0, "approved", 1)).toThrow();
    expect(() => buildAdaptivePanelFinalDecisionId("team-1", "run-1", 3, "", 1)).toThrow();
  });
});

describe("buildWorkspacePanelFinalDecisionId (Phase 9B.5.2)", () => {
  it("is deterministic", () => {
    const a = buildWorkspacePanelFinalDecisionId("ws-1", "run-1", 3, "approved", 1);
    const b = buildWorkspacePanelFinalDecisionId("ws-1", "run-1", 3, "approved", 1);
    expect(a).toBe(b);
  });

  it("produces a distinct ID when workspaceId, runId, panelRevision, or finalStatus differs", () => {
    const base = buildWorkspacePanelFinalDecisionId("ws-1", "run-1", 3, "approved", 1);
    expect(buildWorkspacePanelFinalDecisionId("ws-2", "run-1", 3, "approved", 1)).not.toBe(base);
    expect(buildWorkspacePanelFinalDecisionId("ws-1", "run-2", 3, "approved", 1)).not.toBe(base);
    expect(buildWorkspacePanelFinalDecisionId("ws-1", "run-1", 4, "approved", 1)).not.toBe(base);
    expect(buildWorkspacePanelFinalDecisionId("ws-1", "run-1", 3, "rejected", 1)).not.toBe(base);
  });

  it("never collides with the legacy Team decision-ID namespace for the same runId/panelRevision/finalStatus/aggregationPolicyVersion", () => {
    const workspaceId = buildWorkspacePanelFinalDecisionId("ws-1", "run-1", 3, "approved", 1);
    const team = buildAdaptivePanelFinalDecisionId("ws-1", "run-1", 3, "approved", 1);
    expect(workspaceId).not.toBe(team);
  });

  it("is a safe Firestore document ID with a distinct prefix from the legacy Team builder", () => {
    const id = buildWorkspacePanelFinalDecisionId("ws-1", "run-1", 3, "approved", 1);
    expect(id).not.toContain("/");
    expect(id).toMatch(/^panel_workspace_dec_[0-9a-f]{32}$/);
  });

  it("throws on empty required components", () => {
    expect(() => buildWorkspacePanelFinalDecisionId("", "run-1", 3, "approved", 1)).toThrow();
    expect(() => buildWorkspacePanelFinalDecisionId("ws-1", "", 3, "approved", 1)).toThrow();
    expect(() => buildWorkspacePanelFinalDecisionId("ws-1", "run-1", 0, "approved", 1)).toThrow();
    expect(() => buildWorkspacePanelFinalDecisionId("ws-1", "run-1", 3, "", 1)).toThrow();
  });
});

function vote(reviewerUserId: string, status: AdaptiveHumanReviewVoteV1["status"], conditions?: string[]): AdaptiveHumanReviewVoteV1 {
  return {
    schemaVersion: 1,
    kind: "adaptive_human_review_vote",
    teamId: "team-1",
    runId: "run-1",
    panelRevision: 1,
    reviewerUserId,
    status,
    conditions,
    comment: status === "changes_requested" || status === "rejected" ? "reason" : undefined,
    commentPresent: status === "changes_requested" || status === "rejected",
    conditionsCount: conditions?.length ?? 0,
    submittedAt: "2020-01-01T00:00:00.000Z",
  };
}

describe("buildFinalConditionsUnion", () => {
  it("unions conditions from only the supporting (winning-group) reviewers, in their sorted order", () => {
    const votes = [vote("a", "approved_with_conditions", ["x"]), vote("b", "approved_with_conditions", ["y"]), vote("c", "rejected")];
    const union = buildFinalConditionsUnion(votes, ["a", "b"]);
    expect(union).toEqual(["x", "y"]);
  });

  it("excludes a losing-group vote's conditions even if that reviewer happens to have some (shouldn't happen, but never trusted)", () => {
    const votes = [vote("a", "approved", undefined), vote("b", "rejected")];
    const union = buildFinalConditionsUnion(votes, ["a"]); // "a" won with plain "approved" — no AC vote at all
    expect(union).toEqual([]);
  });

  it("exact-string deduplicates across multiple supporting votes", () => {
    const votes = [vote("a", "approved_with_conditions", ["must fix X"]), vote("b", "approved_with_conditions", ["must fix X"])];
    const union = buildFinalConditionsUnion(votes, ["a", "b"]);
    expect(union).toEqual(["must fix X"]);
  });

  it("preserves first-occurrence order across reviewers", () => {
    const votes = [vote("a", "approved_with_conditions", ["first", "second"]), vote("b", "approved_with_conditions", ["third", "first"])];
    const union = buildFinalConditionsUnion(votes, ["a", "b"]);
    expect(union).toEqual(["first", "second", "third"]);
  });

  it("caps the union at MAX_REVIEW_CONDITIONS_COUNT (20), keeping the first N in order", () => {
    const manyConditions = Array.from({ length: 15 }, (_, i) => `condition-a-${i}`);
    const moreConditions = Array.from({ length: 15 }, (_, i) => `condition-b-${i}`);
    const votes = [vote("a", "approved_with_conditions", manyConditions), vote("b", "approved_with_conditions", moreConditions)];
    const union = buildFinalConditionsUnion(votes, ["a", "b"]);
    expect(union).toHaveLength(20);
    expect(union[0]).toBe("condition-a-0");
    expect(union[19]).toBe("condition-b-4");
  });

  it("returns an empty array when no supporting vote is approved_with_conditions", () => {
    const votes = [vote("a", "approved"), vote("b", "approved")];
    expect(buildFinalConditionsUnion(votes, ["a", "b"])).toEqual([]);
  });

  it("never returns condition text from a reviewer not in supportingReviewerUserIds even if their vote object is present in the array", () => {
    const votes = [vote("a", "approved_with_conditions", ["a-condition"]), vote("z", "approved_with_conditions", ["z-condition"])];
    const union = buildFinalConditionsUnion(votes, ["a"]);
    expect(union).toEqual(["a-condition"]);
  });
});

describe("buildFinalSystemComment", () => {
  it("returns the fixed system comment for changes_requested", () => {
    expect(buildFinalSystemComment("changes_requested")).toBe("Finalized by multi-reviewer panel.");
  });

  it("returns the fixed system comment for rejected", () => {
    expect(buildFinalSystemComment("rejected")).toBe("Finalized by multi-reviewer panel.");
  });

  it("returns undefined for approved", () => {
    expect(buildFinalSystemComment("approved")).toBeUndefined();
  });

  it("returns undefined for approved_with_conditions", () => {
    expect(buildFinalSystemComment("approved_with_conditions")).toBeUndefined();
  });

  it("never contains any individual reviewer's private comment text — it is a fixed literal, not built from input", () => {
    expect(buildFinalSystemComment.length).toBe(1); // only takes finalStatus, nothing else
  });
});

describe("buildFinalizedMultiReviewerHumanReview", () => {
  it("builds the full canonical humanReview object with multi-reviewer provenance", () => {
    const result = buildFinalizedMultiReviewerHumanReview({
      finalStatus: "approved_with_conditions",
      finalizingActorUid: "owner-uid",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      conditions: ["must fix X"],
      panelRevision: 3,
      aggregationPolicyVersion: 1,
      supportingReviewerCount: 2,
    });
    expect(result).toEqual({
      status: "approved_with_conditions",
      reviewerId: "owner-uid",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      comment: undefined,
      conditions: ["must fix X"],
      decidedVia: "multi_reviewer_panel",
      panelRevision: 3,
      aggregationPolicyVersion: 1,
      supportingReviewerCount: 2,
    });
  });

  it("sets the system comment and omits conditions for changes_requested", () => {
    const result = buildFinalizedMultiReviewerHumanReview({
      finalStatus: "changes_requested",
      finalizingActorUid: "owner-uid",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      panelRevision: 3,
      aggregationPolicyVersion: 1,
      supportingReviewerCount: 2,
    });
    expect(result.comment).toBe("Finalized by multi-reviewer panel.");
    expect(result.conditions).toBeUndefined();
  });

  it("omits conditions for plain approved even if conditions were (incorrectly) passed in", () => {
    const result = buildFinalizedMultiReviewerHumanReview({
      finalStatus: "approved",
      finalizingActorUid: "owner-uid",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      conditions: ["should be dropped"],
      panelRevision: 3,
      aggregationPolicyVersion: 1,
      supportingReviewerCount: 2,
    });
    expect(result.conditions).toBeUndefined();
  });

  it("never includes the full reviewer list or raw vote text — only compact provenance fields", () => {
    const result = buildFinalizedMultiReviewerHumanReview({
      finalStatus: "approved",
      finalizingActorUid: "owner-uid",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      panelRevision: 3,
      aggregationPolicyVersion: 1,
      supportingReviewerCount: 2,
    });
    expect(result).not.toHaveProperty("reviewerUserIds");
    expect(result).not.toHaveProperty("votes");
    expect(result).not.toHaveProperty("supportingReviewerUserIds");
  });
});

describe("buildAdaptivePanelFinalizationHistoryEntry", () => {
  it("builds a metadata-only entry with a deterministic eventId", () => {
    const entry = buildAdaptivePanelFinalizationHistoryEntry({
      teamId: "team-1",
      runId: "run-1",
      preFinalizationPanelRevision: 3,
      finalizedPanelRevision: 4,
      finalStatus: "approved",
      finalDecisionId: "panel_dec_x",
      aggregationPolicyVersion: 1,
      reviewerCount: 3,
      submittedCount: 3,
      supportingReviewerCount: 2,
      actorUserId: "owner-uid",
      finalizedAt: "2020-06-01T00:00:00.000Z",
    });
    expect(entry.eventId).toBe("4:panel_finalized");
    expect(entry.eventType).toBe("panel_finalized");
    expect(entry.finalDecisionId).toBe("panel_dec_x");
  });

  it("Phase 9B.5.2 — teamId: null (Workspace-bound panel finalization) is accepted, not coerced/omitted", () => {
    const entry = buildAdaptivePanelFinalizationHistoryEntry({
      teamId: null,
      runId: "run-1",
      preFinalizationPanelRevision: 1,
      finalizedPanelRevision: 2,
      finalStatus: "approved",
      finalDecisionId: "panel_workspace_dec_x",
      aggregationPolicyVersion: 1,
      reviewerCount: 2,
      submittedCount: 2,
      supportingReviewerCount: 2,
      actorUserId: "owner-uid",
      finalizedAt: "2020-06-01T00:00:00.000Z",
    });
    expect(entry.teamId).toBeNull();
  });

  it("never includes vote comments, conditions, or reviewer names/emails", () => {
    const entry = buildAdaptivePanelFinalizationHistoryEntry({
      teamId: "team-1",
      runId: "run-1",
      preFinalizationPanelRevision: 1,
      finalizedPanelRevision: 2,
      finalStatus: "rejected",
      finalDecisionId: "panel_dec_y",
      aggregationPolicyVersion: 1,
      reviewerCount: 2,
      submittedCount: 2,
      supportingReviewerCount: 2,
      actorUserId: "owner-uid",
      finalizedAt: "2020-06-01T00:00:00.000Z",
    });
    for (const forbidden of ["comment", "condition", "email", "reviewerName"]) {
      expect(JSON.stringify(entry).toLowerCase()).not.toContain(forbidden);
    }
  });
});
