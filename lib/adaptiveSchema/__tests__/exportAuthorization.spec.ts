/**
 * Adaptive Research Export, Phase 1 — canExportAdaptiveResearch() tests.
 * Pure function, no mocking needed — every plan × governance-state
 * combination from the design's authorization axes, as explicit
 * table-driven cases.
 */

import { canExportAdaptiveResearch, CanExportAdaptiveResearchInput } from "@/lib/adaptiveSchema/exportAuthorization";
import { ReportStatusKind } from "@/lib/adaptiveSchema/reportStatus";

function baseInput(overrides: Partial<CanExportAdaptiveResearchInput> = {}): CanExportAdaptiveResearchInput {
  return {
    isRunOwner: true,
    planId: "lite",
    teamRole: null,
    classification: "internal",
    governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
    ...overrides,
  };
}

describe("canExportAdaptiveResearch", () => {
  it("denies a non-owner regardless of everything else", () => {
    const verdict = canExportAdaptiveResearch(baseInput({ isRunOwner: false }));
    expect(verdict).toEqual({ allowed: false, reason: "not_run_owner" });
  });

  it("denies Free plan (advancedExportEnabled: false)", () => {
    const verdict = canExportAdaptiveResearch(baseInput({ planId: "free" }));
    expect(verdict).toEqual({ allowed: false, reason: "plan_not_entitled" });
  });

  it.each(["lite", "full"] as const)("allows %s plan (advancedExportEnabled: true) for an approved report", (planId) => {
    const verdict = canExportAdaptiveResearch(baseInput({ planId }));
    expect(verdict).toEqual({ allowed: true, requiresVisibleStatusNotice: false });
  });

  it("a team member (non-admin) may still export their own run — ownership, not role, gates a single-run export", () => {
    const verdict = canExportAdaptiveResearch(baseInput({ planId: "full", teamRole: "member" }));
    expect(verdict.allowed).toBe(true);
  });

  describe("governance state — Milestone-2 family", () => {
    const cases: { kind: ReportStatusKind | "superseded"; expected: "allowed" | "blocked"; visibleNotice: boolean }[] = [
      { kind: "approved", expected: "allowed", visibleNotice: false },
      { kind: "approved_with_conditions", expected: "allowed", visibleNotice: true },
      { kind: "changes_requested", expected: "allowed", visibleNotice: true },
      { kind: "unreviewed_in_queue", expected: "allowed", visibleNotice: true },
      { kind: "not_reviewed_no_review_configured", expected: "allowed", visibleNotice: true },
      { kind: "incomplete", expected: "allowed", visibleNotice: true },
      { kind: "superseded", expected: "allowed", visibleNotice: true },
      { kind: "rejected", expected: "blocked", visibleNotice: false },
    ];

    it.each(cases)("$kind → $expected (a $kind report must never look like an approved one when exported)", ({ kind, expected, visibleNotice }) => {
      const verdict = canExportAdaptiveResearch(
        baseInput({ governanceStatusAtExport: { family: "milestone2", kind, isOwnerOverride: false } })
      );
      if (expected === "blocked") {
        expect(verdict).toEqual({ allowed: false, reason: "governance_state_blocked" });
      } else {
        expect(verdict).toEqual({ allowed: true, requiresVisibleStatusNotice: visibleNotice });
      }
    });

    it("changes_requested is explicitly exportable (with a visible notice), never silently blocked like rejected — it is a genuinely different, non-terminal state", () => {
      const verdict = canExportAdaptiveResearch(
        baseInput({ governanceStatusAtExport: { family: "milestone2", kind: "changes_requested", isOwnerOverride: false } })
      );
      expect(verdict.allowed).toBe(true);
    });
  });

  describe("governance state — legacy family (the real 3-value model, never force-fit into the 8-status vocabulary)", () => {
    it("approved → allowed, no visible notice required", () => {
      const verdict = canExportAdaptiveResearch(baseInput({ governanceStatusAtExport: { family: "legacy", status: "approved" } }));
      expect(verdict).toEqual({ allowed: true, requiresVisibleStatusNotice: false });
    });

    it("needs_review → allowed, visible notice required", () => {
      const verdict = canExportAdaptiveResearch(baseInput({ governanceStatusAtExport: { family: "legacy", status: "needs_review" } }));
      expect(verdict).toEqual({ allowed: true, requiresVisibleStatusNotice: true });
    });

    it("blocked → export blocked outright", () => {
      const verdict = canExportAdaptiveResearch(baseInput({ governanceStatusAtExport: { family: "legacy", status: "blocked" } }));
      expect(verdict).toEqual({ allowed: false, reason: "governance_state_blocked" });
    });

    it("null (never evaluated) → allowed, visible notice required — never silently treated as approved", () => {
      const verdict = canExportAdaptiveResearch(baseInput({ governanceStatusAtExport: { family: "legacy", status: null } }));
      expect(verdict).toEqual({ allowed: true, requiresVisibleStatusNotice: true });
    });
  });

  it("every input combination maps to a real verdict — never throws", () => {
    expect(() => canExportAdaptiveResearch(baseInput({ planId: "free", isRunOwner: false }))).not.toThrow();
  });
});
