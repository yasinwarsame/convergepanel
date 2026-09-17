/**
 * TEAM-VERIFICATION-PARITY-R4-I1 §C/§W — the canonical Team Claim DETAIL
 * address builder and its R3 API counterpart.
 *
 * The builder is pure, so these are exact-string assertions: a Project-bound
 * Claim must never collapse to the Unfiled address, and the Project API URL
 * must carry exactly one encoded `projectId`.
 */

import { teamClaimDetailHref, teamClaimDetailApiUrl } from "@/lib/workspaces/teamClaimDetailHref";

const W = "ws-1";
const P = "proj-1";
const V = "vcl-1";

describe("teamClaimDetailHref", () => {
  it("addresses an Unfiled Claim at the Workspace level", () => {
    expect(teamClaimDetailHref({ workspaceId: W, projectId: null, verificationId: V })).toBe("/workspace/team/ws-1/claims/vcl-1");
  });

  it("addresses a Project-bound Claim beneath its Project", () => {
    expect(teamClaimDetailHref({ workspaceId: W, projectId: P, verificationId: V })).toBe("/workspace/team/ws-1/projects/proj-1/claims/vcl-1");
  });

  it("never collapses a Project-bound Claim onto the Unfiled address", () => {
    const filed = teamClaimDetailHref({ workspaceId: W, projectId: P, verificationId: V });
    const unfiled = teamClaimDetailHref({ workspaceId: W, projectId: null, verificationId: V });
    expect(filed).not.toBe(unfiled);
    expect(filed).toContain("/projects/proj-1/");
    expect(unfiled).not.toContain("/projects/");
  });

  it("uses the product term `claims`, never the storage name `verifications`", () => {
    expect(teamClaimDetailHref({ workspaceId: W, projectId: null, verificationId: V })).not.toContain("verifications");
    expect(teamClaimDetailHref({ workspaceId: W, projectId: P, verificationId: V })).not.toContain("verifications");
  });

  it("percent-encodes every dynamic segment exactly once", () => {
    expect(teamClaimDetailHref({ workspaceId: "a b/c", projectId: "p#1", verificationId: "v?2" })).toBe("/workspace/team/a%20b%2Fc/projects/p%231/claims/v%3F2");
    expect(teamClaimDetailHref({ workspaceId: "a b/c", projectId: null, verificationId: "v?2" })).toBe("/workspace/team/a%20b%2Fc/claims/v%3F2");
  });

  it("cannot be steered outside the Team Workspace address space", () => {
    // A traversal-shaped id is encoded, not honoured: the result still begins
    // with this Workspace's own base path.
    const href = teamClaimDetailHref({ workspaceId: W, projectId: null, verificationId: "../../../admin" });
    expect(href).toBe("/workspace/team/ws-1/claims/..%2F..%2F..%2Fadmin");
    expect(href.startsWith("/workspace/team/ws-1/")).toBe(true);
  });
});

describe("teamClaimDetailApiUrl", () => {
  it("omits projectId for the Unfiled address", () => {
    expect(teamClaimDetailApiUrl({ workspaceId: W, projectId: null, verificationId: V })).toBe("/api/workspaces/ws-1/verifications/vcl-1");
  });

  it("always sends ?projectId= for a Project address", () => {
    expect(teamClaimDetailApiUrl({ workspaceId: W, projectId: P, verificationId: V })).toBe("/api/workspaces/ws-1/verifications/vcl-1?projectId=proj-1");
  });

  it("sends exactly one encoded projectId parameter", () => {
    const url = teamClaimDetailApiUrl({ workspaceId: W, projectId: "p/1", verificationId: V });
    expect(url.match(/projectId=/g)).toHaveLength(1);
    expect(url).toBe("/api/workspaces/ws-1/verifications/vcl-1?projectId=p%2F1");
  });

  it("targets the Team verifications endpoint, never a Personal one", () => {
    for (const projectId of [null, P]) {
      const url = teamClaimDetailApiUrl({ workspaceId: W, projectId, verificationId: V });
      expect(url.startsWith("/api/workspaces/ws-1/verifications/")).toBe(true);
      expect(url).not.toContain("/api/user/");
    }
  });

  it("percent-encodes the Workspace and verification segments", () => {
    expect(teamClaimDetailApiUrl({ workspaceId: "w s", projectId: null, verificationId: "v&1" })).toBe("/api/workspaces/w%20s/verifications/v%261");
  });
});
