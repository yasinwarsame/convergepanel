/** Project/Research Assignment — list-hook contracts: `?assignee=me` URL building and the required `assignees` / `assignee` DTO fields. */
import { parseTeamProjectsListPageResponse, buildTeamProjectsListUrl, isValidTeamProjectAssignee } from "@/hooks/useTeamProjects";
import { parseTeamProjectRunsPageResponse, buildTeamProjectRunsUrl } from "@/hooks/useTeamProjectRuns";

const WS_ID = "ws 1";
const item = (overrides: Record<string, unknown> = {}) => ({ id: "p1", workspaceId: WS_ID, name: "P", status: "active", createdAt: "x", updatedAt: "x", updateTime: { seconds: 1, nanoseconds: 0 }, assignees: [{ uid: "m1", displayName: "Bao", state: "stale" }], ...overrides });
const run = (overrides: Record<string, unknown> = {}) => ({ id: "r1", at: "2026-01-01T00:00:00.000Z", question: "Q?", selectedModels: [], projectId: "p1", assignee: { uid: "m1", displayName: "Bao", state: "stale" }, ...overrides });

describe("URL builders — `me` is the only filter value; the server substitutes the caller's uid", () => {
  it("Projects", () => {
    expect(buildTeamProjectsListUrl({ workspaceId: WS_ID, status: "active", assigneeFilter: null })).toBe("/api/workspaces/ws%201/projects?status=active");
    expect(buildTeamProjectsListUrl({ workspaceId: WS_ID, status: "archived", assigneeFilter: "me", cursor: "c&1" })).toBe("/api/workspaces/ws%201/projects?status=archived&assignee=me&cursor=c%261");
  });
  it("Project runs", () => {
    expect(buildTeamProjectRunsUrl({ workspaceId: WS_ID, projectId: "p 1", assigneeFilter: null })).toBe("/api/workspaces/ws%201/projects/p%201/runs");
    expect(buildTeamProjectRunsUrl({ workspaceId: WS_ID, projectId: "p 1", assigneeFilter: "me", cursor: "c" })).toBe("/api/workspaces/ws%201/projects/p%201/runs?assignee=me&cursor=c");
  });
});

describe("DTO validation", () => {
  it("Project rows REQUIRE a well-formed assignees array (D4 stale entries are valid data, rendered by name)", () => {
    const ok = parseTeamProjectsListPageResponse({ ok: true, body: { ok: true, items: [item()], hasMore: false }, expectedWorkspaceId: WS_ID, expectedStatus: "active" });
    expect(ok.ok).toBe(true);
    for (const bad of [item({ assignees: undefined }), item({ assignees: "m1" }), item({ assignees: [{ uid: "m1", displayName: "Bao", state: "unknown" }] }), item({ assignees: [{ uid: "", displayName: "Bao", state: "active" }] })]) {
      expect(parseTeamProjectsListPageResponse({ ok: true, body: { ok: true, items: [bad], hasMore: false }, expectedWorkspaceId: WS_ID, expectedStatus: "active" })).toEqual({ ok: false, errorCode: "internal_error" });
    }
    expect(isValidTeamProjectAssignee({ uid: "m1", displayName: "Bao", state: "active" })).toBe(true);
  });
  it("run rows REQUIRE `assignee` to be null or a well-formed presentation", () => {
    expect(parseTeamProjectRunsPageResponse({ ok: true, body: { ok: true, items: [run(), run({ id: "r2", assignee: null })], hasMore: false }, expectedProjectId: "p1" }).ok).toBe(true);
    for (const bad of [run({ assignee: undefined }), run({ assignee: "m1" }), run({ assignee: { uid: "m1", displayName: "Bao" } })]) {
      expect(parseTeamProjectRunsPageResponse({ ok: true, body: { ok: true, items: [bad], hasMore: false }, expectedProjectId: "p1" })).toEqual({ ok: false, errorCode: "internal_error" });
    }
  });
});
