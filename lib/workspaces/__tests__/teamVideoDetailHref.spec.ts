/**
 * TEAM-VERIFICATION-PARITY-R5-I2 §AJ — the pure Team Video detail address and
 * read-endpoint builders.
 */

import { teamVideoDetailHref, teamVideoDetailApiUrl } from "@/lib/workspaces/teamVideoDetailHref";

const W = "ws-1";
const P = "proj-1";
const V = "vid-1";

describe("teamVideoDetailHref", () => {
  it("an Unfiled Video addresses the Workspace route", () => {
    expect(teamVideoDetailHref({ workspaceId: W, projectId: null, verificationId: V })).toBe("/workspace/team/ws-1/videos/vid-1");
  });

  it("a filed Video addresses the Project route", () => {
    expect(teamVideoDetailHref({ workspaceId: W, projectId: P, verificationId: V })).toBe("/workspace/team/ws-1/projects/proj-1/videos/vid-1");
  });

  it("uses the product term `videos`, never the storage collection name", () => {
    const href = teamVideoDetailHref({ workspaceId: W, projectId: P, verificationId: V });
    expect(href).toContain("/videos/");
    expect(href).not.toContain("videoVerifications");
    expect(href).not.toContain("verifications/vid");
  });

  it("percent-encodes every dynamic segment exactly once", () => {
    expect(teamVideoDetailHref({ workspaceId: "w s", projectId: "p/1", verificationId: "v?1" })).toBe("/workspace/team/w%20s/projects/p%2F1/videos/v%3F1");
    expect(teamVideoDetailHref({ workspaceId: "w s", projectId: null, verificationId: "v#1" })).toBe("/workspace/team/w%20s/videos/v%231");
  });

  it("never produces a Personal address", () => {
    for (const projectId of [null, P]) {
      const href = teamVideoDetailHref({ workspaceId: W, projectId, verificationId: V });
      expect(href).not.toContain("/api/");
      expect(href).not.toContain("/verify-video");
      expect(href.startsWith("/workspace/team/")).toBe(true);
    }
  });
});

describe("teamVideoDetailApiUrl", () => {
  it("the Unfiled address sends no containment query", () => {
    expect(teamVideoDetailApiUrl({ workspaceId: W, projectId: null, verificationId: V })).toBe("/api/workspaces/ws-1/video-verifications/vid-1");
  });

  it("a Project address ALWAYS sends ?projectId so the server enforces containment", () => {
    expect(teamVideoDetailApiUrl({ workspaceId: W, projectId: P, verificationId: V })).toBe("/api/workspaces/ws-1/video-verifications/vid-1?projectId=proj-1");
  });

  it("encodes path and query components", () => {
    expect(teamVideoDetailApiUrl({ workspaceId: "w s", projectId: "p/1", verificationId: "v 1" })).toBe(
      "/api/workspaces/w%20s/video-verifications/v%201?projectId=p%2F1"
    );
  });

  it("never targets a Personal endpoint", () => {
    for (const projectId of [null, P]) {
      const url = teamVideoDetailApiUrl({ workspaceId: W, projectId, verificationId: V });
      expect(url).not.toContain("/api/user/");
      expect(url).not.toContain("/api/verify-video");
      expect(url.startsWith("/api/workspaces/")).toBe(true);
    }
  });

  it("the UI href and the API URL are different surfaces for the same artifact", () => {
    const ui = teamVideoDetailHref({ workspaceId: W, projectId: P, verificationId: V });
    const api = teamVideoDetailApiUrl({ workspaceId: W, projectId: P, verificationId: V });
    expect(ui).not.toEqual(api);
    expect(ui.startsWith("/workspace/")).toBe(true);
    expect(api.startsWith("/api/")).toBe(true);
  });
});
