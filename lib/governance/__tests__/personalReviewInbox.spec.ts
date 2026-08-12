import {
  personalReviewInboxStatus,
  isPersonalReviewInboxStatusCompleted,
  buildPersonalReviewInboxItem,
  filterPersonalReviewInboxItems,
  PersonalReviewInboxItemV1,
} from "@/lib/governance/personalReviewInbox";

describe("personalReviewInboxStatus", () => {
  it.each(["unreviewed", "pending"] as const)("%s maps to assigned (never 'In review')", (s) => {
    expect(personalReviewInboxStatus(s)).toBe("assigned");
  });

  it.each(["approved", "approved_with_conditions", "changes_requested", "rejected"] as const)("%s maps to itself", (s) => {
    expect(personalReviewInboxStatus(s)).toBe(s);
  });
});

describe("isPersonalReviewInboxStatusCompleted", () => {
  it("assigned is not completed; every terminal status is", () => {
    expect(isPersonalReviewInboxStatusCompleted("assigned")).toBe(false);
    expect(isPersonalReviewInboxStatusCompleted("approved")).toBe(true);
    expect(isPersonalReviewInboxStatusCompleted("rejected")).toBe(true);
  });
});

function runData(overrides: Record<string, unknown> = {}) {
  return {
    question: "What are the trends?",
    governanceRecord: {
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      humanReview: { status: "unreviewed" },
    },
    ...overrides,
  };
}

describe("buildPersonalReviewInboxItem", () => {
  it("builds a valid assigned row", () => {
    const item = buildPersonalReviewInboxItem({
      runId: "run-1",
      assignedAt: "2026-08-12T18:00:00.000Z",
      ownerDisplayName: "Jane Owner",
      runData: runData(),
    });
    expect(item).toEqual({
      runId: "run-1",
      title: "What are the trends?",
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      assignedAt: "2026-08-12T18:00:00.000Z",
      ownerDisplayName: "Jane Owner",
      status: "assigned",
    });
  });

  it("includes completedAt for a terminal status", () => {
    const item = buildPersonalReviewInboxItem({
      runId: "run-1",
      assignedAt: "2026-08-12T18:00:00.000Z",
      ownerDisplayName: "Jane Owner",
      runData: runData({
        governanceRecord: {
          schemaId: "decision_support",
          answerShape: "decision_support_view",
          humanReview: { status: "approved", reviewedAt: "2026-08-12T19:00:00.000Z" },
        },
      }),
    });
    expect(item?.status).toBe("approved");
    expect(item?.completedAt).toBe("2026-08-12T19:00:00.000Z");
  });

  it("truncates a very long title", () => {
    const longQuestion = "x".repeat(500);
    const item = buildPersonalReviewInboxItem({
      runId: "run-1",
      assignedAt: "2026-08-12T18:00:00.000Z",
      ownerDisplayName: "Jane Owner",
      runData: runData({ question: longQuestion }),
    });
    expect(item?.title.length).toBeLessThanOrEqual(201);
    expect(item?.title.endsWith("…")).toBe(true);
  });

  it("returns null for a malformed/missing governanceRecord rather than fabricating a row", () => {
    const item = buildPersonalReviewInboxItem({
      runId: "run-1",
      assignedAt: "2026-08-12T18:00:00.000Z",
      ownerDisplayName: "Jane Owner",
      runData: { question: "q" },
    });
    expect(item).toBeNull();
  });

  it("returns null for an invalid humanReview.status", () => {
    const item = buildPersonalReviewInboxItem({
      runId: "run-1",
      assignedAt: "2026-08-12T18:00:00.000Z",
      ownerDisplayName: "Jane Owner",
      runData: runData({
        governanceRecord: { schemaId: "decision_support", answerShape: "decision_support_view", humanReview: { status: "not_a_real_status" } },
      }),
    });
    expect(item).toBeNull();
  });

  it("never includes billing/token/comment fields — the DTO shape itself has no such keys", () => {
    const item = buildPersonalReviewInboxItem({
      runId: "run-1",
      assignedAt: "2026-08-12T18:00:00.000Z",
      ownerDisplayName: "Jane Owner",
      runData: runData(),
    });
    expect(Object.keys(item!).sort()).toEqual(["answerShape", "assignedAt", "ownerDisplayName", "runId", "schemaId", "status", "title"].sort());
  });
});

describe("filterPersonalReviewInboxItems", () => {
  const items: PersonalReviewInboxItemV1[] = [
    { runId: "a", title: "A", schemaId: "decision_support" as any, answerShape: "decision_support_view" as any, assignedAt: "t", ownerDisplayName: "O", status: "assigned" },
    { runId: "b", title: "B", schemaId: "decision_support" as any, answerShape: "decision_support_view" as any, assignedAt: "t", ownerDisplayName: "O", status: "approved", completedAt: "t2" },
    { runId: "c", title: "C", schemaId: "decision_support" as any, answerShape: "decision_support_view" as any, assignedAt: "t", ownerDisplayName: "O", status: "rejected", completedAt: "t2" },
  ];

  it("'all' returns everything", () => {
    expect(filterPersonalReviewInboxItems(items, "all")).toHaveLength(3);
  });

  it("'pending' returns only assigned", () => {
    expect(filterPersonalReviewInboxItems(items, "pending").map((i) => i.runId)).toEqual(["a"]);
  });

  it("'completed' returns every terminal status", () => {
    expect(filterPersonalReviewInboxItems(items, "completed").map((i) => i.runId)).toEqual(["b", "c"]);
  });
});
