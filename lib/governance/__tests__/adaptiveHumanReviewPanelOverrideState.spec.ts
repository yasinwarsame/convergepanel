/**
 * Multi-Reviewer Owner Override, Part F — panel schema extension tests:
 * the `finalizedVia`/`overrideJustificationPresent`/`overrideByUserId`
 * fields and the parser's cross-field validation for them. Backward
 * compatibility with existing Part E finalized panels (which carry NONE of
 * these fields at all) is the central invariant verified here.
 */

import {
  AdaptiveHumanReviewPanelV1,
  parseAdaptiveHumanReviewPanel,
  buildFinalizedAdaptiveHumanReviewPanel,
  buildOwnerOverriddenAdaptiveHumanReviewPanel,
} from "@/lib/governance/adaptiveHumanReviewPanel";

function validOpenPanel(overrides: Partial<AdaptiveHumanReviewPanelV1> = {}): AdaptiveHumanReviewPanelV1 {
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
    createdAt: "2020-01-01T00:00:00.000Z",
    createdByUserId: "admin-uid",
    updatedAt: "2020-01-01T00:00:00.000Z",
    updatedByUserId: "admin-uid",
    ...overrides,
  };
}

function validFinalizedPanel(overrides: Partial<AdaptiveHumanReviewPanelV1> = {}): AdaptiveHumanReviewPanelV1 {
  return {
    ...validOpenPanel(),
    status: "finalized",
    revision: 2,
    updatedAt: "2020-06-01T00:00:00.000Z",
    finalizedAt: "2020-06-01T00:00:00.000Z",
    finalizedByUserId: "owner-uid",
    finalStatus: "approved",
    finalDecisionId: "panel_dec_abcdef0123456789abcdef0123456789",
    aggregationPolicyVersion: 1,
    ...overrides,
  };
}

function validOverriddenPanel(overrides: Partial<AdaptiveHumanReviewPanelV1> = {}): AdaptiveHumanReviewPanelV1 {
  return validFinalizedPanel({
    finalDecisionId: "panel_override_dec_abcdef0123456789abcdef0123456789",
    finalizedVia: "owner_override",
    overrideJustificationPresent: true,
    overrideByUserId: "owner-uid",
    ...overrides,
  });
}

describe("parseAdaptiveHumanReviewPanel — backward compatibility with Part E finalized panels", () => {
  it("a Part-E finalized panel with NO finalizedVia at all still parses as valid", () => {
    const result = parseAdaptiveHumanReviewPanel(validFinalizedPanel());
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.panel.finalizedVia).toBeUndefined();
      expect(result.panel.overrideJustificationPresent).toBeUndefined();
      expect(result.panel.overrideByUserId).toBeUndefined();
    }
  });
});

describe("parseAdaptiveHumanReviewPanel — finalizedVia cross-field validation", () => {
  it("a valid owner_override-finalized panel parses as valid, carrying override provenance", () => {
    const result = parseAdaptiveHumanReviewPanel(validOverriddenPanel());
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.panel.finalizedVia).toBe("owner_override");
      expect(result.panel.overrideJustificationPresent).toBe(true);
      expect(result.panel.overrideByUserId).toBe("owner-uid");
    }
  });

  it("a valid finalizedVia: 'aggregation' panel parses as valid, with no override fields", () => {
    const result = parseAdaptiveHumanReviewPanel(validFinalizedPanel({ finalizedVia: "aggregation" }));
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.panel.finalizedVia).toBe("aggregation");
      expect(result.panel.overrideJustificationPresent).toBeUndefined();
      expect(result.panel.overrideByUserId).toBeUndefined();
    }
  });

  it("finalizedVia present on an open (non-finalized) panel is rejected", () => {
    const result = parseAdaptiveHumanReviewPanel({ ...validOpenPanel(), finalizedVia: "aggregation" });
    expect(result).toEqual({ status: "malformed" });
  });

  it("an invalid finalizedVia literal is rejected", () => {
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ finalizedVia: "manual" as any }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ finalizedVia: "" as any }))).toEqual({ status: "malformed" });
  });

  it("finalizedVia: owner_override without overrideJustificationPresent is rejected", () => {
    const { overrideJustificationPresent, ...rest } = validOverriddenPanel();
    expect(parseAdaptiveHumanReviewPanel(rest)).toEqual({ status: "malformed" });
  });

  it("finalizedVia: owner_override with overrideJustificationPresent: false is rejected (must be true, never false)", () => {
    expect(parseAdaptiveHumanReviewPanel(validOverriddenPanel({ overrideJustificationPresent: false }))).toEqual({ status: "malformed" });
  });

  it("finalizedVia: owner_override without overrideByUserId is rejected", () => {
    const { overrideByUserId, ...rest } = validOverriddenPanel();
    expect(parseAdaptiveHumanReviewPanel(rest)).toEqual({ status: "malformed" });
  });

  it("finalizedVia: owner_override with an empty overrideByUserId is rejected", () => {
    expect(parseAdaptiveHumanReviewPanel(validOverriddenPanel({ overrideByUserId: "" }))).toEqual({ status: "malformed" });
  });

  it("overrideJustificationPresent/overrideByUserId present when finalizedVia is 'aggregation' is rejected", () => {
    expect(
      parseAdaptiveHumanReviewPanel(validFinalizedPanel({ finalizedVia: "aggregation", overrideJustificationPresent: true }))
    ).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ finalizedVia: "aggregation", overrideByUserId: "x" }))).toEqual({
      status: "malformed",
    });
  });

  it("overrideJustificationPresent/overrideByUserId present when finalizedVia is absent entirely is rejected", () => {
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ overrideJustificationPresent: true }))).toEqual({ status: "malformed" });
    expect(parseAdaptiveHumanReviewPanel(validFinalizedPanel({ overrideByUserId: "x" }))).toEqual({ status: "malformed" });
  });

  it("override fields present on an open panel are rejected even without finalizedVia", () => {
    const result = parseAdaptiveHumanReviewPanel({ ...validOpenPanel(), overrideByUserId: "owner-uid" });
    expect(result).toEqual({ status: "malformed" });
  });
});

describe("buildOwnerOverriddenAdaptiveHumanReviewPanel", () => {
  it("sets status finalized, finalizedVia owner_override, and override provenance fields", () => {
    const current = validOpenPanel({ revision: 5 });
    const overridden = buildOwnerOverriddenAdaptiveHumanReviewPanel({
      current,
      actorUserId: "owner-uid",
      now: "2020-06-01T00:00:00.000Z",
      finalStatus: "rejected",
      finalDecisionId: "panel_override_dec_xyz",
      aggregationPolicyVersion: 1,
    });
    expect(overridden.status).toBe("finalized");
    expect(overridden.revision).toBe(6);
    expect(overridden.finalizedAt).toBe("2020-06-01T00:00:00.000Z");
    expect(overridden.finalizedByUserId).toBe("owner-uid");
    expect(overridden.finalStatus).toBe("rejected");
    expect(overridden.finalDecisionId).toBe("panel_override_dec_xyz");
    expect(overridden.finalizedVia).toBe("owner_override");
    expect(overridden.overrideJustificationPresent).toBe(true);
    expect(overridden.overrideByUserId).toBe("owner-uid");
  });

  it("preserves reviewerUserIds, mode, quorum, requiredReviewerCount, createdAt, createdByUserId exactly (votes untouched)", () => {
    const current = validOpenPanel({ createdAt: "2019-01-01T00:00:00.000Z", createdByUserId: "founder-uid" });
    const overridden = buildOwnerOverriddenAdaptiveHumanReviewPanel({
      current,
      actorUserId: "owner-uid",
      now: "2020-06-01T00:00:00.000Z",
      finalStatus: "approved",
      finalDecisionId: "panel_override_dec_xyz",
      aggregationPolicyVersion: 1,
    });
    expect(overridden.reviewerUserIds).toEqual(current.reviewerUserIds);
    expect(overridden.mode).toBe(current.mode);
    expect(overridden.quorum).toBe(current.quorum);
    expect(overridden.requiredReviewerCount).toBe(current.requiredReviewerCount);
    expect(overridden.createdAt).toBe("2019-01-01T00:00:00.000Z");
    expect(overridden.createdByUserId).toBe("founder-uid");
  });

  it("output round-trips through the parser as valid", () => {
    const overridden = buildOwnerOverriddenAdaptiveHumanReviewPanel({
      current: validOpenPanel(),
      actorUserId: "owner-uid",
      now: "2020-06-01T00:00:00.000Z",
      finalStatus: "approved_with_conditions",
      finalDecisionId: "panel_override_dec_xyz",
      aggregationPolicyVersion: 1,
    });
    expect(parseAdaptiveHumanReviewPanel(overridden).status).toBe("valid");
  });

  it("can override a DEADLOCKED panel just as readily as any other open panel (no vote-count precondition in the builder)", () => {
    const current = validOpenPanel({ reviewerUserIds: ["a", "b"], requiredReviewerCount: 2, quorum: 2 });
    const overridden = buildOwnerOverriddenAdaptiveHumanReviewPanel({
      current,
      actorUserId: "owner-uid",
      now: "2020-06-01T00:00:00.000Z",
      finalStatus: "approved",
      finalDecisionId: "panel_override_dec_xyz",
      aggregationPolicyVersion: 1,
    });
    expect(parseAdaptiveHumanReviewPanel(overridden).status).toBe("valid");
  });
});

describe("buildFinalizedAdaptiveHumanReviewPanel now explicitly sets finalizedVia: 'aggregation'", () => {
  it("sets finalizedVia to 'aggregation' going forward, distinguishing it from an owner override", () => {
    const finalized = buildFinalizedAdaptiveHumanReviewPanel({
      current: validOpenPanel(),
      actorUserId: "owner-uid",
      now: "2020-06-01T00:00:00.000Z",
      finalStatus: "approved",
      finalDecisionId: "panel_dec_xyz",
      aggregationPolicyVersion: 1,
    });
    expect(finalized.finalizedVia).toBe("aggregation");
    expect(finalized.overrideJustificationPresent).toBeUndefined();
    expect(finalized.overrideByUserId).toBeUndefined();
    expect(parseAdaptiveHumanReviewPanel(finalized).status).toBe("valid");
  });
});
