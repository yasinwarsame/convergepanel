/**
 * Multi-Reviewer Panel Foundation, Part B — parseAdaptiveMultiReviewerSettings() tests.
 */

import { parseAdaptiveMultiReviewerSettings } from "@/lib/governance/adaptiveTeamReview";

describe("parseAdaptiveMultiReviewerSettings", () => {
  it("absent settings parse as disabled", () => {
    expect(parseAdaptiveMultiReviewerSettings(undefined)).toEqual({ enabled: false, mode: "majority_quorum" });
  });

  it("null settings parse as disabled", () => {
    expect(parseAdaptiveMultiReviewerSettings(null)).toEqual({ enabled: false, mode: "majority_quorum" });
  });

  it("enabled: false parses as disabled", () => {
    expect(parseAdaptiveMultiReviewerSettings({ enabled: false, mode: "majority_quorum" })).toEqual({
      enabled: false,
      mode: "majority_quorum",
    });
  });

  it("a valid enabled majority_quorum setting parses as enabled", () => {
    expect(parseAdaptiveMultiReviewerSettings({ enabled: true, mode: "majority_quorum" })).toEqual({
      enabled: true,
      mode: "majority_quorum",
    });
  });

  it("a non-object value parses as disabled", () => {
    expect(parseAdaptiveMultiReviewerSettings("enabled")).toEqual({ enabled: false, mode: "majority_quorum" });
    expect(parseAdaptiveMultiReviewerSettings(42)).toEqual({ enabled: false, mode: "majority_quorum" });
    expect(parseAdaptiveMultiReviewerSettings(true)).toEqual({ enabled: false, mode: "majority_quorum" });
  });

  it("a malformed object (wrong-typed enabled) parses as disabled", () => {
    expect(parseAdaptiveMultiReviewerSettings({ enabled: "yes", mode: "majority_quorum" })).toEqual({
      enabled: false,
      mode: "majority_quorum",
    });
  });

  it("an unknown mode parses as disabled — never silently coerced to the one supported mode", () => {
    expect(parseAdaptiveMultiReviewerSettings({ enabled: true, mode: "unanimous" })).toEqual({
      enabled: false,
      mode: "majority_quorum",
    });
    expect(parseAdaptiveMultiReviewerSettings({ enabled: true, mode: "single" })).toEqual({
      enabled: false,
      mode: "majority_quorum",
    });
  });

  it("a missing mode field parses as disabled", () => {
    expect(parseAdaptiveMultiReviewerSettings({ enabled: true })).toEqual({ enabled: false, mode: "majority_quorum" });
  });

  it("no silent enrollment: every absent/malformed shape converges on the exact same disabled default, never a partially-enabled state", () => {
    const cases = [undefined, null, {}, { enabled: true }, { mode: "majority_quorum" }, { enabled: 1, mode: "majority_quorum" }];
    for (const c of cases) {
      expect(parseAdaptiveMultiReviewerSettings(c)).toEqual({ enabled: false, mode: "majority_quorum" });
    }
  });

  it("is deterministic — the same input always parses to the same output", () => {
    const input = { enabled: true, mode: "majority_quorum" };
    expect(parseAdaptiveMultiReviewerSettings(input)).toEqual(parseAdaptiveMultiReviewerSettings(input));
  });
});
