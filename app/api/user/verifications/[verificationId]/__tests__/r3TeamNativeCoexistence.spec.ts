/**
 * TEAM-VERIFICATION-PARITY-R3 — the Personal-namespaced detail route keeps its
 * existing Team-aware branch unchanged while the canonical Team-native detail
 * route is introduced beside it. Behaviour of this route stays covered by
 * `route.spec.ts`; this pins the structural coexistence contract.
 */

import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(process.cwd(), "app/api/user/verifications/[verificationId]/route.ts"), "utf8");

describe("Personal-namespaced verification detail route after R3", () => {
  it("still classifies Team Claim rows and re-authorizes them against the row's own Workspace", () => {
    expect(source).toContain("validateTeamClaimVerificationRowShape");
    expect(source).toContain("resolveTeamRunWorkspaceAccess");
    expect(source).toContain("resolveTeamSourceResearchLink");
    expect(source).toContain("resolvePersonalSourceResearchLink");
  });

  it("does not depend on, redirect to, or share code with the new Team-native read contracts", () => {
    for (const r3 of ["listTeamClaimVerifications", "teamClaimVerificationSummary", "teamClaimVerificationResponse", "teamClaimVerificationsCursor", "/api/workspaces/"]) {
      expect(source).not.toContain(r3);
    }
    expect(source).not.toMatch(/redirect\(/);
  });
});
