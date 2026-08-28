import {
  teamProjectAuthorizationDeniedResponse,
  teamProjectNotFoundConcealedResponse,
  teamProjectInvalidStatusTransitionResponse,
  teamWorkspaceReadNotFoundResponse,
} from "../teamProjectErrorResponse";

describe("teamProjectAuthorizationDeniedResponse", () => {
  it("insufficient_capability -> 403, distinguishable (caller IS an active member)", () => {
    const { status, body } = teamProjectAuthorizationDeniedResponse("insufficient_capability");
    expect(status).toBe(403);
    expect(body.errorCode).toBe("insufficient_capability");
  });

  it.each([
    "team_workspaces_disabled",
    "workspace_not_found",
    "workspace_malformed",
    "membership_not_found",
    "membership_removed",
    "membership_malformed",
    "owner_integrity_violation",
  ] as const)("%s -> concealed 404, identical body shape across all of them", (reason) => {
    const { status, body } = teamProjectAuthorizationDeniedResponse(reason);
    expect(status).toBe(404);
    expect(body.errorCode).toBe("team_workspace_not_found");
  });

  it("every 404-mapped reason produces byte-identical bodies (non-distinguishable concealment)", () => {
    const reasons = [
      "team_workspaces_disabled",
      "workspace_not_found",
      "workspace_malformed",
      "membership_not_found",
      "membership_removed",
      "membership_malformed",
      "owner_integrity_violation",
    ] as const;
    const bodies = reasons.map((r) => JSON.stringify(teamProjectAuthorizationDeniedResponse(r).body));
    expect(new Set(bodies).size).toBe(1);
  });

  // Phase 10C.1A (F1 concealment correction): "team_workspaces_disabled"
  // (Case 1 — target Workspace not yet rollout-admitted) must be
  // byte-identical to "workspace_not_found" (Case 2 — admitted, but the
  // Workspace doesn't exist / caller has no legitimate access). Before this
  // fix, Case 1 was routed to the distinct shared 503
  // `teamWorkspacesDisabledResponse()` instead of through this function at
  // all — letting a caller who already knows a target Workspace ID
  // distinguish "not admitted" from "admitted but no access."
  it("F1 parity: team_workspaces_disabled (Case 1) is byte-identical to workspace_not_found (Case 2)", () => {
    const notAdmitted = teamProjectAuthorizationDeniedResponse("team_workspaces_disabled");
    const admittedButForeign = teamProjectAuthorizationDeniedResponse("workspace_not_found");
    expect(notAdmitted.status).toBe(admittedButForeign.status);
    expect(JSON.stringify(notAdmitted.body)).toBe(JSON.stringify(admittedButForeign.body));
  });

  it("F1 parity: team_workspaces_disabled is NOT confused with insufficient_capability (a real member's denial stays distinguishable)", () => {
    const notAdmitted = teamProjectAuthorizationDeniedResponse("team_workspaces_disabled");
    const insufficientCapability = teamProjectAuthorizationDeniedResponse("insufficient_capability");
    expect(notAdmitted.status).not.toBe(insufficientCapability.status);
  });
});

describe("teamProjectNotFoundConcealedResponse", () => {
  it("returns a concealed 404, distinct errorCode from the Workspace-level concealment", () => {
    const { status, body } = teamProjectNotFoundConcealedResponse();
    expect(status).toBe(404);
    expect(body.errorCode).toBe("project_not_found");
  });
});

describe("teamProjectInvalidStatusTransitionResponse", () => {
  it("returns 409 (safe to expose — authorization already established)", () => {
    const { status, body } = teamProjectInvalidStatusTransitionResponse();
    expect(status).toBe(409);
    expect(body.errorCode).toBe("invalid_project_status_transition");
  });
});

describe("teamWorkspaceReadNotFoundResponse", () => {
  it("returns the same concealed 404 shape as teamProjectAuthorizationDeniedResponse's non-capability branch", () => {
    const readDenied = teamWorkspaceReadNotFoundResponse();
    const mutationDenied = teamProjectAuthorizationDeniedResponse("workspace_not_found");
    expect(readDenied.status).toBe(mutationDenied.status);
    expect(JSON.stringify(readDenied.body)).toBe(JSON.stringify(mutationDenied.body));
  });
});
