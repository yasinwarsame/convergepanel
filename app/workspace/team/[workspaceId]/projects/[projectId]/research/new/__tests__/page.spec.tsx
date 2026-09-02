/**
 * Team Project Research Composer, Phase 12A.3 —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/research/new`
 * server-gate tests. Same technique as the sibling Project detail gate
 * spec: calls the Server Component function directly and asserts real
 * `next/navigation` `notFound()` behavior (digest `"NEXT_NOT_FOUND"`).
 *
 * Extends the Project detail page's containment coverage with the two
 * additional gates this route requires: the `research.create` +
 * `research.organize` capability pair, and the Project-active-status
 * check (an archived Project can never accept a new run).
 */

const mockedResolveServerComponentIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({
  resolveServerComponentIdentity: (...args: any[]) => mockedResolveServerComponentIdentity(...args),
}));

const mockedResolveWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({
  resolveWorkspaceAccess: (...args: any[]) => mockedResolveWorkspaceAccess(...args),
}));

const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({
  getProject: (...args: any[]) => mockedGetProject(...args),
}));

jest.mock("@/components/workspace/projects/TeamResearchComposerShell", () => ({
  __esModule: true,
  default: (props: any) => ({ __mockShell: true, props }),
}));

import TeamProjectResearchComposerPage from "@/app/workspace/team/[workspaceId]/projects/[projectId]/research/new/page";

const WS_ID = "ws-1";
const OTHER_WS_ID = "ws-2";
const PROJECT_ID = "proj-1";
const UID = "uid-member";

function callPage(projectId: string = PROJECT_ID) {
  return TeamProjectResearchComposerPage({ params: { workspaceId: WS_ID, projectId } });
}

async function expectRealNotFound(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect((caught as any)?.digest).toBe("NEXT_NOT_FOUND");
}

function grantedTeamAccess(overrides: Partial<{ capabilities: string[] }> = {}) {
  return {
    granted: true,
    workspaceType: "team",
    workspace: { id: WS_ID, name: "Acme Team" },
    membership: { role: "member" },
    capabilities: ["workspace.read", "projects.read", "research.create", "research.organize"],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("TeamProjectResearchComposerPage — gate (server-authoritative)", () => {
  it("unauthenticated -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    await expectRealNotFound(callPage());
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("resolveWorkspaceAccess denies -> notFound, getProject never called", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    await expectRealNotFound(callPage());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("wrong workspace type (Personal) -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "personal", workspace: { id: WS_ID, name: "Personal" } });
    await expectRealNotFound(callPage());
  });

  it("missing projects.read -> notFound, getProject never called", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: ["workspace.read", "research.create", "research.organize"] }));
    await expectRealNotFound(callPage());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("has projects.read + research.create but NOT research.organize -> notFound (the exact pair createTeamWorkspaceRun() requires for a Project-bound run)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: ["workspace.read", "projects.read", "research.create"] }));
    await expectRealNotFound(callPage());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("has projects.read + research.organize but NOT research.create -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: ["workspace.read", "projects.read", "research.organize"] }));
    await expectRealNotFound(callPage());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("read-only role (projects.read + research.read only) -> notFound, no misleading composer rendered", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: ["workspace.read", "projects.read", "research.read"] }));
    await expectRealNotFound(callPage());
  });

  it("Project not found -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue({ status: "not_found" });
    await expectRealNotFound(callPage());
  });

  it("CRITICAL — a Project belonging to a DIFFERENT Workspace than the route's own workspaceId -> notFound, concealed identically to not-found (cross-Workspace containment)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue({
      status: "found",
      project: { id: PROJECT_ID, workspaceId: OTHER_WS_ID, name: "Foreign Project", status: "active" },
    });
    await expectRealNotFound(callPage());
  });

  it("caller has access to BOTH Workspaces separately -> still notFound for a Project served through the WRONG Workspace's route (access to the other Workspace is never sufficient)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess()); // grants access to WS_ID
    mockedGetProject.mockResolvedValue({
      status: "found",
      project: { id: PROJECT_ID, workspaceId: OTHER_WS_ID, name: "Foreign Project", status: "active" },
    });
    await expectRealNotFound(callPage());
  });

  it("ARCHIVED Project -> notFound, never renders an enabled composer for a Project the backend would reject", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue({
      status: "found",
      project: { id: PROJECT_ID, workspaceId: WS_ID, name: "Old Project", status: "archived" },
    });
    await expectRealNotFound(callPage());
  });

  it("authorized + active Project in the correct Workspace -> renders the shell with correct route-bound context", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: ["workspace.read", "projects.read", "research.create", "research.organize", "audit.read"] }));
    mockedGetProject.mockResolvedValue({
      status: "found",
      project: { id: PROJECT_ID, workspaceId: WS_ID, name: "ABC Acquisition", status: "active" },
    });
    const result: any = await callPage();
    expect(result.props.workspaceId).toBe(WS_ID);
    expect(result.props.workspaceName).toBe("Acme Team");
    expect(result.props.canReadAudit).toBe(true);
    expect(result.props.project).toEqual({ id: PROJECT_ID, name: "ABC Acquisition" });
  });

  it("getProject is called with exactly the route's projectId, never workspaceId or any other value", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue({
      status: "found",
      project: { id: PROJECT_ID, workspaceId: WS_ID, name: "X", status: "active" },
    });
    await callPage(PROJECT_ID);
    expect(mockedGetProject).toHaveBeenCalledWith(PROJECT_ID);
  });
});
