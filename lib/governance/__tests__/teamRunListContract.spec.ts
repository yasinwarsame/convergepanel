/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — pure list-contract
 * unit tests: classifyTeamRunRow, mappers, filters, sort, pagination,
 * query-summary truncation.
 */

import {
  classifyTeamRunRow,
  buildTeamRunQuerySummary,
  TEAM_RUN_QUERY_SUMMARY_MAX_LENGTH,
  applyTeamRunListFilters,
  parseTeamRunListFilters,
  sortTeamRunListItems,
  paginateTeamRunListItems,
  isItemFlagged,
  AdaptiveTeamRunListItemV1,
  LegacyTeamRunListItemV1,
  TeamRunListItemV1,
  DEFAULT_TEAM_RUN_PAGE_SIZE,
  MAX_TEAM_RUN_PAGE_SIZE,
} from "@/lib/governance/teamRunListContract";

function fakeTimestamp(iso: string) {
  const ms = new Date(iso).getTime();
  return { toMillis: () => ms };
}

function validAdaptiveRaw(overrides: Record<string, unknown> = {}) {
  return {
    projectionVersion: 1,
    teamId: "team-1",
    userId: "owner-uid",
    runId: "run-1",
    adaptive: true,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    receiptConclusion: "The panel recommends option A.",
    sourceBacked: true,
    humanReviewNeeded: false,
    automatedGovernanceStatus: "flagged",
    humanReviewStatus: "unreviewed",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function validLegacyRaw(overrides: Record<string, unknown> = {}) {
  return {
    teamId: "team-1",
    userId: "owner-uid",
    userEmail: "owner@test.com",
    type: "research",
    query: "What is the best CRM?",
    consensusScore: 82,
    policyFlags: ["weak_evidence"],
    timestamp: fakeTimestamp("2026-07-27T00:00:00.000Z"),
    ...overrides,
  };
}

describe("buildTeamRunQuerySummary", () => {
  it("trims, normalizes line breaks, and returns short text unchanged", () => {
    expect(buildTeamRunQuerySummary("  hello\nworld  ")).toBe("hello world");
  });

  it("returns undefined for non-string or empty input", () => {
    expect(buildTeamRunQuerySummary(undefined)).toBeUndefined();
    expect(buildTeamRunQuerySummary(42)).toBeUndefined();
    expect(buildTeamRunQuerySummary("   ")).toBeUndefined();
  });

  it("truncates deterministically at the max length", () => {
    const long = "a".repeat(TEAM_RUN_QUERY_SUMMARY_MAX_LENGTH + 50);
    const result = buildTeamRunQuerySummary(long)!;
    expect(result.length).toBe(TEAM_RUN_QUERY_SUMMARY_MAX_LENGTH);
    expect(result.endsWith("…")).toBe(true);
  });

  it("never semantically rewrites — output is a prefix of the normalized input", () => {
    const long = "The panel found several risks worth noting. ".repeat(10);
    const result = buildTeamRunQuerySummary(long)!;
    const withoutEllipsis = result.endsWith("…") ? result.slice(0, -1) : result;
    expect(long.trim().startsWith(withoutEllipsis)).toBe(true);
  });
});

describe("classifyTeamRunRow — adaptive", () => {
  it("classifies a valid adaptive row", () => {
    const result = classifyTeamRunRow("team-1:run-1", validAdaptiveRaw());
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.item.kind).toBe("adaptive");
      const item = result.item as AdaptiveTeamRunListItemV1;
      expect(item.reviewable).toBe(true);
      expect(item.schemaId).toBe("decision_support");
    }
  });

  it("marks a terminal humanReviewStatus as not reviewable", () => {
    const result = classifyTeamRunRow("id", validAdaptiveRaw({ humanReviewStatus: "approved" }));
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect((result.item as AdaptiveTeamRunListItemV1).reviewable).toBe(false);
    }
  });

  it.each([
    ["projectionVersion", 2],
    ["teamId", ""],
    ["userId", ""],
    ["runId", ""],
    ["schemaId", "not_a_schema"],
    ["answerShape", "wrong_shape"],
    ["receiptConclusion", 42],
    ["sourceBacked", "yes"],
    ["humanReviewNeeded", "no"],
    ["automatedGovernanceStatus", "bogus"],
    ["humanReviewStatus", "bogus"],
    ["createdAt", "not-a-date"],
    ["updatedAt", "not-a-date"],
    ["reviewedAt", "not-a-date"],
  ])("rejects an invalid adaptive field: %s", (field, badValue) => {
    const result = classifyTeamRunRow("id", validAdaptiveRaw({ [field]: badValue }));
    expect(result).toEqual({ status: "malformed", teamRunId: "id", detectedKind: "adaptive" });
  });

  it("never falls back to the legacy mapper when the adaptive body is invalid", () => {
    const result = classifyTeamRunRow("id", validAdaptiveRaw({ schemaId: "garbage" }));
    expect(result.status).toBe("malformed");
    if (result.status === "malformed") {
      expect(result.detectedKind).toBe("adaptive");
    }
  });
});

describe("classifyTeamRunRow — legacy", () => {
  it("classifies a valid legacy row", () => {
    const result = classifyTeamRunRow("legacy-1", validLegacyRaw());
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      const item = result.item as LegacyTeamRunListItemV1;
      expect(item.kind).toBe("legacy");
      expect(item.querySummary).toBe("What is the best CRM?");
      expect(item.blockedByPolicy).toBe(true);
      expect(item.governanceReviewRequired).toBe(true);
    }
  });

  it("governanceReviewRequired is false once a humanDecision exists", () => {
    const result = classifyTeamRunRow(
      "legacy-1",
      validLegacyRaw({ humanDecision: { action: "approved", decidedBy: "u1", decidedAt: "2026-07-28T00:00:00.000Z", notes: "" } })
    );
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      const item = result.item as LegacyTeamRunListItemV1;
      expect(item.governanceReviewRequired).toBe(false);
      expect(item.humanDecision).toEqual({ action: "approved", decidedAt: "2026-07-28T00:00:00.000Z" });
    }
  });

  it("rejects a row with a missing or invalid timestamp", () => {
    const missing = classifyTeamRunRow("id", validLegacyRaw({ timestamp: undefined }));
    expect(missing).toEqual({ status: "malformed", teamRunId: "id", detectedKind: "legacy" });

    const wrongType = classifyTeamRunRow("id", validLegacyRaw({ timestamp: "2026-07-27T00:00:00.000Z" }));
    expect(wrongType).toEqual({ status: "malformed", teamRunId: "id", detectedKind: "legacy" });
  });

  it("rejects a row with a policyFlags field of the wrong type", () => {
    const result = classifyTeamRunRow("id", validLegacyRaw({ policyFlags: "not-an-array" }));
    expect(result).toEqual({ status: "malformed", teamRunId: "id", detectedKind: "legacy" });
  });

  it("defaults policyFlags to [] when absent (not malformed)", () => {
    const { policyFlags, ...withoutFlags } = validLegacyRaw();
    const result = classifyTeamRunRow("id", withoutFlags);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect((result.item as LegacyTeamRunListItemV1).policyFlags).toEqual([]);
    }
  });

  it("drops a malformed nested humanDecision without failing the whole row", () => {
    const result = classifyTeamRunRow("id", validLegacyRaw({ humanDecision: { action: "not_a_valid_action" } }));
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect((result.item as LegacyTeamRunListItemV1).humanDecision).toBeUndefined();
    }
  });

  it("defaults a missing or non-finite consensusScore to null", () => {
    const result = classifyTeamRunRow("id", validLegacyRaw({ consensusScore: undefined }));
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect((result.item as LegacyTeamRunListItemV1).consensusScore).toBeNull();
    }
  });
});

describe("classifyTeamRunRow — malformed top-level input", () => {
  it("rejects a non-object row", () => {
    expect(classifyTeamRunRow("id", null)).toEqual({ status: "malformed", teamRunId: "id" });
    expect(classifyTeamRunRow("id", "a string")).toEqual({ status: "malformed", teamRunId: "id" });
  });
});

describe("parseTeamRunListFilters", () => {
  it("defaults to kind=all, page=1, limit=DEFAULT_TEAM_RUN_PAGE_SIZE", () => {
    const result = parseTeamRunListFilters(new URLSearchParams());
    expect(result).toEqual({ ok: true, filters: { kind: "all", reviewable: undefined, flagged: undefined, humanReviewStatus: undefined, page: 1, limit: DEFAULT_TEAM_RUN_PAGE_SIZE } });
  });

  it("rejects an invalid kind", () => {
    expect(parseTeamRunListFilters(new URLSearchParams("kind=bogus"))).toEqual({ ok: false, reason: "invalid_kind" });
  });

  it("rejects an invalid boolean for reviewable/flagged", () => {
    expect(parseTeamRunListFilters(new URLSearchParams("reviewable=maybe"))).toEqual({ ok: false, reason: "invalid_reviewable" });
    expect(parseTeamRunListFilters(new URLSearchParams("flagged=maybe"))).toEqual({ ok: false, reason: "invalid_flagged" });
  });

  it("rejects an invalid page", () => {
    expect(parseTeamRunListFilters(new URLSearchParams("page=0"))).toEqual({ ok: false, reason: "invalid_page" });
    expect(parseTeamRunListFilters(new URLSearchParams("page=abc"))).toEqual({ ok: false, reason: "invalid_page" });
    expect(parseTeamRunListFilters(new URLSearchParams("page=1.5"))).toEqual({ ok: false, reason: "invalid_page" });
  });

  it("rejects an invalid limit", () => {
    expect(parseTeamRunListFilters(new URLSearchParams("limit=0"))).toEqual({ ok: false, reason: "invalid_limit" });
    expect(parseTeamRunListFilters(new URLSearchParams("limit=abc"))).toEqual({ ok: false, reason: "invalid_limit" });
  });

  it("caps limit at MAX_TEAM_RUN_PAGE_SIZE", () => {
    const result = parseTeamRunListFilters(new URLSearchParams("limit=99999"));
    expect(result).toEqual({ ok: true, filters: expect.objectContaining({ limit: MAX_TEAM_RUN_PAGE_SIZE }) });
  });

  it("rejects an unknown humanReviewStatus", () => {
    expect(parseTeamRunListFilters(new URLSearchParams("humanReviewStatus=bogus"))).toEqual({
      ok: false,
      reason: "invalid_human_review_status",
    });
  });

  it("accepts a valid humanReviewStatus", () => {
    const result = parseTeamRunListFilters(new URLSearchParams("humanReviewStatus=pending"));
    expect(result).toEqual({ ok: true, filters: expect.objectContaining({ humanReviewStatus: "pending" }) });
  });
});

function adaptiveItem(overrides: Partial<AdaptiveTeamRunListItemV1> = {}): AdaptiveTeamRunListItemV1 {
  return {
    kind: "adaptive",
    teamRunId: "team-1:run-1",
    runId: "run-1",
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    receiptConclusion: "x",
    sourceBacked: true,
    humanReviewNeeded: false,
    automatedGovernanceStatus: "passed",
    humanReviewStatus: "unreviewed",
    reviewable: true,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function legacyItem(overrides: Partial<LegacyTeamRunListItemV1> = {}): LegacyTeamRunListItemV1 {
  return {
    kind: "legacy",
    teamRunId: "legacy-1",
    createdAt: "2026-07-27T00:00:00.000Z",
    policyFlags: [],
    blockedByPolicy: false,
    governanceReviewRequired: false,
    consensusScore: null,
    ...overrides,
  };
}

describe("isItemFlagged", () => {
  it("adaptive: flagged/blocked are flagged, others are not", () => {
    expect(isItemFlagged(adaptiveItem({ automatedGovernanceStatus: "flagged" }))).toBe(true);
    expect(isItemFlagged(adaptiveItem({ automatedGovernanceStatus: "blocked" }))).toBe(true);
    expect(isItemFlagged(adaptiveItem({ automatedGovernanceStatus: "passed" }))).toBe(false);
    expect(isItemFlagged(adaptiveItem({ automatedGovernanceStatus: undefined }))).toBe(false);
  });

  it("legacy: mirrors governanceReviewRequired exactly", () => {
    expect(isItemFlagged(legacyItem({ governanceReviewRequired: true }))).toBe(true);
    expect(isItemFlagged(legacyItem({ governanceReviewRequired: false }))).toBe(false);
  });
});

describe("applyTeamRunListFilters", () => {
  const items: TeamRunListItemV1[] = [
    adaptiveItem({ teamRunId: "a1", automatedGovernanceStatus: "flagged", humanReviewStatus: "unreviewed", reviewable: true }),
    adaptiveItem({ teamRunId: "a2", automatedGovernanceStatus: "passed", humanReviewStatus: "approved", reviewable: false }),
    legacyItem({ teamRunId: "l1", governanceReviewRequired: true }),
    legacyItem({ teamRunId: "l2", governanceReviewRequired: false }),
  ];

  it("kind=legacy returns only legacy rows", () => {
    const result = applyTeamRunListFilters(items, { kind: "legacy", page: 1, limit: 25 });
    expect(result.map((r) => r.teamRunId)).toEqual(["l1", "l2"]);
  });

  it("kind=adaptive returns only adaptive rows", () => {
    const result = applyTeamRunListFilters(items, { kind: "adaptive", page: 1, limit: 25 });
    expect(result.map((r) => r.teamRunId)).toEqual(["a1", "a2"]);
  });

  it("flagged=true matches both kinds using their own semantic", () => {
    const result = applyTeamRunListFilters(items, { kind: "all", flagged: true, page: 1, limit: 25 });
    expect(result.map((r) => r.teamRunId).sort()).toEqual(["a1", "l1"]);
  });

  it("reviewable=true excludes legacy rows entirely (adaptive-native semantic)", () => {
    const result = applyTeamRunListFilters(items, { kind: "all", reviewable: true, page: 1, limit: 25 });
    expect(result.map((r) => r.teamRunId)).toEqual(["a1"]);
  });

  it("humanReviewStatus filter excludes legacy rows entirely", () => {
    const result = applyTeamRunListFilters(items, { kind: "all", humanReviewStatus: "approved", page: 1, limit: 25 });
    expect(result.map((r) => r.teamRunId)).toEqual(["a2"]);
  });
});

describe("sortTeamRunListItems", () => {
  it("sorts by effective timestamp descending", () => {
    const items: TeamRunListItemV1[] = [
      adaptiveItem({ teamRunId: "old", updatedAt: "2026-07-01T00:00:00.000Z" }),
      adaptiveItem({ teamRunId: "new", updatedAt: "2026-07-29T00:00:00.000Z" }),
      legacyItem({ teamRunId: "mid", createdAt: "2026-07-15T00:00:00.000Z" }),
    ];
    const sorted = sortTeamRunListItems(items);
    expect(sorted.map((r) => r.teamRunId)).toEqual(["new", "mid", "old"]);
  });

  it("breaks ties by teamRunId descending", () => {
    const items: TeamRunListItemV1[] = [
      adaptiveItem({ teamRunId: "b", updatedAt: "2026-07-29T00:00:00.000Z" }),
      adaptiveItem({ teamRunId: "a", updatedAt: "2026-07-29T00:00:00.000Z" }),
      adaptiveItem({ teamRunId: "c", updatedAt: "2026-07-29T00:00:00.000Z" }),
    ];
    const sorted = sortTeamRunListItems(items);
    expect(sorted.map((r) => r.teamRunId)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate the input array", () => {
    const items: TeamRunListItemV1[] = [adaptiveItem({ teamRunId: "a" }), adaptiveItem({ teamRunId: "b" })];
    const original = [...items];
    sortTeamRunListItems(items);
    expect(items).toEqual(original);
  });

  it("adaptive rows sort by their real updatedAt, never as infinitely old", () => {
    const items: TeamRunListItemV1[] = [
      legacyItem({ teamRunId: "legacy-old", createdAt: "2020-01-01T00:00:00.000Z" }),
      adaptiveItem({ teamRunId: "adaptive-recent", updatedAt: "2026-07-29T00:00:00.000Z" }),
    ];
    const sorted = sortTeamRunListItems(items);
    expect(sorted[0].teamRunId).toBe("adaptive-recent");
  });
});

describe("paginateTeamRunListItems", () => {
  const items: TeamRunListItemV1[] = Array.from({ length: 30 }, (_, i) => adaptiveItem({ teamRunId: `r${i}` }));

  it("computes total, hasNextPage, hasPreviousPage correctly", () => {
    const { pageItems, pagination } = paginateTeamRunListItems(items, 1, 25);
    expect(pageItems).toHaveLength(25);
    expect(pagination).toEqual({ page: 1, limit: 25, total: 30, hasNextPage: true, hasPreviousPage: false });
  });

  it("computes the last page correctly", () => {
    const { pageItems, pagination } = paginateTeamRunListItems(items, 2, 25);
    expect(pageItems).toHaveLength(5);
    expect(pagination).toEqual({ page: 2, limit: 25, total: 30, hasNextPage: false, hasPreviousPage: true });
  });

  it("returns an empty page beyond the last page, without error", () => {
    const { pageItems, pagination } = paginateTeamRunListItems(items, 5, 25);
    expect(pageItems).toHaveLength(0);
    expect(pagination.hasNextPage).toBe(false);
  });

  it("never duplicates items across adjacent pages", () => {
    const page1 = paginateTeamRunListItems(items, 1, 10).pageItems.map((i) => i.teamRunId);
    const page2 = paginateTeamRunListItems(items, 2, 10).pageItems.map((i) => i.teamRunId);
    const overlap = page1.filter((id) => page2.includes(id));
    expect(overlap).toHaveLength(0);
  });
});
