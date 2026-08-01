/**
 * Immutable Adaptive Review History — read-side classifier/sort tests
 * (classifyAdaptiveHumanReviewHistoryRow, sortAdaptiveReviewHistoryRows).
 */

import { classifyAdaptiveHumanReviewHistoryRow, sortAdaptiveReviewHistoryRows } from "@/lib/governance/adaptiveHumanReviewHistory";

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: "adaptive_human_review",
    historyId: "dec_abc",
    decisionId: "dec_abc",
    runId: "run-1",
    teamId: "team-1",
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    priorStatus: "unreviewed",
    newStatus: "approved",
    reviewerId: "reviewer-uid",
    reviewedAt: "2026-07-30T00:00:00.000Z",
    governanceRecordUpdatedAt: "2026-07-30T00:00:00.000Z",
    commentPresent: false,
    conditionsCount: 0,
    createdAt: "2026-07-30T00:00:01.000Z",
    ...overrides,
  };
}

describe("classifyAdaptiveHumanReviewHistoryRow", () => {
  it("classifies a valid row and extracts only the 5 compact fields", () => {
    const result = classifyAdaptiveHumanReviewHistoryRow("dec_abc", validRow());
    expect(result).toEqual({
      status: "valid",
      historyId: "dec_abc",
      item: {
        priorStatus: "unreviewed",
        newStatus: "approved",
        reviewedAt: "2026-07-30T00:00:00.000Z",
        commentPresent: false,
        conditionsCount: 0,
      },
    });
  });

  it("never leaks reviewerId, teamId, schemaId, decisionId, or comment/conditions text into the item", () => {
    const result = classifyAdaptiveHumanReviewHistoryRow("dec_abc", validRow());
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(Object.keys(result.item).sort()).toEqual(["commentPresent", "conditionsCount", "newStatus", "priorStatus", "reviewedAt"].sort());
    }
  });

  it("rejects a non-object row", () => {
    expect(classifyAdaptiveHumanReviewHistoryRow("id", null)).toEqual({ status: "malformed", historyId: "id" });
    expect(classifyAdaptiveHumanReviewHistoryRow("id", "a string")).toEqual({ status: "malformed", historyId: "id" });
  });

  it("rejects an unsupported version", () => {
    const result = classifyAdaptiveHumanReviewHistoryRow("id", validRow({ version: 2 }));
    expect(result).toEqual({ status: "malformed", historyId: "id" });
  });

  it("rejects a wrong kind", () => {
    const result = classifyAdaptiveHumanReviewHistoryRow("id", validRow({ kind: "something_else" }));
    expect(result).toEqual({ status: "malformed", historyId: "id" });
  });

  it.each(["priorStatus", "newStatus", "reviewedAt", "commentPresent", "conditionsCount"])(
    "rejects a missing or invalid %s",
    (field) => {
      const row = validRow();
      delete (row as any)[field];
      const result = classifyAdaptiveHumanReviewHistoryRow("id", row);
      expect(result).toEqual({ status: "malformed", historyId: "id" });
    }
  );

  it("rejects a terminal value in priorStatus (only unreviewed/pending are valid there)", () => {
    const result = classifyAdaptiveHumanReviewHistoryRow("id", validRow({ priorStatus: "approved" }));
    expect(result).toEqual({ status: "malformed", historyId: "id" });
  });

  it("rejects a non-terminal value in newStatus", () => {
    const result = classifyAdaptiveHumanReviewHistoryRow("id", validRow({ newStatus: "unreviewed" }));
    expect(result).toEqual({ status: "malformed", historyId: "id" });
  });

  it("rejects a negative conditionsCount", () => {
    const result = classifyAdaptiveHumanReviewHistoryRow("id", validRow({ conditionsCount: -1 }));
    expect(result).toEqual({ status: "malformed", historyId: "id" });
  });
});

describe("sortAdaptiveReviewHistoryRows", () => {
  it("sorts by reviewedAt ascending", () => {
    const rows = [
      { historyId: "b", item: { priorStatus: "unreviewed" as const, newStatus: "approved" as const, reviewedAt: "2026-07-30T02:00:00.000Z", commentPresent: false, conditionsCount: 0 } },
      { historyId: "a", item: { priorStatus: "unreviewed" as const, newStatus: "approved" as const, reviewedAt: "2026-07-30T01:00:00.000Z", commentPresent: false, conditionsCount: 0 } },
    ];
    const sorted = sortAdaptiveReviewHistoryRows(rows);
    expect(sorted.map((i) => i.reviewedAt)).toEqual(["2026-07-30T01:00:00.000Z", "2026-07-30T02:00:00.000Z"]);
  });

  it("breaks ties deterministically by historyId, never exposed in the output", () => {
    const rows = [
      { historyId: "z", item: { priorStatus: "unreviewed" as const, newStatus: "approved" as const, reviewedAt: "2026-07-30T00:00:00.000Z", commentPresent: false, conditionsCount: 0 } },
      { historyId: "a", item: { priorStatus: "unreviewed" as const, newStatus: "approved" as const, reviewedAt: "2026-07-30T00:00:00.000Z", commentPresent: false, conditionsCount: 1 } },
    ];
    const sorted = sortAdaptiveReviewHistoryRows(rows);
    expect(sorted[0].conditionsCount).toBe(1); // "a" sorts before "z"
    expect(sorted.every((i) => !("historyId" in i))).toBe(true);
  });

  it("does not mutate the input array", () => {
    const rows = [
      { historyId: "b", item: { priorStatus: "unreviewed" as const, newStatus: "approved" as const, reviewedAt: "2026-07-30T02:00:00.000Z", commentPresent: false, conditionsCount: 0 } },
    ];
    const original = [...rows];
    sortAdaptiveReviewHistoryRows(rows);
    expect(rows).toEqual(original);
  });
});
