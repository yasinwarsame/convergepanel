import { teamRunAccessDeniedResponse } from "../teamRunAccessResponse";

describe("teamRunAccessDeniedResponse", () => {
  it("lookup_failed -> 503 (deliberately NOT the same 404 as other reasons — genuine infrastructure failure)", () => {
    expect(teamRunAccessDeniedResponse("lookup_failed").status).toBe(503);
  });

  it.each([
    "team_workspaces_disabled",
    "workspace_not_found",
    "workspace_malformed",
    "wrong_workspace_type",
    "membership_not_found",
    "membership_removed",
    "membership_malformed",
    "owner_integrity_violation",
  ] as const)("%s -> concealed 404, identical body shape across all of them", (reason) => {
    const { status, body } = teamRunAccessDeniedResponse(reason);
    expect(status).toBe(404);
    expect(body.errorCode).toBe("team_workspace_not_found");
  });

  it("every 404-mapped reason produces byte-identical bodies (non-distinguishable concealment)", () => {
    const reasons = [
      "team_workspaces_disabled",
      "workspace_not_found",
      "workspace_malformed",
      "wrong_workspace_type",
      "membership_not_found",
      "membership_removed",
      "membership_malformed",
      "owner_integrity_violation",
    ] as const;
    const bodies = reasons.map((r) => JSON.stringify(teamRunAccessDeniedResponse(r).body));
    expect(new Set(bodies).size).toBe(1);
  });

  // Phase 10C.1A (F1 concealment correction): "team_workspaces_disabled"
  // (Case 1 — target Workspace not yet rollout-admitted) must be
  // byte-identical to "workspace_not_found" (Case 2 — admitted, but the
  // Workspace doesn't exist / caller has no legitimate access). Before this
  // fix, Case 1 returned a distinct 503 that let a caller who already knows
  // a target Workspace ID distinguish "not admitted" from "admitted but no
  // access" — a rollout-cohort-membership oracle.
  it("F1 parity: team_workspaces_disabled (Case 1) is byte-identical to workspace_not_found (Case 2)", () => {
    const notAdmitted = teamRunAccessDeniedResponse("team_workspaces_disabled");
    const admittedButForeign = teamRunAccessDeniedResponse("workspace_not_found");
    expect(notAdmitted.status).toBe(admittedButForeign.status);
    expect(JSON.stringify(notAdmitted.body)).toBe(JSON.stringify(admittedButForeign.body));
  });

  it("F1 parity: team_workspaces_disabled is NOT confused with lookup_failed (infrastructure failure stays distinct)", () => {
    const notAdmitted = teamRunAccessDeniedResponse("team_workspaces_disabled");
    const infra = teamRunAccessDeniedResponse("lookup_failed");
    expect(notAdmitted.status).not.toBe(infra.status);
  });
});
