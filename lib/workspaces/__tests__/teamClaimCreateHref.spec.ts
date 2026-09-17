/**
 * TEAM-VERIFICATION-PARITY-R4-I3 §AG — the Team Claim CREATION address builder.
 * Pure, so these are exact-string assertions: the route is the creation scope,
 * and it must not be steerable by its own inputs.
 */

import { teamClaimCreateHref } from "@/lib/workspaces/teamClaimCreateHref";

const W = "ws-1";
const P = "proj-1";

describe("teamClaimCreateHref", () => {
  it("addresses Unfiled creation at the Workspace level", () => {
    expect(teamClaimCreateHref({ workspaceId: W, projectId: null })).toBe("/workspace/team/ws-1/claims/new");
  });

  it("addresses Project-bound creation beneath its Project", () => {
    expect(teamClaimCreateHref({ workspaceId: W, projectId: P })).toBe("/workspace/team/ws-1/projects/proj-1/claims/new");
  });

  it("never collapses a Project-bound create onto the Unfiled address", () => {
    const filed = teamClaimCreateHref({ workspaceId: W, projectId: P });
    expect(filed).not.toBe(teamClaimCreateHref({ workspaceId: W, projectId: null }));
    expect(filed).toContain("/projects/proj-1/");
  });

  it("percent-encodes every dynamic segment exactly once", () => {
    expect(teamClaimCreateHref({ workspaceId: "a b/c", projectId: "p#1" })).toBe("/workspace/team/a%20b%2Fc/projects/p%231/claims/new");
    expect(teamClaimCreateHref({ workspaceId: "a b/c", projectId: null })).toBe("/workspace/team/a%20b%2Fc/claims/new");
  });

  it("cannot be steered outside the addressed Workspace", () => {
    const href = teamClaimCreateHref({ workspaceId: W, projectId: "../../../admin" });
    expect(href).toBe("/workspace/team/ws-1/projects/..%2F..%2F..%2Fadmin/claims/new");
    expect(href.startsWith("/workspace/team/ws-1/")).toBe(true);
  });

  it("always ends at the creation segment and carries no return path or query", () => {
    for (const projectId of [null, P]) {
      const href = teamClaimCreateHref({ workspaceId: W, projectId });
      expect(href.endsWith("/claims/new")).toBe(true);
      expect(href).not.toContain("?");
      expect(href).not.toContain("returnTo");
      expect(href).not.toContain("/api/");
    }
  });
});
