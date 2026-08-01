/**
 * Multi-Reviewer Panel Foundation, Part B — pure model, limits, quorum
 * derivation, and parser tests for AdaptiveHumanReviewPanelV1.
 */

import {
  MIN_ADAPTIVE_PANEL_REVIEWERS,
  MAX_ADAPTIVE_PANEL_REVIEWERS,
  deriveAdaptivePanelQuorum,
  normalizeAdaptivePanelReviewerUserIds,
  buildNextAdaptiveHumanReviewPanel,
  buildCancelledAdaptiveHumanReviewPanel,
  parseAdaptiveHumanReviewPanel,
  AdaptiveHumanReviewPanelV1,
} from "@/lib/governance/adaptiveHumanReviewPanel";

describe("limits", () => {
  it("min is 2, max is 9", () => {
    expect(MIN_ADAPTIVE_PANEL_REVIEWERS).toBe(2);
    expect(MAX_ADAPTIVE_PANEL_REVIEWERS).toBe(9);
  });
});

describe("deriveAdaptivePanelQuorum", () => {
  it.each([
    [2, 2],
    [3, 2],
    [4, 3],
    [5, 3],
    [6, 4],
    [7, 4],
    [8, 5],
    [9, 5],
  ])("size %i -> quorum %i (floor(n/2)+1)", (size, expected) => {
    expect(deriveAdaptivePanelQuorum(size)).toBe(expected);
  });
});

describe("normalizeAdaptivePanelReviewerUserIds", () => {
  it("deduplicates", () => {
    expect(normalizeAdaptivePanelReviewerUserIds(["a", "b", "a"])).toEqual(["a", "b"]);
  });

  it("sorts deterministically regardless of input order", () => {
    expect(normalizeAdaptivePanelReviewerUserIds(["c", "a", "b"])).toEqual(["a", "b", "c"]);
    expect(normalizeAdaptivePanelReviewerUserIds(["b", "c", "a"])).toEqual(["a", "b", "c"]);
  });
});

function validPanel(overrides: Partial<AdaptiveHumanReviewPanelV1> = {}): AdaptiveHumanReviewPanelV1 {
  return {
    schemaVersion: 1,
    kind: "adaptive_review_panel",
    teamId: "team-1",
    runId: "run-1",
    mode: "majority_quorum",
    reviewerUserIds: ["a", "b", "c"],
    requiredReviewerCount: 3,
    quorum: 2,
    status: "open",
    revision: 1,
    createdAt: "2026-07-31T00:00:00.000Z",
    createdByUserId: "admin-uid",
    updatedAt: "2026-07-31T00:00:00.000Z",
    updatedByUserId: "admin-uid",
    ...overrides,
  };
}

describe("buildNextAdaptiveHumanReviewPanel", () => {
  const BASE = {
    teamId: "team-1",
    runId: "run-1",
    actorUserId: "admin-uid",
    now: "2026-07-31T00:00:00.000Z",
  };

  it("creation (current: null) starts at revision 1 and sets createdAt/createdByUserId to now/actor", () => {
    const next = buildNextAdaptiveHumanReviewPanel({ ...BASE, reviewerUserIds: ["b", "a"], current: null });
    expect(next).toEqual({
      schemaVersion: 1,
      kind: "adaptive_review_panel",
      teamId: "team-1",
      runId: "run-1",
      mode: "majority_quorum",
      reviewerUserIds: ["a", "b"],
      requiredReviewerCount: 2,
      quorum: 2,
      status: "open",
      revision: 1,
      createdAt: "2026-07-31T00:00:00.000Z",
      createdByUserId: "admin-uid",
      updatedAt: "2026-07-31T00:00:00.000Z",
      updatedByUserId: "admin-uid",
    });
  });

  it("reconfiguration preserves createdAt/createdByUserId, increments revision, replaces reviewers", () => {
    const current = validPanel({ revision: 4, createdAt: "2026-01-01T00:00:00.000Z", createdByUserId: "owner-uid" });
    const next = buildNextAdaptiveHumanReviewPanel({ ...BASE, reviewerUserIds: ["x", "y"], current });
    expect(next.revision).toBe(5);
    expect(next.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.createdByUserId).toBe("owner-uid");
    expect(next.updatedAt).toBe("2026-07-31T00:00:00.000Z");
    expect(next.updatedByUserId).toBe("admin-uid");
    expect(next.reviewerUserIds).toEqual(["x", "y"]);
    expect(next.requiredReviewerCount).toBe(2);
    expect(next.quorum).toBe(2);
  });

  it("always recomputes requiredReviewerCount/quorum from the reviewer list, never trusting a stale value", () => {
    const next = buildNextAdaptiveHumanReviewPanel({ ...BASE, reviewerUserIds: ["a", "b", "c", "d", "e"], current: null });
    expect(next.requiredReviewerCount).toBe(5);
    expect(next.quorum).toBe(3);
  });

  it("mode is always majority_quorum — never accepted as input", () => {
    const next = buildNextAdaptiveHumanReviewPanel({ ...BASE, reviewerUserIds: ["a", "b"], current: null });
    expect(next.mode).toBe("majority_quorum");
  });
});

describe("buildCancelledAdaptiveHumanReviewPanel", () => {
  it("sets status cancelled, increments revision, preserves reviewer list", () => {
    const current = validPanel({ revision: 2, reviewerUserIds: ["a", "b"], requiredReviewerCount: 2, quorum: 2 });
    const next = buildCancelledAdaptiveHumanReviewPanel({ current, actorUserId: "owner-uid", now: "2026-08-01T00:00:00.000Z" });
    expect(next.status).toBe("cancelled");
    expect(next.revision).toBe(3);
    expect(next.reviewerUserIds).toEqual(["a", "b"]);
    expect(next.updatedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(next.updatedByUserId).toBe("owner-uid");
  });

  it("preserves createdAt/createdByUserId unchanged", () => {
    const current = validPanel({ createdAt: "2026-01-01T00:00:00.000Z", createdByUserId: "owner-uid" });
    const next = buildCancelledAdaptiveHumanReviewPanel({ current, actorUserId: "admin-uid", now: "2026-08-01T00:00:00.000Z" });
    expect(next.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.createdByUserId).toBe("owner-uid");
  });
});

describe("parseAdaptiveHumanReviewPanel", () => {
  it("a valid open panel parses as valid", () => {
    const result = parseAdaptiveHumanReviewPanel(validPanel());
    expect(result.status).toBe("valid");
    if (result.status === "valid") expect(result.panel.status).toBe("open");
  });

  it("a valid cancelled panel parses as valid", () => {
    const result = parseAdaptiveHumanReviewPanel(validPanel({ status: "cancelled" }));
    expect(result.status).toBe("valid");
  });

  it("undefined/null is absent", () => {
    expect(parseAdaptiveHumanReviewPanel(undefined)).toEqual({ status: "absent" });
    expect(parseAdaptiveHumanReviewPanel(null)).toEqual({ status: "absent" });
  });

  it("a schemaVersion greater than 1 is unsupported_version", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ schemaVersion: 2 as 1 }))).toEqual({ status: "unsupported_version" });
  });

  it("a missing schemaVersion is malformed (not unsupported_version)", () => {
    const { schemaVersion, ...rest } = validPanel();
    expect(parseAdaptiveHumanReviewPanel(rest)).toEqual({ status: "malformed" });
  });

  it("a non-object is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel("panel")).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(42)).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel([])).toEqual({ status: "malformed" });
  });

  it("wrong kind is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ kind: "something_else" as any }))).toEqual({ status: "malformed" });
  });

  it("empty/missing teamId is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ teamId: "" }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validPanel({ teamId: undefined as any }))).toEqual({ status: "malformed" });
  });

  it("empty/missing runId is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ runId: "" }))).toEqual({ status: "malformed" });
  });

  it("a non-array reviewerUserIds is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ reviewerUserIds: "a,b,c" as any }))).toEqual({ status: "malformed" });
  });

  it("an array containing a non-string/empty-string entry is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ reviewerUserIds: ["a", "", "c"] }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validPanel({ reviewerUserIds: ["a", 1 as any, "c"] }))).toEqual({ status: "malformed" });
  });

  it("duplicate reviewer IDs are malformed", () => {
    expect(
      parseAdaptiveHumanReviewPanel(validPanel({ reviewerUserIds: ["a", "b", "a"], requiredReviewerCount: 3, quorum: 2 }))
    ).toEqual({ status: "malformed" });
  });

  it("too few reviewers (below MIN) is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ reviewerUserIds: ["a"], requiredReviewerCount: 1, quorum: 1 }))).toEqual({
      status: "malformed",
    });
  });

  it("too many reviewers (above MAX) is malformed", () => {
    const tooMany = Array.from({ length: 10 }, (_, i) => `r${i}`);
    expect(
      parseAdaptiveHumanReviewPanel(validPanel({ reviewerUserIds: tooMany, requiredReviewerCount: 10, quorum: 6 }))
    ).toEqual({ status: "malformed" });
  });

  it("requiredReviewerCount not matching reviewerUserIds.length is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ requiredReviewerCount: 5 }))).toEqual({ status: "malformed" });
  });

  it("quorum not matching floor(n/2)+1 is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ quorum: 99 }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validPanel({ quorum: 3 }))).toEqual({ status: "malformed" }); // 3 reviewers -> quorum should be 2
  });

  it("an invalid status value is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ status: "finalized" as any }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validPanel({ status: "ready_to_finalize" as any }))).toEqual({ status: "malformed" });
  });

  it("a non-integer or negative/zero revision is malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ revision: 0 }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validPanel({ revision: -1 }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validPanel({ revision: 1.5 as any }))).toEqual({ status: "malformed" });
  });

  it("invalid timestamps are malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ createdAt: "not-a-date" }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validPanel({ updatedAt: "" }))).toEqual({ status: "malformed" });
  });

  it("createdAt after updatedAt is malformed", () => {
    expect(
      parseAdaptiveHumanReviewPanel(validPanel({ createdAt: "2026-07-31T12:00:00.000Z", updatedAt: "2026-07-31T00:00:00.000Z" }))
    ).toEqual({ status: "malformed" });
  });

  it("empty/missing actor IDs are malformed", () => {
    expect(parseAdaptiveHumanReviewPanel(validPanel({ createdByUserId: "" }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validPanel({ updatedByUserId: "" }))).toEqual({ status: "malformed" });
  });

  it("a runId/teamId mismatch against the caller's expected context is malformed", () => {
    const result = parseAdaptiveHumanReviewPanel(validPanel(), { expectedTeamId: "team-2", expectedRunId: "run-1" });
    expect(result).toEqual({ status: "malformed" });
    const result2 = parseAdaptiveHumanReviewPanel(validPanel(), { expectedTeamId: "team-1", expectedRunId: "run-2" });
    expect(result2).toEqual({ status: "malformed" });
  });

  it("a matching context passes through unaffected", () => {
    const result = parseAdaptiveHumanReviewPanel(validPanel(), { expectedTeamId: "team-1", expectedRunId: "run-1" });
    expect(result.status).toBe("valid");
  });

  it("never coerces malformed data into a valid shape — the malformed input is never echoed back as if valid", () => {
    const malformed = validPanel({ quorum: 999 });
    const result = parseAdaptiveHumanReviewPanel(malformed);
    expect(result).toEqual({ status: "malformed" });
    expect(result).not.toHaveProperty("panel");
  });
});
