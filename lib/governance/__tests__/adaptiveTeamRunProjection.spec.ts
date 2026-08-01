/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part C —
 * buildAdaptiveTeamRunProjection() / truncateReceiptConclusionForProjection()
 * contract tests.
 */

import {
  AdaptiveTeamRunProjection,
  RECEIPT_CONCLUSION_PROJECTION_LIMIT,
  buildAdaptiveTeamRunProjection,
  truncateReceiptConclusionForProjection,
} from "@/lib/governance/adaptiveTeamReview";

const BASE_ARGS = {
  teamId: "team_abc12345_1700000000000",
  userId: "uid-123",
  runId: "run-11111111-1111-1111-1111-111111111111",
  schemaId: "ranked_enumeration" as const,
  answerShape: "ranked_list" as const,
  receiptConclusion: "The panel reached consensus on the top three options.",
  sourceBacked: true,
  humanReviewNeeded: false,
  automatedGovernanceStatus: "passed" as const,
  humanReviewStatus: "unreviewed" as const,
  now: "2026-07-28T12:00:00.000Z",
};

describe("truncateReceiptConclusionForProjection", () => {
  it("returns the input unchanged when at or under the limit", () => {
    const exact = "x".repeat(RECEIPT_CONCLUSION_PROJECTION_LIMIT);
    expect(truncateReceiptConclusionForProjection(exact)).toBe(exact);
    expect(truncateReceiptConclusionForProjection("short")).toBe("short");
  });

  it("truncates and appends an ellipsis when over the limit", () => {
    const long = "y".repeat(RECEIPT_CONCLUSION_PROJECTION_LIMIT + 50);
    const result = truncateReceiptConclusionForProjection(long);
    expect(result.length).toBe(RECEIPT_CONCLUSION_PROJECTION_LIMIT);
    expect(result.endsWith("…")).toBe(true);
    expect(result.slice(0, -1)).toBe("y".repeat(RECEIPT_CONCLUSION_PROJECTION_LIMIT - 1));
  });

  it("is deterministic — identical input always produces identical output", () => {
    const long = "z".repeat(RECEIPT_CONCLUSION_PROJECTION_LIMIT + 10);
    expect(truncateReceiptConclusionForProjection(long)).toBe(truncateReceiptConclusionForProjection(long));
  });

  it("never rewrites content semantically — output is always a prefix of the input plus at most the ellipsis", () => {
    const long = "The panel found several notable risks. ".repeat(20);
    const result = truncateReceiptConclusionForProjection(long);
    const withoutEllipsis = result.endsWith("…") ? result.slice(0, -1) : result;
    expect(long.startsWith(withoutEllipsis)).toBe(true);
  });
});

describe("buildAdaptiveTeamRunProjection", () => {
  it("produces a projection with exactly the expected field set and discriminator", () => {
    const projection = buildAdaptiveTeamRunProjection(BASE_ARGS);
    expect(projection).toEqual<AdaptiveTeamRunProjection>({
      projectionVersion: 1,
      teamId: BASE_ARGS.teamId,
      userId: BASE_ARGS.userId,
      runId: BASE_ARGS.runId,
      adaptive: true,
      schemaId: BASE_ARGS.schemaId,
      answerShape: BASE_ARGS.answerShape,
      receiptConclusion: BASE_ARGS.receiptConclusion,
      sourceBacked: BASE_ARGS.sourceBacked,
      humanReviewNeeded: BASE_ARGS.humanReviewNeeded,
      automatedGovernanceStatus: BASE_ARGS.automatedGovernanceStatus,
      humanReviewStatus: BASE_ARGS.humanReviewStatus,
      createdAt: BASE_ARGS.now,
      updatedAt: BASE_ARGS.now,
    });
  });

  it("sets createdAt and updatedAt to the same provided timestamp on initial creation", () => {
    const projection = buildAdaptiveTeamRunProjection(BASE_ARGS);
    expect(projection.createdAt).toBe(BASE_ARGS.now);
    expect(projection.updatedAt).toBe(BASE_ARGS.now);
  });

  it("truncates a long receiptConclusion via the shared truncation function", () => {
    const long = "a".repeat(RECEIPT_CONCLUSION_PROJECTION_LIMIT + 100);
    const projection = buildAdaptiveTeamRunProjection({ ...BASE_ARGS, receiptConclusion: long });
    expect(projection.receiptConclusion).toBe(truncateReceiptConclusionForProjection(long));
    expect(projection.receiptConclusion.length).toBe(RECEIPT_CONCLUSION_PROJECTION_LIMIT);
  });

  it("omits automatedGovernanceStatus when not provided (undefined, not a fabricated default)", () => {
    const { automatedGovernanceStatus, ...withoutStatus } = BASE_ARGS;
    const projection = buildAdaptiveTeamRunProjection(withoutStatus);
    expect(projection.automatedGovernanceStatus).toBeUndefined();
  });

  it("never includes fields outside the compact contract — no sources, basis, assumptions, uncertainties, question, comment, conditions, or reviewer identity", () => {
    const projection = buildAdaptiveTeamRunProjection(BASE_ARGS) as Record<string, unknown>;
    const forbiddenKeys = [
      "sources",
      "basis",
      "assumptions",
      "uncertainties",
      "limitations",
      "question",
      "comment",
      "conditions",
      "reviewerId",
      "reviewerName",
      "decisionReceipt",
      "rawModelOutput",
    ];
    for (const key of forbiddenKeys) {
      expect(projection).not.toHaveProperty(key);
    }
  });

  it("carries humanReviewNeeded and humanReviewStatus independently (not derived from each other)", () => {
    const flagged = buildAdaptiveTeamRunProjection({ ...BASE_ARGS, humanReviewNeeded: true, humanReviewStatus: "pending" });
    expect(flagged.humanReviewNeeded).toBe(true);
    expect(flagged.humanReviewStatus).toBe("pending");

    const notNeeded = buildAdaptiveTeamRunProjection({ ...BASE_ARGS, humanReviewNeeded: false, humanReviewStatus: "unreviewed" });
    expect(notNeeded.humanReviewNeeded).toBe(false);
    expect(notNeeded.humanReviewStatus).toBe("unreviewed");
  });
});
