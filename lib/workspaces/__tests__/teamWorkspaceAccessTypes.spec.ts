/**
 * ZCA L-4 — the client's closed capability/role lists (teamWorkspaceAccessTypes.ts) are exactly the
 * server's (capabilities.ts / membershipTypes.ts, both server-only), so a client parse can never
 * accept a string the server would not grant, nor reject one it does.
 */
import { capabilitiesForRole } from "@/lib/workspaces/capabilities";
import { WORKSPACE_MEMBERSHIP_ROLES } from "@/lib/workspaces/membershipTypes";
import { CLIENT_WORKSPACE_CAPABILITIES, CLIENT_WORKSPACE_ROLES, parseTeamWorkspaceAccessResponse } from "@/lib/workspaces/teamWorkspaceAccessTypes";

describe("client/server capability parity", () => {
  it("roles are identical", () => {
    expect([...CLIENT_WORKSPACE_ROLES].sort()).toEqual([...WORKSPACE_MEMBERSHIP_ROLES].sort());
  });
  it("the union of every role's capabilities is exactly the client list", () => {
    const union = new Set(WORKSPACE_MEMBERSHIP_ROLES.flatMap((r) => [...capabilitiesForRole(r)]));
    expect([...union].sort()).toEqual([...CLIENT_WORKSPACE_CAPABILITIES].sort());
  });
});

describe("parseTeamWorkspaceAccessResponse", () => {
  const OK = { ok: true, workspace: { id: "w", name: "N" }, role: "viewer", capabilities: ["workspace.read"], reportReviewEnabled: false, projectAssignmentUiEnabled: false };
  it("accepts the exact ok shape", () => {
    expect(parseTeamWorkspaceAccessResponse(OK)).toEqual({ workspace: { id: "w", name: "N" }, role: "viewer", capabilities: ["workspace.read"], reportReviewEnabled: false, projectAssignmentUiEnabled: false });
  });
  it.each([
    ["ok false", { ...OK, ok: false }],
    ["unknown role", { ...OK, role: "superuser" }],
    ["unknown capability", { ...OK, capabilities: ["workspace.read", "everything"] }],
    ["non-array capabilities", { ...OK, capabilities: "workspace.read" }],
    ["missing name", { ...OK, workspace: { id: "w" } }],
    ["non-boolean flag", { ...OK, reportReviewEnabled: "yes" }],
    ["null", null],
  ])("rejects %s", (_n, body) => {
    expect(parseTeamWorkspaceAccessResponse(body)).toBeNull();
  });
});
