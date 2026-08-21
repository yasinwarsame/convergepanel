import { teamRunAccessDeniedResponse } from "../teamRunAccessResponse";

describe("teamRunAccessDeniedResponse", () => {
  it("team_workspaces_disabled -> 503", () => {
    expect(teamRunAccessDeniedResponse("team_workspaces_disabled").status).toBe(503);
  });

  it("lookup_failed -> 503 (deliberately NOT the same 404 as other reasons)", () => {
    expect(teamRunAccessDeniedResponse("lookup_failed").status).toBe(503);
  });

  it.each(["workspace_not_found", "workspace_malformed", "wrong_workspace_type", "membership_not_found", "membership_removed", "membership_malformed", "owner_integrity_violation"] as const)(
    "%s -> concealed 404, identical body shape across all of them",
    (reason) => {
      const { status, body } = teamRunAccessDeniedResponse(reason);
      expect(status).toBe(404);
      expect(body.errorCode).toBe("team_workspace_not_found");
    }
  );

  it("every 404-mapped reason produces byte-identical bodies (non-distinguishable concealment)", () => {
    const reasons = ["workspace_not_found", "workspace_malformed", "wrong_workspace_type", "membership_not_found", "membership_removed", "membership_malformed", "owner_integrity_violation"] as const;
    const bodies = reasons.map((r) => JSON.stringify(teamRunAccessDeniedResponse(r).body));
    expect(new Set(bodies).size).toBe(1);
  });
});
