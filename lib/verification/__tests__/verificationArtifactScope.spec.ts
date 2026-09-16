/**
 * TEAM-VERIFICATION-PARITY-R1 — structural Personal/Team scope rule for
 * stored Claim and Video verification artifacts.
 */

import { isPersonalVerificationArtifact, isWorkspaceBoundVerificationArtifact } from "@/lib/verification/verificationArtifactScope";

describe("verification artifact scope — field presence, never value", () => {
  it("no workspaceId field -> Personal", () => {
    const row = { userId: "u1", type: "claim_verification", claim: "c" };
    expect(isWorkspaceBoundVerificationArtifact(row)).toBe(false);
    expect(isPersonalVerificationArtifact(row)).toBe(true);
  });

  it("valid workspaceId string -> Workspace-bound", () => {
    const row = { userId: "u1", workspaceId: "ws-1", projectId: null };
    expect(isWorkspaceBoundVerificationArtifact(row)).toBe(true);
    expect(isPersonalVerificationArtifact(row)).toBe(false);
  });

  it.each([
    ["null", null],
    ["empty string", ""],
    ["undefined value (field still present)", undefined],
    ["number", 42],
    ["boolean false", false],
    ["object", { id: "ws-1" }],
    ["array", ["ws-1"]],
  ])("workspaceId present as %s -> Workspace-bound (fails closed)", (_label, value) => {
    const row: Record<string, unknown> = { userId: "u1", workspaceId: value };
    expect(isWorkspaceBoundVerificationArtifact(row)).toBe(true);
    expect(isPersonalVerificationArtifact(row)).toBe(false);
  });

  it("projectId alone does NOT imply Team (Personal origin-linked Claims may carry one)", () => {
    for (const projectId of ["proj-1", null, ""]) {
      const row = { userId: "u1", type: "claim_verification", projectId };
      expect(isWorkspaceBoundVerificationArtifact(row)).toBe(false);
      expect(isPersonalVerificationArtifact(row)).toBe(true);
    }
  });

  it("a workspaceId inherited from the prototype is not an own field", () => {
    const row = Object.create({ workspaceId: "ws-1" }) as Record<string, unknown>;
    row.userId = "u1";
    expect(isWorkspaceBoundVerificationArtifact(row)).toBe(false);
  });

  it("non-object input is neither Workspace-bound nor Personal", () => {
    for (const v of [null, undefined, "ws-1", 1, true]) {
      expect(isWorkspaceBoundVerificationArtifact(v)).toBe(false);
      expect(isPersonalVerificationArtifact(v)).toBe(false);
    }
  });
});
