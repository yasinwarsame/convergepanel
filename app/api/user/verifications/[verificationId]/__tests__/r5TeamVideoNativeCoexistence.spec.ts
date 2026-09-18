/**
 * TEAM-VERIFICATION-PARITY-R5-I1 §Z — the Personal-namespaced detail route
 * keeps its existing Team VIDEO branch unchanged while the canonical
 * Team-native Video detail route is introduced beside it.
 *
 * That route's own behaviour stays covered by `route.spec.ts`; this suite pins
 * the structural coexistence contract, exactly as `r3TeamNativeCoexistence`
 * did when the Team Claim read contracts landed.
 */

import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(process.cwd(), "app/api/user/verifications/[verificationId]/route.ts"), "utf8");

describe("Personal-namespaced verification detail route after R5-I1", () => {
  it("still classifies Team VIDEO rows by workspaceId FIELD PRESENCE and re-authorizes them against the row's own Workspace", () => {
    expect(source).toContain("validateTeamVideoVerificationRowShape");
    expect(source).toContain("resolveTeamRunWorkspaceAccess");
    expect(source).toContain("hasOwnProperty");
    expect(source).toContain("mapStoredVideoVerificationToClientPayload");
  });

  it("still keeps its Team CLAIM branch (R5-I1 changed neither)", () => {
    expect(source).toContain("validateTeamClaimVerificationRowShape");
  });

  it("does not depend on, redirect to, or share code with the new Team-native VIDEO read contracts", () => {
    for (const r5 of [
      "listTeamVideoVerifications",
      "teamVideoVerificationSummary",
      "teamVideoVerificationResponse",
      "teamVideoVerificationsCursor",
      "/api/workspaces/",
    ]) {
      expect(source).not.toContain(r5);
    }
    expect(source).not.toMatch(/redirect\(/);
  });

  it("a claimed-Team Video row is NEVER allowed to fall back to Personal ownership", () => {
    // The route's own documented invariant; pinned so a future edit that
    // reintroduces a Personal fallback for a workspaceId-bearing Video row
    // fails here as well as in that route's behavioural suite.
    expect(source).toContain("may NEVER fall back");
  });
});
