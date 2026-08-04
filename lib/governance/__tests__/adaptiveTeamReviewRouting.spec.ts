/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part C —
 * routeAdaptiveTeamReview() and parseAdaptiveReviewSettings() tests.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));
jest.mock("@/lib/adaptiveSchema/classifier", () => ({
  classifyQuery: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { classifyQuery } from "@/lib/adaptiveSchema/classifier";
import { parseAdaptiveReviewSettings, routeAdaptiveTeamReview } from "@/lib/governance/adaptiveTeamReview";
import { AdaptiveReviewSettings } from "@/lib/governance/teamTypes";

const mockedClassifyQuery = classifyQuery as jest.MockedFunction<typeof classifyQuery>;

beforeEach(() => {
  mockedCallGemini.mockClear();
  mockedClassifyQuery.mockClear();
});

describe("parseAdaptiveReviewSettings", () => {
  it("returns disabled for undefined/null input", () => {
    expect(parseAdaptiveReviewSettings(undefined)).toEqual({ enabled: false, mode: "flagged_only" });
    expect(parseAdaptiveReviewSettings(null)).toEqual({ enabled: false, mode: "flagged_only" });
  });

  it("returns disabled for a non-object input", () => {
    expect(parseAdaptiveReviewSettings("enabled")).toEqual({ enabled: false, mode: "flagged_only" });
    expect(parseAdaptiveReviewSettings(42)).toEqual({ enabled: false, mode: "flagged_only" });
  });

  it("returns disabled when enabled is not a boolean", () => {
    expect(parseAdaptiveReviewSettings({ enabled: "true", mode: "all" })).toEqual({ enabled: false, mode: "flagged_only" });
  });

  it("returns disabled when mode is missing or not a recognized value", () => {
    expect(parseAdaptiveReviewSettings({ enabled: true })).toEqual({ enabled: false, mode: "flagged_only" });
    expect(parseAdaptiveReviewSettings({ enabled: true, mode: "everything" })).toEqual({ enabled: false, mode: "flagged_only" });
  });

  it("parses a valid, fully-formed setting correctly", () => {
    expect(parseAdaptiveReviewSettings({ enabled: true, mode: "all" })).toEqual({ enabled: true, mode: "all" });
    expect(parseAdaptiveReviewSettings({ enabled: true, mode: "flagged_only" })).toEqual({ enabled: true, mode: "flagged_only" });
    expect(parseAdaptiveReviewSettings({ enabled: true, mode: "human_review_needed" })).toEqual({ enabled: true, mode: "human_review_needed" });
  });

  it("parses enabled: false correctly even with a valid mode present (no fallback to disabled reason needed — it's genuinely disabled)", () => {
    expect(parseAdaptiveReviewSettings({ enabled: false, mode: "all" })).toEqual({ enabled: false, mode: "all" });
  });
});

describe("routeAdaptiveTeamReview", () => {
  it("settings absent → disabled", () => {
    expect(routeAdaptiveTeamReview({ humanReviewNeeded: true, automatedGovernanceStatus: "flagged" })).toEqual({
      shouldCreateProjection: false,
      reason: "disabled",
    });
  });

  it("settings.enabled false → disabled", () => {
    const settings: AdaptiveReviewSettings = { enabled: false, mode: "all" };
    expect(routeAdaptiveTeamReview({ humanReviewNeeded: true, automatedGovernanceStatus: "flagged", settings })).toEqual({
      shouldCreateProjection: false,
      reason: "disabled",
    });
  });

  describe("mode: flagged_only", () => {
    const settings: AdaptiveReviewSettings = { enabled: true, mode: "flagged_only" };

    it("flagged → create", () => {
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: false, automatedGovernanceStatus: "flagged", settings })).toEqual({
        shouldCreateProjection: true,
        reason: "flagged",
      });
    });

    it("blocked → create", () => {
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: false, automatedGovernanceStatus: "blocked", settings })).toEqual({
        shouldCreateProjection: true,
        reason: "blocked",
      });
    });

    it("passed → not eligible", () => {
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: false, automatedGovernanceStatus: "passed", settings })).toEqual({
        shouldCreateProjection: false,
        reason: "not_eligible",
      });
    });

    it("not_evaluated → not eligible", () => {
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: false, automatedGovernanceStatus: "not_evaluated", settings })).toEqual({
        shouldCreateProjection: false,
        reason: "not_eligible",
      });
    });

    it("error → not eligible (an evaluation failure is not evidence the run needs review)", () => {
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: false, automatedGovernanceStatus: "error", settings })).toEqual({
        shouldCreateProjection: false,
        reason: "not_eligible",
      });
    });

    it("automatedGovernanceStatus undefined → not eligible", () => {
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: true, settings })).toEqual({
        shouldCreateProjection: false,
        reason: "not_eligible",
      });
    });

    it("humanReviewNeeded true has no independent effect under flagged_only", () => {
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: true, automatedGovernanceStatus: "passed", settings })).toEqual({
        shouldCreateProjection: false,
        reason: "not_eligible",
      });
    });
  });

  describe("mode: human_review_needed", () => {
    const settings: AdaptiveReviewSettings = { enabled: true, mode: "human_review_needed" };

    it("humanReviewNeeded true → create", () => {
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: true, settings })).toEqual({
        shouldCreateProjection: true,
        reason: "human_review_needed",
      });
    });

    it("humanReviewNeeded false → not eligible", () => {
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: false, automatedGovernanceStatus: "flagged", settings })).toEqual({
        shouldCreateProjection: false,
        reason: "not_eligible",
      });
    });

    it("humanReviewNeeded true creates even when automatedGovernanceStatus is undefined or error — this is the one mode that can route without a resolved automated status", () => {
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: true, settings })).toEqual({
        shouldCreateProjection: true,
        reason: "human_review_needed",
      });
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: true, automatedGovernanceStatus: "error", settings })).toEqual({
        shouldCreateProjection: true,
        reason: "human_review_needed",
      });
    });
  });

  describe("mode: all", () => {
    const settings: AdaptiveReviewSettings = { enabled: true, mode: "all" };

    it("always creates, regardless of humanReviewNeeded or automatedGovernanceStatus", () => {
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: false, automatedGovernanceStatus: "passed", settings })).toEqual({
        shouldCreateProjection: true,
        reason: "all_runs",
      });
      expect(routeAdaptiveTeamReview({ humanReviewNeeded: false, settings })).toEqual({
        shouldCreateProjection: true,
        reason: "all_runs",
      });
    });
  });

  it("is deterministic — identical input produces an identical result", () => {
    const settings: AdaptiveReviewSettings = { enabled: true, mode: "flagged_only" };
    const input = { humanReviewNeeded: true, automatedGovernanceStatus: "flagged" as const, settings };
    expect(routeAdaptiveTeamReview(input)).toEqual(routeAdaptiveTeamReview(input));
  });

  it("never calls a connector, classifier, or the legacy policy engine", () => {
    const settings: AdaptiveReviewSettings = { enabled: true, mode: "all" };
    routeAdaptiveTeamReview({ humanReviewNeeded: true, automatedGovernanceStatus: "flagged", settings });
    expect(mockedCallGemini).not.toHaveBeenCalled();
    expect(mockedClassifyQuery).not.toHaveBeenCalled();
  });
});
