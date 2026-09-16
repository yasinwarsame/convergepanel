/**
 * TEAM-RESEARCH-PARITY-R3 §AB/§I — Team research detail addresses and the
 * matching R1 read URL.
 */
import { teamResearchDetailHref, teamRunDetailApiUrl } from "@/lib/workspaces/teamResearchDetailHref";

describe("teamResearchDetailHref", () => {
  it("Project-bound run → the Project research detail address", () => {
    expect(teamResearchDetailHref({ workspaceId: "ws-1", projectId: "proj-1", runId: "run-1" })).toBe("/workspace/team/ws-1/projects/proj-1/research/run-1");
  });

  it("Unfiled run (projectId null) → the Unfiled Team research detail address", () => {
    expect(teamResearchDetailHref({ workspaceId: "ws-1", projectId: null, runId: "run-1" })).toBe("/workspace/team/ws-1/research/run-1");
  });

  it("never emits a Personal research address for either scope", () => {
    for (const projectId of ["proj-1", null]) {
      const href = teamResearchDetailHref({ workspaceId: "ws-1", projectId, runId: "run-1" });
      expect(href.startsWith("/workspace/team/ws-1/")).toBe(true);
      expect(href).not.toMatch(/^\/workspace\/research\//);
      expect(href).not.toContain("openResearchRun");
    }
  });

  it("percent-encodes every dynamic segment exactly once", () => {
    expect(teamResearchDetailHref({ workspaceId: "w/1 x", projectId: "p&1", runId: "r?1" })).toBe("/workspace/team/w%2F1%20x/projects/p%261/research/r%3F1");
    expect(teamResearchDetailHref({ workspaceId: "w/1 x", projectId: null, runId: "r?1" })).toBe("/workspace/team/w%2F1%20x/research/r%3F1");
  });
});

describe("teamRunDetailApiUrl", () => {
  it("Project address → the R1 endpoint WITH ?projectId", () => {
    expect(teamRunDetailApiUrl({ workspaceId: "ws-1", projectId: "proj-1", runId: "run-1" })).toBe("/api/workspaces/ws-1/runs/run-1?projectId=proj-1");
  });

  it("Unfiled address → the R1 endpoint WITHOUT a projectId", () => {
    expect(teamRunDetailApiUrl({ workspaceId: "ws-1", projectId: null, runId: "run-1" })).toBe("/api/workspaces/ws-1/runs/run-1");
  });

  it("never the Personal run endpoint; values encoded exactly once", () => {
    const url = teamRunDetailApiUrl({ workspaceId: "w/1 x", projectId: "p&1", runId: "r?1" });
    expect(url).toBe("/api/workspaces/w%2F1%20x/runs/r%3F1?projectId=p%261");
    expect(url).not.toContain("/api/user/runs");
    expect(url).not.toContain("%25");
  });
});
