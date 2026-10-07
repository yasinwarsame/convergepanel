/**
 * TEAM_EXPORT_E2_B — `canAccessWorkspaceAdaptiveExport()`, the historical-access
 * verdict. Separate from the creation verdict: its capability axis is
 * `research.read`, and it never takes an `exports.create` input.
 */

import { canAccessWorkspaceAdaptiveExport, canExportWorkspaceAdaptiveResearch } from "@/lib/adaptiveSchema/exportAuthorization";

const approved = { family: "milestone2", kind: "approved", isOwnerOverride: false } as const;
const base = { hasResearchReadCapability: true, planId: "full" as const, classification: "internal" as never, governanceStatusAtExport: approved as never };

describe("canAccessWorkspaceAdaptiveExport", () => {
  it("allows a research.read holder on an entitled plan for a non-blocked frozen export", () => {
    expect(canAccessWorkspaceAdaptiveExport(base)).toEqual({ allowed: true, requiresVisibleStatusNotice: false });
  });

  it("denies without research.read", () => {
    expect(canAccessWorkspaceAdaptiveExport({ ...base, hasResearchReadCapability: false })).toEqual({ allowed: false, reason: "workspace_capability_missing" });
  });

  it("denies on a plan without advanced export (current plan decides)", () => {
    expect(canAccessWorkspaceAdaptiveExport({ ...base, planId: "free" })).toEqual({ allowed: false, reason: "plan_not_entitled" });
    expect(canAccessWorkspaceAdaptiveExport({ ...base, planId: "lite" }).allowed).toBe(true);
  });

  it.each([
    ["milestone2 rejected", { family: "milestone2", kind: "rejected", isOwnerOverride: false }],
    ["legacy blocked", { family: "legacy", status: "blocked" }],
  ])("denies a frozen %s export", (_l, status) => {
    expect(canAccessWorkspaceAdaptiveExport({ ...base, governanceStatusAtExport: status as never })).toEqual({ allowed: false, reason: "governance_state_blocked" });
  });

  it("allows a not-yet-approved frozen state but flags the visible status notice", () => {
    expect(canAccessWorkspaceAdaptiveExport({ ...base, governanceStatusAtExport: { family: "legacy", status: "needs_review" } as never })).toEqual({ allowed: true, requiresVisibleStatusNotice: true });
  });

  it("is structurally distinct from the creation verdict: research.read alone does not create", () => {
    // The same research-only caller is denied by CREATION and allowed by ACCESS.
    expect(canExportWorkspaceAdaptiveResearch({ hasExportsCreateCapability: false, planId: "full", classification: "internal" as never, governanceStatusAtExport: approved as never })).toEqual({ allowed: false, reason: "workspace_capability_missing" });
    expect(canAccessWorkspaceAdaptiveExport(base).allowed).toBe(true);
  });
});
